const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const Xess=require("../src/modules/shared/reshade/xess"),Library=require("../src/modules/shared/reshade/xess/library"),Source=Library.Source;
const sha=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"graphics-xess-")));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const payload=path.join(root,"processor"),profile=path.join(root,"profile"),directory=path.join(payload,"xess");fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(profile);const files=["x86_64-windows/host.exe","x86_64-windows/bridge.dll","x86_64-unix/bridge.so"].map(name=>{const file=path.join(directory,name),bytes=Buffer.from(name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return {path:name,size:bytes.length,sha256:sha(bytes)};});const descriptor={schema:1,providerABI:1,backend:"d3d12",architecture:"x86_64",sdk:{commit:Source.commit,sha256:Source.sha256,bytes:Source.bytes},hostPath:files[0].path,bridge:{name:"maclauncher-xess-gpu",windows:files[1].path,unix:files[2].path},files};fs.writeFileSync(path.join(directory,"provider.json"),JSON.stringify(descriptor));return {root:payload,userDataDir:profile,directory:path.join(profile,"game"),platform:"darwin",descriptor,payloadDirectory:directory};}
test("adding XeSS retains the existing temporal control ABI ordinals",()=>{const Controls=require("../src/modules/shared/reshade/temporal-controls");for(const [ordinal,temporalMethod]of ["off","metalfx","fsr2","fsr3","fsr4","xess"].entries()){const packet=Controls.packet({temporalMethod});assert.equal(packet.length,24);assert.equal(packet.readUInt32LE(8),ordinal);}});
function addGeneration(f){
  const Components=require("../src/modules/shared/reshade/xess/components.json"),relative="x86_64-windows/generation.exe",bytes=Buffer.from("generation host");
  fs.writeFileSync(path.join(f.payloadDirectory,relative),bytes);
  f.descriptor.files.push({path:relative,size:bytes.length,sha256:sha(bytes)});
  f.descriptor.generation={providerABI:1,hostPath:relative,backend:"d3d12",operation:"interpolate",maxInterpolatedFrames:1,
    requires:["color","depth","motion","viewMatrix","projectionMatrix"],sdk:Object.fromEntries(Components.files.map(row=>[row.id,{path:"bin/"+row.file,sha256:row.sha256,bytes:row.bytes}]))};
  fs.writeFileSync(path.join(f.payloadDirectory,"provider.json"),JSON.stringify(f.descriptor));
}
test("XeSS preparation keeps original generation companions and SR routes independent",async t=>{
  const f=fixture(t);addGeneration(f);
  t.mock.method(Library,"resolve",async(_root,options)=>options.operation==="interpolate"?{libraries:{frameGeneration:"/original/libxess_fg.dll",latency:"/original/libxell.dll"}}:{library:"/original/libxess.dll"});
  const requests=[];
  f.registry={listGraphicsComputeHosts:()=>[{getState:()=>({available:true,backends:["d3d12"]}),prepare:async request=>{
    requests.push(request);return {executable:"/trusted/wine",arguments:["--"],environment:{},hostPath:request.hostPath,originalLibrary:request.originalLibrary,
      ...(request.originalLibraries?{originalLibraries:request.originalLibraries}:{}),resources:{read:request.originalLibraries||[request.originalLibrary]}};
  }}]};
  const Broker=require("../src/modules/shared/runtime/gpu-compute-broker"),binding=Xess.reserve({...f,launchId:"sr-plus-generation"});t.after(()=>Broker.release(binding));
  const sr=await Xess.prepare({...f,xessBinding:binding}),fg=await Xess.prepare({...f,xessBinding:binding,operation:"interpolate"});
  const table=JSON.parse(fs.readFileSync(binding.config));assert.deepEqual(Object.keys(table.hosts),["d3d12","d3d12-fg"]);
  assert.equal(table.hosts.d3d12.originalLibrary,"/original/libxess.dll");
  assert.deepEqual(table.hosts["d3d12-fg"].originalLibraries,["/original/libxess_fg.dll","/original/libxell.dll"]);
  assert.deepEqual(requests[1].originalLibraries,fg.resources.read);assert.notEqual(sr.settings.xessIdentity,fg.settings.xessIdentity);
  assert.equal(requests[1].hostPath,path.join(f.payloadDirectory,f.descriptor.generation.hostPath));
  await assert.rejects(Xess.prepare({...f,xessBinding:binding,operation:"interpolate",backend:"vulkan"}),/no compatible/);
});
test("a rolled-back XeSS registration restores the earlier demand and stops the idle request watcher at once",async t=>{
  const f=fixture(t);t.mock.method(Library,"resolve",async()=>({library:"/original/libxess.dll"}));
  f.registry={listGraphicsComputeHosts:()=>[{getState:()=>({available:true,backends:["d3d12"]}),prepare:async request=>({executable:"/trusted/wine",arguments:["--"],environment:{},
    hostPath:request.hostPath,originalLibrary:request.originalLibrary,resources:{read:[request.originalLibrary]}})}]};
  const watchers=[];t.mock.method(fs,"watch",()=>{const watcher={closed:false,close(){this.closed=true;},on(){return this;},unref(){}};watchers.push(watcher);return watcher;});
  const Broker=require("../src/modules/shared/runtime/gpu-compute-broker"),binding=Xess.reserve({...f,launchId:"rollback"});t.after(()=>Broker.release(binding));
  Broker.bind(binding,process.pid);
  const undo=[],publication={onRollback:callback=>undo.push(callback)};
  await Xess.prepare({...f,xessBinding:binding,publication});
  assert.equal(Broker.demanded(binding),true);assert.equal(watchers.length,1);assert.equal(watchers[0].closed,false);
  for(const callback of undo.reverse())callback();
  assert.equal(Broker.demanded(binding),false);assert.equal(watchers[0].closed,true,"the restored plan without XeSS stops the idle watcher at once");
});
test("XeSS readiness follows operation receipts and the selected payload's actual factory",t=>{
  const f=fixture(t);f.registry={listGraphicsComputeHosts:()=>[{getState:()=>({available:true,backends:["d3d12"]})}]};
  t.mock.method(Library,"listInstalled",()=>[{version:Source.version,capabilities:["interpolate"]}]);
  assert.equal(Xess.state(f.root,f).ready,false);assert.equal(Xess.state(f.root,{...f,operation:"interpolate"}).available,false);
  addGeneration(f);assert.equal(Xess.state(f.root,{...f,operation:"interpolate"}).ready,true);assert.equal(Xess.state(f.root,f).ready,false);
  f.descriptor.generation.sdk.latency.sha256="0".repeat(64);fs.writeFileSync(path.join(f.payloadDirectory,"provider.json"),JSON.stringify(f.descriptor));
  assert.equal(Xess.resolve(f.root,f),null);
});
test("XeSS generation declares actual matrices and a single intermediate independently of SR",()=>{
  const Plan=require("../src/modules/shared/effects/plan"),options={graphicsCapabilities:{frameGeneration:true,providerGenerationMethods:["xess"],frameGenerationMethods:["xess"]},xessGenerationProvider:{available:true,backends:["d3d12"],availableWithoutRuntime:true},graphicsInputs:{depth:true,motionVectors:true,cameraProjection:true}};
  const row=Plan.catalog(options).find(row=>row.id==="frame-generation:xess");assert(row.available);
  assert.deepEqual(row.backends,["d3d12"]);assert.deepEqual(row.pendingInputs,["viewMatrix","projectionMatrix"]);
  assert.deepEqual(row.inputContract.requires,["depth","motion","viewMatrix","projectionMatrix","opaque"]);
  assert.equal(row.outputContract.maximumMultiplier,2);assert.equal(row.outputContract.phases,"midpoint");assert.equal(row.acceptsSynthetic,false);
  assert.equal(Plan.validate({schema:2,mode:"advanced",enabled:true,video:[{...row.template,id:"generation"}]}).video[0].method,"xess");
  const ready=Plan.catalog({...options,graphicsInputs:{depth:true,motionVectors:true,viewMatrix:true,projectionMatrix:true}}).find(candidate=>candidate.id===row.id);
  assert.equal(ready.pendingInputs,undefined);
});
test("XeSS discovery is offline and the dormant endpoint never initializes a GPU host",t=>{const f=fixture(t);t.mock.method(globalThis,"fetch",()=>assert.fail("Local discovery stays offline"));let prepares=0;f.registry={listGraphicsComputeHosts:()=>[{getState:()=>({available:true,backends:["d3d12"]}),prepare:()=>prepares++}]};const binding=Xess.reserve({...f,launchId:"a"});assert.match(binding.namespace,/^org\.maclauncher\.xess\.[a-f0-9]{24}\.$/);assert.equal(fs.existsSync(binding.config),false);assert.equal(Xess.reserve({...f,launchId:"a"}).namespace,binding.namespace);assert.notEqual(Xess.reserve({...f,launchId:"b"}).namespace,binding.namespace);const state=Xess.state(f.root,f);assert.equal(state.available,true);assert.equal(state.ready,false);assert.equal(state.needsPreparation,true);assert.equal(state.availableWithoutRuntime,true);assert.deepEqual(state.backends,["d3d12"]);assert.match(state.preparationReason,/runtime will be prepared/);assert.equal(prepares,0);});
test("the original XeSS host is selected by available compute resources across game architectures",async t=>{const f=fixture(t);t.mock.method(Library,"resolve",async()=>({library:"/original/libxess.dll"}));let requests=[];const config={executable:"/trusted/wine",arguments:["--bottle","/existing"],environment:{PATH:"/usr/bin"},hostPath:"/trusted/host.exe",originalLibrary:"/original/libxess.dll",resources:{read:["/original/libxess.dll"]}};f.registry={listGraphicsComputeHosts:()=>[{getState:()=>({available:true,backends:["d3d12"]}),prepare:async request=>{requests.push(request);return config;}}]};const binding=Xess.reserve({...f,launchId:"same"});for(const graphicsArchitecture of ["arm64","x64"]){const result=await Xess.prepare({...f,root:f.root,graphicsArchitecture,graphicsInputs:{methods:["metalfx"],depth:true,motionVectors:true},xessBinding:binding});assert.equal(result.environment.RESHADE_XESS_CONFIG,binding.config);assert.match(result.settings.xessIdentity,/^[a-f0-9]{64}$/);const table=JSON.parse(fs.readFileSync(binding.config));assert.equal(table.defaultBackend,"d3d12");assert.deepEqual(table.hosts,{d3d12:config});assert.equal(result.settings.xessBackend,"auto");assert.equal(result.settings.xessExecutionBackend,"d3d12");}assert.equal(requests.length,2);assert.equal(requests[0].originalLibrary,"/original/libxess.dll");await assert.rejects(Xess.prepare({...f,backend:"vulkan"}),/no compatible/);fs.writeFileSync(path.join(f.payloadDirectory,f.descriptor.hostPath),"tampered");await assert.rejects(Xess.prepare({...f,xessBinding:binding}),/no XeSS GPU host/);});
test("XeSS accepts normalized scene inputs without an unrelated camera or source-method restriction",()=>{const Plan=require("../src/modules/shared/effects/plan"),Graphics=require("../src/modules/shared/reshade/graphics-settings"),Binding=require("../src/modules/shared/reshade/launch-binding");const options={graphicsHost:"window",graphicsCapabilities:{temporal:true,providerTemporalMethods:["xess"],temporalMethods:["xess"]},xessProvider:{available:true,backends:["d3d12"]},graphicsInputs:{depth:true,motionVectors:true,methods:["metalfx"]}};const row=Plan.catalog(options).find(row=>row.id==="temporal:xess");assert.equal(row.available,true);assert.equal(row.pendingInputs,undefined);assert.deepEqual(row.inputContract.requires,["depth","motion"]);const pending=Plan.catalog({...options,graphicsInputs:{}}).find(row=>row.id==="temporal:xess");assert.deepEqual(pending.pendingInputs,["depth","motion"]);assert.deepEqual(Graphics.updateSettings({},{temporalMethod:"xess",xessBackend:"vulkan"}).xessBackend,"vulkan");assert.equal(Binding.nodeUnavailableReason({effectPlanAPI:1,effectPlanLiveResources:{xess:{config:"/owned/config"}}},{kind:"temporal",method:"xess",enabled:true}),null);});

test("one graph retains both XeSS backends without invalidating an unchanged backend",async t=>{
  const f=fixture(t),descriptor=f.descriptor;
  const file={path:"x86_64-windows/vulkan-host.exe"},bytes=Buffer.from("vulkan host");
  fs.writeFileSync(path.join(f.payloadDirectory,file.path),bytes);
  descriptor.files.push({...file,size:bytes.length,sha256:sha(bytes)});
  descriptor.backends=["d3d12","vulkan"];
  descriptor.hostPaths={d3d12:descriptor.hostPath,vulkan:file.path};
  fs.writeFileSync(path.join(f.payloadDirectory,"provider.json"),JSON.stringify(descriptor));
  t.mock.method(Library,"resolve",async()=>({library:"/original/libxess.dll"}));
  const requested=[];
  let vulkanVersion=1;
  f.registry={listGraphicsComputeHosts:()=>[{
    getState:()=>({available:true,backends:["d3d12","vulkan"]}),
    prepare:async request=>{
      requested.push(request.backend);
      return {executable:"/trusted/"+request.backend,arguments:request.backend==="d3d12"?["--"]:[],environment:{},hostPath:request.hostPath,originalLibrary:request.originalLibrary,version:request.backend==="vulkan"?vulkanVersion:1};
    }
  }]};
  const Broker=require("../src/modules/shared/runtime/gpu-compute-broker");
  const binding=Xess.reserve({...f,launchId:"two-backends"});t.after(()=>Broker.release(binding));
  const prepare=backend=>Xess.prepare({...f,backend,xessBinding:binding});
  const first=await prepare("auto"),second=await prepare("vulkan");
  assert.equal(first.settings.xessBackend,"auto");
  assert.equal(first.settings.xessExecutionBackend,"d3d12");
  assert.equal(second.settings.xessExecutionBackend,"vulkan");
  let table=JSON.parse(fs.readFileSync(binding.config));
  assert.equal(table.defaultBackend,"d3d12");
  assert.deepEqual(Object.keys(table.hosts),["d3d12","vulkan"]);
  assert.equal(table.hosts.vulkan.hostPath,path.join(f.payloadDirectory,file.path));
  assert.deepEqual(table.hosts.d3d12.arguments,["--"]);
  assert.deepEqual(table.hosts.vulkan.arguments,[]);
  vulkanVersion++;
  const changed=await prepare("vulkan"),unchanged=await prepare("auto");
  assert.notEqual(changed.settings.xessIdentity,second.settings.xessIdentity);
  assert.equal(unchanged.settings.xessIdentity,first.settings.xessIdentity);
  assert.deepEqual(requested,["d3d12","vulkan","vulkan","d3d12"]);
});

test("a preparable GPU host remains selectable offline and resumes the requested backend after consent",async t=>{
  const f=fixture(t);t.mock.method(globalThis,"fetch",()=>assert.fail("Discovery and this prepared fixture stay offline"));
  t.mock.method(Library,"resolve",async()=>({library:"/original/libxess.dll"}));
  const {confirmToolInstall}=require("../src/modules/shared/runtime/tool-install");
  let installed=false,prepares=0,consents=0;
  const config={executable:"/trusted/wine",arguments:[],environment:{PATH:"/usr/bin"},hostPath:"/trusted/host.exe",originalLibrary:"/original/libxess.dll",resources:{read:["/original/libxess.dll"]}};
  f.registry={listGraphicsComputeHosts:()=>[{getState:()=>({available:installed,backends:installed?["d3d12"]:[],preparable:!installed,preparableBackends:installed?[]:["d3d12"]}),prepare:async(request,context)=>{
    ++prepares;assert.equal(request.backend,"d3d12");
    await confirmToolInstall(context,{managerId:"managed-gpu",version:"compatible",requiresDownload:true,label:"GPU helper"});
    installed=true;return config;
  }}]};
  const before=Xess.state(f.root,f);assert.equal(before.available,true);assert.deepEqual(before.backends,["d3d12"]);assert.deepEqual(before.readyBackends,[]);assert.equal(before.ready,false);assert.equal(prepares,0);
  const binding=Xess.reserve({...f,launchId:"managed"});
  const result=await Xess.prepare({...f,xessBinding:binding,backend:"d3d12",confirmRuntimeInstall:async plan=>{++consents;assert.equal(plan.managerId,"managed-gpu");return true;}});
  assert.equal(prepares,1);assert.equal(consents,1);assert.equal(result.settings.xessBackend,"d3d12");assert.equal(result.settings.xessExecutionBackend,"d3d12");
  assert.equal(JSON.parse(fs.readFileSync(binding.config)).hosts.d3d12.hostPath,config.hostPath);
});

test("declining the XeSS runtime leaves a dormant launch and never starts host preparation",async t=>{
  const f=fixture(t);t.mock.method(globalThis,"fetch",()=>assert.fail("Declined setup cannot download"));let prepares=0,consents=0;
  f.registry={listGraphicsComputeHosts:()=>[{getState:()=>({available:false,backends:[],preparable:true,preparableBackends:["d3d12"]}),prepare:async()=>{++prepares;assert.fail("A declined setup cannot prepare the host");}}]};
  const binding=Xess.reserve({...f,launchId:"declined"});
  await assert.rejects(Xess.prepare({...f,xessBinding:binding,confirmRuntimeInstall:async plan=>{++consents;assert.equal(plan.managerId,Source.managerId);return false;}}),{name:"AbortError",code:"ABORT_ERR"});
  assert.equal(consents,1);assert.equal(prepares,0);assert.equal(fs.existsSync(binding.config),false);
});

test("preparation without a consent result downloads neither the XeSS runtime nor a GPU host",async t=>{
  const f=fixture(t);t.mock.method(globalThis,"fetch",()=>assert.fail("Preparation without consent cannot download"));
  const {confirmToolInstall}=require("../src/modules/shared/runtime/tool-install");let prepares=0,installs=0;
  f.registry={listGraphicsComputeHosts:()=>[{getState:()=>({available:false,backends:[],preparable:true,preparableBackends:["d3d12"]}),prepare:async(_request,context)=>{
    ++prepares;await confirmToolInstall(context,{managerId:"managed-gpu",version:"compatible",requiresDownload:true});++installs;}}]};
  const binding=Xess.reserve({...f,launchId:"unconsented"});
  await assert.rejects(Xess.prepare({...f,xessBinding:binding}),{code:"GRAPHICS_XESS_RUNTIME_MISSING"});
  assert.equal(await Library.install(f),null);assert.equal(await Library.install({...f,operation:"interpolate"}),null);assert.equal(prepares,0);
  t.mock.method(Library,"resolve",async()=>({library:"/original/libxess.dll"}));
  await assert.rejects(Xess.prepare({...f,xessBinding:binding}),{name:"AbortError"});
  assert.equal(prepares,1);assert.equal(installs,0);assert.equal(fs.existsSync(binding.config),false);
});

test("a superseded edit aborts managed-host consent before install or config publication",async t=>{
  const f=fixture(t),controller=new AbortController();t.mock.method(Library,"resolve",async()=>({library:"/original/libxess.dll"}));
  const {confirmToolInstall}=require("../src/modules/shared/runtime/tool-install");let installs=0;
  f.registry={listGraphicsComputeHosts:()=>[{getState:()=>({available:false,backends:[],preparable:true,preparableBackends:["d3d12"]}),prepare:async(_request,context)=>{
    assert.equal(context.signal,controller.signal);await confirmToolInstall(context,{managerId:"managed-gpu",version:"compatible",requiresDownload:true});++installs;assert.fail("The superseded edit cannot install");
  }}]};
  const binding=Xess.reserve({...f,launchId:"superseded"});
  await assert.rejects(Xess.prepare({...f,xessBinding:binding,signal:controller.signal,confirmRuntimeInstall:async()=>{controller.abort();return true;}}),{name:"AbortError"});
  assert.equal(installs,0);assert.equal(fs.existsSync(binding.config),false);
});

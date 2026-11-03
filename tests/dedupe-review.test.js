const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const B=require('../src/modules/shared/runtime/bundled-native'),P=require('../src/modules/shared/runtime/package-dependencies');
const {packageFor}=require('./helpers/runtime-package.cjs'),Mach=require('./fixtures/macho-image');
const base=path.resolve(__dirname,'..'),lock=async()=>async()=>{};
function root(t){const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'dedupe-review-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function createManager(value,packages){
 const fetchUrlBuffer=async()=>({status:200,body:Buffer.from(JSON.stringify({schemaVersion:2,projectId:value.record.id,updatePolicy:'manual',packages:[value.record]}))});
 const download=async(url,file)=>fs.copyFileSync([...packages.values()].find(item=>item.record.asset.url===url).archive,file);
 return require('../src/modules/shared/runtime/project-build-manager').createProjectBuildManager({projectId:value.record.id,label:value.record.id,repository:'example/runtime-builds',manifestRelative:value.record.manifestRelative,sourceRelative:null,executableRelative:'entry.js',dataOnly:true,
  verifyPayload:selected=>B.verifyPayload(selected.root,selected.declaration),dependencies:{systemVersionSync:()=> '26.0',fetchUrlBuffer,downloadToFile:download,packageDependencies:{fetchCatalog:async o=>({packages:[packages.get(o.projectId).record]}),download,acquireLock:lock}}});
}
async function installedAndroid(t){
 const dir=root(t),userDataDir=path.join(dir,'profile'),shared=await packageFor(dir,'shared-stack'),dep={project:shared.record.id,release:shared.record.version,sha256:shared.record.asset.sha256};
 const fact=shared.facts.find(item=>item.path==='lib/shared.dylib'),android=await packageFor(dir,'android',{manifestRelative:'runtime.json',dependencies:[dep],aliases:{'lib/shared.dylib':{project:dep.project,path:fact.path}},externalFacts:[fact],manifestValues:{profile:{id:'fixture',javaMajor:21,nativeLoadTarget:'maclauncher.android.bridge.GuestNativeLoader'}}});
 const packages=new Map([shared,android].map(value=>[value.record.id,value])),manager=createManager(android,packages);await manager.installRuntime({userDataDir});
 return {dir,userDataDir,shared,android,dep,packages,manager,chosen:manager.resolveSelection(null,{},userDataDir,{verification:'status'}).install};
}
test('Android dependency launches derive their profile from the installed payload and verify only off-thread',async t=>{
 t.mock.method(require('../src/modules/shared/runtime/host-capabilities'),'getHostCapabilities',()=>({platform:'darwin',hardwareArch:'arm64'}));
 const f=await installedAndroid(t),original=B.verifyPayload,calls=[];
 t.mock.method(B,'verifyPayload',(...args)=>{calls.push(args[0]);return original(...args);});
 assert.equal(f.manager.resolveSelection(null,{},f.userDataDir,{verification:'status'}).ready,true);assert.deepEqual(calls,[]);
 assert.equal(f.chosen.declaration.source.revision,f.android.record.source.revision);
 assert.deepEqual(f.chosen.sealedDeclaration,f.android.declaration);
 const Runtime=require('../src/modules/android/runtime'),Verifier=require('../src/modules/android/runtime-verifier');t.after(()=>Verifier.close());
 const options={root:f.chosen.root,platform:'darwin',arch:'arm64',macOSVersion:'26.0'};
 const result=await Runtime.resolveForLaunch(options,f.chosen.declaration);assert.equal(result.root,f.chosen.root);assert.ok(result.dependencyReadRoots.length);
 assert.deepEqual(calls,[],'The Android verifier owns full dependency hashing');
 const library=path.join(P.directory(f.userDataDir,f.dep),'files/LICENSE');fs.writeFileSync(library,Buffer.alloc(fs.statSync(library).size,7));
 await assert.rejects(Runtime.resolveForLaunch(options,f.chosen.declaration),/checksum/);assert.deepEqual(calls,[]);
});
test('background runtime inventory crosses the actual backend worker protocol with dependency packages',async t=>{
 const f=await installedAndroid(t),file=path.join(f.dir,'inventory-worker.cjs');
 fs.writeFileSync(file,`
 const {workerData}=require('node:worker_threads');
 const modulePath=${JSON.stringify(path.join(base,'src/modules/registry.js'))};
 const original=require(modulePath);
 const manager=require(${JSON.stringify(path.join(base,'src/modules/shared/runtime/project-build-manager.js'))}).createProjectBuildManager({projectId:'android',label:'Android fixture',repository:'example/runtime-builds',manifestRelative:'runtime.json',sourceRelative:null,executableRelative:'entry.js',dataOnly:true,verifyPayload:()=>{throw new Error('Inventory must not verify payloads');},dependencies:{systemVersionSync:()=> '26.0'}});
 const info={id:'fixture'};
 require.cache[modulePath].exports={...original,listModuleIds:()=>['fixture'],listModules:()=>[info],getModule:()=>({runtimeManagers:[manager]}),getModuleInfo:()=>info,getModuleDir:()=>workerData.userDataDir,listSharedRuntimeManagers:()=>[],getRuntimeManagerUi:()=>null};
 require(${JSON.stringify(path.join(base,'src/core/backend-worker.js'))});
 `);
 const {BackendWorkerClient}=require('../src/core/backend-worker-client'),client=new BackendWorkerClient({workerPath:file,workerData:{userDataDir:f.userDataDir}}),events=[];
 client.on('event',(event,payload)=>{events.push({event,payload});});t.after(()=>client.close());
 assert.equal(await client.request('runtimeStates',{runtimes:{}},['android']),true);
 const state=events.find(item=>item.event==='runtimeState')?.payload.state;assert.ok(state);assert.equal(state.installed[0].ready,true);
 assert.equal(JSON.stringify(state).includes('could not be cloned'),false);assert.doesNotThrow(()=>structuredClone(state));
});
test('reinstallation repairs a corrupt shared package even while an installed consumer retains it',async t=>{
 const f=await installedAndroid(t),directory=P.directory(f.userDataDir,f.dep),file=path.join(directory,'files/lib/shared.dylib');fs.writeFileSync(file,'damaged');
 const retained=path.join(f.userDataDir,'runtimes/retaining-consumer/1.0');fs.mkdirSync(retained,{recursive:true});fs.writeFileSync(path.join(retained,'runtime.json'),JSON.stringify({catalogEntry:{projectPackage:{dependencies:[f.dep]}}}));
 await f.manager.uninstallRuntime({userDataDir:f.userDataDir,version:'1.0.0'});assert.equal(fs.existsSync(directory),true);
 await f.manager.installRuntime({userDataDir:f.userDataDir});
 const reopened=f.manager.resolveSelection(null,{},f.userDataDir).install;
 assert.equal(B.verifyPayload(reopened.root,reopened.declaration),true);assert.equal(fs.existsSync(directory),true);

});
test('dependency collection is nonblocking and retires interrupted stages through guarded trash',async t=>{
 const dir=root(t),userDataDir=path.join(dir,'profile'),parent=path.join(userDataDir,'runtimes/.dependencies/example/1.0');fs.mkdirSync(parent,{recursive:true});
 const stage=path.join(parent,'.install-Ab12Cd');fs.mkdirSync(stage);fs.writeFileSync(path.join(stage,'partial'),'owned partial');fs.writeFileSync(stage+'.tar.gz','owned archive');
 let settings;assert.deepEqual(await P.collect(userDataDir,{acquireLock:async(file,options)=>{settings=options;return null;}}),{skipped:'busy'});assert.equal(settings.wait,false);assert.ok(fs.existsSync(stage));
 await P.collect(userDataDir,{acquireLock:lock});assert.deepEqual(fs.readdirSync(parent),[]);
});
test('an aliased dependency still exposes its nested unaliased loader dependencies',()=>{
 const leaf={record:{id:'leaf',version:'1.0',asset:{sha256:'b'.repeat(64)}},root:'/owned/leaf',declaration:{files:[{path:'lib/leaf.dylib'}]},children:new Map()};
 const parent={record:{id:'parent',version:'1.0',asset:{sha256:'a'.repeat(64)}},root:'/owned/parent',declaration:{files:[{path:'lib/parent.dylib'}]},children:new Map([['leaf',leaf]])};
 assert.deepEqual(P.loaderPaths({aliases:{schema:1,files:{'parent.dylib':{project:'parent',path:'lib/parent.dylib'}}}},new Map([['parent',parent]])),['/owned/leaf/lib']);
});
function nativeFixture(directory,{wrapperRole='x86_64',launchers=['arm64','x64']}={}){
 const payload=path.join(directory,'files'),files=[];fs.mkdirSync(payload,{recursive:true});
 for(const [name,bytes,mode]of [['bin/host',Mach.image({cpu:Mach.X64,fileType:2}),0o755],['lib/child.dylib',Mach.image({cpu:Mach.X64}),0o755],['LICENSE',Buffer.from('retained notice'),0o644]]){
  const file=path.join(payload,'files',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{mode});files.push({path:name,size:bytes.length,sha256:B.digest(bytes),mode,...(name!=='LICENSE'?{architectures:['x86_64']}:{} )});
 }
 const manifest={schemaVersion:1,managerId:'fixture-native',version:'1.0',arch:'x64',platform:'darwin',minimumMacOS:'13.0',executableRelative:'bin/host',files,dependencies:[],upstreamRevision:'a'.repeat(40),provenance:{sourceRevision:'a'.repeat(40)},notices:[{name:'Owned fixture',license:'MIT',sourceUrl:'https://example.com/source',path:'LICENSE'}]};
 const bytes=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(path.join(payload,'manifest.json'),bytes);
 const filename='fixture-native-1.0-x64.tar.gz',tag='fixture-native/v1.0/x64',record={schemaVersion:2,id:'fixture-native',version:'1.0',arch:'x64',launcherArchitectures:launchers,minimumMacOS:'13.0',manifestRelative:'manifest.json',manifestSha256:B.digest(bytes),sourceSha256:B.digest(bytes),source:{repository:'example/source',revision:'b'.repeat(40)},updatePolicy:'manual',tag,asset:{filename,sha256:'c'.repeat(64),bytes:1,url:'https://github.com/example/runtime-builds/releases/download/'+encodeURIComponent(tag)+'/'+filename}};
 const wrapper={...record,files:[...files.map(file=>({...file,path:'files/'+file.path,...(file.architectures&&wrapperRole!==undefined?{executionArchitecture:wrapperRole}:{})})),{path:'manifest.json',sha256:B.digest(bytes),size:bytes.length,mode:0o644}]};
 const write=()=>fs.writeFileSync(path.join(directory,'runtime-package.json'),JSON.stringify(wrapper));write();return{payload,manifest,record,wrapper,write,pin:{version:'1.0',upstreamRevision:record.source.revision,projectPackage:record}};
}
test('manager-only native checks preserve record fields, derive child roles only for child managers, and keep original inventory errors',async t=>{
 const dir=root(t),{createProjectNativePackage}=require('../src/modules/shared/runtime/project-native-package');
 const create=nativeLibrary=>createProjectNativePackage({projectId:'fixture-native',repository:'example/runtime-builds'},{id:'fixture-native',catalog:[],nativeLibrary,dependencies:{verifySignatures:async()=>{}}});
 const f=nativeFixture(path.join(dir,'valid'));await create(false).prepare({unpacked:path.dirname(f.payload),pin:f.pin});
 let passes=0;const original=B.verifyPayload;t.mock.method(B,'verifyPayload',(...args)=>{passes++;return original(...args);});
 const selected=create(false).inspectInstalled(path.dirname(f.payload),f.pin,{verification:'status'});assert.equal(passes,0);assert.equal(selected.declaration.source.revision,f.record.source.revision);assert.ok(selected.declaration.files.filter(x=>x.architectures).every(x=>x.executionArchitecture==='x86_64'));
 create(false).inspectInstalled(path.dirname(f.payload),f.pin,{verification:'full'});assert.equal(passes,1);
 const legacy=nativeFixture(path.join(dir,'legacy-source'));delete legacy.record.source;await create(false).prepare({unpacked:path.dirname(legacy.payload),pin:legacy.pin});assert.equal(create(false).inspectInstalled(path.dirname(legacy.payload),legacy.pin,{verification:'status'}).declaration.source,undefined);
 const library=nativeFixture(path.join(dir,'library'));await assert.rejects(create(true).prepare({unpacked:path.dirname(library.payload),pin:library.pin}),/inventory differs/);
 for(const role of ['arm64','x64','',null]){const bad=nativeFixture(path.join(dir,'role-'+String(role)),{wrapperRole:role});await assert.rejects(create(false).prepare({unpacked:path.dirname(bad.payload),pin:bad.pin}),/inventory differs/);}
 const mismatch=nativeFixture(path.join(dir,'mismatch'));mismatch.wrapper.files[0].size++;mismatch.write();await assert.rejects(create(false).prepare({unpacked:path.dirname(mismatch.payload),pin:mismatch.pin}),/inventory differs/);
});
test('local Mach-O aliases share an inode and cross-directory aliases preserve load-command resolution',t=>{
 const dir=root(t);
 function prepare(name,dependency,alias){const root=path.join(dir,name);fs.mkdirSync(path.join(root,'lib'),{recursive:true});fs.mkdirSync(path.join(root,'shared'));
  const images=[['lib/canonical.dylib',Mach.image({dependencies:[dependency],installName:'@rpath/canonical.dylib'})],['shared/dep.dylib',Mach.image({dependencies:[]})]],files=[];
  for(const [file,bytes]of images){fs.writeFileSync(path.join(root,file),bytes);files.push({path:file,size:bytes.length,mode:0o644,sha256:B.digest(bytes),architectures:['arm64']});}
  return{root,declaration:{files,aliases:{schema:1,files:{[alias]:'lib/canonical.dylib'}}},alias};}
 for(const [name,dependency,alias]of [['same','@loader_path/dep.dylib','lib/alias.dylib'],['safe','@loader_path/../shared/dep.dylib','other/alias.dylib']]){
  const f=prepare(name,dependency,alias);assert.equal(B.verifyStoredPayload(f.root,f.declaration),true);P.materialize(f.root,f.declaration);
  const file=path.join(f.root,alias),target=path.join(f.root,'lib/canonical.dylib');assert.equal(fs.lstatSync(file).isSymbolicLink(),true);assert.equal(fs.statSync(file).ino,fs.statSync(target).ino);assert.equal(B.verifyPayload(f.root,f.declaration),true);
  fs.unlinkSync(file);fs.symlinkSync(path.join(f.root,'shared/dep.dylib'),file);assert.throws(()=>B.verifyPayload(f.root,f.declaration),/canonical/);
 }
 const unsafe=prepare('unsafe','@loader_path/dep.dylib','other/alias.dylib');assert.throws(()=>P.materialize(unsafe.root,unsafe.declaration),/Cross-directory Mach-O alias changes load-command resolution/);
});
test('upkeep retires obsolete internal tool copies without touching other profile files',async t=>{
 const dir=root(t),owned=path.join(dir,'internal-tools/tool', 'a'.repeat(64)),other=path.join(dir,'internal-tools/tool/user-files');fs.mkdirSync(owned,{recursive:true});fs.mkdirSync(other);fs.writeFileSync(path.join(owned,'tool.jar'),'old jar');fs.writeFileSync(path.join(other,'keep'),'keep');
 const ago=new Date(Date.now()-2*3600000);fs.utimesSync(owned,ago,ago);
 const store=require('../src/core/derived-stores').find(x=>x.id==='obsolete-internal-tool-copies');const result=await require('../src/core/storage-maintenance').maintainStorage({userDataDir:dir,stores:[store]});assert.equal(result.removed,1);assert.equal(fs.existsSync(owned),false);assert.ok(fs.existsSync(other));
});
test('launcher bundle trust excludes downloaded apps and collapse preserves Mach-O locations and signing boundaries',async t=>{
 const dir=root(t),app=path.join(dir,'MacLauncher.app'),resources=path.join(app,'Contents/Resources');fs.mkdirSync(resources,{recursive:true});
 const bytes=Buffer.from('PK\x03\x04shared agent'),stored=path.join(resources,'native-runtimes/z/steam-agent.jar'),other=path.join(resources,'app.asar.unpacked/agent.jar');
 for(const file of [stored,other]){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);}
 const native=Mach.image(),a=path.join(resources,'one.dylib'),b=path.join(resources,'two.dylib');fs.writeFileSync(a,native);fs.writeFileSync(b,native);
 assert.deepEqual(require('../scripts/app-deduplication.cjs').collapse(app),{aliases:1,bytesRemoved:bytes.length});assert.equal(fs.lstatSync(stored).isFile(),true);assert.equal(fs.lstatSync(other).isSymbolicLink(),true);assert.ok(fs.lstatSync(a).isFile()&&fs.lstatSync(b).isFile());
 assert.equal(B.appAlias(other),null);assert.equal(B.withAppBundle(app,()=>B.appAlias(other)),stored);
 const guest=path.join(dir,'profile/runtimes/game/Guest.app/Contents/Resources');fs.mkdirSync(guest,{recursive:true});fs.writeFileSync(path.join(guest,'canonical.jar'),bytes);fs.symlinkSync('canonical.jar',path.join(guest,'alias.jar'));
 assert.equal(B.appAlias(path.join(guest,'alias.jar')),null);assert.equal(B.withAppBundle(app,()=>B.appAlias(path.join(guest,'alias.jar'))),null);
 const Verifier=require('../src/modules/android/runtime-verifier');t.after(()=>Verifier.close());
 await assert.rejects(Verifier.verifyPayload(guest,{files:['canonical.jar','alias.jar'].map(name=>({path:name,size:bytes.length,sha256:B.digest(bytes),mode:0o644}))}),/symlinks/);
});
test('the Java Steam status branch accepts its collapsed 1.9.0 agent only inside the launcher bundle',t=>{
 const dir=root(t),app=path.join(dir,'MacLauncher.app'),resources=path.join(app,'Contents/Resources'),Runtime=require('../src/modules/java/runtime/steamworks/runtime');
 const pin={...Runtime.Catalog.find(item=>item.version==='1.9.0')};assert.ok(pin.version);
 const directory=path.join(resources,'native-runtimes/java-steamworks',pin.bridgeVersion,'universal');fs.mkdirSync(directory,{recursive:true});
 const native=Mach.image({cpu:Mach.X64}),agent=Buffer.from('PK\x03\x04retained source agent');pin.jniSha256=B.digest(native);pin.jniSize=native.length;pin.agentSha256=B.digest(agent);
 fs.writeFileSync(path.join(directory,'libsteamworks4j.dylib'),native);fs.writeFileSync(path.join(directory,'steam-agent.jar'),agent);
 const outer={id:'java-steamworks',version:pin.bridgeVersion,wrapperVersion:pin.version,sourceRevision:pin.sourceRevision,librarySha256:pin.jniSha256,abiProfile:pin.abiProfile,agentSha256:pin.agentSha256,agentClassMajor:52};
 const manifest=Buffer.from(JSON.stringify(outer));fs.writeFileSync(path.join(directory,'helper.json'),manifest);
 const canonical=path.join(resources,'native-runtimes/aaa/steam-agent.jar');fs.mkdirSync(path.dirname(canonical),{recursive:true});fs.writeFileSync(canonical,agent);require('../scripts/app-deduplication.cjs').collapse(app);
 const declaration={id:'java-steamworks',version:pin.bridgeVersion,arch:'universal',launcherArchitectures:['arm64','x64'],directoryRelative:path.relative(path.join(resources,'native-runtimes'),directory),manifestRelative:'helper.json',manifestSha256:B.digest(manifest)};
 assert.equal(B.withAppBundle(app,()=>Runtime.resolveBundle(pin,{resourcesRoot:resources,declarations:[declaration],verification:'status'})).ready,true);
 assert.throws(()=>Runtime.resolveBundle(pin,{resourcesRoot:resources,declarations:[declaration],verification:'status'}),/files are invalid/);
});
test('included status stays metadata-only and full resolution verifies each payload once',async t=>{
 const dir=root(t),app=path.join(dir,'MacLauncher.app'),resources=path.join(app,'Contents/Resources'),native=path.join(resources,'native-runtimes'),shared=await packageFor(dir,'shared-stack'),dep={project:shared.record.id,release:shared.record.version,sha256:shared.record.asset.sha256};
 const consumer=await packageFor(dir,'consumer',{dependencies:[dep]});fs.mkdirSync(path.join(native,'.declarations'),{recursive:true});
 const R=require('../scripts/runtime-packages.cjs');for(const item of [shared,consumer]){const output=path.join(native,item.declaration.directoryRelative);fs.mkdirSync(output,{recursive:true});await R.extractPackage(item.archive,output,item.record);fs.writeFileSync(path.join(native,'.declarations',item.record.asset.sha256+'.json'),item.outer);}
 fs.writeFileSync(path.join(resources,'runtime-packages.json'),JSON.stringify({packages:[shared.record,consumer.record]}));
 const original=B.verifyPayload,calls=[];t.mock.method(B,'verifyPayload',(...args)=>{calls.push(args[0]);return original(...args);});
 const I=require('../src/modules/shared/runtime/included-helpers');I.resolveIncluded([consumer.declaration],{id:'consumer',resourcesRoot:resources,verification:'status'});assert.deepEqual(calls,[]);
 I.inspectIncluded([consumer.declaration],{id:'consumer',resourcesRoot:resources,verification:'full',dataOnly:true,executableRelative:'entry.js'});
 assert.equal(calls.filter(file=>file===path.join(native,shared.declaration.directoryRelative)).length,1);assert.equal(calls.filter(file=>file===path.join(native,consumer.declaration.directoryRelative)).length,1);
 assert.equal(B.withAppBundle(app,()=>B.verifyPayload(path.join(native,consumer.declaration.directoryRelative),structuredClone(consumer.declaration))),true,'An included verifier can recover the exact context after a clone boundary');
});
test('cross-directory local aliases compare RPATH expansion and executable-relative loads for every slice',t=>{
 const dir=root(t);let sequence=0;
 function run({dependencies,runPaths=[],fileType=6,cpu=Mach.ARM64}){
  const root=path.join(dir,String(sequence++));for(const name of ['lib','other','shared'])fs.mkdirSync(path.join(root,name),{recursive:true});
  const bytes=Mach.image({dependencies,runPaths,fileType,cpu}),file='lib/canonical.dylib';fs.writeFileSync(path.join(root,file),bytes);
  const declaration={files:[{path:file,size:bytes.length,sha256:B.digest(bytes),mode:0o644,architectures:[cpu===Mach.X64?'x86_64':'arm64']}],aliases:{schema:1,files:{'other/alias.dylib':file}}};
  P.materialize(root,declaration);return root;
 }
 assert.doesNotThrow(()=>run({dependencies:['@rpath/dep.dylib'],runPaths:['@loader_path/../shared']}));
 assert.throws(()=>run({dependencies:['@rpath/dep.dylib'],runPaths:['@loader_path']}),/Cross-directory Mach-O alias changes load-command resolution/);
 assert.throws(()=>run({dependencies:['@executable_path/dep.dylib'],fileType:2}),/Cross-directory Mach-O alias changes load-command resolution/);
 assert.doesNotThrow(()=>run({dependencies:['/usr/lib/libSystem.B.dylib'],cpu:Mach.X64}));
});

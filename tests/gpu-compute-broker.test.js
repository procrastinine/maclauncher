const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const Broker=require("../src/modules/shared/runtime/gpu-compute-broker"),Sandbox=require("../src/modules/shared/runtime/macos-sandbox"),Writable=require("../src/modules/shared/writable-input");
const until=async predicate=>{const deadline=Date.now()+3000;for(;;){try{const value=predicate();if(value)return value;}catch{}if(Date.now()>deadline)throw Error("The GPU compute receipt did not arrive.");await new Promise(resolve=>setTimeout(resolve,20));}};
test("the compute broker uses private prepared programs and authenticates its own child before publishing a receipt",async t=>{
  const userDataDir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"gpu-broker-")));let binding;
  t.after(()=>{try{if(binding)Broker.release(binding);}finally{fs.rmSync(userDataDir,{recursive:true,force:true});}});
  binding={...Broker.reserve({userDataDir,launchId:"test-launch"}),namespace:"org.maclauncher.xess.test."};
  const script=path.join(userDataDir,"owned-host.cjs");fs.writeFileSync(script,'process.stdout.write("MACLAUNCHER_XESS_HELPER "+JSON.stringify({pid:process.pid,token:process.argv.at(-1)})+"\\n");setInterval(()=>{},1000);');
  const original=Sandbox.isolateComputeHost;let requests=[];Sandbox.isolateComputeHost=async(config,context)=>{requests.push(context.endpoint);return {executable:config.executable,args:config.arguments,environment:{PATH:"/usr/bin:/bin"}};};t.after(()=>{if(original)Sandbox.isolateComputeHost=original;else delete Sandbox.isolateComputeHost;});
  const config={executable:process.execPath,arguments:[script],hostPath:"/trusted/helper.exe",originalLibrary:"/trusted/original.dll",environment:{}};
  Broker.register(binding,config);config.executable="/untrusted/replacement";
  Broker.bind(binding,process.pid);
  const requestId=crypto.randomUUID(),endpoint=binding.namespace+requestId;
  Writable.atomicWrite(path.join(binding.requestRoot,requestId+".request.json"),JSON.stringify({schema:1,requestId,endpoint}),{root:userDataDir});
  const file=path.join(binding.receiptRoot,requestId+".receipt.json"),receipt=await until(()=>{const row=JSON.parse(fs.readFileSync(file));assert.equal(row.error,undefined);return row;});
  assert.equal(receipt.requestId,requestId);assert.match(receipt.hostToken,/^[a-f0-9]{64}$/);assert.equal(receipt.helperPID,receipt.launcherPID);assert.notEqual(receipt.helperPID,process.pid);assert.deepEqual(requests,[endpoint]);assert.equal(fs.existsSync(path.join(binding.requestRoot,requestId+".request.json")),false);
  const rejected=crypto.randomUUID();Writable.atomicWrite(path.join(binding.requestRoot,rejected+".request.json"),JSON.stringify({schema:1,requestId:rejected,endpoint:binding.namespace+rejected,executable:"/untrusted/program"}),{root:userDataDir});
  const invalid=await until(()=>JSON.parse(fs.readFileSync(path.join(binding.receiptRoot,rejected+".receipt.json"))));assert.match(invalid.error,/Invalid GPU compute endpoint/);assert.equal(requests.length,1);
  Writable.atomicWrite(path.join(binding.requestRoot,requestId+".stop.json"),JSON.stringify({schema:1,requestId}),{root:userDataDir});await until(()=>{try{process.kill(receipt.helperPID,0);return false;}catch{return true;}});
});

test("backend selection is isolated while another backend is being prepared",async t=>{
  const userDataDir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"gpu-broker-backends-")));let binding;
  t.after(()=>{try{if(binding)Broker.release(binding);}finally{fs.rmSync(userDataDir,{recursive:true,force:true});}});
  binding={...Broker.reserve({userDataDir,launchId:"two-backends"}),namespace:"org.maclauncher.xess.test."};
  const script=path.join(userDataDir,"owned-host.cjs");
  fs.writeFileSync(script,'require("fs").writeFileSync(process.env.RECORD_DIR+"/"+process.argv[2].split("/").at(-1)+".json",JSON.stringify(process.argv.slice(2,-1)));process.stdout.write("MACLAUNCHER_XESS_HELPER "+JSON.stringify({pid:process.pid,token:process.argv.at(-1)})+"\\n");setInterval(()=>{},1000);');
  let releasePolicy,startedPolicy;
  const started=new Promise(resolve=>{startedPolicy=resolve}),waiting=new Promise(resolve=>{releasePolicy=resolve}),launches=[];
  t.mock.method(Sandbox,"isolateComputeHost",async config=>{
    launches.push(config.hostPath);
    if(config.hostPath==="/trusted/d3d12.exe"){startedPolicy();await waiting;}
    return {executable:config.executable,args:config.arguments,environment:{PATH:"/usr/bin:/bin",RECORD_DIR:userDataDir}};
  });
  const config=backend=>({executable:process.execPath,arguments:[script],hostPath:"/trusted/"+backend+".exe",originalLibrary:"/trusted/original.dll",environment:{}});
  Broker.register(binding,config("d3d12"),{backend:"d3d12"});
  Broker.register(binding,config("vulkan"),{backend:"vulkan"});
  Broker.bind(binding,process.pid);
  const request=(backend,operation)=>{const requestId=crypto.randomUUID();Writable.atomicWrite(path.join(binding.requestRoot,requestId+".request.json"),JSON.stringify({schema:1,requestId,endpoint:binding.namespace+requestId,backend,...(operation?{operation}:{})}),{root:userDataDir});return requestId;};
  const read=id=>JSON.parse(fs.readFileSync(path.join(binding.receiptRoot,id+".receipt.json")));
  const d3d=request("d3d12");await started;
  Broker.register(binding,{...config("vulkan"),hostPath:"/trusted/vulkan-updated.exe"},{backend:"vulkan"});
  const table=Broker.register(binding,{...config("d3d12-fg"),originalLibrary:"/trusted/fg.dll",originalLibraries:["/trusted/fg.dll","/trusted/xell.dll"]},{backend:"d3d12",operation:"interpolate"});
  assert.equal(table.defaultBackend,"d3d12");
  assert.equal(table.hosts.d3d12.hostPath,"/trusted/d3d12.exe");
  releasePolicy();
  const first=await until(()=>read(d3d));
  assert.equal(first.error,undefined);assert.equal(first.backend,"d3d12");
  const requestedVulkan=request("vulkan"),second=await until(()=>read(requestedVulkan));
  assert.equal(second.error,undefined);assert.equal(second.backend,"vulkan");
  assert.notEqual(second.helperPID,first.helperPID);
  const requestedFG=request("d3d12","interpolate"),generated=await until(()=>read(requestedFG));
  assert.equal(generated.error,undefined);assert.equal(generated.backend,"d3d12");assert.equal(generated.operation,"interpolate");
  assert.notEqual(generated.helperPID,first.helperPID);
  const argumentsForFG=JSON.parse(fs.readFileSync(path.join(userDataDir,"d3d12-fg.exe.json")));
  assert.deepEqual(argumentsForFG,["/trusted/d3d12-fg.exe",binding.namespace+requestedFG,"/trusted/fg.dll","/trusted/xell.dll"]);
  const unsupported=request("metal"),rejected=await until(()=>read(unsupported));
  assert.match(rejected.error,/route is invalid/);
  assert.deepEqual(launches,["/trusted/d3d12.exe","/trusted/vulkan-updated.exe","/trusted/d3d12-fg.exe"]);
});

test("a live registration in another realm serves its route once while the launch realm keeps its other routes",async t=>{
  const userDataDir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"gpu-broker-realms-")));let binding,Live;
  t.after(()=>{try{if(binding)Broker.release(binding);}finally{try{if(binding)Live?.release(binding);}finally{fs.rmSync(userDataDir,{recursive:true,force:true});}}});
  binding={...Broker.reserve({userDataDir,launchId:"two-realms"}),namespace:"org.maclauncher.xess.realms.",config:path.join(userDataDir,"xess-host.json")};
  // The backend worker and main each load their own module instance.
  const id=require.resolve("../src/modules/shared/runtime/gpu-compute-broker"),cached=require.cache[id];delete require.cache[id];
  try{Live=require(id);}finally{require.cache[id]=cached;}
  const script=path.join(userDataDir,"owned-host.cjs");
  fs.writeFileSync(script,'process.stdout.write("MACLAUNCHER_XESS_HELPER "+JSON.stringify({pid:process.pid,token:process.argv.at(-1)})+"\\n");setInterval(()=>{},1000);');
  const launches=[];
  t.mock.method(Sandbox,"isolateComputeHost",async config=>{launches.push(config.hostPath);return {executable:config.executable,args:config.arguments,environment:{PATH:"/usr/bin:/bin"}};});
  const config=name=>({executable:process.execPath,arguments:[script],hostPath:"/trusted/"+name+".exe",originalLibrary:"/trusted/original.dll",environment:{}});
  Broker.register(binding,config("launch-d3d12"),{backend:"d3d12"});
  Broker.register(binding,config("launch-fg"),{backend:"d3d12",operation:"interpolate"});
  Broker.bind(binding,process.pid);
  const table=Live.register(binding,config("live-d3d12"),{backend:"d3d12"});Live.bind(binding,process.pid);
  assert.equal(table.hosts.d3d12.hostPath,"/trusted/live-d3d12.exe");
  assert.equal(table.hosts["d3d12-fg"].hostPath,"/trusted/launch-fg.exe","the launch realm's other routes stay listed");
  assert.deepEqual(JSON.parse(fs.readFileSync(binding.config,"utf8")),table);
  const request=(backend,operation)=>{const requestId=crypto.randomUUID();Writable.atomicWrite(path.join(binding.requestRoot,requestId+".request.json"),JSON.stringify({schema:1,requestId,endpoint:binding.namespace+requestId,backend,...(operation?{operation}:{})}),{root:userDataDir});return requestId;};
  const read=id=>JSON.parse(fs.readFileSync(path.join(binding.receiptRoot,id+".receipt.json")));
  const live=request("d3d12"),served=await until(()=>read(live));assert.equal(served.error,undefined);
  const generation=request("d3d12","interpolate"),generated=await until(()=>read(generation));assert.equal(generated.error,undefined);
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.deepEqual(launches,["/trusted/live-d3d12.exe","/trusted/launch-fg.exe"]);
});

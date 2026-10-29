// Copyright (c) MacLauncher contributors. MIT license.
// Setup messages only. GPU images and synchronization stay in native IPC.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),{spawn}=require("node:child_process");
const Writable=require("../writable-input");
const {watchDirectory}=require("../../../core/watch-files");
const sessions=new Map(),uuid=/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
function reserve({userDataDir,launchId}){
  if(typeof launchId!=="string"||!launchId)throw Error("The GPU compute launch identity is unavailable.");
  const root=path.join(userDataDir,"graphics/compute-sessions",crypto.createHash("sha256").update(launchId).digest("hex"));
  for(const name of ["requests","receipts"])Writable.assertOwnDirectory(userDataDir,path.join(root,name));
  return {userDataDir,requestRoot:path.join(root,"requests"),receiptRoot:path.join(root,"receipts")};
}
function session(binding){
  const key=binding.requestRoot;let value=sessions.get(key);
  if(!value){value={...binding,configs:new Map(),pid:null,children:new Map(),pending:new Set(),watcher:null,timer:null,demanded:false};sessions.set(key,value);}
  if(value.receiptRoot!==binding.receiptRoot||value.namespace!==binding.namespace)throw Error("The GPU compute receipt binding changed.");
  return value;
}
function routeKey(backend,operation="superresolution"){
  if(!["d3d12","vulkan"].includes(backend)||!["superresolution","interpolate"].includes(operation))throw Error("The GPU compute route is invalid.");
  return backend+(operation==="interpolate"?"-fg":"");
}
function register(binding,prepared,{backend="d3d12",operation="superresolution"}={}){
  const value=session(binding);
  const key=routeKey(backend,operation);
  // The prepared module object is the authority. Files writable by a game
  // cannot choose a program, a library, an environment or a runtime prefix.
  const config=structuredClone(prepared);
  if(!path.isAbsolute(config.executable||"")||!path.isAbsolute(config.hostPath||"")||!path.isAbsolute(config.originalLibrary||"")||!Array.isArray(config.arguments)||config.arguments.some(arg=>typeof arg!=="string"||/[\0]/.test(arg))||!config.environment||typeof config.environment!=="object")throw Error("The GPU compute launch configuration is invalid.");
  if(config.originalLibraries!==undefined&&(!Array.isArray(config.originalLibraries)||!config.originalLibraries.length||config.originalLibraries.length>16||config.originalLibraries.some(file=>typeof file!=="string"||!path.isAbsolute(file)||file.includes("\0"))))throw Error("The GPU compute library arguments are invalid.");
  value.configs.set(key,config);value.demanded=true;
  // Launch preparation and live edits register in separate realms, each with
  // its own session. The written table of the launch (its namespace) keeps
  // the routes of the other realm and names the latest registration of each
  // route; only the session holding that registration serves the route
  // (`registered`). The table never chooses what a session runs.
  const hosts={...Object.fromEntries(value.configs),...written(value)?.hosts,[key]:config};
  const keys=["d3d12","vulkan","d3d12-fg","vulkan-fg"].filter(key=>hosts[key]),defaultBackend=keys[0].replace(/-fg$/,"");
  const legacy=hosts[keys.find(key=>!key.endsWith("-fg"))];
  const table={...(legacy?structuredClone(legacy):{}),schema:1,...(value.namespace?{namespace:value.namespace}:{}),defaultBackend,hosts:Object.fromEntries(keys.map(key=>[key,structuredClone(hosts[key])]))};
  if(value.config)Writable.atomicWrite(value.config,JSON.stringify(table),{root:value.userDataDir});
  if(value.pid){watch(value);scan(value).catch(()=>{});}
  return table;
}
function written(value){
  try{const table=value.config&&JSON.parse(fs.readFileSync(value.config,"utf8"));return table?.schema===1&&table.namespace===value.namespace&&table.hosts&&typeof table.hosts==="object"?table:null;}catch{return null;}
}
function registered(value,key,config){
  const table=written(value);
  return !table||JSON.stringify(table.hosts[key])===JSON.stringify(config);
}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
function receipt(value,id,data){Writable.atomicWrite(path.join(value.receiptRoot,id+".receipt.json"),JSON.stringify({schema:1,requestId:id,...data}),{root:value.userDataDir});}
function stop(value,id){
  const owned=value.children.get(id);if(!owned)return;
  value.children.delete(id);owned.closing=true;
  owned.child.stdout?.destroy();owned.child.stderr?.destroy();
  // Only the broker's own ChildProcess is signalled. Runtime servers and
  // helpers belonging to other graphics sessions are never enumerated.
  if(owned.child?.exitCode===null&&!owned.child.killed)owned.child.kill("SIGTERM");
}
async function readRequest(value,name){
  const file=path.join(value.requestRoot,name),stat=await fs.promises.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error("Invalid GPU compute request.");
  const handle=await fs.promises.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{return JSON.parse(await handle.readFile("utf8"));}finally{await handle.close();}
}
async function launch(value,id,request){
  if(value.pending.has(id)||value.children.has(id))return;
  value.pending.add(id);
  try{
    if(!value.pid||!alive(value.pid)||!value.configs.size)return;
    // A request is claimed once, by the session holding the latest
    // registration of its route; another session leaves it in place.
    const operation=request.operation||"superresolution";let key,config;
    try{key=routeKey(request.backend||["d3d12","vulkan"].find(key=>value.configs.has(routeKey(key,operation))),operation);config=value.configs.get(key);}catch{}
    if(key&&!registered(value,key,config))return;
    const claimed=path.join(value.requestRoot,id+".claimed.json");
    try{await fs.promises.rename(path.join(value.requestRoot,id+".request.json"),claimed);}catch(error){if(error.code==="ENOENT")return;throw error;}
    await fs.promises.rm(claimed,{force:true});
    if(request.schema!==1||request.requestId!==id||request.endpoint!==value.namespace+id||Object.keys(request).some(key=>!["schema","requestId","endpoint","backend","operation"].includes(key)))throw Error("Invalid GPU compute endpoint.");
    if(value.children.size>=32)throw Error("The GPU compute setup queue is full.");
    if(!config)throw Error(key?"The requested GPU compute backend is not prepared.":"The GPU compute route is invalid.");
    const backend=key.replace(/-fg$/,"");
    const token=crypto.randomBytes(32).toString("hex");
    const policy=await require("./macos-sandbox").isolateComputeHost(config,{...value,endpoint:request.endpoint});
    if(!value.pid||!alive(value.pid)||value.configs.get(key)!==config)return;
    const child=spawn(policy.executable,[...policy.args,config.hostPath,request.endpoint,...(config.originalLibraries||[config.originalLibrary]),token],{env:policy.environment,stdio:["ignore","pipe","pipe"],windowsHide:true});
    const owned={child,closing:false,authenticated:false};value.children.set(id,owned);
    let output="",diagnostics="";
    const timeout=setTimeout(()=>{if(!owned.authenticated){receipt(value,id,{error:"The GPU compute host did not authenticate."});stop(value,id);}},30000);timeout.unref?.();
    child.stdout.on("data",chunk=>{
      if(owned.closing||owned.authenticated)return;
      output+=chunk.toString("utf8");if(output.length>16384){stop(value,id);return;}
      for(;;){const end=output.indexOf("\n");if(end<0)break;const line=output.slice(0,end).trim();output=output.slice(end+1);if(!line.startsWith("MACLAUNCHER_XESS_HELPER "))continue;
        try{const hello=JSON.parse(line.slice(24));if(hello.token!==token||!Number.isSafeInteger(hello.pid)||hello.pid<2)throw Error("Invalid GPU host identity.");
          owned.authenticated=true;clearTimeout(timeout);receipt(value,id,{helperPID:hello.pid,hostToken:token,launcherPID:child.pid,backend,operation});
        }catch{receipt(value,id,{error:"The GPU compute host identity is invalid."});stop(value,id);}break;
      }
    });
    // Setup failures retain a bounded diagnostic tail for contextual details.
    child.stderr.on("data",chunk=>{diagnostics=(diagnostics+chunk.toString("utf8")).slice(-4096);});
    const finished=(error,exitCode=null,signal=null)=>{if(owned.finished)return;owned.finished=true;clearTimeout(timeout);if(!owned.closing)receipt(value,id,{error:error?.message||"The GPU compute host closed.",exitCode,signal,...(diagnostics?{details:diagnostics}:{})});child.stdout?.destroy();child.stderr?.destroy();if(value.children.get(id)===owned)value.children.delete(id);};
    child.once("error",finished);child.once("close",(code,signal)=>finished(null,code,signal));child.unref();
  }catch(error){receipt(value,id,{error:error.message});}finally{value.pending.delete(id);}
}
async function scan(value){
  if(value.scanning||!value.pid)return;value.scanning=true;
  try{
    for(const name of await fs.promises.readdir(value.requestRoot)){
      const match=/^(.+)\.(request|stop)\.json$/.exec(name);if(!match||!uuid.test(match[1]))continue;
      const [,id,kind]=match;
      try{const request=await readRequest(value,name);if(kind==="stop"){if(request.schema===1&&request.requestId===id)stop(value,id);}else await launch(value,id,request);}catch{}
    }
  }finally{value.scanning=false;}
}
// The request watcher and the 1 Hz liveness check run only while an enabled
// XeSS row is prepared for the bound game, or one of its hosts still runs.
function watch(value){
  if(value.watcher||!value.pid)return;
  const pid=value.pid;
  // A failed request watcher is armed again and rescans; it never ends the session.
  value.watcher=watchDirectory(value.requestRoot,()=>{scan(value).catch(()=>{});},{persistent:false});
  value.timer=setInterval(()=>{if(!alive(pid))release(value);else if(!value.demanded&&!value.children.size&&!value.pending.size)idle(value);},1000);value.timer.unref();
}
function idle(value){value.watcher?.close();clearInterval(value.timer);value.watcher=null;value.timer=null;}
function bind(binding,pid){
  if(!Number.isSafeInteger(pid)||pid<2)throw Error("The GPU compute process binding is invalid.");
  // Idle sessions of games that ended have nothing to stop; drop them here.
  for(const value of [...sessions.values()])if(!value.watcher&&value.pid&&value.pid!==pid&&!alive(value.pid))sessions.delete(value.requestRoot);
  const value=session(binding);if(value.pid&&value.pid!==pid)throw Error("The GPU compute process binding changed.");value.pid=pid;
  if(value.demanded){watch(value);scan(value).catch(()=>{});}
}
// A prepared plan without an enabled XeSS row. The watcher stops at once when
// no host of the earlier plan runs, otherwise once the last one ends; the next
// registered row, or a rollback to a plan with one (demand true), starts it
// again. Returns the earlier demand.
function demand(binding,demanded){
  const value=sessions.get(binding.requestRoot);if(!value)return false;
  const before=value.demanded;value.demanded=demanded===true;
  if(value.demanded&&value.pid&&value.configs.size){watch(value);scan(value).catch(()=>{});}
  else if(!value.demanded&&!value.children.size&&!value.pending.size)idle(value);
  return before;
}
function demanded(binding){return sessions.get(binding.requestRoot)?.demanded===true;}
function release(binding){const value=sessions.get(binding.requestRoot);if(!value)return;value.pid=null;value.watcher?.close();clearInterval(value.timer);for(const id of [...value.children.keys()])stop(value,id);sessions.delete(binding.requestRoot);}
process.once("exit",()=>{for(const value of [...sessions.values()])release(value);});
module.exports={reserve,register,bind,demand,demanded,release};

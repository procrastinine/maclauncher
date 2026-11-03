const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), Module = require("node:module");
const Runtime = require("../src/modules/shared/mvmz/cheats/runtime");
const { buildCheatsRuntimeSource } = require("../src/modules/shared/mvmz/cheats/runtime-source");

function temporary(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"maclauncher-cheat-atomic-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
function install(t,root,implementation=Runtime) {
  t.mock.timers.enable({apis:["setTimeout","setInterval"]});
  const cheatsFilePath=path.join(root,"cheats.json");
  return implementation.installCheatsRuntime({DEFAULT_CHEATS:{enabled:true,speed:1},
    normalizeCheats:raw=>({enabled:raw?.enabled!==false,speed:Number(raw?.speed)||1}),cheatsFilePath,
    window:new EventTarget(),document:{},enablePatcher:false,enableToolsUi:false});
}

test("game cheat writes preserve the prior document on failed publication and retry the same change",t=>{
  const root=temporary(t),api=install(t,root),file=api.cheatsFilePath;
  api.writeCheatsFileNow({enabled:true,speed:1});const before=fs.readFileSync(file),files=fs.readdirSync(root).sort();
  const rename=fs.renameSync,seen=[];
  const mock=t.mock.method(fs,"renameSync",(from,to)=>{
    if(to===file){seen.push([from,to]);assert.notEqual(from,to);assert.equal(path.dirname(from),path.dirname(to));
      assert.deepEqual(fs.readFileSync(to),before);throw Object.assign(Error("fixture rename failure"),{code:"EIO"});}
    return rename(from,to);
  });
  assert.equal(api.writeCheatsFileNow({enabled:false,speed:3}),false);
  assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readdirSync(root).sort(),files);assert.equal(seen.length,1);
  mock.mock.restore();assert.equal(api.writeCheatsFileNow({enabled:false,speed:3}),true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)),{enabled:false,speed:3});
});

test("game tool-state writes keep complete old bytes when rename fails",t=>{
  const root=temporary(t),api=install(t,root),before=fs.readFileSync(api.stateFilePath),files=fs.readdirSync(root).sort();
  const rename=fs.renameSync,mock=t.mock.method(fs,"renameSync",(from,to)=>{
    if(to===api.stateFilePath)throw Object.assign(Error("fixture rename failure"),{code:"EIO"});return rename(from,to);
  });
  const locations=[{name:"Saved place",mapId:2,x:3,y:4}];api.setRuntimeState({locations});t.mock.timers.tick(200);
  assert.deepEqual(fs.readFileSync(api.stateFilePath),before);assert.deepEqual(fs.readdirSync(root).sort(),files);
  mock.mock.restore();api.setRuntimeState({locations});t.mock.timers.tick(200);
  assert.deepEqual(JSON.parse(fs.readFileSync(api.stateFilePath)),{locations});
});

test("standalone cheat assets embed the shared writer without app paths or newer Node-only APIs",t=>{
  const root=temporary(t),runtimeFile=path.join(root,"runtime.js"),source=buildCheatsRuntimeSource();
  assert.doesNotMatch(source,/require\(["']\.\.\/\.\.\/atomic-file["']\)/);
  const module=new Module(runtimeFile),oldFs={...fs};delete oldFs.rmSync;
  module.filename=runtimeFile;module.paths=Module._nodeModulePaths(root);
  module.require=request=>{
    if(request==="fs")return oldFs;
    if(request==="crypto")return {randomBytes:require("node:crypto").randomBytes};
    assert.ok(["path"].includes(request),`Standalone runtime must use only its builtin dependencies: ${request}`);
    return require(request);
  };
  module._compile(source,runtimeFile);
  const api=install(t,root,module.exports);
  assert.equal(api.writeCheatsFileNow({enabled:false,speed:2}),true);
  assert.equal(JSON.parse(fs.readFileSync(api.cheatsFilePath)).speed,2);
  assert.equal(fs.existsSync(path.join(root,"atomic-file.js")),false);
});

test("Electron's existing fallback writer atomically publishes cheats without truncating a previous file",t=>{
  const root=temporary(t),file=path.join(root,"cheats.json");fs.writeFileSync(file,'{"enabled":false,"speed":1}');const before=fs.readFileSync(file);
  t.mock.timers.enable({apis:["setTimeout","setInterval"]});
  const previous={window:globalThis.window,document:globalThis.document,module:globalThis.module,exports:globalThis.exports};
  t.after(()=>{for(const [key,value]of Object.entries(previous))if(value===undefined)delete globalThis[key];else globalThis[key]=value;});
  globalThis.window=new EventTarget();window.StorageManager={__maclauncher_patched:true,isLocalMode(){return true;},save(){},localFileDirectoryPath(){return root;}};
  globalThis.document={body:null,readyState:"loading",getElementById(){return null;},currentScript:null};
  t.mock.method(Runtime,"installCheatsRuntime",()=>{throw Error("Fixture uses the existing fallback");});
  t.mock.method(console,"error",()=>{});
  const rename=fs.renameSync,mock=t.mock.method(fs,"renameSync",(from,to)=>{
    if(to===file){assert.notEqual(from,to);assert.deepEqual(fs.readFileSync(to),before);throw Object.assign(Error("fixture rename failure"),{code:"EIO"});}
    return rename(from,to);
  });
  const adapter=require("../src/modules/shared/mvmz/rpgmaker-electron").createRpgmakerElectronRuntime({engineId:"mv"});
  const context={config:{gameDir:root,contentRootDir:root,indexHtml:path.join(root,"index.html"),cheatsFilePath:file,cheats:{enabled:true,speed:3}},webFrame:{executeJavaScript:()=>Promise.resolve()}};
  adapter.install(context);assert.deepEqual(fs.readFileSync(file),before);
  mock.mock.restore();adapter.install(context);assert.equal(JSON.parse(fs.readFileSync(file)).speed,3);
});

test("existing NW and explicit plugin asset paths receive the standalone atomic writer without a new file",t=>{
  const root=temporary(t),game=path.join(root,"game");fs.mkdirSync(path.join(game,"js"),{recursive:true});
  fs.writeFileSync(path.join(game,"index.html"),"fixture");fs.writeFileSync(path.join(game,"js/main.js"),'PluginManager.setup($plugins);\n');
  for(const [id,filename]of [["plain","nwjs-launcher"],["patched","nwjs-patched-launcher"]]){
    const wrapper=require("../src/modules/shared/web/runtime/"+filename).buildWrapper({entry:{gameId:id,gamePath:game,contentRootDir:game,indexHtml:path.join(game,"index.html"),cheatsFilePath:path.join(root,"cheats.json")},
      userDataDir:path.join(root,"profile"),supportsCheats:true,cheatsFilePath:path.join(root,"cheats.json"),patchConfig:{}});
    assert.equal(fs.readFileSync(path.join(wrapper,"__maclauncher/runtime.js"),"utf8"),buildCheatsRuntimeSource());
    assert.equal(fs.existsSync(path.join(wrapper,"__maclauncher/atomic-file.js")),false);
  }
  require("../src/modules/shared/web/cheats/patcher").patchGame({engine:"mv",indexDir:game});
  const runtime=path.join(game,"js/plugins/maclauncher/runtime.js");
  assert.equal(fs.readFileSync(runtime,"utf8"),buildCheatsRuntimeSource());
  assert.equal(fs.existsSync(path.join(path.dirname(runtime),"atomic-file.js")),false);
});

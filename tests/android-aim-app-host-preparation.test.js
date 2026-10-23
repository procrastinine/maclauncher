const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { prepareSystem, controlDescriptor, pin } = require("../src/modules/android/providers/aim");
const { directoryForImage } = require("../src/modules/android/providers/aim/image-cache");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const originalIdentity = "1".repeat(64), firstGeneration = "a".repeat(64), nextGeneration = "b".repeat(64);

function fixture(t, capability) {
  if (arguments.length < 2) capability = true;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aim-app-host preparation-"));
  t.after(() => {
    function writable(directory) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      fs.chmodSync(directory, 0o700);
      for (const name of fs.readdirSync(directory)) writable(path.join(directory, name));
    }
    writable(root); fs.rmSync(root, { recursive: true, force: true });
  });
  const runtime = { version: "host-1", root: path.join(root, "runtime ; literal $(value)"), manifest: { files: [] } };
  if (capability !== undefined) runtime.manifest.capabilities = { appHost: capability };
  runtime.bin = path.join(runtime.root, "bin"); fs.mkdirSync(runtime.bin, { recursive: true });
  function input(name, bytes) {
    const file = path.join(runtime.root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    runtime.manifest.files = [...runtime.manifest.files.filter(row => row.path !== name), { path: name, sha256: sha(bytes) }];
  }
  input("image/overlay.toml", "schema = 1\n"); input("app-host/agent.jar", "agent-1");
  const userDataDir = path.join(root, "profile with spaces"), directory = directoryForImage(userDataDir, runtime, pin.androidImage);
  fs.mkdirSync(path.join(directory, "userdata"), { recursive: true });
  const base = path.join(directory, "system.dmg"), userdataFile = path.join(directory, "userdata", "preserved.bin");
  fs.writeFileSync(base, "existing original system base", { mode: 0o444 }); fs.writeFileSync(userdataFile, "existing private userdata");
  const configuration = path.join(root, "preparer-options.json"), callsFile = path.join(root, "preparer-calls.jsonl");
  const externalRoot = path.join(root, "outside-image-cache", "root"), externalMarker = path.join(root, "external.identity");
  fs.mkdirSync(externalRoot, { recursive: true }); fs.writeFileSync(path.join(externalRoot, ".identity"), firstGeneration + "\n", { mode: 0o444 });
  fs.writeFileSync(externalMarker, firstGeneration + "\n", { mode: 0o444 });
  const helper = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),cfg=JSON.parse(fs.readFileSync(${JSON.stringify(configuration)},'utf8'));
fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({args,root:process.env.MACLAUNCHER_AIM_ROOT})+'\\n');
const capable=args[0]==='--app-host',ordinary=capable?args.slice(1):args;
if(ordinary.length!==3)throw Error('Unexpected preparer argument count');
const [archive,payload,output]=ordinary,originalImage=path.join(output,'derived','root');
fs.mkdirSync(originalImage,{recursive:true});
if(!fs.existsSync(path.join(originalImage,'.identity')))fs.writeFileSync(path.join(originalImage,'.identity'),${JSON.stringify(originalIdentity + "\n")},{mode:0o444});
if(cfg.exitCode){process.stderr.write('Native preparation failed.\\n');process.exit(cfg.exitCode);}
if(!capable){process.stdout.write(originalImage+'\\n');process.exit(0);}
const appHostImage=path.join(output,'app-host',cfg.generation,'root');
fs.mkdirSync(path.dirname(appHostImage),{recursive:true});
if(cfg.rootAlias)fs.symlinkSync(${JSON.stringify(externalRoot)},appHostImage,'dir');
else{
 fs.mkdirSync(appHostImage,{recursive:true});
 const marker=path.join(appHostImage,'.identity');
 if(cfg.markerKind==='directory')fs.mkdirSync(marker);
 else if(cfg.markerKind==='alias')fs.symlinkSync(${JSON.stringify(externalMarker)},marker);
 else if(!cfg.markerMissing&&!fs.existsSync(marker))fs.writeFileSync(marker,cfg.generation+'\\n',{mode:0o444});
 fs.chmodSync(appHostImage,0o555);
}
if(cfg.exitCode){process.stderr.write('Native preparation failed.\\n');process.exit(cfg.exitCode);}
process.stdout.write(Object.hasOwn(cfg,'stdout')?cfg.stdout:JSON.stringify(Object.hasOwn(cfg,'reply')?cfg.reply:{originalImage,appHostImage})+'\\n');
`;
  fs.writeFileSync(path.join(runtime.bin, "android-runtime-prepare"), helper, { mode: 0o755 });
  let downloadRequests = 0;
  const context = { userDataDir,
    confirmRuntimeInstall() { downloadRequests++; throw new Error("A cached-image test must never request a download."); },
    downloadManager: { runTask() { downloadRequests++; throw new Error("A cached-image test must never start a download."); } } };
  const storage = { root: path.join(root, "game-profile"), androidRoot: path.join(root, "game-profile/android"),
    home: path.join(root, "game-profile/home"), temporary: path.join(root, "game-profile/tmp") };
  const policy = { networkAllowed: false };
  function configure(options = {}) { fs.writeFileSync(configuration, JSON.stringify({ generation: firstGeneration, ...options })); }
  configure();
  return { root, runtime, directory, base, userdataFile, context, storage, policy, input, configure, externalRoot, externalMarker,
    originalImage: path.join(directory, "derived/root"), appHostImage: path.join(directory, "app-host", firstGeneration, "root"),
    calls: () => fs.readFileSync(callsFile, "utf8").trim().split("\n").map(JSON.parse),
    prepare: () => prepareSystem({ context, storage, policy, runtime }), downloads: () => downloadRequests };
}

test("AIM prepares only the original image and keeps shared inputs and private userdata", async t => {
  const f=fixture(t),baseBefore=fs.statSync(f.base),prepared=await f.prepare();
  assert.equal(prepared.directory,f.directory);assert.equal(prepared.image,f.originalImage);assert.equal(prepared.appHostImage,undefined);
  assert.equal(prepared.userdata,path.join(f.directory,"userdata"));assert.equal(prepared.runtime,f.runtime);
  assert.equal(fs.readFileSync(path.join(prepared.image,".identity"),"utf8"),originalIdentity+"\n");
  assert.deepEqual(f.calls(),[{args:[path.join(f.directory,"system.zip"),f.runtime.root,f.directory],root:f.runtime.root}]);
  assert.equal(fs.existsSync(path.join(f.directory,"app-host")),false);assert.equal(f.downloads(),0);
  assert.equal(fs.readFileSync(f.base,"utf8"),"existing original system base");assert.equal(fs.statSync(f.base).ino,baseBefore.ino);
  assert.equal(fs.readFileSync(f.userdataFile,"utf8"),"existing private userdata");
  const control=controlDescriptor({runtime:f.runtime,storage:f.storage,policy:f.policy,prepared,args:["status"]});
  assert.equal(control.command,path.join(f.runtime.bin,"aimctl"));assert.deepEqual(control.args,["--data",f.storage.androidRoot,"status"]);
  assert.equal(control.env.MACLAUNCHER_AIM_NETWORK,"deny");assert.ok(control.readDirectories.includes(prepared.directory));
  assert.deepEqual(control.executableDirectories,[f.runtime.bin,f.storage.androidRoot,prepared.image]);
});

test("capabilities and saved app-host choices do not create unused image projections",async t=>{
  for(const capability of [undefined,false,true,"true"])await t.test(String(capability),async t=>{
    const f=fixture(t,capability);f.context.runtimeSettings={launchMode:"app-host"};const prepared=await f.prepare();
    assert.equal(prepared.image,f.originalImage);assert.equal(prepared.appHostImage,undefined);
    assert.deepEqual(f.calls()[0].args,[path.join(f.directory,"system.zip"),f.runtime.root,f.directory]);
    assert.equal(fs.existsSync(path.join(f.directory,"app-host")),false);assert.equal(f.downloads(),0);
  });
});

test("concurrent preparation coalesces the original image operation",async t=>{
  const f=fixture(t),[first,second]=await Promise.all([f.prepare(),f.prepare()]);
  assert.equal(first,second);assert.equal(f.calls().length,1);assert.equal(f.downloads(),0);
});

test("host-only changes preserve shared original-image storage and private userdata",async t=>{
  const f=fixture(t),first=await f.prepare(),base=fs.statSync(f.base);
  f.input("app-host/agent.jar","agent-2");f.runtime.version="host-2";f.configure({generation:nextGeneration});
  assert.equal(directoryForImage(f.context.userDataDir,f.runtime,pin.androidImage),f.directory);
  const next=await f.prepare();assert.equal(next.image,first.image);assert.equal(next.userdata,first.userdata);
  assert.equal(fs.statSync(f.base).ino,base.ino);assert.equal(fs.readFileSync(f.userdataFile,"utf8"),"existing private userdata");
  assert.equal(f.calls().length,2);assert.ok(f.calls().every(c=>c.args.length===3));assert.equal(f.downloads(),0);
});

test("failed original-image preparation preserves the base and private userdata",async t=>{
  const f=fixture(t);f.configure({exitCode:7});await assert.rejects(f.prepare(),/Native preparation failed/);
  assert.equal(fs.readFileSync(f.base,"utf8"),"existing original system base");
  assert.equal(fs.readFileSync(f.userdataFile,"utf8"),"existing private userdata");assert.equal(f.calls().length,1);assert.equal(f.downloads(),0);
});

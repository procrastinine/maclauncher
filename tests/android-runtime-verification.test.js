const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const Verifier = require("../src/modules/android/runtime-verifier");
const Bundled = require("../src/modules/shared/runtime/bundled-native");
const Runtime = require("../src/modules/android/runtime");
const Host = require("../src/modules/android/host");
const Module = require("../src/modules/android/main");

test("Android runtime choices expose independent managed builds and preserve the included default", () => {
  assert.equal(Module.manifest.runtime.default, "klepton");
  assert.deepEqual(Module.manifest.runtime.manager, { klepton: "android", macapk: "macapk", aim: "android-aim" });
  assert.deepEqual(Module.runtimeManagers.map(manager => manager.id), ["android", "macapk", "android-aim"]);
  for (const manager of Module.runtimeManagers.filter(manager => manager.id !== "macapk")) {
    assert.equal(manager.delivery.included, "direct");
    assert.equal(manager.delivery.sourceBuild, false);
    assert.equal(manager.delivery.catalog, "remote");
  }
});

function fixture(directory, name) {
  const root = path.join(directory, name); fs.mkdirSync(root);
  const bytes = Buffer.alloc(8192, 73), file = path.join(root, "payload");
  fs.writeFileSync(file, bytes, { mode: 0o600 }); fs.chmodSync(file, 0o600);
  return { root, file, bytes, declaration: { files: [{ path: "payload", size: bytes.length,
    mode: 0o600, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }] } };
}

test("Platform supplier identity covers complete common and image metadata without reading payload files", t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"android-platform-identity-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const base={schemaVersion:1,version:"common",minimumMacOS:"13.0",architectures:["arm64"],sourceHash:"a".repeat(64),inputHash:"b".repeat(64),
    profile:{id:"common",javaMajor:21,nativeLoadTarget:"maclauncher.android.bridge.GuestNativeLoader",frameworkServicesVersion:1,artExecutionVersion:1},
    files:[{path:"android-host.jar",size:3,mode:0o644,sha256:"c".repeat(64)},{path:"native/platform.dylib",size:5,mode:0o755,sha256:"d".repeat(64)},{path:"resources/platform.dat",size:7,mode:0o644,sha256:"e".repeat(64)}],
    platformSupplier:{schemaVersion:1,image:{sha256:"1".repeat(64),records:4,bytes:7},catalog:{sha256:"2".repeat(64),size:3,mode:0o644}}};
  function identity(name,edit){
    const root=path.join(directory,name);fs.mkdirSync(root);const manifest=structuredClone(base);edit?.(manifest);
    const bytes=JSON.stringify(manifest);fs.writeFileSync(path.join(root,"runtime.json"),bytes);
    const declaration={version:manifest.version,minimumMacOS:manifest.minimumMacOS,manifestSha256:crypto.createHash("sha256").update(bytes).digest("hex"),platformHash:"0".repeat(64)};
    const options={root,platform:"darwin",arch:"arm64",macOSVersion:"27.0"},selected=Runtime.resolve(options,declaration).runtimeIdentity;
    assert.deepEqual(Runtime.resolve(options,declaration).runtimeIdentity,selected);return selected;
  }
  const common=identity("common");assert.match(common.platformHash,/^[a-f0-9]{64}$/);assert.notEqual(common.platformHash,"0".repeat(64));
  assert.equal(identity("art",manifest=>{manifest.version="new-art";manifest.sourceHash="3".repeat(64);manifest.inputHash="4".repeat(64);manifest.profile.artExecutionVersion=2;manifest.files.reverse();manifest.profile=Object.fromEntries(Object.entries(manifest.profile).reverse());}).platformHash,common.platformHash);
  for(const[index,name]of ["java","native","resource"].entries())assert.notEqual(identity(name,manifest=>{manifest.files[index].sha256="f".repeat(64);}).platformHash,common.platformHash);
  for(const[name,edit]of [["mode",manifest=>{manifest.files[0].mode=0o600;}],["profile",manifest=>{manifest.profile.frameworkServicesVersion=2;}],
    ["floor",manifest=>{manifest.minimumMacOS="14.0";}],["architecture",manifest=>{manifest.architectures=["arm64","x86_64"];}],
    ["image",manifest=>{manifest.platformSupplier.image.sha256="5".repeat(64);}],["catalog",manifest=>{manifest.platformSupplier.catalog.sha256="6".repeat(64);}],
    ["member",manifest=>{manifest.files.push({path:"resources/new.dat",size:1,mode:0o644,sha256:"7".repeat(64)});}]])
    assert.notEqual(identity(name,edit).platformHash,common.platformHash,name+" changes the supplier identity");
  assert.equal(identity("legacy-common",manifest=>{delete manifest.files;}).platformHash,undefined);
  assert.equal(identity("legacy-art",manifest=>{delete manifest.platformSupplier;}).platformHash,undefined,"ART owners retain the original comparison until complete image metadata is published");
});

test("Android verification runs off-thread and invalidates cached bytes on file, mode and inventory changes", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "android-verify-"));
  t.after(async () => { await Verifier.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const entry = fixture(directory, "runtime"), check = () => Verifier.verifyPayload(entry.root, entry.declaration);
  // Any verification executed in the caller's thread fails this test. The
  // worker has its own module instance and still performs the real checksum.
  const original = Bundled.verifyPayload;
  Bundled.verifyPayload = () => { throw new Error("Verification blocked the caller"); };
  t.after(() => { Bundled.verifyPayload = original; });
  assert.equal((await check()).cacheHit, false);
  assert.equal((await check()).cacheHit, true);
  await Verifier.close();
  assert.equal((await check()).cacheHit, true, "Fresh backend workers reuse unchanged verified payloads");
  const before = fs.statSync(entry.file);
  fs.writeFileSync(entry.file, Buffer.alloc(entry.bytes.length, 19)); fs.utimesSync(entry.file, before.atime, before.mtime);
  await assert.rejects(check(), /checksum or permissions/);
  fs.writeFileSync(entry.file, entry.bytes); assert.equal((await check()).cacheHit, false);
  fs.chmodSync(entry.file, 0o700); await assert.rejects(check(), /checksum or permissions/);
  fs.chmodSync(entry.file, 0o600); await check();
  fs.renameSync(entry.file, path.join(directory, "original"));
  fs.writeFileSync(entry.file, entry.bytes, { mode: 0o600 });
  assert.equal((await check()).cacheHit, false, "Replacement inode invalidates even identical bytes");
  fs.writeFileSync(path.join(entry.root, "extra"), "extra"); await assert.rejects(check(), /inventory/);
  fs.unlinkSync(path.join(entry.root, "extra")); fs.unlinkSync(entry.file); await assert.rejects(check(), /inventory/);
  fs.symlinkSync(path.join(directory, "original"), entry.file); await assert.rejects(check(), /symlinks/);
  fs.unlinkSync(entry.file); fs.writeFileSync(entry.file, entry.bytes, { mode: 0o600 }); await check();
  const architecture = { files: [{ ...entry.declaration.files[0], architectures: ["arm64"] }] };
  await assert.rejects(Verifier.verifyPayload(entry.root, architecture), /Mach-O|native|executable|magic/i);
  for (let i = 0; i < 4; i++) { const next = fixture(directory, "other" + i); await Verifier.verifyPayload(next.root, next.declaration); }
  assert.equal((await check()).cacheHit, false, "Only four payload identities are cached");
});

test("Android verification cancellation retires callers without canceling a separate launch", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "android-verify-cancel-"));
  t.after(async () => { await Verifier.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const entry = fixture(directory, "runtime"), controller = new AbortController();
  const first = Verifier.verifyPayload(entry.root, entry.declaration, { signal: controller.signal });
  const rejected = assert.rejects(first, { name: "AbortError" });
  const second = Verifier.verifyPayload(entry.root, entry.declaration);
  controller.abort(); await rejected; await second;
  await assert.rejects(Verifier.verifyPayload(entry.root, entry.declaration, { signal: controller.signal }), { name: "AbortError" });
  await Verifier.close();
  const last = new AbortController(), only = Verifier.verifyPayload(entry.root, entry.declaration, { signal: last.signal });
  const canceled = assert.rejects(only, { name: "AbortError" }); last.abort(); await canceled;
  assert.equal((await Verifier.verifyPayload(entry.root, entry.declaration)).cacheHit, true,
    "Canceling a caller does not discard the successful prior verification");
});

test("Concurrent Android launches share verification and queued cancellation preserves other versions", async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"android-verify-shared-"));
  t.after(async()=>{await Verifier.close();fs.rmSync(directory,{recursive:true,force:true});});
  const entry=fixture(directory,"runtime");
  const checks=await Promise.all(Array.from({length:64},()=>Verifier.verifyPayload(entry.root,entry.declaration)));
  assert.ok(checks.every(result=>result.cacheHit===false),"Every concurrent caller observes the same first verification");
  const blocker=fixture(directory,"blocker"),canceled=fixture(directory,"canceled"),last=fixture(directory,"last");
  const running=Verifier.verifyPayload(blocker.root,blocker.declaration),controller=new AbortController();
  const waiting=Verifier.verifyPayload(canceled.root,canceled.declaration,{signal:controller.signal});
  const rejected=assert.rejects(waiting,{name:"AbortError"});
  const remaining=Verifier.verifyPayload(last.root,last.declaration);
  controller.abort();await rejected;await running;
  assert.equal((await remaining).cacheHit,false);
  assert.equal((await Verifier.verifyPayload(canceled.root,canceled.declaration)).cacheHit,false,"Canceled queued work is never dispatched");
});

test("Android launch awaits full verification before preparation or spawning", async t => {
  const resolve = Runtime.resolveForLaunch, launch = Host.launch;
  t.after(() => { Runtime.resolveForLaunch = resolve; Host.launch = launch; });
  let complete, launches = 0, lease;
  const order = [];
  Runtime.resolveForLaunch = () => { order.push("verify"); return new Promise(resolve => { complete = resolve; }); };
  Host.launch = async (_entry, _context, payload) => { launches++; return payload; };
  const entry = { gameId: "verification" }, context = { userDataDir: path.join(os.tmpdir(), "android-verification-fixture"),
    useRuntime: async identity => { lease = identity; order.push("lease"); } };
  const running = Module.launchRuntime("klepton", entry, context);
  assert.deepEqual(order, ["lease"]); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["lease", "verify"]); assert.equal(lease.managerId, "android"); assert.ok(lease.version); assert.ok(path.isAbsolute(lease.sourcePath));
  assert.equal(launches, 0); const payload = { verified: true }; complete(payload);
  assert.equal(await running, payload); assert.equal(launches, 1);
  Runtime.resolveForLaunch = async () => { throw new Error("changed payload"); };
  await assert.rejects(Module.launchRuntime("klepton", entry, context), /changed payload/); assert.equal(launches, 1);
});

test("Retained Android backends observe newly activated runtimes and keep in-flight launches coherent", async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"android-activation-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const declarationFile=path.resolve(__dirname,"../src/modules/android/distribution-supplementals.json");
  const make=version=>{
    const root=path.join(directory,version);fs.mkdirSync(root);
    const bytes=Buffer.from(JSON.stringify({schemaVersion:1,version,profile:{id:version,javaMajor:21,nativeLoadTarget:"maclauncher.android.bridge.GuestNativeLoader"}}));
    fs.writeFileSync(path.join(root,"runtime.json"),bytes);
    return {root,declaration:{id:"android",version,minimumMacOS:"13.0",directoryRelative:"android/"+version,manifestSha256:crypto.createHash("sha256").update(bytes).digest("hex")}};
  };
  const first=make("first"),second=make("second");let active=first.declaration,complete;
  const read=fs.readFileSync;
  t.mock.method(fs,"readFileSync",function(file,...args){return String(file)===declarationFile?JSON.stringify([{id:"android-privacy"},active]):read.call(this,file,...args);});
  t.mock.method(Verifier,"verifyPayload",async (_root,declaration)=>{
    assert.equal(declaration.version,"first");
    await new Promise(resolve=>{complete=resolve;});
  });
  const options={platform:"darwin",arch:"arm64",macOSVersion:"27.0"};
  const launching=Runtime.resolveForLaunch({...options,root:first.root});
  active=second.declaration;
  assert.equal(Runtime.resolve({...options,root:second.root}).version,"second");
  complete();const launched=await launching;assert.equal(launched.version,"first");
  assert.deepEqual(launched.runtimeIdentity,{version:first.declaration.version,minimumMacOS:first.declaration.minimumMacOS,
    manifestSha256:first.declaration.manifestSha256});
  assert.equal(Runtime.resolve({...options,root:first.root},JSON.parse(JSON.stringify(launched.runtimeIdentity))).version,"first",
    "A descendant account owner validates the selected manifest after another runtime is activated");
  assert.throws(()=>Runtime.resolve({...options,root:first.root}),/metadata has changed/,
    "The ordinary launch path still verifies against the active included declaration");
  const pinned=Runtime.resolveForLaunch({...options,root:first.root},first.declaration);
  complete();assert.equal((await pinned).version,"first",
    "A trusted caller can retain an immutable declaration across subsequent activations");
  fs.appendFileSync(path.join(first.root,"runtime.json")," ");
  assert.throws(()=>Runtime.resolve({...options,root:first.root},launched.runtimeIdentity),/metadata has changed/,
    "Descendants still reject a modified selected manifest");
  await assert.rejects(Runtime.resolveForLaunch({...options,root:first.root},first.declaration),/metadata has changed/,
    "Pinning an older declaration never bypasses payload validation");
});

test('retained MacLauncher Android builds use verified offline version selection', {skip:process.platform!=='darwin'||process.arch!=='arm64'}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-retained-manager-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const nativeSource=path.join(root,'fixture.c'),library=path.join(root,'fixture.dylib');
  fs.writeFileSync(nativeSource,'int fixture(void){return 7;}\n');
  require('node:child_process').execFileSync('clang',['-dynamiclib','-mmacosx-version-min=13.0',nativeSource,'-o',library]);
  const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  function packageFor(version){
    const record={id:'android',version,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:'13.0',
      directoryRelative:`android/${version}/arm64`,manifestRelative:'runtime.json',sourceRelative:'source.tar.gz'};
    const directory=path.join(root,record.directoryRelative);fs.mkdirSync(path.join(directory,'native'),{recursive:true});
    const files=[['native/libklepton-jvm.dylib',fs.readFileSync(library),0o755],['source.tar.gz',Buffer.from('source '+version),0o644]];
    const manifest={schemaVersion:1,version,minimumMacOS:'13.0',architectures:['arm64'],profile:{id:'fixture',javaMajor:21,nativeLoadTarget:'maclauncher.android.bridge.GuestNativeLoader'},
      files:files.map(([name,bytes,mode])=>({path:name,size:bytes.length,mode,sha256:hash(bytes),...(name.endsWith('.dylib')?{architectures:['arm64']}:{})}))};
    for(const[name,bytes,mode]of files){const file=path.join(directory,name);fs.writeFileSync(file,bytes,{mode});fs.chmodSync(file,mode);}
    const bytes=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(path.join(directory,'runtime.json'),bytes,{mode:0o644});
    record.manifestSha256=hash(bytes);record.sourceSha256=manifest.files[1].sha256;return record;
  }
  const primary=packageFor('1.0'),retained=packageFor('2.0'),metadataPath=path.resolve(__dirname,'../src/modules/android/retained-versions.json');
  let metadata={schemaVersion:1,packages:[retained]},requests=0;
  const read=fs.readFileSync;t.mock.method(fs,'readFileSync',function(file,...args){return path.resolve(String(file))===metadataPath?JSON.stringify(metadata):read.call(this,file,...args);});
  t.mock.method(Runtime,'readDeclaration',()=>primary);
  const manager=require('../src/modules/android/runtime-manager').createManager({systemVersionSync:()=>'26.0',fetchUrlBuffer:async()=>{requests++;throw Error('Unexpected network');},downloadToFile:async()=>{requests++;throw Error('Unexpected download');}});
  const userDataDir=path.join(root,'user'),options={nativeResourceRoot:root},state=manager.getState({userDataDir,...options});
  assert.deepEqual(state.catalog.includedVersions,[primary.version,retained.version]);assert.equal(state.catalog.recommendedVersion,primary.version);
  assert.equal(manager.resolveSelection(null,{},userDataDir,options).version,primary.version,'Retaining another build does not replace the included default');
  for(const[entry,settings]of [[{runtimeData:{klepton:{version:retained.version}}},{}],[null,{runtimes:{android:{defaultVersion:retained.version}}}]]){
    const selected=manager.resolveSelection(entry,settings,userDataDir,options);assert.equal(selected.ready,true);assert.equal(selected.version,retained.version);assert.equal(selected.install.root,path.join(root,retained.directoryRelative));
    assert.equal(Bundled.verifyPayload(selected.install.root,selected.install.declaration),true,'The retained package passes the complete real Mach-O payload verifier');
  }
  assert.equal((await manager.installRuntime({userDataDir,version:retained.version,...options})).source,'bundled');
  assert.equal(state.catalog.versionRequirements[retained.version].requiresDownload,false);assert.equal(requests,0);
  await assert.rejects(manager.uninstallRuntime({userDataDir,version:retained.version,...options}),/included/);
  const invalid=[{id:'android-aim'},{arch:'x64'},{version:'../escape'},{version:12,directoryRelative:'android/12/arm64'},{directoryRelative:'android/elsewhere/arm64'},
    {manifestRelative:'manifest.json'},{sourceRelative:'files/source.tar.gz'},{manifestSha256:'z'.repeat(64)},{sourceSha256:'bad'}];
  for(const change of invalid){metadata={schemaVersion:1,packages:[{...retained,...change}]};assert.throws(()=>manager.getState({userDataDir,...options}),/runtime identity is invalid/);}
  metadata={schemaVersion:2,packages:[retained]};assert.throws(()=>manager.getState({userDataDir,...options}),/retained Android runtime metadata is invalid/);
  for(const field of ['manifestSha256','sourceSha256']){metadata={schemaVersion:1,packages:[{...retained,[field]:'a'.repeat(64)}]};assert.equal(manager.resolveSelection(null,{},userDataDir,{...options,version:retained.version}).ready,false,'A mismatched '+field+' cannot authorize a retained package');}
  metadata={schemaVersion:1,packages:[retained]};fs.rmSync(path.join(root,retained.directoryRelative),{recursive:true});
  assert.equal(manager.resolveSelection(null,{},userDataDir,options).version,primary.version,'Missing retained files leave the primary default usable');assert.equal(requests,0);
});

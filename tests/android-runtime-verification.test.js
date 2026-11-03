const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const Verifier = require("../src/modules/android/runtime-verifier");
const Bundled = require("../src/modules/shared/runtime/bundled-native");
const Runtime = require("../src/modules/android/runtime");
const Host = require("../src/modules/android/host");
const Module = require("../src/modules/android/main");

test("Android runtime choices expose managed packages and preserve the default execution", () => {
  assert.equal(Module.manifest.runtime.default, "klepton");
  assert.deepEqual(Module.manifest.runtime.manager, { klepton: "android", macapk: "macapk", aim: "android-aim" });
  assert.deepEqual(Module.runtimeManagers.map(manager => manager.id), ["android", "macapk", "android-aim", "jadx", "apktool"]);
  for (const manager of Module.runtimeManagers.filter(manager => ["android", "android-aim"].includes(manager.id))) {
    assert.equal(manager.delivery.included, "none");
    assert.equal(manager.delivery.sourceBuild, false);
    assert.equal(manager.delivery.catalog, "remote");
  }
});

test("Android resolves only the selected installation and its CPU", t => {
  t.mock.method(require("../src/modules/shared/runtime/host-capabilities"), "getHostCapabilities", () => ({ platform: "darwin", hardwareArch: "arm64" }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-selected-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, version: "selected",
    profile: { id: "selected", javaMajor: 21, nativeLoadTarget: "maclauncher.android.bridge.GuestNativeLoader" } }));
  fs.writeFileSync(path.join(root, "runtime.json"), bytes);
  const installed = { version: "selected", minimumMacOS: "13.0",
    manifestSha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  assert.equal(Runtime.resolve({ root, platform: "darwin", arch: "arm64", macOSVersion: "27.0" }, installed).version, "selected");
  assert.throws(() => Runtime.resolve({ root, platform: "darwin", arch: "x64", macOSVersion: "27.0" }, installed), /Apple Silicon/);
});

function fixture(directory, name) {
  const root = path.join(directory, name); fs.mkdirSync(root);
  const bytes = Buffer.alloc(8192, 73), file = path.join(root, "payload");
  fs.writeFileSync(file, bytes, { mode: 0o600 }); fs.chmodSync(file, 0o600);
  return { root, file, bytes, declaration: { files: [{ path: "payload", size: bytes.length,
    mode: 0o600, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }] } };
}

test("Platform supplier identity covers complete common and image metadata without reading payload files", t => {
  t.mock.method(require("../src/modules/shared/runtime/host-capabilities"), "getHostCapabilities", () => ({ platform: "darwin", hardwareArch: "arm64" }));
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

test("Android worker snapshots invalidate coarse regular payload and dependency bytes across the real message boundary", async t => {
  const {Worker}=require('node:worker_threads');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-coarse-worker-'));
  const entry=fixture(directory,'runtime'),dependency=fixture(directory,'dependency');
  const pin={project:'fixture-dependency',release:'1.0.0',sha256:'a'.repeat(64)};
  entry.declaration.dependencies=[pin];
  const packages=[{root:dependency.root,declaration:dependency.declaration,record:{id:pin.project,version:pin.release,asset:{sha256:pin.sha256}}}];
  let worker;
  t.after(async()=>{await worker?.terminate();fs.rmSync(directory,{recursive:true,force:true});});
  const start=()=>new Worker(`
    const fs=require('node:fs'),path=require('node:path'),{workerData}=require('node:worker_threads');
    const lstat=fs.lstatSync.bind(fs),held=new Map(workerData.files.map(file=>{
      const stat=lstat(file,{bigint:true});
      return [file,Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{mtimeNs:2000000000n,ctimeNs:1000000000n})];
    }));
    fs.lstatSync=(file,...args)=>args[0]?.bigint&&held.get(path.resolve(String(file)))||lstat(file,...args);
    require(workerData.module);
  `,{eval:true,workerData:{files:[entry.file,dependency.file],module:require.resolve('../src/modules/android/runtime-verifier-worker')}});
  let id=0;
  const check=()=>new Promise((resolve,reject)=>{
    const receive=message=>{worker.removeListener('error',failed);message.error?reject(Object.assign(new Error(message.error.message),message.error)):resolve(message.result);};
    const failed=error=>{worker.removeListener('message',receive);reject(error);};
    worker.once('message',receive);worker.once('error',failed);
    worker.postMessage({id:++id,root:entry.root,declaration:entry.declaration,dependencyPackages:packages});
  });
  worker=start();assert.equal((await check()).cacheHit,false);assert.equal((await check()).cacheHit,true);
  fs.writeFileSync(entry.file,Buffer.alloc(entry.bytes.length,19));
  await assert.rejects(check(),/checksum or permissions/,'Warm worker must not trust equal coarse metadata');
  fs.writeFileSync(entry.file,entry.bytes);await check();
  await worker.terminate();
  fs.writeFileSync(dependency.file,Buffer.alloc(dependency.bytes.length,19));
  worker=start();
  await assert.rejects(check(),/checksum or permissions/,'Persistent worker cache must recheck regular dependency bytes too');
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
  const installDir = path.join(context.userDataDir, "runtimes/android/managed");
  t.mock.method(require("../src/modules/android/runtime-manager"), "resolveSelection", () => ({
    ready: true, version: "managed", install: { installDir, root: path.join(installDir, "payload"), declaration: { version: "managed" } }
  }));
  const running = Module.launchRuntime("klepton", entry, context);
  assert.deepEqual(order, ["lease"]); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["lease", "verify"]); assert.equal(lease.managerId, "android"); assert.equal(lease.version, "managed"); assert.equal(lease.sourcePath, installDir);
  assert.equal(launches, 0); const payload = { verified: true }; complete(payload);
  assert.equal(await running, payload); assert.equal(launches, 1);
  Runtime.resolveForLaunch = async () => { throw new Error("changed payload"); };
  await assert.rejects(Module.launchRuntime("klepton", entry, context), /changed payload/); assert.equal(launches, 1);
});

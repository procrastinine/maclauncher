const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Worker } = require("node:worker_threads");
const Assets = require("../src/modules/rgss/assets");
const Launcher = require("../src/modules/rgss/runtime/mkxpz-launcher");
const { createRuntimeCoordinator } = require("../src/core/runtime-coordinator");
const { createLauncher } = require("../src/core/launcher");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-immutable-rgss-"));
  const userDataDir = path.join(root, "user"), resourceRoot = path.join(root, "resources"), kawarikiRoot = path.join(root, "kawariki");
  for (const pack of ["Standard", "RPGVX", "RPGVXAce"]) {
    const directory = path.join(resourceRoot, "rtp", pack); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "asset.txt"), pack + " original");
  }
  fs.mkdirSync(path.join(resourceRoot, "soundfont")); fs.writeFileSync(path.join(resourceRoot, "soundfont", "GMGSx.SF2"), "font");
  fs.mkdirSync(kawarikiRoot); fs.writeFileSync(path.join(kawarikiRoot, "preload.rb"), "Kernel.require File.join(Preload::Path, 'patches.rb')\n");
  fs.writeFileSync(path.join(kawarikiRoot, "patches.rb"), "# original patches");
  t.after(() => { Assets.removeStagedAssets({ userDataDir }); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, userDataDir, resourceRoot, kawarikiRoot, options: { userDataDir, resourceRoot, kawarikiRoot } };
}

test("healthy force refresh reuses immutable assets and leaves publisher inputs untouched", t => {
  const f = fixture(t), original = fs.readFileSync(path.join(f.kawarikiRoot, "preload.rb"));
  const first = Assets.ensureAssetsStaged(f.options), next = Assets.ensureAssetsStaged({ ...f.options, force: true });
  assert.equal(next.generationRoot, first.generationRoot); assert.equal(next.stagedNow, false);
  assert.equal(fs.readdirSync(path.dirname(first.generationRoot)).filter(name => !name.startsWith(".")).length, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.kawarikiRoot, "preload.rb")), original);
  const paths = Assets.resolveStagedPaths(f.userDataDir, "Standard", { generationRoot: first.generationRoot });
  assert.equal(fs.statSync(paths.kawarikiPreload).mode & 0o222, 0);
  assert.match(fs.readFileSync(paths.kawarikiPreload, "utf8"), /patches-extra\.rb/);
});

test("source updates and private damage preserve the generation referenced by an earlier game config", t => {
  const f = fixture(t), first = Assets.ensureAssetsStaged(f.options);
  const paths = Assets.resolveStagedPaths(f.userDataDir, "Standard", { generationRoot: first.generationRoot });
  const config = Launcher.buildMkxpConfig({ entry: { gamePath: f.root, moduleData: { rgssVersion: "RGSS1", rtpId: "Standard" } }, userDataDir: f.userDataDir, runtimeSettings: {}, stagedAssets: paths });
  fs.writeFileSync(path.join(f.resourceRoot, "soundfont", "GMGSx.SF2"), "updated resource");
  const updated = Assets.ensureAssetsStaged(f.options);
  assert.notEqual(updated.generationRoot, first.generationRoot);
  assert.equal(fs.readFileSync(config.midiSoundFont, "utf8"), "font");
  assert.equal(config.preloadScript[0], paths.kawarikiPreload);
  const altered = path.join(updated.generationRoot, "soundfont", "GMGSx.SF2");
  fs.chmodSync(altered, 0o644); fs.writeFileSync(altered, "damaged resource");
  const repaired = Assets.ensureAssetsStaged({ ...f.options, force: true });
  assert.notEqual(repaired.generationRoot, updated.generationRoot);
  assert.equal(fs.readFileSync(path.join(repaired.generationRoot, "soundfont", "GMGSx.SF2"), "utf8"), "updated resource");
  assert.equal(fs.readFileSync(altered, "utf8"), "damaged resource");
  assert.equal(fs.readFileSync(paths.soundfontPath, "utf8"), "font");
});

test("unchanged source observations reuse hashes and metadata-only updates keep the generation", t => {
  const f = fixture(t), font = path.join(f.resourceRoot, "soundfont", "GMGSx.SF2");
  const first = Assets.ensureAssetsStaged(f.options), open = fs.openSync, read = fs.readSync;
  const descriptors = new Set(); let sourceReads = 0;
  t.mock.method(fs, "openSync", (file, ...args) => { const fd = open(file, ...args); if (file === font) descriptors.add(fd); return fd; });
  t.mock.method(fs, "readSync", (fd, ...args) => { if (descriptors.has(fd)) sourceReads++; return read(fd, ...args); });
  const warm = Assets.ensureAssetsStaged(f.options);
  assert.equal(warm.generationRoot, first.generationRoot); assert.equal(sourceReads, 0);
  fs.utimesSync(font, new Date(1000), new Date(2000));
  const refreshed = Assets.ensureAssetsStaged(f.options);
  assert.equal(refreshed.generationRoot, first.generationRoot); assert.equal(refreshed.stagedNow, false);
  assert.ok(sourceReads > 0, "Changed real-file metadata must recheck its bytes");
  sourceReads = 0;
  assert.equal(Assets.ensureAssetsStaged(f.options).generationRoot, first.generationRoot);
  assert.equal(sourceReads, 0);
});

test("real source mutation and file replacement during hashing fail without publishing assets", t => {
  const f = fixture(t), font = path.join(f.resourceRoot, "soundfont", "GMGSx.SF2");
  const open = fs.openSync, read = fs.readSync; let descriptor, changed = false;
  t.mock.method(fs, "openSync", (file, ...args) => { const fd = open(file, ...args); if (file === font) descriptor = fd; return fd; });
  t.mock.method(fs, "readSync", (fd, ...args) => {
    const bytes = read(fd, ...args);
    if (fd === descriptor && !changed) { changed = true; fs.writeFileSync(font, "FONT"); }
    return bytes;
  });
  assert.throws(() => Assets.ensureAssetsStaged(f.options), /source changed while reading/);
  assert.equal(fs.existsSync(path.join(f.userDataDir, "modules", "rgss", "assets")), false);
  t.mock.restoreAll();
  t.mock.method(fs, "openSync", (file, ...args) => {
    if (file === font) { fs.renameSync(font, font + ".previous"); fs.writeFileSync(font, "font"); }
    return open(file, ...args);
  });
  assert.throws(() => Assets.ensureAssetsStaged(f.options), /source changed while reading/);
  assert.equal(fs.existsSync(path.join(f.userDataDir, "modules", "rgss", "assets")), false);
});

test("a real directory named .asar retains normal source mutation and symlink checks", t => {
  const f = fixture(t), directory = path.join(f.root, "real.asar");
  fs.renameSync(f.resourceRoot, directory);
  const options = { ...f.options, resourceRoot: directory };
  const first = Assets.ensureAssetsStaged(options), font = path.join(directory, "soundfont", "GMGSx.SF2");
  fs.writeFileSync(font, "FONT");
  const updated = Assets.ensureAssetsStaged(options);
  assert.notEqual(updated.generationRoot, first.generationRoot);
  assert.equal(fs.readFileSync(path.join(first.generationRoot, "soundfont", "GMGSx.SF2"), "utf8"), "font");
  fs.unlinkSync(font); fs.symlinkSync(path.join(f.kawarikiRoot, "preload.rb"), font);
  assert.throws(() => Assets.getAssetsStatus(options), /only real files and directories/);
});

test("concurrent cold publishers atomically share one healthy generation without deleting legacy/live assets", { timeout: 15000 }, async t => {
  const f = fixture(t), legacy = path.join(f.userDataDir, "modules", "rgss", "assets", "rtp", "Standard");
  fs.mkdirSync(legacy, { recursive: true }); fs.writeFileSync(path.join(legacy, "legacy.txt"), "live legacy resource");
  const barrier = new SharedArrayBuffer(4), state = new Int32Array(barrier);
  const modulePath = require.resolve("../src/modules/rgss/assets");
  const code = `const fs=require('node:fs'),{parentPort,workerData}=require('node:worker_threads');
    const copy=fs.cpSync,state=new Int32Array(workerData.barrier);let held=false;
    fs.cpSync=function(...args){if(!held){held=true;Atomics.add(state,0,1);parentPort.postMessage({waiting:true});while(Atomics.load(state,0)<3){const value=Atomics.load(state,0);if(value>=3)break;if(Atomics.wait(state,0,value,10000)==='timed-out'&&Atomics.load(state,0)<3)throw Error('publication barrier timed out');}}return copy(...args);};
    try{const status=require(workerData.modulePath).ensureAssetsStaged(workerData.options);parentPort.postMessage({done:true,generationRoot:status.generationRoot});}catch(error){parentPort.postMessage({error:error.stack});}`;
  const workers = [0, 1].map(() => new Worker(code, { eval: true, workerData: { barrier, modulePath, options: f.options } }));
  t.after(async () => Promise.all(workers.map(worker => worker.terminate())));
  let waiting = 0;
  const done = workers.map(worker => new Promise((resolve, reject) => {
    worker.on("error", reject); worker.on("message", message => {
      if (message.error) reject(new Error(message.error));
      if (message.waiting && ++waiting === 2) {
        try {
          assert.equal(fs.readFileSync(path.join(legacy, "legacy.txt"), "utf8"), "live legacy resource");
          const visible = fs.readdirSync(path.join(f.userDataDir, "modules", "rgss", "assets", "generations")).filter(name => !name.startsWith("."));
          assert.deepEqual(visible, []); Atomics.store(state, 0, 3); Atomics.notify(state, 0, 2);
        } catch (error) { reject(error); }
      }
      if (message.done) resolve(message.generationRoot);
    });
  }));
  const roots = await Promise.all(done);
  assert.equal(roots[0], roots[1]); assert.equal(fs.readdirSync(path.dirname(roots[0])).filter(name => !name.startsWith(".")).length, 1);
  assert.equal(fs.readFileSync(path.join(legacy, "legacy.txt"), "utf8"), "live legacy resource");
  assert.equal(Assets.getAssetsStatus(f.options).assetsStaged, true);
});

test("manager-wide explicit removal rejects while a different MKXP version uses shared assets", { timeout: 10000 }, async t => {
  const f = fixture(t), staged = Assets.ensureAssetsStaged(f.options);
  const coordinator = createRuntimeCoordinator({ userDataDir: f.userDataDir });
  const game = coordinator.client("different-game"), token = await game.acquireUse({ managerId: "mkxpz", version: "another-runtime-version", sourcePath: staged.generationRoot });
  await game.bindUse(token, process.pid);
  const launcher = createLauncher({ userDataDir: f.userDataDir, runtimeCoordinator: coordinator.client("remove-action") });
  const entry = { gameId: "asset-owner", moduleId: "rgss", gamePath: f.root, moduleData: { assetsStaged: true } };
  await assert.rejects(launcher.runAction(entry, "removeAssets"), error => error.code === "RUNTIME_IN_USE");
  assert.equal(Assets.getAssetsStatus(f.options).assetsStaged, true);
  assert.equal(entry.moduleData.assetsStaged, true);
  await game.release(token);
  const result = await launcher.runAction(entry, "removeAssets");
  assert.equal(result.assetsStaged, false); assert.equal(Assets.getAssetsStatus(f.options).assetsStaged, false);
});

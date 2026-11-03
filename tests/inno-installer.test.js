const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Header = require("../src/modules/shared/installers/inno-header");
const Inno = require("../src/modules/shared/installers/inno");
const Inputs = require("../src/modules/shared/installers");
const { untilTestEnds } = require("./helpers/fixture-process");

function loader({ external = true } = {}) {
  const bytes = Buffer.alloc(256); bytes.write("MZ");
  bytes.writeUInt32LE(0x6f6e6e49, 0x30); bytes.writeUInt32LE(64, 0x34); bytes.writeUInt32LE(~64 >>> 0, 0x38);
  Buffer.from("72446c507453cde6d77b0b2a", "hex").copy(bytes, 64);
  bytes.writeUInt32LE(1, 76); bytes.writeUInt32LE(128, 96); bytes.writeUInt32LE(external ? 0 : 224, 100);
  bytes.writeUInt32LE(Header.crc32(bytes.subarray(64, 104)), 104);
  bytes.write("Inno Setup Setup Data (5.5.7) (u)", 128);
  return bytes;
}
function fixture(t, { external = true, files = [{ path: "index.html", authoredPath: "{app}\\index.html", size: 16, location: 0 }] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-inno-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "setup.exe"), userDataDir = path.join(root, "data"), tool = path.join(root, "reader.cjs");
  fs.writeFileSync(file, loader({ external }));
  const metadata = { schemaVersion: 1, helperVersion: "fixture-v1", sourceRevision: "a".repeat(40), format: "inno", formatVersion: "5.5.7 (unicode)",
    headerOffset: 128, dataOffset: external ? 0 : 224, externalData: external, encrypted: false,
    requiredSlices: external ? [{ index: 0, names: ["setup-1.bin"] }] : [], files };
  fs.writeFileSync(path.join(root, "metadata.json"), JSON.stringify(metadata));
  fs.writeFileSync(tool, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),root=__dirname;
const mode=fs.existsSync(path.join(root,'mode'))?fs.readFileSync(path.join(root,'mode'),'utf8'):'';
fs.appendFileSync(path.join(root,'calls'),process.argv[2]+'\\n');
if(process.argv[2]==='--inspect-json'){console.log(fs.readFileSync(path.join(root,'metadata.json'),'utf8'));}
else {const out=process.argv[process.argv.indexOf('--output-dir')+1],info=JSON.parse(fs.readFileSync(path.join(root,'metadata.json')));
 for(const file of info.files){const dest=path.join(out,file.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,Buffer.alloc(mode==='corrupt'?file.size+1:file.size,32));}
 if(mode==='symlink'){fs.symlinkSync(path.join(root,'setup.exe'),path.join(out,'unexpected'));}
 if(mode==='wait'){${untilTestEnds}}if(mode==='fail')process.exitCode=1;
}
`, { mode: 0o755 });
  const helper = { version: metadata.helperVersion, sourceRevision: metadata.sourceRevision, identity: "b".repeat(64), inspector: tool, executable: tool };
  const options = { userDataDir, gameId: "testgame", helper };
  const slice = path.join(root, "setup-1.bin");
  return { root, file, slice, userDataDir, helper, options, metadata, calls: () => fs.readFileSync(path.join(root, "calls"), "utf8").trim().split("\n") };
}
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("structured Inno loader pointer, checksum and version gate reject strings in ordinary EXEs", t => {
  const f = fixture(t), info = Header.probeInno(f.file);
  assert.deepEqual([info.formatVersion, info.unicode, info.headerOffset, info.externalData], ["5.5.7", true, 128, true]);
  const bytes = loader(); bytes[104] ^= 1; fs.writeFileSync(f.file, bytes);
  assert.throws(() => Header.probeInno(f.file), /checksum/);
  fs.writeFileSync(f.file, Buffer.from("MZ" + " ".repeat(80) + "Inno Setup Setup Data (5.5.7) (u)"));
  assert.equal(Header.probeInno(f.file), null);
  assert.equal(Header.crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("embedded Inno file data can precede the setup header while offsets remain bounded", t => {
  const f = fixture(t, { external: false });
  const bytes = loader({ external: false });
  bytes.writeUInt32LE(112, 100);
  bytes.writeUInt32LE(Header.crc32(bytes.subarray(64, 104)), 104);
  fs.writeFileSync(f.file, bytes);
  const info = Header.probeInno(f.file);
  assert.deepEqual([info.headerOffset, info.dataOffset, info.externalData], [128, 112, false]);
  for (const offset of [bytes.length, 0xffffffff]) {
    bytes.writeUInt32LE(offset, 100);
    bytes.writeUInt32LE(Header.crc32(bytes.subarray(64, 104)), 104);
    fs.writeFileSync(f.file, bytes);
    assert.throws(() => Header.probeInno(f.file), /data offsets/);
  }
});

test("exact missing companion names are exposed before creating an extraction directory", async t => {
  const f = fixture(t), info = await Inno.inspectInstaller(f.file, { helper: f.helper });
  assert.deepEqual(info.missing, ["setup-1.bin"]);
  await assert.rejects(Inno.prepareInstaller(f.file, f.options), error => error.code === "INSTALLER_MISSING_PARTS" && /setup-1\.bin/.test(error.message));
  assert.equal(fs.existsSync(f.userDataDir), false);
  assert.ok(f.calls().every(value => value === "--inspect-json"));
});

test("complete external data extracts once, reuses one cache, and preserves both sources", async t => {
  const f = fixture(t); fs.writeFileSync(f.slice, "installer data");
  const before = [digest(f.file), digest(f.slice)];
  const first = await Inputs.prepareInput(f.file, f.options), second = await Inputs.prepareInput(f.file, f.options);
  assert.equal(first.inputPath, second.inputPath); assert.equal(second.containerData.cached, true);
  assert.deepEqual(f.calls(), ["--inspect-json", "--extract"]);
  assert.deepEqual([digest(f.file), digest(f.slice)], before);
  assert.equal(fs.readdirSync(path.dirname(first.inputPath)).includes("receipt.json"), true);
  assert.equal(fs.readdirSync(path.dirname(path.dirname(first.inputPath))).filter(name => /^[a-f0-9]{64}$/.test(name)).length, 1);
});

test("local-to-Included same-byte helper adoption ignores install path, timestamps and manifest presentation identity", async t => {
  const f = fixture(t); fs.writeFileSync(f.slice, "installer data");
  const first = await Inputs.prepareInput(f.file, f.options);
  const included = path.join(f.root, "Included"); fs.mkdirSync(included);
  const adoptedTool = path.join(included, "reader.cjs"); fs.copyFileSync(f.helper.executable, adoptedTool);
  fs.chmodSync(adoptedTool, 0o755); fs.utimesSync(adoptedTool, new Date(0), new Date(0));
  const adopted = { ...f.helper, executable: adoptedTool, inspector: adoptedTool, identity: "c".repeat(64) };
  assert.equal(await Inno.helperCacheIdentity(adopted), await Inno.helperCacheIdentity(f.helper));
  const warm = await Inputs.prepareInput(f.file, { ...f.options, helper: adopted });
  assert.equal(warm.inputPath, first.inputPath); assert.equal(warm.containerData.key, first.containerData.key);
  assert.equal(warm.containerData.cached, true); assert.equal(warm.containerData.helperIdentity, adopted.identity);
  assert.deepEqual(f.calls(), ["--inspect-json", "--extract"]);
  assert.equal(Inputs.findCachedInputGameId(f.userDataDir, f.file), f.options.gameId);
  assert.equal(fs.readdirSync(path.dirname(path.dirname(first.inputPath))).filter(name => /^[a-f0-9]{64}$/.test(name)).length, 1);
});

test("source inode replacement verifies archive bytes once without rehashing the mutable game", async t => {
  const f = fixture(t); fs.writeFileSync(f.slice, "installer data");
  const first = await Inputs.prepareInput(f.file, f.options), output = path.join(first.inputPath, "index.html");
  const replaceSameBytes = file => {
    const stat = fs.statSync(file), temp = file + ".replacement";
    fs.copyFileSync(file, temp); fs.utimesSync(temp, stat.atime, stat.mtime); fs.renameSync(temp, file);
  };
  replaceSameBytes(f.file); replaceSameBytes(f.slice); replaceSameBytes(output);
  const before = [Inno.identity(f.file), Inno.identity(f.slice), Inno.identity(output)];
  const streams = [], stream = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (file, options) => {
    assert.notEqual(file, output, "Warm reuse never hashes extracted game files");
    streams.push(file); return stream.call(fs, file, options);
  });
  const warm = await Inputs.prepareInput(f.file, f.options);
  assert.equal(warm.inputPath, first.inputPath); assert.equal(warm.containerData.key, first.containerData.key);
  assert.equal(warm.containerData.cached, true); assert.deepEqual(f.calls(), ["--inspect-json", "--extract"]);
  assert.deepEqual([Inno.identity(f.file), Inno.identity(f.slice), Inno.identity(output)], before);
  assert.equal(streams.filter(file => file === f.file).length, 1);
  assert.equal(streams.filter(file => file === f.slice).length, 1);
  streams.length = 0;
  assert.equal((await Inputs.prepareInput(f.file, f.options)).inputPath, first.inputPath);
  assert.ok(!streams.includes(f.file) && !streams.includes(f.slice), "Unchanged installer bytes are not reread");
  assert.deepEqual(f.calls(), ["--inspect-json", "--extract"]);
});

test("warm extracted projects accept added, edited and removed game files without walking or hashing them", async t => {
  const f = fixture(t, { external: false, files: [
    { path: "index.html", authoredPath: "{app}\\index.html", size: 16 },
    { path: "old-asset", authoredPath: "{app}\\old-asset", size: 8 }
  ] });
  const first = await Inputs.prepareInput(f.file, f.options), root = first.inputPath;
  fs.writeFileSync(path.join(root, "index.html"), "patched project source with different bytes and length");
  fs.unlinkSync(path.join(root, "old-asset"));
  fs.mkdirSync(path.join(root, "saves")); fs.writeFileSync(path.join(root, "saves/slot1"), "user save");
  fs.mkdirSync(path.join(root, "mods")); fs.writeFileSync(path.join(root, "mods/extra.js"), "user script");
  const inside = file => typeof file === "string" && (file === root || file.startsWith(root + path.sep));
  for (const owner of [fs, fs.promises]) {
    const name = owner === fs ? "readdirSync" : "readdir", original = owner[name];
    t.mock.method(owner, name, function (file, ...args) {
      assert.equal(inside(file), false, "Warm reuse must not enumerate the mutable game");
      return original.call(this, file, ...args);
    });
  }
  const stream = fs.createReadStream;
  t.mock.method(fs, "createReadStream", function (file, ...args) {
    assert.equal(inside(file), false, "Warm reuse must not hash the mutable game");
    return stream.call(this, file, ...args);
  });
  for (const readOnly of [false, true]) {
    const warm = await Inputs.prepareInput(f.file, { ...f.options, readOnly });
    assert.equal(warm.inputPath, root); assert.equal(warm.containerData.cached, true);
  }
  assert.equal(fs.readFileSync(path.join(root, "saves/slot1"), "utf8"), "user save");
  assert.equal(fs.readFileSync(path.join(root, "mods/extra.js"), "utf8"), "user script");
  assert.equal(fs.existsSync(path.join(root, "old-asset")), false);
  assert.deepEqual(f.calls(), ["--inspect-json", "--extract"]);
});

test("warm reuse rejects a missing or linked extraction root without replacing preserved game bytes", async t => {
  const f = fixture(t, { external: false });
  const first = await Inputs.prepareInput(f.file, f.options), preserved = first.inputPath + "-preserved";
  fs.renameSync(first.inputPath, preserved);
  fs.writeFileSync(path.join(preserved, "save.dat"), "user save");
  await assert.rejects(Inputs.prepareInput(f.file, f.options), error => error.code === "INSTALLER_CACHE_INVALID");
  assert.equal(fs.existsSync(first.inputPath), false);
  fs.symlinkSync(preserved, first.inputPath);
  await assert.rejects(Inputs.prepareInput(f.file, f.options), /symlinks/);
  assert.equal(fs.lstatSync(first.inputPath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(preserved, "save.dat"), "utf8"), "user save");
  assert.deepEqual(f.calls(), ["--inspect-json", "--extract"]);
});

test("read-only content verification never updates metadata or copies even after inode changes", async t => {
  const f = fixture(t); fs.writeFileSync(f.slice, "installer data");
  const first = await Inputs.prepareInput(f.file, f.options), directory = path.dirname(first.inputPath);
  const indexFile = path.join(path.dirname(directory), "current.json"), indexBefore = fs.readFileSync(indexFile);
  const namesBefore = fs.readdirSync(directory), temp = f.slice + ".replacement";
  fs.copyFileSync(f.slice, temp); fs.renameSync(temp, f.slice);
  const warm = await Inputs.prepareInput(f.file, { ...f.options, readOnly: true });
  assert.equal(warm.inputPath, first.inputPath); assert.equal(warm.containerData.cached, true);
  assert.deepEqual(fs.readFileSync(indexFile), indexBefore); assert.deepEqual(fs.readdirSync(directory), namesBefore);
  assert.deepEqual(f.calls(), ["--inspect-json", "--extract"]);
});

test("changed helper bytes invalidate compatibility while corrupted cached hashes never authorize reuse", async t => {
  const f = fixture(t); fs.writeFileSync(f.slice, "installer data");
  const first = await Inputs.prepareInput(f.file, f.options), before = await Inno.helperCacheIdentity(f.helper);
  fs.appendFileSync(f.helper.executable, "\n// changed implementation\n");
  assert.notEqual(await Inno.helperCacheIdentity(f.helper), before);
  const next = await Inputs.prepareInput(f.file, f.options);
  assert.notEqual(next.inputPath, first.inputPath); assert.equal(next.containerData.cached, false);
  assert.deepEqual(f.calls(), ["--inspect-json", "--extract", "--inspect-json", "--extract"]);
  const receiptFile = path.join(path.dirname(next.inputPath), "receipt.json"), receipt = JSON.parse(fs.readFileSync(receiptFile));
  receipt.files[0].sha256 = "forged"; fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  await assert.rejects(Inputs.prepareInput(f.file, f.options), error => error.code === "INSTALLER_CACHE_INVALID");
});

test("embedded-data installers use the same provider without inventing companion names", async t => {
  const f = fixture(t, { external: false });
  const result = await Inputs.prepareInput(f.file, f.options);
  assert.equal(result.containerData.format, "inno");
  assert.deepEqual(result.containerData.sources.map(item => item.path), [f.file]);
});

test("unsafe paths, case collisions and file-directory conflicts are rejected before extraction", async t => {
  for (const files of [
    [{ path: "../outside", authoredPath: "{app}\\outside", size: 1 }],
    [{ path: "safe", authoredPath: "{app}\\..\\outside", size: 1 }],
    [{ path: "A", authoredPath: "{app}\\A", size: 1 }, { path: "a", authoredPath: "{app}\\a", size: 1 }],
    [{ path: "dir", authoredPath: "{app}\\dir", size: 1 }, { path: "dir/file", authoredPath: "{app}\\dir\\file", size: 1 }]
  ]) {
    const f = fixture(t, { external: false, files });
    await assert.rejects(Inno.prepareInstaller(f.file, f.options), /unsafe|conflicting/);
    assert.deepEqual(f.calls(), ["--inspect-json"]); assert.equal(fs.existsSync(f.userDataDir), false);
  }
});

test("corrupt, failing and symlink outputs leave no published or partial cache", async t => {
  for (const mode of ["corrupt", "fail", "symlink"]) {
    const f = fixture(t, { external: false }); fs.writeFileSync(path.join(f.root, "mode"), mode);
    await assert.rejects(Inno.prepareInstaller(f.file, f.options));
    const cache = path.join(f.userDataDir, "games/testgame/containers/inno");
    assert.deepEqual(fs.readdirSync(cache), []);
  }
});

test("cancellation terminates the native child before removing its partial stage", async t => {
  const f = fixture(t, { external: false }); fs.writeFileSync(path.join(f.root, "mode"), "wait");
  const controller = new AbortController(); let nativePid;
  await assert.rejects(Inno.prepareInstaller(f.file, { ...f.options, signal: controller.signal, onSpawn(value) {
    if (value.args.includes("--extract")) { nativePid = value.pid; t.after(() => { try { process.kill(nativePid, "SIGKILL"); } catch {} }); setTimeout(() => controller.abort(), 100); }
  } }), error => error.name === "AbortError");
  assert.ok(nativePid); assert.throws(() => process.kill(nativePid, 0), error => error.code === "ESRCH");
  assert.deepEqual(fs.readdirSync(path.join(f.userDataDir, "games/testgame/containers/inno")), []);
});

test("installer source edits select a new generation without overwriting an edited game", async t => {
  const f = fixture(t); fs.writeFileSync(f.slice, "first");
  const first = await Inno.prepareInstaller(f.file, f.options);
  fs.writeFileSync(path.join(first.inputPath, "index.html"), "changed");
  assert.equal((await Inno.prepareInstaller(f.file, f.options)).inputPath, first.inputPath);
  fs.writeFileSync(f.slice, "second");
  const second = await Inno.prepareInstaller(f.file, f.options);
  assert.notEqual(first.containerData.key, second.containerData.key);
  assert.equal(fs.readFileSync(path.join(first.inputPath, "index.html"), "utf8"), "changed");
});

test("the generic provider leaves ordinary game inputs unchanged and does not resolve a native tool", async t => {
  const f = fixture(t); fs.writeFileSync(f.file, Buffer.from("MZ" + " ".repeat(128)));
  assert.deepEqual(await Inputs.prepareInput(f.file, {}), { inputPath: f.file, containerData: null });
  assert.equal(fs.existsSync(path.join(f.root, "calls")), false);
});

test("read-only resolution uses an existing cache but never unpacks a new installer", async t => {
  const f = fixture(t, { external: false });
  await assert.rejects(Inputs.prepareInput(f.file, { ...f.options, readOnly: true }), error => error.code === "INSTALLER_IMPORT_REQUIRED");
  assert.equal(fs.existsSync(f.userDataDir), false); assert.equal(fs.existsSync(path.join(f.root, "calls")), false);
  const ready = await Inputs.prepareInput(f.file, f.options);
  const cached = await Inputs.prepareInput(f.file, { ...f.options, readOnly: true });
  assert.equal(cached.inputPath, ready.inputPath); assert.equal(cached.containerData.cached, true);
  assert.deepEqual(f.calls(), ["--inspect-json", "--extract"]);
});

test("an engine detection failure can retry the same owned completed extraction", async t => {
  const f = fixture(t, { external: false });
  const ready = await Inputs.prepareInput(f.file, f.options);
  assert.equal(Inputs.findCachedInputGameId(f.userDataDir, f.file), f.options.gameId);
  const retried = await Inputs.prepareInput(f.file, { ...f.options, gameId: Inputs.findCachedInputGameId(f.userDataDir, f.file) });
  assert.equal(retried.inputPath, ready.inputPath); assert.deepEqual(f.calls(), ["--inspect-json", "--extract"]);
});

test("cached replay binds helper version, manifest, format, source list and recomputed key", async t => {
  const f = fixture(t, { external: false });
  const ready = await Inputs.prepareInput(f.file, f.options), directory = path.dirname(ready.inputPath);
  const receiptFile = path.join(directory, "receipt.json"), original = fs.readFileSync(receiptFile);
  const mutations = [
    value => { value.helperVersion = "different-v2"; },
    value => { value.helperIdentity = "c".repeat(64); },
    value => { value.format = "zip"; },
    value => { value.key = "d".repeat(64); },
    value => { value.sources[0].identity += ":changed"; },
    value => { value.sources.push({ path: path.join(f.root, "unrelated.bin"), identity: value.sources[0].identity }); }
  ];
  for (const mutate of mutations) {
    const receipt = JSON.parse(original); mutate(receipt); fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    await assert.rejects(Inputs.prepareInput(f.file, f.options), error => error.code === "INSTALLER_CACHE_INVALID");
  }
  fs.writeFileSync(receiptFile, original);
  const indexFile = path.join(path.dirname(directory), "current.json"), indexBytes = fs.readFileSync(indexFile), index = JSON.parse(indexBytes);
  // Even a coordinated edit of receipt.key and index.key cannot select a cache
  // generation whose key does not follow from the exact source/helper identity.
  const changedKey = "e".repeat(64), moved = path.join(path.dirname(directory), changedKey);
  fs.renameSync(directory, moved); index.key = changedKey;
  const receipt = JSON.parse(original); receipt.key = changedKey;
  fs.writeFileSync(path.join(moved, "receipt.json"), JSON.stringify(receipt)); fs.writeFileSync(indexFile, JSON.stringify(index));
  await assert.rejects(Inputs.prepareInput(f.file, f.options), error => error.code === "INSTALLER_CACHE_INVALID");
  assert.deepEqual(f.calls(), ["--inspect-json", "--extract"]);
  fs.renameSync(moved, directory); fs.writeFileSync(receiptFile, original); fs.writeFileSync(indexFile, indexBytes);
  assert.equal((await Inputs.prepareInput(f.file, f.options)).inputPath, ready.inputPath);
});

test("metadata's fast cache observes the installer receipt before reusing engine facts", async t => {
  const f = fixture(t, { external: false });
  const info = { id: "fixture", label: "Fixture", runtime: {} }, mod = { id: "fixture", manifest: info };
  const registry = { listModuleIds: () => [info.id], listModules: () => [info], getModuleInfo: () => info,
    getModule: () => mod, getModuleDir: () => path.join(f.root, "module"),
    detectGameAsync: async input => ({ moduleId: "fixture", name: "Fixture", gamePath: input, contentRootDir: input, moduleData: {} }) };
  const service = require("../src/core/game-metadata").createGameMetadataService({ userDataDir: f.userDataDir, registry,
    inputPreparation: (file, options) => Inputs.prepareInput(file, { ...f.options, ...options }) });
  const entry = await service.importEntry(f.file, {});
  require("../src/core/game-store").writeGameRecord(f.userDataDir, entry);
  await service.importEntry(f.file, {});
  const receiptFile = path.join(path.dirname(entry.containerData.extractedRoot), "receipt.json"), receipt = JSON.parse(fs.readFileSync(receiptFile));
  receipt.helperVersion = "tampered"; fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  await assert.rejects(service.importEntry(f.file, {}), error => error.code === "INSTALLER_CACHE_INVALID");
  assert.deepEqual(f.calls(), ["--inspect-json", "--extract"]);
});

test("the installer reader is a managed Tools package for its actual ARM host", () => {
  const manager = require("../src/modules/shared/installers/runtime/innoextract-manager");
  assert.equal(manager.id, "innoextract");
  assert.equal(manager.ui.groupId, "tools");
  assert.equal(manager.ui.management, "managed");
  assert.equal(require("../src/modules/shared/runtime/included-package-metadata").declarations(require("../src/modules/shared/installers/distribution-supplementals.json")).length, 0);
  assert.equal(require("../scripts/native-supplementals.cjs").declarations().some(item => item.id === "innoextract"), false);
  assert.equal(require("../src/modules/registry").listSharedRuntimeManagers().some(item => item.id === "innoextract"), true);
  assert.equal("recommendedVersion" in manager.getState({}).catalog, false);
});

test("a staged application reader never substitutes for a missing managed install", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inno-managed-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourcesRoot = path.resolve(__dirname, "../src/resources");
  assert.throws(() => Inno.resolveHelper({ userDataDir: root, resourcesRoot, arch: "arm64" }),
    error => error.code === "INSTALLER_TOOL_MISSING");
  assert.throws(() => Inno.resolveHelper({ userDataDir: root, resourcesRoot, arch: "x64" }),
    error => error.code === "INSTALLER_TOOL_MISSING");
});

test("Locate moves an installer's source set, reuses its extracted bytes and restores records on refusal", async t => {
  const f = fixture(t), Store = require("../src/core/game-store");
  fs.writeFileSync(f.slice, "installer data");
  let moduleId = "fixture";
  const registry = { listModuleIds: () => ["fixture"], listModules: () => [{ id: "fixture" }], getModuleInfo: id => ({ id }),
    getModule: () => null, getModuleDir: () => path.join(f.root, "module"),
    detectGameAsync: async input => ({ moduleId, gamePath: input, contentRootDir: input, name: "Fixture", moduleData: {} }) };
  const service = require("../src/core/game-metadata").createGameMetadataService({ userDataDir: f.userDataDir, registry,
    inputPreparation: (file, options) => Inputs.prepareInput(file, { ...f.options, ...options }) });
  const entry = await service.importEntry(f.file, {});
  Store.writeGameRecord(f.userDataDir, entry);
  const beforeFiles = fs.readFileSync(path.join(entry.gamePath, "index.html"));
  const movedDir = path.join(f.root, "Moved installer");
  fs.mkdirSync(movedDir);
  const moved = path.join(movedDir, "renamed.exe"), companion = path.join(movedDir, path.basename(f.slice));
  fs.renameSync(f.file, moved); fs.renameSync(f.slice, companion);
  const result = await service.relocateEntry(entry, moved, {});
  assert.equal(result.gameId, entry.gameId);
  assert.equal(result.gamePath, entry.gamePath, "the launcher-owned game is not moved or unpacked again");
  assert.equal(result.importPath, moved);
  assert.deepEqual(result.containerData.sources.map(source => source.path), [moved, companion]);
  assert.deepEqual(fs.readFileSync(path.join(result.gamePath, "index.html")), beforeFiles);
  assert.equal((await service.refreshEntry(result, {}, { force: true })).containerData.cached, true);
  assert.deepEqual(f.calls(), ["--inspect-json", "--extract"], "relocation and offline refresh do not extract again");
  const container = path.dirname(path.dirname(result.gamePath));
  const currentFile = path.join(container, "current.json"), current = fs.readFileSync(currentFile);
  const receiptFile = path.join(path.dirname(result.gamePath), "receipt.json"), receipt = fs.readFileSync(receiptFile);
  const wrong = path.join(movedDir, "other.exe");
  fs.copyFileSync(moved, wrong);
  moduleId = "other";
  await assert.rejects(service.relocateEntry(result, wrong, {}), error => error.code === "GAME_TYPE_MISMATCH");
  assert.deepEqual(Store.readGameRecord(f.userDataDir, entry.gameId), result);
  assert.deepEqual(fs.readFileSync(currentFile), current);
  assert.deepEqual(fs.readFileSync(receiptFile), receipt);
  // An installer with other contents is unpacked before detection. A refusal
  // removes that copy and keeps the game's existing one.
  const copies = fs.readdirSync(container).sort(), different = path.join(movedDir, "different.exe");
  fs.writeFileSync(different, Buffer.concat([fs.readFileSync(moved).subarray(0, -1), Buffer.from([1])]));
  await assert.rejects(service.relocateEntry(result, different, {}), error => error.code === "GAME_TYPE_MISMATCH");
  assert.deepEqual(f.calls().slice(-2), ["--inspect-json", "--extract"], "the other installer was unpacked");
  assert.deepEqual(fs.readdirSync(container).sort(), copies);
  assert.deepEqual(Store.readGameRecord(f.userDataDir, entry.gameId), result);
  assert.deepEqual(fs.readFileSync(currentFile), current);
  assert.deepEqual(fs.readFileSync(path.join(result.gamePath, "index.html")), beforeFiles);
});

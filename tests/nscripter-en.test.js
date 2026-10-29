const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Module = require("../src/modules/nscripter/main");
const Tools = require("../src/modules/nscripter/native-tools");
const Manager = require("../src/modules/nscripter/runtime/onscripter-en-manager");
const { detectGame } = require("../src/modules/nscripter/detect");
const Scan = require("../src/modules/nscripter/scan");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-ons-en-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "Original Windows game"); fs.mkdirSync(source);
  return { root, source, entry: { gameId: "original-game", contentRootDir: source, gamePath: source },
    context: { userDataDir: path.join(root, "userData"), settings: {}, runtimeSettings: {} } };
}

test("ONScripter-EN preserves offline source profiles while explicit refresh replaces Builds rows without upstream downloads", async t => {
  // Upstream releases publish Linux and Windows executables only; Mac packages come from MacLauncher Builds.
  let upstreamFetches = 0, catalogFetches = 0;
  const discovery = {
    fetchGithubReleases: async () => { upstreamFetches++; return [{ tag_name: "2025-06-08" }]; },
    fetchGithubTags: async () => { upstreamFetches++; return [{ name: "2025-06-08", commit: { sha: Manager.REVISION } }]; }
  };
  const repository = "procrastinine/maclauncher-builds";
  const record = (version, sourceSha256) => {
    const tag = `onscripter-en/v${version}/${process.arch}`, filename = `onscripter-en-${version}-${process.arch}.tar.gz`;
    return { schemaVersion: 2, id: "onscripter-en", version, arch: process.arch, launcherArchitectures: [process.arch], minimumMacOS: "13.0",
      manifestRelative: "manifest.json", manifestSha256: "1".repeat(64), sourceSha256, updatePolicy: "manual", tag,
      asset: { filename, bytes: 1, sha256: "2".repeat(64), url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${filename}` } };
  };
  let packages = [];
  const manager = Manager.createManager({ dependencies: { discovery, manager: { projectBuilds: {
    fetchUrlBuffer: async () => { catalogFetches++; return { status: 200, body: Buffer.from(JSON.stringify({
      schemaVersion: 2, projectId: "onscripter-en", updatePolicy: "manual", packages
    })) }; }
  } } } });
  assert.deepEqual(manager.getState().catalog.versions, []);
  assert.equal(manager.core.catalog.length, 11); assert.equal(catalogFetches, 0);
  const snapshot = manager.core.catalog.find(pin => pin.version === Manager.SNAPSHOT);
  assert.equal(snapshot.upstreamRevision, Manager.SNAPSHOT_REVISION);
  assert.equal(snapshot.upstreamTag, undefined);
  assert.deepEqual(snapshot.sourceScope, { kind: "primary-tree", omittedSubmodules: ["test/googletest"] });
  const profileSource = manager.core.catalog.find(pin => pin.version === Manager.PROFILE).sourceArtifact.sha256;
  packages = [record(Manager.SNAPSHOT, "3".repeat(64)), record(Manager.PROFILE, profileSource)];
  await manager.refreshCatalog({ force: true });
  assert.deepEqual([...manager.getState().catalog.versions].sort(), [Manager.PROFILE, Manager.SNAPSHOT].sort());
  packages = [record(Manager.SNAPSHOT, "3".repeat(64))];
  await manager.refreshCatalog({ force: true });
  assert.deepEqual(manager.getState().catalog.versions, [Manager.SNAPSHOT]);
  assert.equal(catalogFetches, 2); assert.equal(upstreamFetches, 0);
  assert.equal(manager.core.catalog.find(pin => pin.version === "2023-06-28-mac-v1").localBuild, false);
  assert.equal(manager.core.catalog.find(pin => pin.version === Manager.PROFILE).upstreamRevision, Manager.REVISION);
  assert.equal(manager.core.catalog.find(pin => pin.version === Manager.LEGACY_PROFILE).upstreamRevision, Manager.REVISION);
  assert.equal(manager.core.catalog.find(pin => pin.version === Manager.LEGACY_PROFILE).deprecated, true);
  const missing = manager.resolveSelection({ runtimeData: { onscripter_en: { version: "unknown" } } }, {});
  assert.equal(missing.version, "unknown"); assert.equal(missing.ready, false);
});

test("ONScripter-EN requires a version choice and preserves explicit older v1 and v2 selections", t => {
  const { entry, context } = fixture(t);
  assert.equal(Manager.resolveSelection(entry, {}, context.userDataDir).version, null);
  assert.equal(Manager.resolveSelection(entry, {}, context.userDataDir).selectionRequired, true);
  entry.runtimeData = { onscripter_en: { version: Manager.LEGACY_PROFILE } };
  assert.equal(Manager.resolveSelection(entry, {}, context.userDataDir).version, Manager.LEGACY_PROFILE);
  assert.deepEqual(Manager.distributionVersions, []);
  assert.equal(Manager.delivery.included, "none");
  entry.runtimeData = { onscripter_en: { version: Manager.PROFILE } };
  assert.equal(Manager.resolveSelection(entry, {}, context.userDataDir).version, Manager.PROFILE);
});

test("native saves import only known saves and leave originals and edited managed saves intact", t => {
  const { source, entry, context } = fixture(t);
  fs.writeFileSync(path.join(source, "save1.dat"), "original save");
  fs.writeFileSync(path.join(source, "envdata"), "original settings");
  fs.writeFileSync(path.join(source, "nscript.dat"), "script is not a save");
  const result = Tools.prepareNativeSaves(entry, context, source);
  assert.equal(result.saveDir, entry.defaultSaveDir);
  assert.equal(fs.existsSync(path.join(result.saveDir, "nscript.dat")), false);
  fs.writeFileSync(path.join(result.saveDir, "save1.dat"), "player edited save");
  Tools.prepareNativeSaves(entry, context, source);
  assert.equal(fs.readFileSync(path.join(result.saveDir, "save1.dat"), "utf8"), "player edited save");
  assert.equal(fs.readFileSync(path.join(source, "save1.dat"), "utf8"), "original save");
  assert.throws(() => Tools.prepareNativeSaves({ ...entry, saveDirOverride: "relative" }, context, source), /absolute/);
  assert.throws(() => Tools.moduleRoot({ gameId: "../escape" }, context), /persisted game id/);
  assert.equal(Module.resolveSaveLocations(entry, context).primaryDirectory, entry.defaultSaveDir);
  assert.equal(Module.resolveSaveLocations({ ...entry, runtimeId: "onsyuri_web" }, context).primaryDirectory, null);
  assert.equal(Module.resolveSaveLocations({ ...entry, runtimeId: "external" }, context).primaryDirectory, null);
});

test("NScripter source export decodes the published XOR formats without running or changing originals", t => {
  const { source, entry, context } = fixture(t), plain = Buffer.from('*define\ncaption "Example"\ngame\n*start\nend\n');
  const file = path.join(source, "nscript.dat"), encoded = Buffer.from(plain);
  for (let i = 0; i < encoded.length; i++) encoded[i] ^= 0x84;
  fs.writeFileSync(file, encoded);
  const first = Tools.exportScript(entry, context, source);
  assert.equal(fs.readFileSync(first.scriptPath, "utf8"), plain.toString()); assert.deepEqual(fs.readFileSync(file), encoded);
  fs.writeFileSync(first.scriptPath, "player modified export");
  Tools.exportScript(entry, context, source);
  const parent = path.dirname(first.directory), previous = fs.readdirSync(parent).find(name => name.startsWith("script.previous-"));
  assert.equal(fs.readFileSync(path.join(parent, previous, "0.txt"), "utf8"), "player modified export");
  fs.rmSync(file); const magic = [0x79, 0x57, 0x0d, 0x80, 0x04], secured = Buffer.from(plain);
  for (let i = 0; i < secured.length; i++) secured[i] ^= magic[i % 5];
  fs.writeFileSync(path.join(source, "nscr_sec.dat"), secured);
  assert.deepEqual(Tools.readScript(source).bytes, plain);
});

test("NScripter executable-key-table export follows upstream's first permutation and preserves original inputs", t => {
  const { source, entry, context } = fixture(t);
  const plain = Buffer.from('*define\ncaption "Key table"\ngame\n*start\nend\n');
  const permutation = Buffer.from(Array.from({ length: 256 }, (_, index) => (index * 73 + 41) & 255));
  const executableBytes = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(14), permutation, Buffer.from('tail')]);
  const executable = path.join(source, "original.exe"), script = path.join(source, "nscript.___");
  const encoded = Buffer.from(plain.map(value => permutation[value ^ 0x84]));
  fs.writeFileSync(executable, executableBytes); fs.writeFileSync(script, encoded); entry.importPath = executable;
  const key = Tools.readKeyTable(executable);
  assert.equal(key.tableOffset, 16);
  for (let index = 0; index < 256; index++) assert.equal(key.table[permutation[index]], index);
  const result = Tools.exportScript(entry, context, source);
  assert.equal(result.decoder, "maclauncher-nscript-v2"); assert.equal(result.format, "exe-key-table");
  assert.equal(result.keyExecutable.originalPath, executable); assert.equal(result.keyExecutable.tableOffset, 16);
  assert.equal(fs.readFileSync(result.scriptPath, "utf8"), plain.toString());
  assert.deepEqual(fs.readFileSync(executable), executableBytes); assert.deepEqual(fs.readFileSync(script), encoded);
  fs.writeFileSync(path.join(source, "other.exe"), executableBytes);
  assert.throws(() => Tools.resolveKeyExecutable(source), /original Windows executable/);
  fs.writeFileSync(executable, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(1024 * 1024)]));
  assert.throws(() => Tools.readKeyTable(executable), /no supported/);
});

test("ONScripter-EN automatically supplies the dragged original executable for encrypted scripts", async t => {
  const { source, entry, context } = fixture(t), executable = path.join(source, "original.exe");
  fs.writeFileSync(path.join(source, "nscript.___"), "encrypted script"); fs.writeFileSync(executable, "MZoriginal");
  entry.importPath = executable;
  t.mock.method(Manager, "resolveSelection", () => ({ ready: true, version: Manager.PROFILE, install: { executablePath: "/managed/bin/onscripter-en" } }));
  let arguments;
  context.spawnDetachedChecked = (_, args) => { arguments = args; return { native: true }; };
  await Module.launchRuntime("onscripter_en", entry, context);
  const keyIndex = arguments.indexOf("--key-exe");
  assert.ok(keyIndex >= 0); assert.equal(arguments[keyIndex + 1], executable);
  assert.equal(fs.readFileSync(executable, "utf8"), "MZoriginal");
});

test("declared ONScripter-EN Unicode formats are detected and text mode remains explicit", t => {
  const { source } = fixture(t); fs.writeFileSync(path.join(source, "00.utf.txt"), "*define\ngame\n*start\nend\n");
  assert.equal(detectGame({ rootDir: source }).engine, "nscripter");
  assert.equal(Tools.resolveTextMode(source), "english"); assert.equal(Tools.resolveTextMode(source, { textMode: "japanese" }), "japanese");
  assert.throws(() => Tools.resolveTextMode(source, { textMode: "english --root /tmp" }), /supported/);
});

test("NScripter plaintext detection validates bounded headers and rejects unrelated filenames", t => {
  const { source } = fixture(t), file = path.join(source, "0.txt");
  fs.writeFileSync(file, "Ordinary notes mentioning *define and game.\n");
  assert.equal(detectGame({ rootDir: source }), null);
  fs.writeFileSync(file, ""); assert.equal(detectGame({ rootDir: source }), null);
  const valid = Buffer.from('; comments\r\n*define\r\ncaption "Original"\r\ngame\r\n*start\r\nend\r\n');
  fs.writeFileSync(file, Buffer.concat([valid, Buffer.alloc(256 * 1024, 0x20)]));
  let read;
  const result = detectGame({ rootDir: source }, { readBytes: (target, offset, size) => {
    read = { target, offset, size }; return fs.readFileSync(target).subarray(offset, offset + size);
  } });
  assert.equal(read.size, Scan.MAX_DETECTION_SCRIPT_BYTES);
  assert.equal(result.detectionEvidence[0].type, "nscripter-script-header");
  assert.deepEqual(result.detectionEvidence[0].markers, ["*define", "caption"]);
  fs.rmSync(file); const encoded = Buffer.from(valid);
  for (let index = 0; index < encoded.length; index++) encoded[index] ^= 0x84;
  fs.writeFileSync(path.join(source, "nscript.dat"), encoded);
  assert.equal(detectGame({ rootDir: source }).moduleData.scriptFormat, "xor-84");
  fs.writeFileSync(path.join(source, "nscript.dat"), "arbitrary binary data");
  assert.equal(detectGame({ rootDir: source }), null);
});

test("ONScripter-EN launches from original assets with managed saves/config and optional native variable editor", async t => {
  const { source, entry, context } = fixture(t); fs.writeFileSync(path.join(source, "00.txt"), "*define\ngame\n*start\nend\n");
  fs.writeFileSync(path.join(source, "ons.cfg"), "window\n");
  t.mock.method(Manager, "resolveSelection", () => ({ ready: true, version: Manager.PROFILE, install: { executablePath: "/managed/bin/onscripter-en" } }));
  let launch;
  context.spawnDetachedChecked = (...args) => { launch = args; return { native: true }; };
  context.runtimeSettings.enableVariableEditor = true;
  context.gameArguments = ["--fullscreen", ""];
  const result = await Module.launchRuntime("onscripter_en", entry, context);
  assert.equal(result.native, true); assert.equal(launch[0], "/managed/bin/onscripter-en");
  assert.deepEqual(launch[1].slice(0, 4), ["--root", source, "--save", entry.defaultSaveDir + path.sep]);
  assert.ok(launch[1].includes("--japanese")); assert.ok(launch[1].includes("--edit"));
  assert.deepEqual(launch[1].slice(-2), ["--fullscreen", ""]);
  assert.equal(launch[2].cwd.startsWith(context.userDataDir + path.sep), true);
  assert.equal(fs.readFileSync(path.join(launch[2].cwd, "ons.cfg"), "utf8"), "window\n");
  assert.equal(fs.readFileSync(path.join(source, "ons.cfg"), "utf8"), "window\n");
  assert.equal(Module.ensureRuntime, undefined, "the shared runtime planner must retain Yuri's automatic installation route");
});

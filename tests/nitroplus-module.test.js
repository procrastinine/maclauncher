const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const Module = require("../src/modules/nitroplus/main");
const Inspect = require("../src/modules/nitroplus/inspect");
const runtimeFixture = { version: "fixture-nitroplus", revision: "a".repeat(40), npaRevision: "b".repeat(40), plugins: ["app", "audioconvert", "videoconvertscale"] };
const Manager = require("../src/modules/nitroplus/runtime/manager");
const { peFixture, versionResource } = require("./helpers/pe-fixture");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nitroplus-module-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function npa(entries = [{ name: "boot.nss", text: 'chapter main {\n#SCRIPT_VERSION="2.00";\n}\n' }], { compressed = false, encrypted = false } = {}) {
  const rows = [], payloads = [], key1 = 0x5cf58a1a, key2 = 0x689e1e0c, product = Math.imul(key1, key2) >>> 0;
  const sum = (product >>> 24) + ((product >>> 16) & 255) + ((product >>> 8) & 255) + (product & 255);
  let offset = 0;
  for (const [index, entry] of entries.entries()) {
    const name = Buffer.from(entry.name, "ascii"), size = Buffer.byteLength(entry.text || "payload"),
      payload = compressed ? zlib.deflateSync(Buffer.from(entry.text || "payload")) : Buffer.from(entry.text || "payload");
    const row = Buffer.alloc(4 + name.length + 17); row.writeUInt32LE(name.length);
    for (let i = 0; i < name.length; i++) row[4 + i] = (name[i] - 0xfc * i + sum + (index & 255) + ((index >>> 8) & 255)) & 255;
    const cursor = 4 + name.length; row[cursor] = 2;
    row.writeUInt32LE(offset, cursor + 5); row.writeUInt32LE(payload.length, cursor + 9); row.writeUInt32LE(size, cursor + 13);
    rows.push(row); payloads.push(payload); offset += payload.length;
  }
  const header = Buffer.alloc(41); Inspect.MAGIC.copy(header); header.writeInt32LE(key1, 7); header.writeInt32LE(key2, 11);
  header[15] = Number(compressed); header[16] = Number(encrypted); header.writeUInt32LE(entries.length, 17);
  header.writeUInt32LE(entries.length, 25); header.writeUInt32LE(rows.reduce((total, row) => total + row.length, 0), 37);
  return Buffer.concat([header, ...rows, ...payloads]);
}
function game(root, options = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "nss.npa"), npa(undefined, options));
  fs.writeFileSync(path.join(root, "system.npa"), npa([{ name: "system.ini", text: "[product]\nname=A Nitroplus Game\nversion=version2.00\n[script]\nstart=nss/boot.nss\n[window]\ntitle=A Nitroplus Game\nwidth=800\nheight=600\n" }]));
  fs.writeFileSync(path.join(root, "game.exe"), peFixture({ version: versionResource({ strings: { CompanyName: "Nitroplus", ProductName: "A Nitroplus Game" } }) }).bytes);
  return root;
}
function detect(root, inputPath = root) { return Module.detectGame({ rootDir: root, inputPath, isAppBundle: false }); }
function hash(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function install(root, version = runtimeFixture.version) {
  const executablePath = path.join(root, "bin/npengine-runner"), pluginRoot = path.join(root, "lib/gstreamer-1.0");
  fs.mkdirSync(path.dirname(executablePath), { recursive: true }); fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(executablePath, ["MACLAUNCHER_NPENGINE_SAVE_DIR", runtimeFixture.revision, runtimeFixture.npaRevision, "--check-scripts"].join("\0"), { mode: 0o755 });
  for (const plugin of runtimeFixture.plugins) fs.writeFileSync(path.join(pluginRoot, `libgst${plugin}.dylib`), "plugin fixture");
  fs.writeFileSync(path.join(root, "profile.json"), JSON.stringify({ version, sourceTreeSha256: "a".repeat(64), overlaySha256: "b".repeat(64),
    upstreamRevision: runtimeFixture.revision, npaRevision: runtimeFixture.npaRevision, plugins: runtimeFixture.plugins }));
  fs.writeFileSync(path.join(root, "fontconfig.conf"), "font configuration fixture");
  return { version, upstreamRevision: runtimeFixture.revision, executablePath, sha256: hash(executablePath) };
}

test("Nitroplus detection validates NPA/NSS data and distinguishes authored, product and executable versions", t => {
  const root = game(temporary(t)), detected = detect(root, path.join(root, "game.exe"));
  assert.equal(detected.moduleId, "nitroplus"); assert.equal(detected.runtimeId, "npengine");
  assert.equal(detected.name, "A Nitroplus Game"); assert.equal(detected.moduleData.scriptVersion, "2.00");
  assert.equal(detected.moduleData.productVersion, "version2.00");
  assert.equal(detected.moduleData.originalRunner.fileVersion, "1.5.7.23");
  assert.equal(detected.moduleData.detectedVersion, null); assert.match(detected.moduleData.originalRunner.source, /RT_VERSION/);
  assert.equal(Module.detectGame({ rootDir: root, inputPath: root, isAppBundle: true }), null);
  fs.writeFileSync(path.join(root, "nss.npa"), "NPA NSS Nitroplus".repeat(20)); assert.equal(detect(root), null);
});

test("Nitroplus bounded archive inspection rejects malformed indices, duplicate names and escaping paths", t => {
  const root = temporary(t), file = path.join(root, "nss.npa");
  for (const name of ["../boot.nss", "C:/boot.nss", "folder//boot.nss", "/boot.nss"]) {
    fs.writeFileSync(file, npa([{ name, text: "chapter main {}" }])); assert.equal(Inspect.inspectArchive(file), null);
  }
  fs.writeFileSync(file, npa([{ name: "boot.nss", text: "one" }, { name: "BOOT.NSS", text: "two" }])); assert.equal(Inspect.inspectArchive(file), null);
  const invalidRange = npa(); invalidRange.writeUInt32LE(0xffffffff, 41 + 4 + 8 + 5);
  fs.writeFileSync(file, invalidRange); assert.equal(Inspect.inspectArchive(file), null);
  const invalidCount = npa(); invalidCount.writeUInt32LE(Inspect.LIMITS.entries + 1, 17);
  fs.writeFileSync(file, invalidCount); assert.equal(Inspect.inspectArchive(file), null);
  const valid = npa(), reads = [];
  fs.writeFileSync(file, valid);
  const archive = Inspect.inspectArchive(file, { detection: { stat: fs.statSync, readBytes: (_file, offset, length) => { reads.push({ offset, length }); return valid.subarray(offset, offset + length); } } });
  assert.equal(archive.fileCount, 1); assert.deepEqual(reads.map(read => read.length), [41, archive.indexBytes]);
  assert.ok(reads.every(read => read.offset + read.length <= 41 + archive.indexBytes));
  assert.throws(() => Inspect.inspectArchive(file, { detection: { stat: () => { const error = new Error("limit"); error.code = "DETECTION_LIMIT"; throw error; } } }), /limit/);
});

test("Nitroplus compressed script tools enforce output sizes and encrypted data is detected without launch", t => {
  const root = game(temporary(t), { compressed: true });
  assert.equal(detect(root).moduleData.supported, true);
  const archive = Inspect.inspectArchive(path.join(root, "nss.npa"));
  assert.match(Inspect.decode(Inspect.readEntry(archive, archive.entries[0])), /chapter main/);
  assert.throws(() => Inspect.readEntry(archive, archive.entries[0], { maximum: 2 }), /limit/);
  game(root, { encrypted: true }); const encrypted = detect(root);
  assert.equal(encrypted.moduleData.supported, false);
  assert.throws(() => Module.ensureRuntime({ ...encrypted, gameId: "test" }, { userDataDir: temporary(t), settings: {} }), /NPA encryption format is unsupported/);
  game(root); fs.writeFileSync(path.join(root, "voice.npa"), npa([{ name: "voice.ogg", text: "audio fixture" }], { compressed: true }));
  assert.equal(detect(root).moduleData.supported, false);
  assert.match(detect(root).moduleData.compatibility, /Compressed NPA audio/);
  fs.rmSync(path.join(root, "voice.npa")); fs.writeFileSync(path.join(root, "cg.npa"), "invalid archive");
  assert.equal(detect(root).moduleData.supported, false); assert.deepEqual(detect(root).moduleData.invalidArchives, ["cg.npa"]);
});

test("Nitroplus ignores escaping symlinks and requires real NSS chapter metadata", t => {
  const root = game(temporary(t)), outside = game(temporary(t));
  fs.rmSync(path.join(root, "nss.npa")); fs.symlinkSync(path.join(outside, "nss.npa"), path.join(root, "nss.npa"));
  assert.equal(detect(root), null);
  fs.rmSync(path.join(root, "nss.npa")); fs.writeFileSync(path.join(root, "nss.npa"), npa([{ name: "boot.nss", text: "Nitroplus but no chapter" }]));
  assert.equal(detect(root), null);
});

test("Nitroplus launch preparation references original archives and confines generated data to the game", t => {
  const root = game(temporary(t)), userDataDir = temporary(t), runtime = install(temporary(t)), before = hash(path.join(root, "nss.npa"));
  const entry = { ...detect(root), gameId: "abc123" }, context = { userDataDir };
  Module.onImport(entry, context);
  const prepared = Module.__test.prepareLaunch(entry, context, runtime);
  assert.equal(prepared.args[prepared.args.indexOf("--game-root") + 1], root);
  assert.equal(prepared.saves, path.join(userDataDir, "games/abc123/modules/nitroplus/saves"));
  assert.equal(prepared.env.GST_PLUGIN_SYSTEM_PATH_1_0, "");
  assert.ok(prepared.env.GST_REGISTRY_1_0.startsWith(path.join(userDataDir, "games/abc123/")));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(prepared.directory, "preparation.json"))).copies, []);
  assert.equal(hash(path.join(root, "nss.npa")), before);
  entry.gameId = "../escape"; assert.throws(() => Module.onImport(entry, context), /persisted game id/);
});

test("Nitroplus explicit script extraction is private, bounded and preserves source hashes", t => {
  const root = game(temporary(t)), userDataDir = temporary(t), before = hash(path.join(root, "nss.npa"));
  const entry = { ...detect(root), gameId: "extract123" }, result = Module.actions.extractScripts(entry, {}, { userDataDir });
  assert.equal(result.count, 1); assert.equal(result.encoding, "UTF-8");
  assert.match(fs.readFileSync(path.join(result.directory, "boot.nss"), "utf8"), /chapter main/);
  assert.equal(hash(path.join(root, "nss.npa")), before);
  assert.throws(() => Module.actions.extractScripts(entry, {}, { userDataDir }), /already extracted/);
  Module.cleanupGameData(entry, { userDataDir }); assert.equal(fs.existsSync(result.directory), false);
  assert.equal(fs.existsSync(root), true);
});

test("Nitroplus profiles reject incomplete interpreter and plugin distributions", t => {
  const runtime = install(temporary(t));
  assert.equal(Module.__test.verifyProfile(runtime).upstreamRevision, runtimeFixture.revision);
  fs.rmSync(path.join(path.dirname(runtime.executablePath), "../lib/gstreamer-1.0/libgstapp.dylib"));
  assert.throws(() => Module.__test.distribution(runtime), /ENOENT/);
  const incomplete = { ...runtime, sha256: "different" };
  fs.writeFileSync(incomplete.executablePath, "stock interpreter"); assert.throws(() => Module.__test.verifyProfile(incomplete), /lacks NPA\/NSS/);
});

test("Nitroplus starts without source or package seeds and preserves an explicit choice", t => {
  const userDataDir = temporary(t);
  assert.deepEqual(Manager.core.listCatalog({ userDataDir }), []);
  assert.deepEqual(Manager.getState({ userDataDir }).catalog.versions, []);
  assert.equal(Manager.resolveSelection({ runtimeData: { npengine: { version: "fixture-choice" } } }, {}, userDataDir).version, "fixture-choice");
});

test("Nitroplus launches any installed Mac runtime whose payload declares the launcher interface", t => {
  const root = game(temporary(t)), userDataDir = temporary(t), entry = { ...detect(root), gameId: "version123" };
  assert.equal(Manager.resolveSelection(entry, {}, userDataDir).version, null);
  // A later Builds revision is installed through the normal flow, then launches from its own profile.
  const later = { ...entry, runtimeData: { npengine: { version: "0.5.3-MCLv2" } } };
  assert.equal(Module.ensureRuntime(later, { userDataDir, settings: {} }).version, "0.5.3-MCLv2");
  const runtime = install(temporary(t), "0.5.3-MCLv2");
  assert.equal(Module.__test.verifyProfile(runtime).npaRevision, runtimeFixture.npaRevision);
  assert.equal(Module.__test.distribution(runtime).profile.upstreamRevision, runtimeFixture.revision);
  const source = { ...entry, runtimeData: { npengine: { version: "0.5.2" } } };
  assert.equal(Module.ensureRuntime(source, { userDataDir, settings: {} }).version, "0.5.2", "an unknown explicit choice is retained until catalog discovery");
  assert.throws(() => Module.__test.verifyProfile({ ...runtime, upstreamRevision: "c".repeat(40) }), /profile differs from its package/);
  const profilePath = path.join(path.dirname(runtime.executablePath), "../profile.json"), profile = JSON.parse(fs.readFileSync(profilePath));
  fs.writeFileSync(profilePath, JSON.stringify({ ...profile, npaRevision: "c".repeat(40) }));
  assert.throws(() => Module.__test.verifyProfile({ ...runtime, sha256: "other" }), /lacks NPA\/NSS/);
  fs.writeFileSync(profilePath, JSON.stringify({ ...profile, plugins: [] }));
  assert.throws(() => Module.__test.distribution(runtime), /missing or incompatible/);
});

test("Nitroplus profiles agree with recorded package provenance even after a cached executable check", t => {
  const root = temporary(t), runtime = install(root, "0.5.3-MCLv1"), profilePath = path.join(root, "profile.json");
  const profile = { ...JSON.parse(fs.readFileSync(profilePath)),
    additionalSources: [{ id: "libnpa", upstreamRevision: runtimeFixture.npaRevision, sourceTreeSha256: "d".repeat(64) }] };
  runtime.buildProvenance = { sourceTreeSha256: profile.sourceTreeSha256, overlaySha256: profile.overlaySha256, additionalSources: profile.additionalSources };
  fs.writeFileSync(profilePath, JSON.stringify(profile));
  assert.doesNotThrow(() => Module.__test.verifyProfile(runtime));
  assert.doesNotThrow(() => Module.__test.distribution(runtime));
  for (const changed of [
    { sourceTreeSha256: "c".repeat(64) }, { overlaySha256: "c".repeat(64) }, { additionalSources: [] },
    { additionalSources: [{ ...profile.additionalSources[0], sourceTreeSha256: "c".repeat(64) }] },
    { additionalSources: [{ ...profile.additionalSources[0], upstreamRevision: "c".repeat(40) }] }
  ]) {
    fs.writeFileSync(profilePath, JSON.stringify({ ...profile, ...changed }));
    assert.throws(() => Module.__test.verifyProfile(runtime), /profile differs from its package/);
  }
  fs.writeFileSync(profilePath, JSON.stringify(profile));
  assert.doesNotThrow(() => Module.__test.verifyProfile({ ...runtime, buildProvenance: undefined }));
  assert.doesNotThrow(() => Module.__test.verifyProfile({ ...runtime, version: "0.5.3-macos-v9" }));
});

test("Nitroplus standalone preparation clears inherited dynamic-library fallbacks", t => {
  const root = game(temporary(t)), userDataDir = temporary(t), runtime = install(temporary(t));
  const previous = process.env.DYLD_FALLBACK_LIBRARY_PATH;
  try {
    process.env.DYLD_FALLBACK_LIBRARY_PATH = "/opt/homebrew/lib";
    const entry = { ...detect(root), gameId: "nativepaths" };
    const prepared = Module.__test.prepareLaunch(entry, { userDataDir }, runtime);
    assert.equal(prepared.env.DYLD_FALLBACK_LIBRARY_PATH, undefined);
    assert.equal(process.env.DYLD_FALLBACK_LIBRARY_PATH, "/opt/homebrew/lib");
  } finally {
    if (previous === undefined) delete process.env.DYLD_FALLBACK_LIBRARY_PATH; else process.env.DYLD_FALLBACK_LIBRARY_PATH = previous;
  }
});

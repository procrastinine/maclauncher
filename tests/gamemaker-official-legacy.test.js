const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Codec = require("../src/modules/gamemaker/runtime/official-legacy-zip");
const Legacy = require("../src/modules/gamemaker/runtime/official-legacy");
const Official = require("../src/modules/gamemaker/runtime/official");
const Installer = require("../src/modules/gamemaker/runtime/official-installer");
const Catalog = require("../src/modules/gamemaker/runtime/official-catalog");
const Compatibility = require("../src/modules/gamemaker/runtime/official-compatibility");

const Fixture = require("./helpers/gamemaker-official.cjs");
const filename = Fixture.legacyFilename;
const member = "Interpreted/Mac/bin/quitxcode.sh";
// One 39-byte member from the public vendor package. Its expected plaintext
// hash was checked independently with Python zipfile and vendor BouncyCastle.
const VECTOR = "UEsDBBQACQAIAFeLk0nnZPqsNQAAACcAAAAgAAAASW50ZXJwcmV0ZWQvTWFjL2Jpbi9xdWl0eGNvZGUuc2gyL6UCfiAZLJGw6dNTjcHOofGorWUVkcZBorquuNEPlqITytQd6f4FjQnsbXGqmxPeLO/2/lBLAQIzABQACQAIAFeLk0nnZPqsNQAAACcAAAAgAAAAAAAAAAAAAAAAAAAAAABJbnRlcnByZXRlZC9NYWMvYmluL3F1aXR4Y29kZS5zaFBLBQYAAAAAAQABAE4AAABzAAAAAAA=";
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "gm-legacy-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function vector(t, mutate) { const file = path.join(temporary(t), "fixture.zip"), bytes = Buffer.from(VECTOR, "base64"); mutate?.(bytes); fs.writeFileSync(file, bytes); return file; }

test("legacy public package decoder matches an independent encrypted vendor vector", t => {
  const file = vector(t), before = fs.readFileSync(file);
  const output = Codec.readPackageMember(file, filename, member);
  assert.equal(output.length, 39);
  assert.equal(crypto.createHash("sha256").update(output).digest("hex"), "6cb4c46ffc6003ba6b6d56a8ca9ee08419a1d2e31cd8df66245d2dbffd258096");
  assert.deepEqual(fs.readFileSync(file), before);
  assert.throws(() => Codec.readPackageMember(file, filename, member, { maxBytes: 20 }), /extraction limit/);
  assert.throws(() => Codec.readPackageMember(file, "renamed.zip", member), /published UUID/);
  assert.throws(() => Codec.readPackageMember(file, filename, "Mac/Mac-YoYoRunner.dmg"), /exactly one/);
});
test("legacy decoder checks CRC, headers and bounded input instead of extracting arbitrary members", t => {
  const crc = vector(t, bytes => bytes.writeUInt32LE((bytes.readUInt32LE(115 + 16) ^ 1) >>> 0, 115 + 16));
  assert.throws(() => Codec.readPackageMember(crc, filename, member), /CRC check/);
  const headers = vector(t, bytes => bytes.writeUInt16LE(99, 8));
  assert.throws(() => Codec.readPackageMember(headers, filename, member), /unsupported transport/);
  const file = vector(t), alias = file + ".alias"; fs.symlinkSync(file, alias);
  assert.throws(() => Codec.readPackageMember(alias, filename, member), /regular ZIP/);
});
test("legacy installation verifies discovered package size before any native tool and needs no Igor", async t => {
  const root = temporary(t), source = path.join(root, "original-game"); fs.mkdirSync(source); fs.writeFileSync(path.join(source, "data.win"), "unchanged original");
  const version = "1.4.2900"; await Fixture.discover(path.join(root, "userData"), { legacy: version });
  let nativeCalls = 0, downloadCalls = 0;
  await assert.rejects(Installer.installOfficialVersion({ userDataDir: path.join(root, "userData"), version,
    dependencies: { downloadToFile: async (url, file) => { downloadCalls++; assert.equal(url, `https://store.yoyogames.com/downloads/gm-studio/${filename}`); fs.writeFileSync(file, "changed ZIP"); },
      runProcess: async () => { nativeCalls++; throw new Error("No native tool should run"); } } }), /size or SHA-256/);
  assert.equal(nativeCalls, 0); assert.equal(downloadCalls, 1);
  assert.equal(fs.existsSync(path.join(root, "userData", "runtimes", "gamemaker-official", "tools")), false);
  assert.equal(fs.existsSync(path.join(root, "userData", "runtimes", "gamemaker-official", version)), false);
  assert.equal(fs.readFileSync(path.join(source, "data.win"), "utf8"), "unchanged original");
});
test("legacy feed release identities come from the exact validated cached row", async t => {
  const root = temporary(t);
  const xml = version => Fixture.legacyFeed(version).toString().match(/<item>[\s\S]*<\/item>/)[0];
  const body = Buffer.from(`<rss><channel>${xml("1.4.1804")}${xml("1.4.2900")}</channel></rss>`);
  const feed = Catalog.FEEDS.find(item => item.family === "studio-1.4"), entries = Catalog.parseFeed(body, feed);
  assert.equal(entries.length, 2); assert.ok(entries.every(Catalog.validateEntry));
  await Catalog.refreshCatalog({ userDataDir: root, sourceId: "official-3", fetch: async () => ({ status: 200, body }) });
  for (const entry of entries) assert.deepEqual(Installer.resolveBuild({ userDataDir: root, version: entry.version }).packages, entry.packages);
  assert.throws(() => Legacy.resolveBuild("1.4.2900", { ...entries[1], packages: [] }), /cached official catalog/);
  assert.throws(() => Installer.resolveBuild({ userDataDir: root, version: "1.4.2700" }), /Refresh/);
  assert.deepEqual(Official.manager.getState({ userDataDir: root }).catalog.versions, ["1.4.2900", "1.4.1804"]);
});
test("format constraints filter discovered rows and preserve exact choices", async t => {
  const root = temporary(t), settings = { runtimes: { "gamemaker-official": { defaultVersion: "2027.2.0.4" } } };
  const legacy = { moduleData: { executionKind: "studio-vm", wadVersion: 16, minimumEngineVersion: "1.4.1767" } };
  const explicitGlobal = Official.manager.resolveSelection(legacy, settings, root);
  assert.equal(explicitGlobal.version, "1.4.9999", "The game's WAD recommendation precedes the global default");
  assert.equal(explicitGlobal.ready, false);
  const cold = Official.manager.resolveSelection(legacy, {}, root);
  assert.equal(cold.version, "1.4.9999"); assert.equal(cold.discoveryRequired, true);
  await Fixture.discover(root, { legacy: "1.4.9999" });
  const selected = Official.manager.resolveSelection(legacy, {}, root);
  assert.equal(selected.version, "1.4.9999"); assert.equal(selected.catalogReady, true); assert.equal(selected.selectionSource, "catalog");
  assert.equal(selected.capability.generation, "studio-1.4");
  assert.deepEqual(Compatibility.capabilityForVersion("2.1.4.200").formatCandidates, []);
  assert.deepEqual(Compatibility.capabilityForVersion("2.2.6.900").formatCandidates, [16]);
  assert.equal(Compatibility.compatibility(legacy.moduleData, "2.2.6.900").compatible, true);
  assert.equal(Compatibility.compatibility(legacy.moduleData, "2.3.7.606").compatible, false);
  assert.equal(Compatibility.compatibility({ executionKind: "studio-vm", wadVersion: 17 }, "1.4.2900").compatible, false);
  assert.equal(Compatibility.compatibility({ wadVersion: 17, minimumEngineVersion: "2.3" }, "2.2.6.900").compatible, false);
  assert.equal(Compatibility.compatibility({ wadVersion: 17, maximumOfficialRuntimeExclusive: "2024.14" }, "2027.2.0.4").compatible, false);
  Fixture.legacyReceipt(root, "1.4.2700"); Fixture.legacyReceipt(root, "1.4.2800");
  assert.equal(Official.manager.resolveSelection(legacy, {}, root).version, "1.4.2800", "The WAD constraint retains compatible installed choices");
  const entry = { ...legacy, runtimeData: { "official-studio": { version: "1.4.2700" } } };
  assert.equal(Official.manager.resolveSelection(entry, settings, root).version, "1.4.2700");
  entry.runtimeData["official-studio"].version = "1.4.2600";
  const absent = Official.manager.resolveSelection(entry, settings, root);
  assert.equal(absent.version, "1.4.2600"); assert.equal(absent.ready, false);
});
test("a discovered legacy release installs with recorded native identities and reuses its receipt offline", async t => {
  const root = temporary(t), version = "1.4.2900"; await Fixture.discover(root, { legacy: version });
  let downloads = 0, images = 0;
  t.mock.method(Codec, "readPackageMember", (_archive, name, member) => { assert.equal(name, filename); assert.equal(member, "Mac/Mac-YoYoRunner.dmg"); return Buffer.from("fixture disk image"); });
  const result = await Installer.installOfficialVersion({ userDataDir: root, version, dependencies: {
    downloadToFile: async (url, output) => { downloads++; assert.equal(url, `https://store.yoyogames.com/downloads/gm-studio/${filename}`); fs.writeFileSync(output, "ZIP"); },
    extractRunnerApp: async (_image, app, options) => { images++; assert.equal(options.version, version); return Fixture.runnerApp(app); },
    runProcess: () => assert.fail("Legacy installation has no Igor prerequisite")
  } });
  assert.equal(result.ready, true); assert.equal(result.version, version); assert.deepEqual([downloads, images], [1, 1]);
  fs.rmSync(path.join(root, "runtimes/gamemaker-official/catalog.json"), { force: true });
  t.mock.method(Catalog, "cachedCatalog", () => null);
  assert.equal(Official.manager.core.resolveInstalled({ userDataDir: root, version }).ready, true);
  assert.equal(Official.manager.resolveSelection({}, {}, root).version, version, "An unset default reuses a verified installed receipt offline");
  assert.equal(Official.manager.resolveSelection({}, {runtimes:{"gamemaker-official":{defaultVersion:null}}}, root).selectionRequired, true);
  assert.equal(Official.manager.resolveSelection({ runtimeData: { "official-studio": { version } } }, {}, root).version, version);
  fs.appendFileSync(result.diskImagePath, "tampered");
  assert.equal(Official.manager.core.resolveInstalled({ userDataDir: root, version }), null);
});

test("detected WAD and sequence recommendations preserve compatible fallbacks and explicit selection layers", async t => {
  const root = temporary(t), inspection = { executionKind: "studio-vm", wadVersion: 17, spriteSequenceLayout: "legacy-32", minimumEngineVersion: "2.3" };
  assert.deepEqual(Compatibility.defaultCandidates(inspection), ["2.3.7.476", "2024.11.0.227"]);
  assert.deepEqual(Compatibility.defaultCandidates({ ...inspection, minimumEngineVersion: "2022.0" }), ["2024.11.0.227"]);
  assert.deepEqual(Compatibility.defaultCandidates({ wadVersion: 16 }), ["1.4.9999"]);
  assert.deepEqual(Compatibility.defaultCandidates({}), [], "No game evidence produces no package-wide recommendation");
  const cold = Official.manager.resolveSelection({ moduleData: inspection }, {}, root);
  assert.equal(cold.version, "2.3.7.476"); assert.equal(cold.recommendedVersion, "2.3.7.476"); assert.equal(cold.discoveryRequired, true);
  const versions = ["2024.12.0.1", "2024.11.0.227", "2.3.7.476"];
  const body = Buffer.from('<rss><channel>' + versions.map(version => Fixture.modernFeed(version).toString().match(/<item>[\s\S]*<\/item>/)[0]).join('') + '</channel></rss>');
  await Catalog.refreshCatalog({ userDataDir: root, fetch: async url => ({ status: 200, body: url.includes('update-studio.rss') ? Fixture.legacyFeed("1.4.9999") : body }) });
  assert.equal(Official.manager.resolveSelection({ moduleData: inspection }, {}, root).version, "2.3.7.476");
  const explicit = { moduleData: inspection, runtimeData: { "official-studio": { version: "2024.12.0.1" } } };
  assert.equal(Official.manager.resolveSelection(explicit, {}, root).version, "2024.12.0.1");
  const defaults = { runtimes: { "gamemaker-official": { defaultVersion: "2024.11.0.227" } } };
  assert.equal(Official.manager.resolveSelection({ moduleData: inspection }, defaults, root).version, "2.3.7.476", "The game recommendation precedes the Runtimes default");
  assert.equal(Official.manager.resolveSelection({}, defaults, root).version, "2024.11.0.227");
  const legacy = { moduleData: { executionKind: "studio-vm", wadVersion: 16 } };
  Fixture.legacyReceipt(root, "1.4.2800");
  assert.equal(Official.manager.resolveSelection(legacy, {}, root).version, "1.4.2800", "Compatible installed runners remain a WAD-derived choice");
  Fixture.legacyReceipt(root, "1.4.9999"); Fixture.legacyReceipt(root, "1.4.10000");
  assert.equal(Official.manager.resolveSelection(legacy, {}, root).version, "1.4.9999", "The detected format recommendation ranks compatible installed choices");
  assert.equal(Official.manager.resolveSelection({}, {}, root).version, "1.4.10000", "The committed installed fallback applies only while the default is unset");
  assert.equal(Official.manager.resolveSelection({}, {runtimes:{"gamemaker-official":{defaultVersion:null}}}, root).version, null);
  const facts = Compatibility.capabilityForVersion("2.2.5.378");
  assert.deepEqual(facts.testedWadVersions, [16]); assert.equal(facts.observation.workaround, "software-opengl");
  assert.match(facts.observation.binarySha256, /^[a-f0-9]{64}$/); assert.equal('result' in facts.observation, false);
});

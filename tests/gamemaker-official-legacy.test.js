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

const filename = Legacy.BUILD.packages[0].filename;
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
test("legacy installation verifies reviewed bytes before any native tool and needs no Igor", async t => {
  const root = temporary(t), source = path.join(root, "original-game"); fs.mkdirSync(source); fs.writeFileSync(path.join(source, "data.win"), "unchanged original");
  let nativeCalls = 0, downloadCalls = 0;
  await assert.rejects(Installer.installOfficialVersion({ userDataDir: path.join(root, "userData"), version: "1.4.9999",
    dependencies: { downloadToFile: async (url, file) => { downloadCalls++; assert.equal(url, Legacy.BUILD.packages[0].url); fs.writeFileSync(file, "changed ZIP"); },
      runProcess: async () => { nativeCalls++; throw new Error("No native tool should run"); } } }), /size or SHA-256/);
  assert.equal(nativeCalls, 0); assert.equal(downloadCalls, 1);
  assert.equal(fs.existsSync(path.join(root, "userData", "runtimes", "gamemaker-official", "tools")), false);
  assert.equal(fs.existsSync(path.join(root, "userData", "runtimes", "gamemaker-official", "1.4.9999")), false);
  assert.equal(fs.readFileSync(path.join(source, "data.win"), "utf8"), "unchanged original");
});
test("legacy feed exposes historical releases while only reviewed native packages install", t => {
  const root = temporary(t), pin = Legacy.BUILD.packages[0];
  const xml = version => `<item><enclosure sparkle:version="${version}"><module name="Mac" url="${pin.publishedUrl}" sparkle:version="${version}" length="${pin.bytes}" sparkle:dsaSignature="${pin.signature}"/></enclosure></item>`;
  const entries = Catalog.parseFeed(Buffer.from(`<rss><channel>${xml("1.4.1804")}${xml("1.4.9999")}</channel></rss>`), Catalog.FEEDS.find(item => item.family === "studio-1.4"));
  assert.equal(entries.length, 2); assert.ok(entries.every(Catalog.validateEntry));
  assert.equal(entries[1].packages[0].url, pin.url); assert.equal(entries[1].packages[0].publishedUrl, pin.publishedUrl);
  assert.equal(Installer.resolveBuild({ userDataDir: root, version: "1.4.9999" }).family, "studio-1.4");
  assert.throws(() => Installer.resolveBuild({ userDataDir: root, version: "1.4.1804" }), /no supported 64-bit/);
  assert.throws(() => Legacy.resolveBuild("1.4.9999", { ...entries[1], packages: [{ ...entries[1].packages[0], bytes: 1 }] }), /package metadata changed/);
  assert.deepEqual(Official.manager.getState({ userDataDir: root }).catalog.versions, []);
});
test("WAD generation and structural floors choose a compatible global official build offline", t => {
  const root = temporary(t), settings = { runtimes: { "gamemaker-official": { defaultVersion: "2026.0.0.23" } } };
  const legacy = { moduleData: { executionKind: "studio-vm", wadVersion: 16, rawVersion: "1.0.0.1539", minimumEngineVersion: "1.4.1767" } };
  const selected = Official.manager.resolveSelection(legacy, settings, root);
  assert.equal(selected.version, "1.4.9999"); assert.equal(selected.catalogReady, true); assert.equal(selected.selectionSource, "format-generation-default");
  assert.equal(selected.capability.generation, "studio-1.4");
  assert.deepEqual(Compatibility.capabilityForVersion("2.1.4.200").formatCandidates, []);
  assert.equal(Compatibility.compatibility(legacy.moduleData, "2.2.5.378").compatible, true);
  assert.deepEqual(Compatibility.capabilityForVersion("1.4.9999").testedWadVersions, [16]);
  assert.equal(selected.capability.observation.renderingStable, false);
  assert.equal(Compatibility.compatibility(legacy.moduleData, "1.4.9999").compatible, true);
  assert.ok(selected.capability.observation.gameLimitations.some(limit => /software rendering remains unstable/.test(limit)));
  assert.deepEqual(Compatibility.capabilityForVersion("2.2.5.378").testedWadVersions, [16]);
  assert.equal(Compatibility.compatibility(legacy.moduleData, "2.3.7.606").compatible, false);
  assert.equal(Compatibility.compatibility({ executionKind: "studio-vm", wadVersion: 17 }, "1.4.9999").compatible, false);
  assert.equal(Compatibility.compatibility({ wadVersion: 17, minimumEngineVersion: "2.3" }, "2.2.5.378").compatible, false);
  assert.equal(Compatibility.compatibility({ wadVersion: 17, maximumOfficialRuntimeExclusive: "2024.14" }, "2026.0.0.23").compatible, false);
  assert.equal(Official.manager.resolveSelection({ moduleData: { wadVersion: 13, executionKind: "studio-vm" } }, settings, root).version, null);
  const explicit = Official.manager.resolveSelection({ ...legacy, runtimeData: { "official-studio": { version: "2026.0.0.23" } } }, settings, root);
  assert.equal(explicit.version, "2026.0.0.23"); assert.match(explicit.reason, /WAD 16/); assert.equal(explicit.selectionSource, "explicit-selection");
  const matching = Official.manager.resolveSelection({ ...legacy, runtimeData: { "official-studio": { version: "1.4.9999" } } }, settings, root);
  assert.equal(matching.version, "1.4.9999"); assert.equal(matching.selectionSource, "explicit-selection");
});

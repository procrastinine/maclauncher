const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const X = require("../src/modules/kirikiri/xp3");
const D = require("../src/modules/kirikiri/detect");
const Kiri = require("../src/modules/kirikiri/main");
const Native = require("../src/modules/shared/runtime/local-native");
const managedFixtures = new Map();

function resourcePackage(root, { version = "fixture-kag3-v1", revision = "1".repeat(40), additional = {} } = {}) {
  if (managedFixtures.has(root)) return managedFixtures.get(root);
  const installDir = path.join(root, "install"), payload = path.join(installDir, "project-payload"), files = path.join(payload, "files");
  const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
  const write = (relative, bytes, mode = 0o644) => {
    const target = path.join(files, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { mode }); fs.chmodSync(target, mode);
    return { path: relative, size: Buffer.byteLength(bytes), mode, sha256: hash(bytes) };
  };
  const resources = {};
  for (const [name, bytes] of Object.entries({
    "PolyfillInitialize.tjs": "// fixture initializer\n", "KAGParser.tjs": "// fixture parser\n",
    "MenuItem_stub.tjs": "// fixture menu\n", "font.ttf": "fixture font", "FONT_LICENSE.txt": "Fixture license\n", ...additional
  })) resources[name] = write("share/kag3-polyfill/" + name, bytes);
  const resourceManifest = { schema: 1, id: "kag3-sdl2-polyfill", upstreamRevision: revision,
    sourceUrl: `https://github.com/krkrsdl2/kag3/tree/${revision}`,
    files: Object.fromEntries(Object.entries(resources).map(([name, file]) => [name, { sha256: file.sha256, size: file.size }])) };
  const resourceFile = write("share/kag3-polyfill/manifest.json", JSON.stringify(resourceManifest));
  const executable = Buffer.alloc(32); executable.writeUInt32LE(0xfeedfacf); executable.writeUInt32LE(process.arch === "arm64" ? 0x0100000c : 0x01000007, 4); executable.writeUInt32LE(2, 12);
  const binary = { ...write("krkrsdl2", executable, 0o755), architectures: [process.arch === "arm64" ? "arm64" : "x86_64"] };
  const upstreamRevision = "124bdf841f09e7ce02aa99b7b55791a0f7a900ff";
  const manifest = { schemaVersion: 1, managerId: "krkrsdl2", version, upstreamRevision, platform: "darwin", arch: process.arch,
    minimumMacOS: "13.0", executableRelative: "krkrsdl2", runtimeFiles: { kag3Manifest: resourceFile.path },
    files: [binary, ...Object.values(resources), resourceFile], dependencies: [], provenance: { sourceRevision: upstreamRevision },
    notices: [{ name: "Fixture", license: "MIT", sourceUrl: "https://github.com/krkrsdl2/kag3", path: resources["FONT_LICENSE.txt"].path }] };
  const manifestBytes = JSON.stringify(manifest); fs.writeFileSync(path.join(payload, "manifest.json"), manifestBytes, { mode: 0o644 });
  const record = { schemaVersion: 2, id: "krkrsdl2", version, arch: process.arch, launcherArchitectures: [process.arch],
    minimumMacOS: "13.0", manifestRelative: "manifest.json", manifestSha256: hash(manifestBytes), sourceSha256: "9".repeat(64),
    updatePolicy: "manual", source: { repository: "krkrsdl2/krkrsdl2", revision: upstreamRevision }, capabilities: { kag3Resources: 1 } };
  const install = { installDir, version, upstreamRevision, runtimePath: path.join(files, binary.path), binarySha256: binary.sha256,
    runtimeFiles: { kag3Manifest: "project-payload/files/" + resourceFile.path }, catalogEntry: { projectPackage: record } };
  const result = { install, record, manifest, resourceManifest, payload, files, resourceFile };
  managedFixtures.set(root, result); return result;
}
function chunk(tag, bytes) { const head = Buffer.alloc(12); head.write(tag, 0, "ascii"); head.writeBigUInt64LE(BigInt(bytes.length), 4); return Buffer.concat([head, bytes]); }
function archive(file, items, { fused = false, chain = false, protectedEntry = false, encryptProtected = false } = {}) {
  const prefix = fused ? Buffer.alloc(512, 0x4d) : Buffer.alloc(0), header = Buffer.alloc(19); X.MAGIC.copy(header);
  const start = chain ? 36 : 19, blobs = [], entries = []; let cursor = start;
  for (const [name, value] of items) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value), stored = encryptProtected ? bytes.map(byte => byte ^ 0xa5) : bytes,
      packed = zlib.deflateSync(stored), encoded = Buffer.from(name, "utf16le"), info = Buffer.alloc(22);
    info.writeUInt32LE(protectedEntry ? 0x80000000 : 0, 0); info.writeBigUInt64LE(BigInt(bytes.length), 4); info.writeBigUInt64LE(BigInt(packed.length), 12); info.writeUInt16LE(encoded.length / 2, 20);
    const segment = Buffer.alloc(28); segment.writeUInt32LE(1, 0); segment.writeBigUInt64LE(BigInt(cursor), 4); segment.writeBigUInt64LE(BigInt(bytes.length), 12); segment.writeBigUInt64LE(BigInt(packed.length), 20);
    const checksum = Buffer.alloc(4); checksum.writeUInt32LE(X.adler32(bytes));
    entries.push(chunk("File", Buffer.concat([chunk("info", Buffer.concat([info, encoded])), chunk("segm", segment), chunk("adlr", checksum)]))); blobs.push(packed); cursor += packed.length;
  }
  const index = Buffer.concat(entries), packedIndex = zlib.deflateSync(index), block = Buffer.alloc(17); block[0] = 1; block.writeBigUInt64LE(BigInt(packedIndex.length), 1); block.writeBigUInt64LE(BigInt(index.length), 9);
  header.writeBigUInt64LE(BigInt(chain ? 19 : cursor), 11);
  const pointer = Buffer.alloc(chain ? 17 : 0); if (chain) { pointer[0] = 0x80; pointer.writeBigUInt64LE(BigInt(cursor), 9); }
  fs.writeFileSync(file, Buffer.concat([prefix, header, pointer, ...blobs, block, packedIndex])); return file;
}

function versionFacts(data) {
  return Object.fromEntries(["detectedVersion", "detectedVersionConfidence", "detectedVersionSource", "engineGeneration", "kagVersion", "tjsVersion"].map(key => [key, data[key]]));
}

test("KiriKiri declared version source stays stable through real cold/warm preparation and tracks genuine source changes", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kiri-metadata-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, "original"), selectedRoot = path.join(root, "selected-alias"); fs.mkdirSync(game); fs.symlinkSync(game, selectedRoot);
  let selected = path.join(selectedRoot, "data.xp3"), actual = path.join(game, "data.xp3");
  const writeGame = (version, member = "System/INITIALIZE.tjs") => archive(actual, [
    ["startup.tjs", 'Scripts.execStorage("' + member + '");'],
    [member, 'var kagVersion = "' + version + '";'],
    ["Config.tjs", ';saveDataLocation = "savedata";'], ["image/background.dat", "original asset"]
  ]);
  writeGame("3.24 stable");
  const detect = () => D.detectGame({ rootDir: selectedRoot, inputPath: selected, stat: fs.statSync(selected) });
  const detected = detect(), entry = { ...detected, gameId: "metadata-stable" };
  const initial = versionFacts(entry.moduleData), originalHash = Native.hashFile(actual);
  assert.equal(initial.detectedVersionSource, actual + "!/System/INITIALIZE.tjs explicit script version constant");
  assert.equal(initial.detectedVersion, "KAG 3.24 stable"); assert.equal(initial.detectedVersionConfidence, "declared");
  const runtime = resourcePackage(path.join(root, "managed-runtime"));
  const manager = Kiri.runtimeManagers.find(value => value.id === "krkrsdl2");
  t.mock.method(manager, "resolveSelection", () => ({ ready: true, version: runtime.install.version, install: runtime.install }));
  const context = { userDataDir: path.join(root, "profile"), runtimeId: "krkrsdl2", runtimeSettings: {}, settings: {} };
  const cold = Kiri.prepareLaunch(entry, context);
  assert.equal(cold.cached, false); assert.equal(cold.versionSource, initial.detectedVersionSource);
  assert.deepEqual(versionFacts(entry.moduleData), initial, "preparation preserves the authored version and its exact source evidence");
  assert.ok(fs.readFileSync(path.join(cold.preparedRoot, "startup.tjs"), "utf8").includes("system_polyfill/PolyfillInitialize.tjs"));
  assert.match(fs.readFileSync(path.join(cold.preparedRoot, "Config.tjs"), "utf8"), /saveDataLocation = System\.dataPath/);
  assert.equal(Native.hashFile(actual), originalHash, "the real compatibility preparation does not modify source bytes");
  const receipt = path.join(cold.preparedRoot, "profile.json"), stamp = new Date(1000000000000);
  const existing = JSON.parse(fs.readFileSync(receipt, "utf8"));
  existing.versionSource = actual + "!/System/INITIALIZE.tjs explicit script version constant after bounded extraction";
  const existingBytes = JSON.stringify(existing, null, 2); fs.writeFileSync(receipt, existingBytes); fs.utimesSync(receipt, stamp, stamp);
  const warm = Kiri.prepareLaunch(entry, context);
  assert.equal(warm.cached, true); assert.equal(warm.preparedRoot, cold.preparedRoot);
  assert.deepEqual(versionFacts(entry.moduleData), initial); assert.equal(warm.versionSource, initial.detectedVersionSource);
  assert.equal(fs.statSync(receipt).mtimeMs, stamp.getTime(), "unchanged warm metadata does not rewrite the preparation receipt");
  assert.equal(fs.readFileSync(receipt, "utf8"), existingBytes, "warm current evidence is independent of an existing receipt's presentation label");

  writeGame("3.25 authored");
  await Kiri.ensureRuntime(entry, context);
  assert.equal(entry.moduleData.detectedVersion, "KAG 3.25 authored", "a changed authored version is not suppressed");
  const updated = Kiri.prepareLaunch(entry, context);
  assert.equal(updated.cached, false); assert.notEqual(updated.preparedRoot, warm.preparedRoot);
  assert.equal(entry.moduleData.detectedVersion, "KAG 3.25 authored");
  assert.equal(entry.moduleData.detectedVersionSource, initial.detectedVersionSource);

  const previousSource = entry.moduleData.detectedVersionSource;
  writeGame("3.25 authored", "Initialize.tjs");
  const movedMember = Kiri.prepareLaunch(entry, context);
  assert.equal(movedMember.cached, false); assert.equal(entry.moduleData.detectedVersion, "KAG 3.25 authored");
  assert.notEqual(entry.moduleData.detectedVersionSource, previousSource, "same version in a genuinely different member retains its new source evidence");
  assert.equal(entry.moduleData.detectedVersionSource, detect().moduleData.detectedVersionSource);
  assert.equal(entry.moduleData.detectedVersionSource, actual + "!/Initialize.tjs explicit script version constant");

  const formerSource = entry.moduleData.detectedVersionSource, renamed = path.join(game, "renamed.xp3"); fs.renameSync(actual, renamed);
  actual = renamed; selected = path.join(selectedRoot, "renamed.xp3"); entry.moduleData.archivePath = selected;
  const movedArchive = Kiri.prepareLaunch(entry, context);
  assert.equal(movedArchive.cached, false); assert.notEqual(entry.moduleData.detectedVersionSource, formerSource);
  assert.equal(entry.moduleData.detectedVersionSource, detect().moduleData.detectedVersionSource);
  assert.equal(entry.moduleData.detectedVersionSource, actual + "!/Initialize.tjs explicit script version constant");
});

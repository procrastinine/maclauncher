const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const Sharing = require("../src/modules/android/prepared-sharing"), Cache = require("../src/modules/android/prepared-cache");
const {fileHash} = require("../src/modules/android/prepare");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "android-prepared-sharing-")));
  t.after(() => fs.rmSync(profile, {recursive: true, force: true}));
  const directory = path.join(profile, "android/apps/example/prepared"); fs.mkdirSync(directory, {recursive: true});
  function generation(letter, execution = "jvm") {
    const key = letter.repeat(64), root = path.join(directory, key), files = [];
    function write(name, bytes, mode = 0o600) { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), {recursive: true}); fs.writeFileSync(p, bytes, {mode}); return {name, sha256: hash(bytes), size: Buffer.byteLength(bytes)}; }
    const apk = write("base.apk", Buffer.alloc(1024 * 1024, 2)), jar = execution === "art" ? null : write("converted.jar", "converted code");
    const elf = Buffer.alloc(128 * 1024, 7); elf.set([0x7f, 0x45, 0x4c, 0x46]);
    files.push({...write("input/lib/arm64-v8a/libexample.so", elf, 0o700), name: "lib/arm64-v8a/libexample.so"});
    if (execution !== "art") files.push({...write("input/assets/map.bin", Buffer.alloc(512 * 1024, 5)), name: "assets/map.bin"});
    const receipt = {schemaVersion: 2, key, sourceName: "base.apk", apkSha256: apk.sha256, ...(jar ? {convertedSha256: jar.sha256} : {execution, assetStorage: "apk"}), files};
    fs.writeFileSync(path.join(root, "prepared.json"), JSON.stringify(receipt)); return {root, receipt, write};
  }
  return {profile, directory, generation};
}

test("Immutable APK, asset, native ELF and converted inputs share generations without linking imports or data", async t => {
  const {profile, directory, generation} = fixture(t), a = generation("a"), b = generation("b"), art = generation("c", "art");
  const raw = path.join(profile, "original.apk"), data = path.join(profile, "android/apps/example/data/save");
  fs.copyFileSync(path.join(a.root, "base.apk"), raw); fs.mkdirSync(path.dirname(data), {recursive: true}); fs.writeFileSync(data, "converted code");
  const before = fs.statSync(path.join(b.root, "base.apk")).ino;
  const result = await Cache.locked(directory, () => Sharing.shareInputs(directory, b.root, b.receipt, {hashFile: fileHash}));
  assert.equal(result.linkedFiles, 4); assert.ok(result.sharedBytes > 1024 * 1024);
  for (const name of ["base.apk", "converted.jar", "input/assets/map.bin", "input/lib/arm64-v8a/libexample.so"]) assert.equal(fs.statSync(path.join(a.root, name)).ino, fs.statSync(path.join(b.root, name)).ino);
  assert.notEqual(before, fs.statSync(path.join(b.root, "base.apk")).ino);
  assert.notEqual(fs.statSync(raw).ino, fs.statSync(path.join(b.root, "base.apk")).ino);
  assert.notEqual(fs.statSync(data).ino, fs.statSync(path.join(b.root, "converted.jar")).ino);
  await Cache.locked(directory, () => Sharing.shareInputs(directory, art.root, art.receipt, {hashFile: fileHash}));
  assert.equal(fs.statSync(path.join(art.root, "base.apk")).ino, fs.statSync(path.join(a.root, "base.apk")).ino);
  assert.equal(fs.statSync(path.join(art.root, "input/lib/arm64-v8a/libexample.so")).mode & 0o777, 0o700);
  fs.rmSync(a.root, {recursive: true}); assert.equal(await fileHash(path.join(b.root, "base.apk")), b.receipt.apkSha256);
  assert.equal(fs.readFileSync(data, "utf8"), "converted code");
});

test("Edited candidates, incompatible modes, aliases and Mach-O files cannot replace verified inputs", async t => {
  const {directory, generation} = fixture(t), a = generation("a"), b = generation("b");
  fs.writeFileSync(path.join(a.root, "base.apk"), Buffer.alloc(1024 * 1024, 3));
  fs.chmodSync(path.join(a.root, "input/assets/map.bin"), 0o400);
  const native = path.join(a.root, "input/lib/arm64-v8a/libexample.so"); fs.unlinkSync(native); fs.symlinkSync(path.join(a.root, "converted.jar"), native);
  const bytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]);
  for (const value of [a, b]) { const row = value.write("input/assets/host.dylib", bytes); value.receipt.files.push({...row, name: "assets/host.dylib"}); fs.writeFileSync(path.join(value.root, "prepared.json"), JSON.stringify(value.receipt)); }
  const result = await Cache.locked(directory, () => Sharing.shareInputs(directory, b.root, b.receipt, {hashFile: fileHash}));
  assert.equal(result.linkedFiles, 1, "only the independently verified converted JAR matches");
  assert.equal(await fileHash(path.join(b.root, "base.apk")), b.receipt.apkSha256);
  assert.notEqual(fs.statSync(path.join(a.root, "input/assets/host.dylib")).ino, fs.statSync(path.join(b.root, "input/assets/host.dylib")).ino);
  assert.equal(fs.lstatSync(path.join(b.root, "input/lib/arm64-v8a/libexample.so")).isSymbolicLink(), false);
});

test("Explicit consolidation honors both source leases and reader inspection", async t => {
  const {directory, generation} = fixture(t), a = generation("a"), b = generation("b");
  const release = await Cache.locked(directory, () => Cache.retainLocked(b.root));
  const bInode = fs.statSync(path.join(b.root, "base.apk")).ino;
  let result = await Cache.consolidatePrepared(directory, {canRewrite: async () => false}); assert.equal(result.linkedFiles, 0);
  result = await Cache.consolidatePrepared(directory, {canRewrite: async () => true});
  assert.ok(result.skipped.includes(b.root)); assert.equal(fs.statSync(path.join(b.root, "base.apk")).ino, bInode, "leased destination identity never changes");
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.root, "prepared.json"))).sharedInputsVersion, 1, "maintenance marks warm generations once");
  // Release uses the original cache pruner. No extra sharing store survives it.
  await release();
  const remaining = Cache.generationPaths(directory); assert.ok(remaining.length >= 1);
  assert.equal(await fileHash(path.join(remaining[0], "base.apk")), a.receipt.apkSha256);
});

test("Cross-game hints skip an owned source lock, then share verified bytes without a blob copy", async t => {
  const {profile, directory, generation} = fixture(t), a = generation("a");
  await Cache.locked(directory, () => Sharing.shareInputs(directory, a.root, a.receipt, {hashFile: fileHash}));
  const b = generation("b");
  const other = path.join(profile, "android/apps/other/prepared"); fs.mkdirSync(other, {recursive: true});
  const moved = path.join(other, path.basename(b.root)); fs.renameSync(b.root, moved); b.root = moved;
  const release = await require("../src/modules/android/catalog-lock").acquireCatalogLock(path.join(path.dirname(directory), ".preparation.lock"));
  let shared;
  try {
    shared = await Cache.locked(other, () => Sharing.shareInputs(other, b.root, b.receipt, {hashFile: fileHash}));
    assert.equal(shared.linkedFiles, 0, "a busy source is skipped, never awaited while another package is owned");
  } finally { await release(); }
  shared = await Cache.locked(other, () => Sharing.shareInputs(other, b.root, b.receipt, {hashFile: fileHash}));
  assert.equal(shared.linkedFiles, 3, "APK, native ELF and large asset share across app identities");
  assert.equal(fs.statSync(path.join(a.root, "input/assets/map.bin")).ino, fs.statSync(path.join(b.root, "input/assets/map.bin")).ino);
  assert.notEqual(fs.statSync(path.join(a.root, "converted.jar")).ino, fs.statSync(path.join(b.root, "converted.jar")).ino, "small files do not bloat the profile hint index");
  fs.rmSync(a.root, {recursive: true});
  assert.equal(await fileHash(path.join(b.root, "base.apk")), b.receipt.apkSha256, "retiring the original path leaves the shared input intact");
  const index = JSON.parse(fs.readFileSync(path.join(profile, "android/.prepared-content.json")));
  assert.equal(index.schemaVersion, 1); assert.ok(fs.statSync(path.join(profile, "android/.prepared-content.json")).size < 8192);
  assert.equal(fs.existsSync(path.join(profile, "android/blobs")), false);
});

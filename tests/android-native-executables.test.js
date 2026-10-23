const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const {spawnSync} = require("node:child_process");
const Sharing = require("../src/modules/android/prepared-sharing"), Cache = require("../src/modules/android/prepared-cache");
const {installedExecutables} = require("../src/modules/android/native-executables");
const Sandbox = require("../src/modules/android/sandbox");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const hashFile = async file => hash(fs.readFileSync(file));

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "android-shared-execute-"))), releases = [];
  t.after(async () => { for (const release of releases.reverse()) await release(); fs.rmSync(root, {recursive: true, force: true}); });
  const elf = Buffer.alloc(128 * 1024); elf.writeUInt32LE(0x464c457f); elf[4] = 2; elf[5] = 1; elf[6] = 1;
  elf.writeUInt16LE(3, 16); elf.writeUInt16LE(183, 18); elf.writeUInt32LE(1, 20); elf.writeBigUInt64LE(64n, 32);
  elf.writeUInt16LE(64, 52); elf.writeUInt16LE(56, 54); elf.writeUInt16LE(1, 56); elf.writeUInt32LE(1, 64);
  const index = path.join(root, "android/.prepared-content.json"), data = path.join(root, "data"), files = path.join(data, "files"), cache = path.join(data, "cache");
  for (const directory of [files, cache]) fs.mkdirSync(directory, {recursive: true});
  function generation(app, letter, execution = "art") {
    const key = letter.repeat(64), directory = path.join(root, "android/apps", app, "prepared"), generation = path.join(directory, key);
    const native = path.join(generation, "input/lib/arm64-v8a"), file = path.join(native, "libhelper.so"), apk = path.join(generation, "base.apk");
    fs.mkdirSync(native, {recursive: true}); fs.writeFileSync(file, elf, {mode: 0o700}); fs.writeFileSync(apk, "original archive");
    if (execution === "jvm") fs.writeFileSync(path.join(generation, "converted.jar"), "converted code");
    const receipt = {schemaVersion: 2, key, execution, sourceName: "base.apk", apkSha256: hash("original archive"),
      ...(execution === "jvm" ? {convertedSha256: hash("converted code")} : {}),
      files: [{name: "lib/arm64-v8a/libhelper.so", sha256: hash(elf), size: elf.length}]};
    fs.writeFileSync(path.join(generation, "prepared.json"), JSON.stringify(receipt));
    return {directory, generation, native, file, apk, receipt};
  }
  const share = (value, digest = hashFile) => Cache.locked(value.directory, () => Sharing.shareInputs(value.directory, value.generation, value.receipt, {hashFile: digest}));
  return {root, data, files, cache, elf, index, releases, generation, share};
}

test("shared ELF eligibility covers leased VM generations, cross-package aliases and legacy receipts", async t => {
  const f = fixture(t), a = f.generation("example", "a"), b = f.generation("example", "b", "jvm"), c = f.generation("other", "c");
  f.releases.push(await Cache.locked(a.directory, () => Cache.retainLocked(a.generation)));
  await f.share(b); await f.share(c);
  assert.equal(fs.statSync(c.file).nlink, 3);
  assert.deepEqual(await installedExecutables([c.native], [f.data]), [c.file], "off-directory aliases are verified without granting them");
  const index = JSON.parse(fs.readFileSync(f.index));
  assert.equal(Object.values(index.nativeAliases)[0].members.length, 3);
  delete index.nativeAliases; fs.writeFileSync(f.index, JSON.stringify(index));
  assert.deepEqual(await installedExecutables([a.native, b.native, c.native], [f.data]), [a.file, b.file, c.file], "legacy two-hint index recovers all three published members");
  const receiptFile = path.join(b.generation, "prepared.json"), original = fs.readFileSync(receiptFile);
  fs.writeFileSync(receiptFile, JSON.stringify({...b.receipt, files: [{...b.receipt.files[0], sha256: "d".repeat(64)}]}));
  assert.deepEqual(await installedExecutables([c.native], [f.data]), [], "cached membership still requires every current original receipt");
  fs.writeFileSync(receiptFile, original);
  fs.rmSync(b.generation, {recursive: true});
  assert.equal(fs.statSync(c.file).nlink, 2);
  assert.deepEqual(await installedExecutables([c.native], [f.data]), [c.file], "retired member does not invalidate surviving shared code");
  assert.equal(Object.values(JSON.parse(fs.readFileSync(f.index)).nativeAliases)[0].members.length, 2);
  assert.equal(fs.statSync(a.file).ino, fs.statSync(c.file).ino);
  assert.deepEqual(await installedExecutables([c.native], [f.data, a.native]), [], "a known writable member denies the shared inode");
  const foreign = path.join(f.root, "foreign-link"); fs.linkSync(c.file, foreign);
  assert.deepEqual(await installedExecutables([c.native], [f.data]), [], "unaccounted foreign link is not authenticated by matching bytes");
  fs.unlinkSync(foreign);
  const writable = path.join(f.files, "writable-link"); fs.linkSync(c.file, writable);
  assert.deepEqual(await installedExecutables([c.native], [f.data]), []);
  fs.unlinkSync(writable);
  assert.deepEqual(await installedExecutables([c.native], [f.data]), [c.file]);
  const changed = Buffer.from(f.elf); changed[changed.length - 1] = 1; fs.writeFileSync(c.file, changed);
  assert.deepEqual(await installedExecutables([c.native], [f.data]), [], "unchanged ELF header cannot hide modified receipt bytes");
});

test("concurrent shared ELF publications preserve complete membership after source link-count changes", async t => {
  const f = fixture(t), a = f.generation("example", "a"), b = f.generation("example", "b"), c = f.generation("example", "c");
  let ready = 0, release;
  const bothHashed = new Promise(resolve => { release = resolve; });
  const digest = async file => {
    const value = await hashFile(file);
    if (file === a.file) { if (++ready === 2) release(); await bothHashed; }
    return value;
  };
  // One existing package owner admits both operations. Only the profile
  // publication sections serialize; both source hashes precede either link.
  const results = await Cache.locked(a.directory, () => Promise.all([b, c].map(value =>
    Sharing.shareInputs(value.directory, value.generation, value.receipt, {hashFile: digest}))));
  assert.deepEqual(results.map(value => value.linkedFiles), [2, 2], "each publication shares its APK and native ELF");
  assert.equal(fs.statSync(a.file).nlink, 3);
  assert.deepEqual(await installedExecutables([b.native, c.native], [f.data]), [b.file, c.file]);
  assert.equal(Object.values(JSON.parse(fs.readFileSync(f.index)).nativeAliases)[0].members.length, 3);
});

test("actual sandbox keeps exact shared ELF execution checks and rejects writable/foreign aliases", {skip: process.platform !== "darwin"}, async t => {
  const f = fixture(t), a = f.generation("example", "a"), b = f.generation("example", "b", "jvm"), c = f.generation("other", "c");
  await f.share(b); await f.share(c);
  const runtime = path.join(f.root, "runtime"), java = path.join(runtime, "bin/java");
  fs.mkdirSync(path.dirname(java), {recursive: true}); fs.mkdirSync(path.join(runtime, "lib"));
  const compile = spawnSync("/usr/bin/clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0",
    path.join(__dirname, "fixtures/android-sandbox/native-shared-execute-probe.c"), "-o", java], {encoding: "utf8"});
  assert.equal(compile.status, 0, compile.stderr); fs.writeFileSync(path.join(runtime, "lib/jspawnhelper"), "unused");
  const configFile = path.join(f.root, "launch.json"); fs.writeFileSync(configFile, "{}");
  const prepare = () => Sandbox.prepareSandbox({javaPath: java, configFile, dataRoot: f.data, blockNetwork: true,
    config: {runtimeRoot: runtime, nativeRoot: c.native, filesRoot: f.files, cacheRoot: f.cache},
    installedPackages: [a, b].map(value => ({sourceApks: [value.apk], nativeRoot: value.native}))});
  async function check(allowed) {
    const sandbox = await prepare();
    const grants = sandbox.profile.split("(allow process-exec ")[1].split("(allow process-fork)")[0];
    assert.ok(!grants.includes("(subpath "));
    for (const value of [a, b, c]) assert.equal(grants.includes('(literal "' + value.file + '")'), allowed);
    const result = spawnSync(sandbox.command, [...sandbox.prefix, ...[a, b, c].map(value => (allowed ? "+" : "-") + value.file)],
      {env: sandbox.environment, cwd: f.files, encoding: "utf8", timeout: 20000});
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /PASS exact shared ELF X_OK/);
  }
  await check(true);
  const writable = path.join(f.files, "writable-link"); fs.linkSync(c.file, writable); await check(false); fs.unlinkSync(writable);
  const foreign = path.join(f.root, "foreign-link"); fs.linkSync(c.file, foreign); await check(false); fs.unlinkSync(foreign);
  await check(true);
});

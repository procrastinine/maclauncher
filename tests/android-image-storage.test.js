const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const Images = require("../src/modules/android/providers/aim/image-storage");
const { prepareSystem } = require("../src/modules/android/providers/aim");
const { directoryForImage } = require("../src/modules/android/providers/aim/image-cache");
const { maintainStorage } = require("../src/core/storage-maintenance");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-image-storage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, "profile"), runtime = { root: path.join(root, "runtime"), manifest: { files: [] } };
  runtime.bin = path.join(runtime.root, "bin");
  const overlay = "schema = 1\n";fs.mkdirSync(path.join(runtime.root, "image"), { recursive: true });
  fs.writeFileSync(path.join(runtime.root, "image/overlay.toml"), overlay);
  runtime.manifest.files.push({ path: "image/overlay.toml", sha256: crypto.createHash("sha256").update(overlay).digest("hex") });
  const image = { sha256: "d".repeat(64) }, directory = directoryForImage(profile, runtime, image);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "system.dmg"), "original base");fs.writeFileSync(path.join(directory, "derived.shadow"), "original shadow");
  fs.mkdirSync(path.join(directory, "userdata"));fs.writeFileSync(path.join(directory, "userdata/save"), "private data");
  const data = path.join(profile, "android/apps/game/data");fs.mkdirSync(data, { recursive: true });fs.writeFileSync(path.join(data, "save"), "app data");
  const logs = [], context = { userDataDir: profile, logger: { info: line => logs.push(line) },
    confirmRuntimeInstall: () => assert.fail("A retained base needs no download") };
  let calls = 0;
  const prepare = capture => prepareSystem({ context, runtime }, { image, capture: async (...args) => {
    calls++;if (capture) await capture(...args);
    fs.mkdirSync(path.join(directory, "derived/root"), { recursive: true });
    fs.writeFileSync(path.join(directory, "derived/root/.identity"), "b".repeat(64));return "";
  } });
  const write = (name, value = "stray content") => { const file = path.join(directory, name);fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, value);return file; };
  const retired = () => fs.readdirSync(directory).filter(name => Images.RETIRED.test(name));
  const preserved = () => {
    assert.equal(fs.readFileSync(path.join(directory, "system.dmg"), "utf8"), "original base");
    assert.equal(fs.readFileSync(path.join(directory, "derived.shadow"), "utf8"), "original shadow");
    assert.equal(fs.readFileSync(path.join(directory, "userdata/save"), "utf8"), "private data");
    assert.equal(fs.readFileSync(path.join(data, "save"), "utf8"), "app data");
  };
  return { profile, directory, context, logs, write, prepare, retired, preserved, calls: () => calls };
}

test("Play retires a fresh stale image tree inline, without background upkeep or deletion", async t => {
  const f = fixture(t);f.write("system/root.identity", "a".repeat(64));f.write("system/root/system/file");f.write("derived/root/.identity", "b".repeat(64));
  await f.prepare(() => { assert.equal(fs.existsSync(path.join(f.directory, "system")), false);assert.equal(fs.existsSync(path.join(f.directory, "derived")), false); });
  assert.equal(f.calls(), 1);assert.equal(f.retired().length, 2);assert.equal(f.logs.length, 1);f.preserved();
  assert.ok(f.retired().some(name => fs.existsSync(path.join(f.directory, name, "root/system/file"))), "Renaming preserves the old bytes until upkeep");
  const store = require("../src/modules/android/derived-stores").find(row => row.id === "android-retired-aim-image-trees");
  assert.ok(store.match.source.startsWith("^") && store.match.source.endsWith("$"));assert.equal(store.match.test(".maclauncher-aim-retired-not-a-uuid"), false);
  assert.equal((await maintainStorage({ userDataDir: f.profile, stores: [store] })).removed, 0, "Recent retired trees stay");
  const result = await maintainStorage({ userDataDir: f.profile, stores: [store], now: Date.now() + store.minAgeMs + 1000 });
  assert.deepEqual(result.errors, []);assert.equal(result.removed, 2);assert.equal(f.retired().length, 0);f.preserved();
});

test("Finder metadata and unrecognized contents cannot block image preparation", async t => {
  const f = fixture(t);f.write("system/.DS_Store", "Finder metadata");f.write("system/._root", "AppleDouble");f.write("system/unrecognized", "preserved unknown bytes");
  await f.prepare(() => assert.equal(fs.existsSync(path.join(f.directory, "system")), false));
  assert.equal(f.retired().length, 1);assert.equal(f.logs.length, 1);
  const retired = path.join(f.directory, f.retired()[0]);
  assert.equal(fs.readFileSync(path.join(retired, ".DS_Store"), "utf8"), "Finder metadata");
  assert.equal(fs.readFileSync(path.join(retired, "unrecognized"), "utf8"), "preserved unknown bytes");f.preserved();
});

test("a partial older image without root.identity recovers immediately after an interrupted preparation", async t => {
  const f = fixture(t);f.write("system/root/system/bin/partial", "partial extraction");
  await assert.rejects(f.prepare(() => { throw Error("Interrupted after retirement"); }), /Interrupted after retirement/);
  assert.equal(f.retired().length, 1);assert.equal(fs.existsSync(path.join(f.directory, "system")), false);
  await f.prepare();assert.equal(f.calls(), 2);assert.equal(f.retired().length, 1);assert.equal(f.logs.length, 1);
  assert.equal(fs.readFileSync(path.join(f.directory, f.retired()[0], "root/system/bin/partial"), "utf8"), "partial extraction");f.preserved();
});

test("mounted targets stay attached, and a busy nested mount produces one clear error", async t => {
  const f = fixture(t), system = path.join(f.directory, "system"), derived = path.join(f.directory, "derived");
  f.write("system/root.identity", "a".repeat(64));f.write("derived/root/.identity", "b".repeat(64));
  const lstat = fs.lstatSync, readdir = fs.readdirSync;
  t.mock.method(fs, "lstatSync", (file, ...args) => {
    const stat = lstat(file, ...args);
    return [system, derived].includes(file) ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: stat.dev + 1 }) : stat;
  });
  t.mock.method(fs, "readdirSync", (file, ...args) => {
    assert.ok(![system, derived].includes(file), "Mounted target contents need no inspection");return readdir(file, ...args);
  });
  await f.prepare();assert.equal(f.retired().length, 0);assert.equal(f.logs.length, 0);f.preserved();
  t.mock.restoreAll();
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => { if (from === system) throw Object.assign(Error("busy mount"), { code: "EBUSY" });return rename(from, to); });
  assert.throws(() => Images.retireMountTargets(f.directory, f.context), error => error.code === "ANDROID_IMAGE_IN_USE" && /Close the other Android session/.test(error.message));
  assert.equal(f.retired().length, 0);assert.ok(fs.existsSync(path.join(system, "root.identity")));f.preserved();
});

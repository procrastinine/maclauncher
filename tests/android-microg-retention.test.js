const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { keepReleases } = require("../src/modules/android/google/package-retention");
const { readJson, maintainStorage } = require("../src/core/storage-maintenance");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-microg-retention-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "android/google/packages"), rows = new Map();
  for (const version of ["1.0.0", "2.0.0", "3.0.0"]) {
    const release = path.join(directory, version);fs.mkdirSync(release, { recursive: true });
    const packages = ["com.google.android.gms", "com.android.vending"].map(packageName => {
      const filename = packageName + "-1.apk", bytes = Buffer.from(packageName + version);
      fs.writeFileSync(path.join(release, filename), bytes);
      return { packageName, versionCode: 1, filename, sha256: sha(bytes), bytes: bytes.length };
    });
    fs.writeFileSync(path.join(release, "release.json"), JSON.stringify({ version, packages }));rows.set(version, packages);
  }
  const services = path.join(root, "android/services/catalog.json");fs.mkdirSync(path.dirname(services));
  const write = packages => fs.writeFileSync(services, JSON.stringify({ schemaVersion: 1, packages }));write([]);
  return { root, directory, rows, context: { userDataDir: root, readJson }, write, services };
}

test("microG keeps the selected release and exact installed APK identities without hashing", t => {
  const f = fixture(t);f.write([{ packageName: "com.google.android.gms", apkSha256: f.rows.get("1.0.0")[0].sha256 }]);
  const keep = keepReleases(f.directory, f.context);
  assert.equal(keep("3.0.0"), true);assert.equal(keep("1.0.0"), true);assert.equal(keep("2.0.0"), false);
  assert.equal(keep("unrecognized"), true);
});

test("microG retains unreadable catalogs, incomplete metadata and aliases", t => {
  const f = fixture(t);
  fs.writeFileSync(f.services, "invalid");assert.equal(keepReleases(f.directory, f.context)("1.0.0"), true);
  f.write([{ packageName: "com.google.android.gms" }]);assert.equal(keepReleases(f.directory, f.context)("1.0.0"), true);
  f.write([]);const file = path.join(f.directory, "1.0.0", f.rows.get("1.0.0")[0].filename);
  fs.unlinkSync(file);fs.symlinkSync(path.join(f.directory, "3.0.0", f.rows.get("3.0.0")[0].filename), file);
  assert.equal(keepReleases(f.directory, f.context)("1.0.0"), true);
});

test("microG shared upkeep is idempotent and leaves the selected release and private app data", async t => {
  const f = fixture(t), declared = require("../src/modules/android/derived-stores").find(store => store.id === "android-superseded-microg");
  const data = path.join(f.root, "android/apps/game/data");fs.mkdirSync(data, { recursive: true });fs.writeFileSync(path.join(data, "save"), "user data");
  const store = { ...declared, minAgeMs: 0 };
  const first = await maintainStorage({ userDataDir: f.root, stores: [store] });assert.deepEqual(first.errors, []);assert.equal(first.removed, 2);
  assert.equal((await maintainStorage({ userDataDir: f.root, stores: [store] })).removed, 0);
  assert.deepEqual(fs.readdirSync(f.directory), ["3.0.0"]);assert.equal(fs.readFileSync(path.join(data, "save"), "utf8"), "user data");
});

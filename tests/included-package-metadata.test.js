const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const Metadata = require("../src/modules/shared/runtime/included-package-metadata");

test("included package references follow the lock without changing ABI or checksum facts", () => {
  const lock = { packages: [
    { id: "bridge", arch: "universal", version: "future-release", manifestSha256: "a".repeat(64) },
    { id: "helper", arch: "arm64", version: "new-helper" },
    { id: "helper", arch: "x64", version: "new-helper" }
  ] };
  const pin = { version: { includedPackage: "bridge", arch: "universal" },
    helperVersion: { includedPackage: "helper" }, abiProfile: "exact-abi", librarySha256: "b".repeat(64) };
  assert.deepEqual(Metadata.resolve(pin, lock), { version: "future-release", helperVersion: "new-helper",
    abiProfile: "exact-abi", librarySha256: "b".repeat(64) });
  lock.packages.push({ id: "bridge", arch: "x64", version: "other-release" });
  assert.throws(() => Metadata.resolve({ includedPackage: "bridge" }, lock), /one locked version/);
});

test("packaged included metadata reads the resource lock rather than the source checkout", () => {
  const filename = path.join("/fixture", "app.asar", "src/modules/shared/runtime/included-package-metadata.js");
  const module = { exports: {} }, files = [], lock = { packages: [] };
  vm.runInNewContext(fs.readFileSync(require.resolve("../src/modules/shared/runtime/included-package-metadata"), "utf8"), {
    module, exports: module.exports, __filename: filename, __dirname: path.dirname(filename),
    process: { resourcesPath: "/fixture/Resources" },
    require(file) { if (file === "node:path") return path; files.push(file); return lock; }
  });
  assert.equal(module.exports.applicationLock(), lock);
  assert.deepEqual(files, ["/fixture/Resources/runtime-packages.json"]);
});

test("included declarations and Steam ABI catalogs name package versions only through the app lock", () => {
  const lock = Metadata.applicationLock();
  const declarations = ["android/distribution-included.json", "rgss/runtime/distribution-supplementals.json",
    "catsystem2/runtime/distribution-supplementals.json", "ios/distribution-supplementals.json",
    "java/runtime/steamworks/distribution-supplementals.json", "love/runtime/distribution-supplementals.json",
    "shared/runtime/distribution-supplementals.json", "shared/web/distribution-supplementals.json",
    "shared/reshade/distribution-supplementals.json"];
  for (const relative of declarations) {
    const raw = require("../src/modules/" + relative);
    for (const row of raw) {
      assert.equal(row.version, undefined, relative);
      assert.equal(row.directoryRelative, undefined, relative);
    }
    for (const row of Metadata.declarations(raw)) {
      assert.ok(lock.packages.some(record => record.id === row.id && record.arch === row.arch &&
        record.version === row.version && record.manifestSha256 === row.manifestSha256), relative);
    }
  }
  for (const relative of ["love/runtime/luasteam-versions.json", "java/runtime/steamworks/versions.json",
    "shared/runtime/steamworks/profiles.json", "shared/runtime/steamworks/versions.json", "shared/runtime/steamworks/ticket-versions.json"]) {
    const rows = require("../src/modules/" + relative);
    const resolved = Metadata.resolve(rows);
    assert.ok(resolved.every(row => typeof row.version === "string" || typeof row.helperVersion === "string"));
    assert.equal(/MCLv\d/.test(JSON.stringify(rows)), false, relative);
  }
});

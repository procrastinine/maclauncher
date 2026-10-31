const assert = require("node:assert/strict");
const test = require("node:test");

const Releases = require("../src/modules/shared/onsyuri/runtime/onsyuri-versions");

test("Onsyuri version parsing keeps beta suffixes and ordering", () => {
  assert.equal(Releases.normalizeOnsyuriVersion("v0.7.6beta2"), "0.7.6beta2");
  assert.equal(Releases.normalizeOnsyuriVersion("0.7.6-beta1"), "0.7.6beta1");
  assert.equal(Releases.normalizeOnsyuriVersion("0.7.5"), "0.7.5");

  const versions = ["0.7.6beta1", "0.7.5", "0.7.6beta2", "0.7.5beta5"].sort(
    Releases.compareOnsyuriVersionsDesc
  );
  assert.deepEqual(versions, ["0.7.6beta2", "0.7.6beta1", "0.7.5", "0.7.5beta5"]);
});

test("Onsyuri Mac versions preserve literal native revisions while stock and Web normalization stays unchanged", () => {
  const version = "0.7.7beta-macos-v2";
  assert.equal(Releases.normalizeOnsyuriMacVersion("v" + version), version);
  assert.equal(Releases.normalizeOnsyuriVersion(version), "0.7.7beta");
  assert.equal(Releases.normalizeOnsyuriMacVersion("onsyuri_v0.7.5_aarch64_darwin"), "0.7.5");
  for (const invalid of ["0.7.7beta-macos-v0", "0.7.7beta-macos-v02", "0.7.7beta-macos-vbad", "0.7.7beta-macos-v2-extra"])
    assert.equal(Releases.normalizeOnsyuriMacVersion(invalid), null);
  assert.deepEqual(["0.7.7beta", "0.7.8alpha", "0.7.7beta-macos-v2", "0.7.7beta-macos-v1"].sort(Releases.compareOnsyuriMacVersionsDesc),
    ["0.7.8alpha", "0.7.7beta-macos-v2", "0.7.7beta-macos-v1", "0.7.7beta"]);
  assert.equal(Releases.compareOnsyuriVersions("0.7.7beta-macos-v2", "0.7.7beta"), 0);
  assert.equal(Releases.normalizeOnsyuriMacVersion("0.7.7beta-MCLv1"), "0.7.7beta-MCLv1");
  assert.deepEqual(["0.7.7beta-MCLv2", "0.7.7beta-MCLv10", "0.7.8-MCLv1"].sort(Releases.compareOnsyuriMacVersionsDesc),
    ["0.7.8-MCLv1", "0.7.7beta-MCLv10", "0.7.7beta-MCLv2"]);
  assert.equal(Releases.normalizeOnsyuriMacVersion("0.7.7beta-MCLv0"), null);
});

test("Onsyuri unnumbered prereleases retain their release identity", () => {
  assert.equal(Releases.normalizeOnsyuriVersion("v0.7.7beta"), "0.7.7beta");
  assert.equal(Releases.normalizeOnsyuriVersion("0.7.7-rc"), "0.7.7rc");
  const versions = ["0.7.7beta", "0.7.7", "0.7.7alpha", "0.7.7beta1", "0.7.7rc"];
  assert.deepEqual(versions.sort(Releases.compareOnsyuriVersionsDesc),
    ["0.7.7", "0.7.7rc", "0.7.7beta1", "0.7.7beta", "0.7.7alpha"]);
});

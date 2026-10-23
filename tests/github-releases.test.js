const assert = require("node:assert/strict");
const test = require("node:test");

const Releases = require("../src/modules/shared/runtime/github-releases");

test("collectGreenworksNwVersions extracts and sorts NW.js versions", () => {
  const releases = [
    {
      tag_name: "v0.22.0",
      assets: [
        { name: "greenworks-v0.22.0-nw-v0.103.1-osx.zip" },
        { name: "greenworks-v0.22.0-nw-v0.103.1-win.zip" }
      ]
    },
    {
      tag_name: "v0.21.0",
      assets: [{ name: "greenworks-v0.21.0-nw-v0.80.0-osx.zip" }]
    }
  ];

  const versions = Releases.collectGreenworksNwVersions(releases);
  assert.deepEqual(versions, ["0.103.1", "0.80.0"]);
});

test("selectGreenworksAsset picks newest compatible asset", () => {
  const releases = [
    {
      tag_name: "v0.22.0",
      assets: [{ name: "greenworks-v0.22.0-nw-v0.103.1-osx.zip" }]
    },
    {
      tag_name: "v0.21.0",
      assets: [{ name: "greenworks-v0.21.0-nw-v0.80.0-osx.zip" }]
    }
  ];

  const match = Releases.selectGreenworksAsset(releases, { nwVersion: "0.103.1" });
  assert.ok(match);
  assert.equal(match.asset.name, "greenworks-v0.22.0-nw-v0.103.1-osx.zip");
});

test("selectOnsyuriAsset finds darwin and web assets", () => {
  const releases = [
    {
      tag_name: "v0.7.5",
      assets: [
        { name: "onsyuri_v0.7.5_aarch64_darwin" },
        { name: "onsyuri_v0.7.5_x86-64_darwin" },
        { name: "onsyuri_v0.7.5_web.7z" }
      ]
    },
    {
      tag_name: "v0.7.4",
      assets: [{ name: "onsyuri_v0.7.4_aarch64_darwin" }]
    }
  ];

  const armAsset = Releases.selectOnsyuriAsset(releases, { arch: "arm64" });
  assert.ok(armAsset);
  assert.equal(armAsset.asset.name, "onsyuri_v0.7.5_aarch64_darwin");

  const webAsset = Releases.selectOnsyuriAsset(releases, { variant: "web" });
  assert.ok(webAsset);
  assert.equal(webAsset.asset.name, "onsyuri_v0.7.5_web.7z");
});

test("collectOnsyuriVersions respects arch and web filters", () => {
  const releases = [
    {
      tag_name: "v0.7.5",
      assets: [
        { name: "onsyuri_v0.7.5_aarch64_darwin" },
        { name: "onsyuri_v0.7.5_web.7z" }
      ]
    },
    {
      tag_name: "v0.7.4",
      assets: [{ name: "onsyuri_v0.7.4_aarch64_darwin" }]
    }
  ];

  const macVersions = Releases.collectOnsyuriVersions(releases, { arch: "arm64" });
  assert.deepEqual(macVersions, ["0.7.5", "0.7.4"]);

  const webVersions = Releases.collectOnsyuriVersions(releases, { variant: "web" });
  assert.deepEqual(webVersions, ["0.7.5"]);
});

test("normalizeArch maps common identifiers", () => {
  assert.equal(Releases.normalizeArch("arm64"), "aarch64");
  assert.equal(Releases.normalizeArch("aarch64"), "aarch64");
  assert.equal(Releases.normalizeArch("x86_64"), "x86-64");
  assert.equal(Releases.normalizeArch("x64"), "x86-64");
});

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

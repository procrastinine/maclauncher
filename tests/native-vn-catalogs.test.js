const test = require("node:test");
const assert = require("node:assert/strict");
const Kiri = require("../src/modules/kirikiri/catalog");
const Alice = require("../src/modules/alicesoft/catalog");

test("KiriKiri discovery binds its moving release to a commit and a published Mac digest", async () => {
  const revision = "a".repeat(40), sha256 = "b".repeat(64);
  const dependencies = {
    fetchGithubTags: async () => [{ name: "latest", commit: { sha: revision } }],
    fetchGithubReleases: async () => [{ tag_name: "latest", assets: [{ name: "krkrsdl2-macos.zip",
      digest: `sha256:${sha256}`, browser_download_url: "https://example.test/mac.zip" },
      { name: "krkrsdl2-win32.zip", digest: `sha256:${sha256}`, browser_download_url: "https://example.test/win.zip" }] }],
    resolveGithubTagCommit: async () => assert.fail("tag metadata must supply the immutable revision")
  };
  const entries = await Kiri.createCatalogDiscovery(dependencies)({});
  assert.equal(entries.length, 1); assert.equal(entries[0].version, "development-aaaaaaaaaaaa");
  assert.equal(entries[0].upstreamRevision, revision); assert.equal(entries[0].asset.sha256, sha256);
  assert.equal(entries[0].asset.url, "https://example.test/mac.zip"); assert.equal(entries[0].executableRelative, "krkrsdl2");
  dependencies.fetchGithubReleases = async () => [{ tag_name: "latest", assets: [{ name: "krkrsdl2-macos.zip", browser_download_url: "https://example.test/mac.zip" }] }];
  const unpinned = await Kiri.createCatalogDiscovery(dependencies)({});
  assert.equal(unpinned[0].asset, undefined); assert.equal(unpinned[0].localBuild, false);
  assert.match(unpinned[0].installReason, /No compatible Mac package/);
});

test("AliceSoft discovery preserves every published release and its actual tag commit without claiming Mac assets", async () => {
  const tags = ["v1.8.0", "v1.7.2", "android-0.1.0"];
  const dependencies = { fetchGithubTags: async () => tags.map((name, i) => ({ name, commit: { sha: String(i + 1).repeat(40) } })),
    fetchGithubReleases: async () => tags.map(tag_name => ({ tag_name, target_commitish: "master",
      assets: [{ name: "windows.zip", browser_download_url: "https://example.test/windows.zip", digest: `sha256:${"f".repeat(64)}` }] })) };
  const entries = await Alice.createCatalogDiscovery("system3-sdl2", dependencies)({});
  assert.deepEqual(entries.map(item => item.version), ["1.8.0", "1.7.2", "android-0.1.0"]);
  assert.deepEqual(entries.map(item => item.releaseTag), tags);
  assert.equal(entries[0].upstreamRevision, "1".repeat(40));
  for (const entry of entries) { assert.equal(entry.localBuild, false); assert.equal(entry.asset, undefined); assert.match(entry.installReason, /No compatible Mac package/); }
});

test("System4 discovery gives its moving nightly an immutable commit identity and preserves historical releases", async () => {
  const tags = ["nightly", "1.0.0", "0.9.0"], revisions = ["a", "b", "c"].map(char => char.repeat(40));
  const entries = await Alice.createCatalogDiscovery("xsystem4", {
    fetchGithubTags: async () => tags.map((name, i) => ({ name, commit: { sha: revisions[i] } })),
    fetchGithubReleases: async () => tags.map(tag_name => ({ tag_name, assets: [] }))
  })({});
  assert.deepEqual(entries.map(row => row.version), ["development-aaaaaaaaaaaa", "1.0.0", "0.9.0"]);
  assert.equal(entries[0].releaseTag, "nightly"); assert.equal(entries[0].upstreamRevision, revisions[0]);
  assert.match(entries[0].installReason, /Windows\/Linux/);
});

// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const Kiri = require("../src/modules/kirikiri/catalog");

test("KiriKiri discovery binds its moving release to a commit and the publisher's Mac digest", async () => {
  const repository = "krkrsdl2/krkrsdl2", latest = Harness.githubRelease(repository, "latest", ["krkrsdl2-macos.zip", "krkrsdl2-win32.zip"]);
  const discover = async releases => {
    Harness.network.routes = Harness.githubRoutes(repository, releases);
    try { return await Kiri.source.discover({}); } finally { Harness.network.routes = null; }
  };
  const [entry] = await discover([latest]), revision = Harness.githubRoutes(repository, [latest])[`https://api.github.com/repos/${repository}/tags`][0].commit.sha;
  assert.equal(entry.version, `development-${revision.slice(0, 12)}`); assert.equal(entry.revision, revision);
  assert.deepEqual(entry.files.map(file => [file.name, file.url, file.digest.value]),
    [["krkrsdl2-macos.zip", latest.assets[0].browser_download_url, latest.assets[0].digest.slice(7)]]);
  const [undigested] = await discover([{ ...latest, assets: latest.assets.map(({ digest, ...asset }) => asset) }]);
  assert.equal(undigested.files[0].digest, undefined, "A download without a published digest records its own at installation");
  const [windows] = await discover([{ ...latest, assets: latest.assets.slice(1) }]);
  assert.deepEqual(windows.files, []); assert.match(windows.installReason, /has no compatible Mac package/);
});

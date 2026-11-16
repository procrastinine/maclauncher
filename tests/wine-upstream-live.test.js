// Required first: it replaces the network functions before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createManager } = require("../src/modules/crossover/winecx/runtime/manager");

const REPOSITORY = "dappermint/winecx-gptk";
const SOURCE_FILE = path.join(__dirname, "../src/runtime-sources/wine/winecx.json");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function asset(tag, name, bytes) {
  return { name, size: bytes.length, id: name.length, digest: `sha256:${sha(bytes)}`,
    browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}` };
}
function release(tag, name) {
  const archive = Buffer.from(`archive ${tag}`), sum = Buffer.from(`${sha(archive)}  ${name}\n`);
  return { tag_name: tag, prerelease: false, published_at: "2026-11-01T00:00:00Z",
    assets: [asset(tag, name, archive), asset(tag, `${name}.sha256`, sum)] };
}
function routes(releases) {
  const result = { [`https://api.github.com/repos/${REPOSITORY}/releases`]: releases,
    [`https://api.github.com/repos/${REPOSITORY}/tags`]: releases.map(row => ({ name: row.tag_name, commit: { sha: "a".repeat(40) } })) };
  for (const row of releases)
    result[`https://api.github.com/repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(row.tag_name)}`] = { object: { type: "commit", sha: "a".repeat(40) } };
  return result;
}

test("a newer Wine release with a new asset name matching the same pattern is offered after Refresh, with its CPU", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wine-upstream-live-")));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); Harness.network.routes = null; });
  const declaration = fs.readFileSync(SOURCE_FILE);
  const manager = createManager({ dependencies: { systemVersionSync: () => "26.1", archiveFloor: async () => null } });
  const userDataDir = path.join(root, "profile");
  Harness.network.routes = routes([release("runtime-v4.8.1", "Libraries.tar.gz")]);
  await manager.refreshCatalog({ userDataDir, force: true });
  assert.deepEqual(manager.getState({ userDataDir, componentSummaries: false }).catalog.versions, ["4.8.1"]);
  Harness.network.routes = routes([release("runtime-v4.9.0", "WineCX-4.9.0-Libraries.tar.xz"), release("runtime-v4.8.1", "Libraries.tar.gz")]);
  await manager.refreshCatalog({ userDataDir, force: true });
  const catalog = manager.getState({ userDataDir, componentSummaries: false }).catalog;
  assert.deepEqual(catalog.versions, ["4.9.0", "4.8.1"]);
  assert.equal(catalog.versionRequirements["4.9.0"].architecture, "x64", "the matched x86_64 asset pattern names the listed CPU");
  assert.equal(catalog.versionRequirements["4.8.1"].architecture, "x64");
  assert.deepEqual(fs.readFileSync(SOURCE_FILE), declaration, "no source file changes");
});

test("Wine asset patterns match names of any version while the Sikarugir catalog keeps its engine floor", () => {
  const source = JSON.parse(fs.readFileSync(path.join(__dirname, "../src/runtime-sources/wine/sikarugir.json"), "utf8"));
  const pattern = new RegExp(source.upstream.assets.x86_64, "i");
  for (const version of ["9.9", "10.0_7", "10.0_8", "11.0", "11.0_1", "12.0", "130.4_2"])
    assert.match(`WS12WineSikarugir${version}.tar.xz`, pattern, version);
  const Catalog = require("../src/modules/crossover/sikarugir/runtime/catalog");
  assert.deepEqual(["9.9", "10.0_7", "10.0_8", "11.0", "11.0_1", "12.0"].filter(version => Catalog.parseEngineName(`WS12WineSikarugir${version}.tar.xz`)),
    ["10.0_8", "11.0_1", "12.0"]);
});

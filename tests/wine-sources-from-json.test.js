// Required first: it replaces the network functions before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Registry = require("../src/runtime-sources");

const fresh = () => {
  for (const name of ["../src/modules/crossover/sources/index.js", "../src/modules/crossover/sources/settings.js"]) delete require.cache[require.resolve(name)];
  return require("../src/modules/crossover/sources/settings");
};
const entries = () => Object.keys(fresh().withSources(require("../src/modules/crossover/manifest.json")).runtime.entries);

test("every Wine source file is a runtime entry of the Windows module, and removing the file removes the entry", t => {
  const declared = Registry.loadSources(), wines = declared.filter(source => source.kind === "wine").map(source => source.id);
  assert.ok(wines.includes("metalsharp-wine") && wines.includes("highball-wine"));
  assert.deepEqual(entries().sort(), [...wines].sort(), "each Wine JSON file is an entry, with no other list");
  t.mock.method(Registry, "loadSources", () => declared.filter(source => source.id !== "highball-wine"));
  assert.deepEqual(entries().sort(), wines.filter(id => id !== "highball-wine").sort(), "without its file the entry is gone");
  t.mock.restoreAll(); fresh();
});

const REPOSITORY = "gauthierpiarrette/highball-engine";
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function release(tag, name) {
  const archive = Buffer.from(`archive ${tag}`), sum = Buffer.from(`${sha(archive)}  ${name}\n`);
  const asset = (file, bytes) => ({ name: file, size: bytes.length, id: file.length, digest: `sha256:${sha(bytes)}`,
    browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${file}` });
  return { tag_name: tag, prerelease: false, published_at: "2026-11-12T00:00:00Z", assets: [asset(name, archive), asset(`${name}.sha256`, sum)] };
}
function routes(releases) {
  const result = { [`https://api.github.com/repos/${REPOSITORY}/releases`]: releases,
    [`https://api.github.com/repos/${REPOSITORY}/tags`]: releases.map(row => ({ name: row.tag_name, commit: { sha: "a".repeat(40) } })) };
  for (const row of releases) result[`https://api.github.com/repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(row.tag_name)}`] = { object: { type: "commit", sha: "a".repeat(40) } };
  return result;
}

test("a Wine declared only by JSON lists the releases its asset patterns match, and a build needing an application loader waits for it", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wine-json-only-")));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); Harness.network.routes = null; });
  const applications = path.join(root, "Applications"), userDataDir = path.join(root, "profile");
  const manager = require("../src/runtime-adapters/wine-release").createManager("highball-wine", { dependencies: { applicationDirectories: [applications] } });
  Harness.network.routes = routes([release("engine-wine-11.0-20261112T101620Z-gst-rpath-0030", "engine-wine-11.0-20261112T101620Z-gst-rpath-0030.tar.gz"),
    release("engine-arm64-wine-11.18-20261108T132317Z-spatial-0056-0057", "engine-arm64-wine-11.18-20261108T132317Z-spatial-0056-0057.tar.gz"),
    release("renderer-dxmt-0.7", "renderer-dxmt-0.7.tar.gz")]);
  await manager.refreshCatalog({ userDataDir, force: true });
  const catalog = () => manager.getState({ userDataDir, componentSummaries: false }).catalog;
  const intel = "11.0-20261112T101620Z-gst-rpath-0030", arm = "11.18-20261108T132317Z-spatial-0056-0057";
  assert.deepEqual([...catalog().versions].sort(), [intel, arm].sort(), "only assets matching a CPU pattern are releases");
  assert.equal(catalog().versionRequirements[intel].architecture, "x64");
  assert.equal(catalog().versionRequirements[arm].architecture, "arm64");
  assert.deepEqual(catalog().installableVersions, [intel], "the arm64 build needs the application's loader");
  assert.match(catalog().versionRequirements[arm].installReason, /runs through Highball, which is not installed/);
  const loader = path.join(applications, "Highball.app/Contents/Helpers/WineLoader.app/Contents/MacOS/wine");
  fs.mkdirSync(path.dirname(loader), { recursive: true }); fs.writeFileSync(loader, "");
  assert.deepEqual([...catalog().installableVersions].sort(), [intel, arm].sort(), "with the application installed, the arm64 build is offered");
});

test("the Wine tree of a download is found by its files, in an archive folder or inside an application", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wine-tree-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { findWine } = require("../src/runtime-adapters/wine-release");
  const touch = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ""); };
  touch(path.join(root, "a/engine/bin/wine")); touch(path.join(root, "a/engine/bin/wineserver")); fs.mkdirSync(path.join(root, "a/engine/lib/wine"), { recursive: true });
  assert.deepEqual(findWine(path.join(root, "a")), { root: "engine", entry: "engine/bin/wine", server: "engine/bin/wineserver" });
  touch(path.join(root, "b/MetalSharp Wine.app/Contents/MacOS/wine")); fs.mkdirSync(path.join(root, "b/MetalSharp Wine.app/Contents/lib/wine/aarch64-unix"), { recursive: true });
  assert.deepEqual(findWine(path.join(root, "b")), { root: "MetalSharp Wine.app/Contents", entry: "MetalSharp Wine.app/Contents/MacOS/wine", server: null });
  fs.mkdirSync(path.join(root, "c"));
  assert.equal(findWine(path.join(root, "c")), null);
});

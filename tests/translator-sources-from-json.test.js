// Required first: it replaces the network functions before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const Registry = require("../src/runtime-sources");

const MODULE = "../src/modules/shared/runtime/translator-managers";
const fresh = () => { delete require.cache[require.resolve(MODULE)]; return require(MODULE); };

test("each translator manager's catalog sources come from its source files, and a new file is a translator of its own", t => {
  const declared = Registry.loadSources();
  const fork = { ...declared.find(source => source.id === "dxvk-upstream"), upstream: { github: "example/dxvk-fork", assets: { x86_64: "^fork-.*\\.zip$" }, prereleases: true } };
  const sample = { id: "sample-d3d", kind: "d3d-translator", label: "Sample D3D", upstream: { github: "example/sample-d3d", assets: { arm64: "^sample-d3d-.*\\.tar\\.gz$" } } };
  t.mock.method(Registry, "loadSources", () => [...declared.filter(source => source.id !== "dxvk-upstream"), fork, sample]);
  const { definitions } = fresh();
  const upstream = definitions.dxvk.sources.find(source => source[0] === "upstream");
  assert.equal(upstream[2], "example/dxvk-fork", "the repository is the file's");
  assert.equal(upstream[3]("fork-2.0.zip"), true); assert.equal(upstream[3]("dxvk-2.0.tar.gz"), false, "the assets are the file's patterns");
  assert.deepEqual(definitions["sample-d3d"].sources.map(source => source.slice(0, 3)), [["upstream", "Sample D3D", "example/sample-d3d"]]);
  assert.equal(definitions["sample-d3d"].sources[0][6], false, "prereleases follow the file");
  t.mock.restoreAll(); fresh();
});

const REPOSITORY = "dttdrv/mullion";
function routes(releases) {
  const result = { [`https://api.github.com/repos/${REPOSITORY}/releases`]: releases,
    [`https://api.github.com/repos/${REPOSITORY}/tags`]: releases.map(row => ({ name: row.tag_name, commit: { sha: "b".repeat(40) } })) };
  for (const row of releases) result[`https://api.github.com/repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(row.tag_name)}`] = { object: { type: "commit", sha: "b".repeat(40) } };
  return result;
}

test("a translator declared only by its file lists the releases its asset pattern matches", async t => {
  t.after(() => { Harness.network.routes = null; });
  const { definitions, catalogSource } = fresh();
  assert.ok(definitions.mullion, "Mullion is a translator from its file alone");
  const asset = name => ({ name, size: 10, id: name.length, browser_download_url: `https://github.com/${REPOSITORY}/releases/download/v0.5-alpha.3/${name}` });
  Harness.network.routes = routes([{ tag_name: "v0.5-alpha.3", prerelease: true, published_at: "2026-11-10T00:00:00Z",
    assets: [asset("mullion-v0.5-alpha.3.tar.gz"), asset("mullion-v0.5-alpha.3-symbols.zip")] }]);
  const pins = await catalogSource(definitions.mullion.sources[0], definitions.mullion.label).discover({});
  assert.deepEqual(pins.map(pin => pin.asset.filename), ["mullion-v0.5-alpha.3.tar.gz"]);
});

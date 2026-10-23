const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Manager = require("../src/modules/godot/runtime/godot-runtime-manager");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const sampleArchiveHtml = `
<div class=archive-group><div><h3 id=4.5.1>Godot 4.5.1</h3><span>Current state:</span> <span class=archive-version-flavor>stable</span></div></div>
<div class="card base-padding archive-releases">
  <div class=archive-list-item><div class=archive-release><a class=archive-version href=/download/archive/4.5.1-stable><h4 id=4.5.1-stable>4.5.1-stable</h4></a></div></div>
  <div class=archive-list-item><div class=archive-release><a class=archive-version href=/download/archive/4.5.1-rc2><h4 id=4.5.1-rc2>4.5.1-rc2</h4></a></div></div>
</div>
<div class=archive-group><div><h3 id=4.5>Godot 4.5</h3><span>Current state:</span> <span class=archive-version-flavor>rc1</span></div></div>
<div class="card base-padding archive-releases">
  <div class=archive-list-item><div class=archive-release><a class=archive-version href=/download/archive/4.5-rc1><h4 id=4.5-rc1>4.5-rc1</h4></a></div></div>
  <div class=archive-list-item><div class=archive-release><a class=archive-version href=/download/archive/4.5-beta1><h4 id=4.5-beta1>4.5-beta1</h4></a></div></div>
</div>
`;

const currentArchiveHtml = `
<div class="archive-list">
  <div class="archive-group">
    <div><h3 id="4.7.1">Godot 4.7.1</h3><span>Current state:</span> <span class="archive-version-flavor">rc1</span></div>
  </div>
  <div class="card base-padding archive-releases">
    <div class="archive-list-item">
      <div class="archive-release">
        <a class="archive-version" href="/download/archive/4.7.1-rc1" title="Open downloads page"><h4 id="4.7.1-rc1">4.7.1-rc1</h4></a>
      </div>
      <a class="btn btn-release-download" href="/download/archive/4.7.1-rc1">Download</a>
    </div>
  </div>
  <div class="archive-group">
    <div><h3 id="4.7">Godot 4.7</h3><span>Current state:</span> <span class="archive-version-flavor">stable</span></div>
  </div>
  <div class="card base-padding archive-releases">
    <div class="archive-list-item">
      <div class="archive-release">
        <a class="archive-version" href="/download/archive/4.7-stable" title="Open downloads page"><h4 id="4.7-stable">4.7-stable</h4></a>
      </div>
      <a class="btn btn-release-download" href="/download/archive/4.7-stable">Download</a>
    </div>
    <hr>
    <div class="archive-list-item">
      <div class="archive-release">
        <a class="archive-version" href="/download/archive/4.7-rc3" title="Open downloads page"><h4 id="4.7-rc3">4.7-rc3</h4></a>
      </div>
      <a class="btn btn-release-download" href="/download/archive/4.7-rc3">Download</a>
    </div>
  </div>
</div>
`;

test("Godot ignores retired game version defaults and retains variant selection", () => {
  const normalized = Manager.normalizeSettings({
    defaultVersion: " 4.5.1-stable ",
    defaultVariant: "mono"
  });
  assert.equal(normalized.defaultVersion, null);
  assert.equal(normalized.defaultVariant, "mono");

  const fallback = Manager.normalizeSettings({});
  assert.equal(fallback.defaultVersion, null);
  assert.equal(fallback.defaultVariant, "mono");
});

test("godot runtime manager exposes sections and variants", () => {
  const userDataDir = makeTempDir("maclauncher-godot-runtime-");
  try {
    const state = Manager.getState({ settings: {}, userDataDir });
    assert.ok(Array.isArray(state.sections));
    assert.equal(state.sections[0].id, "default");
    assert.equal(state.sections[1].id, "gdsdecomp");
    assert.equal(state.sections[0].supportsDefault, false);
    assert.equal(state.sections[1].supportsDefault, true);
    assert.ok(Array.isArray(state.variants));
    assert.deepEqual(state.variants.map(item => item.id), ["standard", "mono"]);
    assert.equal(state.catalog.status, "idle");
    assert.equal(state.sections[1].catalog.status, "idle");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("godot archive parsing returns latest per base", () => {
  const versions = Manager.core.__test.extractArchiveVersions(sampleArchiveHtml, true);
  assert.deepEqual(versions, ["4.5.1-stable", "4.5-rc1"]);
});

test("godot archive parsing returns all versions when requested", () => {
  const versions = Manager.core.__test.extractArchiveVersions(sampleArchiveHtml, false);
  assert.deepEqual(versions, ["4.5.1-stable", "4.5.1-rc2", "4.5-rc1", "4.5-beta1"]);
});

test("godot archive parsing supports current quoted markup", () => {
  const versions = Manager.core.__test.extractArchiveVersions(currentArchiveHtml, true);
  assert.deepEqual(versions, ["4.7.1-rc1", "4.7-stable"]);
});

test("godot archive parsing ignores duplicate download buttons", () => {
  const versions = Manager.core.__test.extractArchiveVersions(currentArchiveHtml, false);
  assert.deepEqual(versions, ["4.7.1-rc1", "4.7-stable", "4.7-rc3"]);
});

test("godot download parser selects macOS .NET zip", () => {
  const downloadHtml = `
    <a href="https://downloads.godotengine.org/?version=4.5.1&flavor=stable&slug=macos.universal.zip&platform=macos.universal">Standard</a>
    <a href="https://downloads.godotengine.org/?version=4.5.1&flavor=stable&slug=mono_macos.universal.zip&platform=macos.universal">.NET</a>
  `;
  const links = Manager.core.__test.extractDownloadLinks(downloadHtml);
  const selected = Manager.core.__test.selectMacDotNetDownload(links);
  assert.ok(selected);
  assert.equal(
    selected.url,
    "https://downloads.godotengine.org/?version=4.5.1&flavor=stable&slug=mono_macos.universal.zip&platform=macos.universal"
  );
});
test("Godot Standard and .NET downloads select distinct actual archive packages", () => {
  const links = ["https://downloads.godotengine.org/?version=3.5.2&flavor=stable&slug=mono_osx.universal.zip&platform=macos.universal",
    "https://downloads.godotengine.org/?version=3.5.2&flavor=stable&slug=osx.universal.zip&platform=macos.universal"];
  assert.equal(Manager.core.__test.selectMacDownload(links, "standard").slug, "osx.universal.zip");
  assert.equal(Manager.core.__test.selectMacDownload(links, "mono").slug, "mono_osx.universal.zip");
  assert.equal(Manager.core.__test.selectMacDownload(links.slice(0, 1), "standard"), null, "missing Standard must not silently install Mono");
  assert.equal(Manager.core.normalizeVariant("standard"), "standard");
  const defaults = {defaultVersion: "4.6.3-stable", defaultVariant: "mono"};
  assert.deepEqual(Manager.updateSettingsAfterInstall(defaults, {version: "3.5.2-stable", variant: "standard"}, {preserveDefaults: true}), defaults);
});

test("Godot archive refresh defaults to all exact releases in newest version order", async () => {
  const fetcher = async () => ({ status: 200, headers: {}, body: Buffer.from(sampleArchiveHtml) });
  const all = await Manager.core.fetchAvailableVersions({ fetcher });
  assert.deepEqual(all.versions, ["4.5.1-stable", "4.5.1-rc2", "4.5-rc1", "4.5-beta1"]);
  assert.equal(all.mode, "all");
  const latest = await Manager.core.fetchAvailableVersions({ latestOnly: true, fetcher });
  assert.deepEqual(latest.versions, ["4.5.1-stable", "4.5-rc1"]);
  assert.deepEqual(Manager.core.__test.extractArchiveVersions(sampleArchiveHtml), all.versions);
});

test("Godot ordinary Refresh replaces a reduced cache and preserves selected historical runtime", async () => {
  const original = Manager.core.fetchAvailableVersions;
  const calls = [];
  const userDataDir = makeTempDir("maclauncher-godot-catalog-");
  const settings = { defaultVersion: "3.5.1-stable", defaultVariant: "mono" };
  try {
    Manager.core.fetchAvailableVersions = async options => {
      calls.push(options.latestOnly);
      return { versions: options.latestOnly ? ["4.7-stable"] : ["4.7-stable", "4.7-rc3", "3.5.1-stable"] };
    };
    await Manager.refreshCatalog({ force: true, latestOnly: true });
    const full = await Manager.refreshCatalog();
    assert.deepEqual(calls, [true, false]);
    assert.deepEqual(full.versions, ["4.7-stable", "4.7-rc3", "3.5.1-stable"]);
    const state = Manager.getState({ settings, userDataDir });
    assert.equal(state.defaultVersion, null);
    assert.equal(state.catalog.latestAvailableVersion, "4.7-stable");
    assert.equal(state.catalog.supportsLatestOnly, false);
    assert.equal(state.catalog.mode, "all");
  } finally {
    Manager.core.fetchAvailableVersions = original;
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Godot full refresh is not suppressed by an in-flight reduced request", async () => {
  const original = Manager.core.fetchAvailableVersions;
  const calls = [];
  let releaseLatest;
  try {
    Manager.core.fetchAvailableVersions = options => {
      calls.push(options.latestOnly);
      if (options.latestOnly) return new Promise(resolve => { releaseLatest = resolve; });
      return Promise.resolve({ versions: ["4.7-stable", "4.7-rc3"] });
    };
    const latest = Manager.refreshCatalog({ force: true, latestOnly: true });
    const full = Manager.refreshCatalog({ force: true });
    releaseLatest({ versions: ["4.7-stable"] });
    await latest;
    assert.deepEqual((await full).versions, ["4.7-stable", "4.7-rc3"]);
    assert.deepEqual(calls, [true, false]);
  } finally {
    Manager.core.fetchAvailableVersions = original;
  }
});

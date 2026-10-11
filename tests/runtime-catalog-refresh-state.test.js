const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const modules = "../src/modules/";
const cases = [
  { name: "NW.js", manager: "shared/web/runtime/nwjs-manager", core: "shared/web/runtime/nwjs-runtime-manager", section: "default" },
  { name: "Greenworks", manager: "shared/web/runtime/nwjs-manager", core: "shared/web/runtime/greenworks-runtime", section: "greenworks" },
  { name: "Ren'Py 8", manager: "renpy/runtime/sdk-runtime-manager", core: "renpy/runtime/sdk-manager", section: "v8" },
  { name: "Ren'Py 7", manager: "renpy/runtime/sdk-runtime-manager", core: "renpy/runtime/sdk-manager", section: "v7" },
  { name: "Godot", manager: "godot/runtime/godot-runtime-manager", core: "godot/runtime/godot-runtime", section: "default" },
  { name: "Godot RE Tools", manager: "godot/runtime/godot-runtime-manager", core: "godot/runtime/gdsdecomp-runtime", section: "gdsdecomp" },
  { name: "Ruffle", manager: "flash/runtime/ruffle-runtime-manager", core: "flash/runtime/ruffle-runtime", section: "default" },
  { name: "LÖVE releases", manager: "love/runtime/love-runtime-manager", core: "love/runtime/love-runtime", section: "stable" },
  { name: "LÖVE nightlies", manager: "love/runtime/love-runtime-manager", core: "love/runtime/love-runtime", section: "nightly", method: "listNightlyBuilds", gh: true },
  { name: "ONScripter-Yuri Web", manager: "shared/onsyuri/runtime/onsyuri-manager", core: "shared/onsyuri/runtime/onsyuri-runtime", section: "web" },
  { name: "MKXP-Z", manager: "rgss/runtime/mkxpz-manager", core: "rgss/runtime/mkxpz-runtime-manager", section: "default", gh: true }
];

function freshManager(config) {
  const location = require.resolve(modules + config.manager);
  delete require.cache[location];
  return require(location);
}
function result(versions) {
  return { versions, webVersions: versions, macVersions: versions, latestStableVersion: versions[0],
    source: "https://example.test/releases", releases: [], entries: [], entriesByVersion: {}, releasesByVersion: {} };
}

for (const config of cases) {
  test(`${config.name} starts offline, replaces release rows and preserves the valid catalog after query errors`, async t => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-refresh-state-"));
    t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
    let now = 1900000000000, calls = 0, state = "idle";
    t.mock.method(Date, "now", () => now);
    const core = require(modules + config.core);
    const query = async () => {
      assert.notEqual(state, "idle", "module initialization and getState must not query upstream");
      calls++;
      if (state === "error") throw new Error("Release query failed");
      return result(state === "first" ? ["2.0.0", "1.0.0"] : ["3.0.0"]);
    };
    t.mock.method(core, config.method || "fetchAvailableVersions", query);
    if (config.gh) t.mock.method(core, "canUseGh", async () => {
      assert.notEqual(state, "idle", "getState must not check GitHub authentication"); return true;
    });
    if (config.name === "MKXP-Z") t.mock.method(core, "fetchLatestAvailableVersions", query);
    const manager = freshManager(config);
    const options = { userDataDir, sectionId: config.section, latestOnly: false };
    const settings = manager.applySettingsUpdate("setDefault", { sectionId: config.section, version: "2.0.0" }, {});
    const read = () => manager.getState({ userDataDir, settings }).sections.find(section => section.id === config.section);
    const initial = read();
    assert.equal(initial.catalog.status, "idle"); assert.deepEqual(initial.catalog.versions, []); assert.equal(calls, 0);
    const selected = initial.defaultVersion, installed = initial.installed;
    state = "first";
    const first = await manager.refreshCatalog(options);
    assert.deepEqual(first.versions, ["2.0.0", "1.0.0"]);
    await manager.refreshCatalog(options); assert.equal(calls, 1, "same successful mode uses the TTL");
    now += 1000; state = "error";
    await assert.rejects(manager.refreshCatalog({ ...options, force: true }), /Release query failed/);
    const failed = read();
    assert.equal(failed.catalog.status, "error"); assert.deepEqual(failed.catalog.versions, first.versions);
    assert.equal(failed.catalog.fetchedAt, first.fetchedAt); assert.equal(failed.catalog.source, first.source);
    assert.equal(failed.defaultVersion, selected); assert.deepEqual(failed.installed, installed);
    now += 1000; state = "next";
    const next = await manager.refreshCatalog(options);
    assert.equal(calls, 3, "an error cannot satisfy the success TTL");
    assert.deepEqual(next.versions, ["3.0.0"]); assert.equal(read().defaultVersion, selected);
  });
}

for (const config of cases.filter(config => config.name === "MKXP-Z" || config.section === "nightly" || config.name === "Ruffle")) {
  for (const fails of [false, true]) {
    test(`${config.name} queues All versions after a pending ${fails ? "failed " : ""}Latest query`, async t => {
      const core = require(modules + config.core), calls = [];
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const query = async latest => {
        calls.push(latest);
        if (latest) { await gate; if (fails) throw new Error("Latest query failed"); }
        return result(latest ? ["3.0.0"] : ["3.0.0", "2.0.0"]);
      };
      if (config.gh) t.mock.method(core, "canUseGh", async () => true);
      if (config.name === "MKXP-Z") {
        t.mock.method(core, "fetchLatestAvailableVersions", () => query(true));
        t.mock.method(core, "fetchAvailableVersions", () => query(false));
      } else t.mock.method(core, config.method || "fetchAvailableVersions", ({ latestOnly }) => query(latestOnly));
      const manager = freshManager(config), options = { sectionId: config.section };
      const latest = manager.refreshCatalog({ ...options, latestOnly: true });
      const handledLatest = fails ? assert.rejects(latest, /Latest query failed/) : latest;
      const all = manager.refreshCatalog({ ...options, latestOnly: false });
      await Promise.resolve(); await Promise.resolve();
      assert.deepEqual(calls, [true]); release();
      await handledLatest;
      const complete = await all;
      assert.equal(complete.mode, "all"); assert.deepEqual(complete.versions, ["3.0.0", "2.0.0"]);
      assert.deepEqual(calls, [true, false]);
      await manager.refreshCatalog({ ...options, latestOnly: false }); assert.deepEqual(calls, [true, false]);
    });
  }
}

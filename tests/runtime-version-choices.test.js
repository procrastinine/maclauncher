const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runtimeVersionChoices, selectRuntimeVersion, managerDefaultVersion } = require("../src/modules/shared/runtime/version-choices");

const automatic = { value: "auto", label: "Automatic" };
const manifest = { runtime: { entries: { demo: { settings: { fields: [
  { key: "version", type: "select", optionsAction: "listRuntimeVersions", optionsKey: "runtimeVersions", options: [automatic] }] } } } } };

test("version settings list installed and installable versions in provider order after the field's fixed options", () => {
  const manager = { id: "demo", getState: ({ userDataDir }) => {
    assert.equal(userDataDir, "/data");
    return { installed: [{ version: "1.2.0-aaaaaaa" }, { version: "0.9" }, { version: "3.0" }], versionLabels: { "1.10": "1.10 · Mac build" },
      catalog: { versions: ["3.0", "2.0", "1.10", "1.2.0-bbbbbbb", "1.2.0-aaaaaaa"],
        versionRequirements: { "2.0": { installReason: "Requires a newer MacLauncher." }, "3.0": { installReason: "Requires macOS 99." } } } };
  } };
  assert.deepEqual(runtimeVersionChoices(manifest, manager, { userDataDir: "/data" }).runtimeVersions, [automatic,
    { value: "1.10", label: "1.10 · Mac build" }, { value: "1.2.0-bbbbbbb", label: "1.2.0-bbbbbbb" },
    { value: "1.2.0-aaaaaaa", label: "1.2.0-aaaaaaa" }, { value: "0.9", label: "0.9" }, { value: "3.0", label: "3.0" }]);
});

test("modules with listed runtime versions offer them in game and runtime settings", t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-version-choices-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const entries = { kirikiri: { moduleData: {} }, gemrb: { moduleData: {} },
    alicesoft: { moduleData: { generation: "system35" } } };
  for (const [id, entry] of Object.entries(entries)) {
    const Module = require(`../src/modules/${id}/main`);
    const managers = Module.runtimeManagers.filter(manager => Module.manifest.runtime.entries[manager.id]?.settings?.fields
      ?.some(field => field.optionsAction === "listRuntimeVersions"));
    assert.ok(managers.length, id);
    for (const manager of managers) {
      const field = Module.manifest.runtime.entries[manager.id].settings.fields.find(item => item.optionsAction === "listRuntimeVersions");
      assert.equal(field.optionsKey, "runtimeVersions");
      const result = Module.settingsActions.listRuntimeVersions({ runtimeId: manager.id }, { userDataDir });
      assert.deepEqual(result.runtimeVersions.slice(0, field.options.length), field.options, `${id}/${manager.id}`);
    }
    assert.deepEqual(Module.actions.listRuntimeVersions(entry, {}, { userDataDir }).runtimeVersions[0],
      Module.manifest.runtime.entries[id === "kirikiri" ? "krkrsdl2" : id === "alicesoft" ? "xsystem35" : "gemrb"].settings.fields
        .find(item => item.optionsAction === "listRuntimeVersions").options[0]);
  }
});

test("runtime versions follow the manual choice, then the game's recommendation, then the Runtimes default", () => {
  assert.deepEqual(selectRuntimeVersion({ manual: " 2.0 ", recommended: "1.5", defaultVersion: "3.0" }), { version: "2.0", source: "manual" });
  assert.deepEqual(selectRuntimeVersion({ manual: "auto", recommended: "1.5", defaultVersion: "3.0" }), { version: "1.5", source: "recommended" });
  assert.deepEqual(selectRuntimeVersion({ manual: "", recommended: null, defaultVersion: "3.0" }), { version: "3.0", source: "default" });
  assert.deepEqual(selectRuntimeVersion({ recommended: 21, defaultVersion: 17 }), { version: 21, source: "recommended" });
  assert.deepEqual(selectRuntimeVersion({ manual: null, recommended: "auto", defaultVersion: undefined }), { version: null, source: null });
});

test("shared selection layers preserve manager defaults, game recommendations and runtime compatibility", t => {
  const { createPinnedNativeManager } = require("../src/modules/shared/runtime/pinned-native-manager");
  const Custom = require("../src/modules/shared/runtime/custom-runtime");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-selection-layers-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const hash = file => require("node:crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const manager = createPinnedNativeManager({ id: "layered", label: "Layered runtime",
    catalog: ["2.0", "1.0"].map(version => ({ version, upstreamRevision: version, localBuild: false })),
    inspectRuntime: ({ runtimePath, expectedSha256 }) => {
      if (expectedSha256 && hash(runtimePath) !== expectedSha256) throw Error("The runtime executable changed.");
      return { executablePath: runtimePath, architectures: ["arm64", "x86_64"], ready: true };
    } });
  require("../src/modules/shared/runtime/runtime-catalog").writeRuntimeCatalog({userDataDir,managerId:"layered",entries:["2.0","1.0"].map(version=>({version,upstreamRevision:version,localBuild:false}))});
  assert.equal(manager.resolveSelection(null, {}, userDataDir).version, "2.0", "The newest listed version is the manager default");
  for (const version of ["1.0", "2.0"]) {
    const runtimePath = path.join(userDataDir, `runtime-${version}`); fs.writeFileSync(runtimePath, version);
    manager.core.registerLocal({ userDataDir, version, runtimePath });
  }
  assert.equal(manager.resolveSelection(null, {}, userDataDir).version, "2.0", "The existing installed fallback is retained");
  const settings = { runtimes: { layered: { defaultVersion: "1.0" } } };
  assert.equal(manager.resolveSelection(null, settings, userDataDir, { recommended: () => "2.0" }).version, "2.0");
  let recommendationReads = 0;
  const game = { runtimeData: { layered: { version: "1.0" } } };
  assert.equal(manager.resolveSelection(game, settings, userDataDir, { version: "auto", recommended: () => { recommendationReads++; return "2.0"; } }).version, "1.0");
  assert.equal(recommendationReads, 0, "A manual game choice does not inspect recommendations");
  const cleared = { runtimes: { layered: { defaultVersion: null } } };
  assert.equal(manager.resolveSelection(null, cleared, userDataDir).version, "2.0");
  assert.equal(manager.resolveSelection(null, cleared, userDataDir).selectionRequired, undefined);
  assert.equal(manager.resolveSelection(null, cleared, userDataDir, { recommendedVersion: "2.0" }).version, "2.0");
  const incompatible = manager.resolveSelection(null, settings, userDataDir, { version: "2.0", compatible: pin => pin.version === "1.0" });
  assert.equal(incompatible.version, "2.0"); assert.equal(incompatible.ready, false); assert.match(incompatible.reason, /incompatible runtime profile/);
  assert.deepEqual(manager.updateSettingsAfterInstall({}, { version: "1.0" }), { defaultVersion: "1.0" });
  assert.deepEqual(manager.updateSettingsAfterInstall({ defaultVersion: "1.0" }, { version: "2.0" }), { defaultVersion: "1.0" });
  assert.deepEqual(manager.updateSettingsAfterInstall({ defaultVersion: null }, { version: "2.0" }), { defaultVersion: "2.0" });
  const customSettings = { runtimes: { layered: { defaultVersion: "/custom/runtime" } } };
  assert.equal(Custom.selectionPath(manager, game, customSettings, { version: "auto" }), null, "A manual managed version wins over a custom global");
  assert.equal(Custom.selectionPath(manager, null, customSettings, { recommendedVersion: () => "2.0" }), null, "A game recommendation wins over a custom global");
  fs.writeFileSync(path.join(userDataDir, "runtime-2.0"), "changed");
  assert.equal(manager.resolveSelection(null, settings, userDataDir, { version: "2.0" }).ready, false, "Exact identity verification remains active");
});

test("manager defaults prefer the published list, use ready installed order only without a list, and treat cleared values as absent", () => {
  assert.equal(managerDefaultVersion({ listed: ["2.0", "1.0"], installed: ["9.0"] }), "2.0");
  assert.equal(managerDefaultVersion({ listed: [], installed: ["9.0", "8.0"] }), "9.0");
  assert.equal(managerDefaultVersion({ listed: [null, "auto", ""], installed: [" 8.0 "] }), "8.0");
  assert.equal(managerDefaultVersion({}), null);
  for (const defaultVersion of [undefined, null, "", "auto"]) assert.deepEqual(selectRuntimeVersion({ defaultVersion,
    fallback: managerDefaultVersion({listed:["2.0"]}) }), {version:"2.0",source:"default"});
});

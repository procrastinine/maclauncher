const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
let snapshotRuntimeState, restoreRuntimeState, subscribeLauncherState;
test.before(async () => {
  ({ snapshotRuntimeState, restoreRuntimeState } = await import("../src/core/runtime-state-snapshot.mjs"));
  ({ subscribeLauncherState } = await import("../src/renderer/src/ui/launcher-state-model.mjs"));
});
function representative() {
  const files = Array.from({ length: 1500 }, (_, i) => ({ path: `resources/runtime/file-${i}.dylib`, sha256: "a".repeat(64), mode: 0o755, bytes: 4096 }));
  const installed = [{ version: "1.0", variant: "architecture:arm64", architecture: "arm64", ready: true,
    readOnly: false, removable: true, installDir: "/profile/runtimes/fixture/1.0", runtimeFiles: { executable: "bin/run" },
    manifest: { files, minimumMacOS: "13.0", features: { imagePair: true } }, declaration: { files, publisher: "publisher" },
    installationMetadata: { files: Object.fromEntries(files.map(file => [file.path, file.sha256])), archiveSha256: "b".repeat(64) },
    missingComponents: [], futureVisibleFact: { label: "Preserve new display metadata" } }];
  const versions = Array.from({ length: 100 }, (_, i) => `${i + 1}.0`);
  const versionRequirements = Object.fromEntries(versions.map(version => [version, { minimumMacOS: "13.0", architecture: "universal",
    installable: true, installReason: null, requiresDownload: true, available: false, prerelease: version === "100.0",
    variants: { standard: { installable: true }, mono: { installable: false, installReason: "Not offered by this release" } } }]));
  const base = { versions, versionRequirements, versionLabels: { "1.0": "Version one" }, source: "https://example.org/releases", installable: true };
  const catalog = { ...base, architectureCatalogs: { arm64: { ...structuredClone(base), architecture: "arm64" }, x64: { ...structuredClone(base), architecture: "x64" } } };
  return { id: "fixture", label: "Fixture", installed, catalog, supportsDefault: true, defaultVersion: "1.0",
    sections: [{ id: "default", label: "Runtime", installed: structuredClone(installed), catalog: structuredClone(catalog),
      defaultVersion: "1.0", supportsDefault: true, availabilityByVersion: { "1.0": { unavailable: false } } }] };
}
function withoutInventories(value, installed = false) {
  if (Array.isArray(value)) return value.map(item => withoutInventories(item, installed));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !installed || key !== "files" && key !== "manifest")
    .map(([key, item]) => [key, withoutInventories(item, installed || key === "installed")]));
}

test("runtime snapshots serialize inventories nowhere and installed/catalog facts once while retaining renderer fields", () => {
  const raw = representative(), before = JSON.stringify(raw), wire = snapshotRuntimeState(raw);
  const bytes = JSON.stringify(wire);
  assert.ok(Buffer.byteLength(bytes) < Buffer.byteLength(before) / 4, "representative JSON must shrink substantially");
  assert.equal(bytes.includes("resources/runtime/file-1499.dylib"), false);
  assert.equal(raw.installed[0].manifest.files.length, 1500, "backend manager inventories remain intact");
  assert.deepEqual(wire.sections[0].installed, { $runtimeRef: "/installed" });
  assert.deepEqual(wire.sections[0].catalog, { $runtimeRef: "/catalog" });
  for (const cpu of ["arm64", "x64"]) assert.deepEqual(wire.catalog.architectureCatalogs[cpu].versionRequirements, { $runtimeRef: "/catalog/versionRequirements" });
  const restored = restoreRuntimeState(JSON.parse(bytes));
  assert.deepEqual(restored, withoutInventories(raw));
  assert.equal(restored.sections[0].installed, restored.installed);
  assert.equal(restored.sections[0].catalog, restored.catalog);
  assert.equal(restored.catalog.architectureCatalogs.x64.versionRequirements, restored.catalog.versionRequirements);
  assert.equal(restored.catalog.versionRequirements["100.0"].prerelease, true);
  assert.deepEqual(snapshotRuntimeState(wire), wire, "already compact snapshots stay stable");
});

test("runtime snapshots omit nested installed native imports while retaining display and unknown metadata", () => {
  const display = { version: "1.2.3", source: { label: "Official publisher", kind: "custom" }, apis: ["Video"],
    architecture: "arm64", pluginDirectories: ["lib/plugins"], futureDisplay: { label: "Keep new metadata", values: [1, 2] } };
  const translator = { ...display, files: [{ path: "lib/plugin.dylib", bytes: 4096 }],
    unixImports: [{ path: "lib/plugin.dylib", imports: [{ name: "@loader_path/library.dylib", weak: false }], exports: ["plugin_init"] }] };
  const row = { version: "1.2.3", ready: true, translator, installationMetadata: { translator: structuredClone(translator) } };
  const raw = { id: "fixture", installed: [row], sections: [{ id: "default", installed: [structuredClone(row)] }],
    catalog: { futureDisplay: { unixImports: "Not an installation inventory" } } };
  const original = structuredClone(raw), wire = snapshotRuntimeState(raw), json = JSON.stringify(wire);
  const restored = restoreRuntimeState(JSON.parse(json));
  assert.deepEqual(restored.installed[0], { version: "1.2.3", ready: true, translator: display, installationMetadata: { translator: display } });
  assert.equal(restored.sections[0].installed, restored.installed, "nested section rows still share installed display facts");
  assert.deepEqual(restored.catalog, raw.catalog, "metadata outside installations remains untouched");
  assert.ok(Buffer.byteLength(json) < Buffer.byteLength(JSON.stringify(raw)), "native inventories do not inflate the snapshot");
  assert.deepEqual(raw, original, "complete canonical native facts stay available to preparation");
  assert.deepEqual(snapshotRuntimeState(wire), wire, "compacting the snapshot again preserves its display facts");
});

test("architecture differences, section-only installs and escaped version keys survive JSON references and CPU filtering", () => {
  const raw = representative();
  raw.catalog.architectureCatalogs.x64.versionRequirements["1.0"].installReason = "Requires an Intel dependency";
  raw.catalog.architectureCatalogs.x64.versionRequirements["1.0"].installable = false;
  const fact = { description: "A release note ".repeat(30), available: true };
  raw.catalog.versionRequirements = { "release/~1": fact, other: structuredClone(fact) };
  raw.sections.push({ id: "additional", installed: [{ version: "2.0", ready: false, missingComponents: ["helper"] }] });
  const wire = snapshotRuntimeState(raw), restored = restoreRuntimeState(JSON.parse(JSON.stringify(wire)));
  assert.equal(wire.installed.length, 2, "wire rows include section-only facts once");
  assert.equal(restored.installed.length, 1, "the original top-level installed selection remains unchanged");
  assert.equal(restored.sections[1].installed[0].version, "2.0");
  assert.equal(restored.catalog.versionRequirements.other, restored.catalog.versionRequirements["release/~1"]);
  assert.equal(restored.catalog.architectureCatalogs.x64.versionRequirements["1.0"].installable, false);
  const { withRunnableBuilds } = require("../src/modules/shared/runtime/host-settings");
  const filtered = withRunnableBuilds(wire, cpu => ({ supported: cpu === "x64" }));
  const again = restoreRuntimeState(snapshotRuntimeState(filtered));
  assert.equal(again.catalog.architectureCatalogs.arm64, undefined);
  assert.equal(again.catalog.architectureCatalogs.x64.versionRequirements["1.0"].installReason, "Requires an Intel dependency");
  assert.deepEqual(again.sections[1].installed[0].missingComponents, ["helper"]);
});

test("legacy named sections keep their shape without gaining a top-level installed section", () => {
  const raw = { id: "legacy", mac: { installed: [{ version: "1.0", ready: true }], catalog: { versions: ["1.0"] } },
    windows: { installed: [{ version: "2.0", ready: false }], catalog: { versions: ["2.0"] } } };
  const wire = snapshotRuntimeState(raw), restored = restoreRuntimeState(JSON.parse(JSON.stringify(wire)));
  assert.equal(wire.installed.length, 2);
  assert.equal(Object.hasOwn(restored, "installed"), false);
  assert.deepEqual(restored, raw);
  assert.deepEqual(snapshotRuntimeState(wire), wire);
});

test("the renderer expands initial/broadcast snapshots once and retains shared facts through activity and changed readiness", async () => {
  const raw = representative(), seen = []; let broadcast, activity;
  const state = manager => ({ runtimeManagers: { fixture: snapshotRuntimeState(manager) }, running: {}, downloads: [] });
  const stop = subscribeLauncherState({ getState: async () => state(raw), onState(callback) { broadcast = callback; return () => {}; },
    onActivity(callback) { activity = callback; return () => {}; } }, value => seen.push(value), error => { throw error; });
  await new Promise(resolve => setImmediate(resolve));
  const first = seen.at(-1).runtimeManagers.fixture;
  assert.equal(first.installed[0].ready, true);assert.equal(first.sections[0].installed[0], first.installed[0]);
  activity({ running: { "/game": 123 } });
  assert.equal(seen.at(-1).runtimeManagers.fixture, first);
  raw.installed[0].ready = false;raw.sections[0].installed[0].ready = false;
  broadcast(structuredClone(state(raw)));
  const changed = seen.at(-1).runtimeManagers.fixture;
  assert.equal(changed.installed[0].ready, false);assert.equal(changed.sections[0].installed[0], changed.installed[0]);
  assert.equal(changed.catalog.architectureCatalogs.arm64.versionRequirements, changed.catalog.versionRequirements);
  stop();
});

test("backend runtime-state emission projects a copy instead of exporting manager inventories", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-state-snapshot-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const raw = representative(), manager = { id: raw.id, label: raw.label, getState: () => raw }, events = [];
  const registry = { listModuleIds: () => ["fixture"], listModules: () => [{ id: "fixture" }], getModule: () => ({ runtimeManagers: [manager] }),
    getModuleInfo: () => ({ id: "fixture" }), getModuleDir: () => root, listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null };
  const { createBackendOperations } = require("../src/core/backend-operations");
  const backend = createBackendOperations({ userDataDir: root, registry, emit: (event, payload) => events.push({ event, payload }) });
  await backend.runtimeStates({ runtimes: {} });backend.beginShutdown();
  const sent = events.find(event => event.event === "runtimeState").payload.state;
  assert.equal(sent.runtimeSnapshotVersion, 1);assert.equal(JSON.stringify(sent).includes("file-1499.dylib"), false);
  assert.equal(restoreRuntimeState(sent).sections[0].installed[0].version, "1.0");
  assert.equal(raw.installed[0].declaration.files.length, 1500);
});

test("backend lanes send states limited to builds this Mac can run, ready for the main process to pass on", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-state-runnable-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const raw = representative();
  raw.catalog.architectureCatalogs.sparc = structuredClone(raw.catalog.architectureCatalogs.x64);
  raw.sections[0].catalog = { versions: ["1.0"], architectureCatalogs: { arm64: { versions: ["1.0"] }, sparc: { versions: ["1.0"] } } };
  const manager = { id: raw.id, label: raw.label, getState: () => raw }, events = [];
  const registry = { listModuleIds: () => ["fixture"], listModules: () => [{ id: "fixture" }], getModule: () => ({ runtimeManagers: [manager] }),
    getModuleInfo: () => ({ id: "fixture" }), getModuleDir: () => root, listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null };
  const backend = require("../src/core/backend-operations").createBackendOperations({ userDataDir: root, registry, emit: (event, payload) => events.push({ event, payload }) });
  await backend.runtimeStates({ runtimes: {} });backend.beginShutdown();
  const sent = events.find(event => event.event === "runtimeState").payload.state, restored = restoreRuntimeState(sent);
  assert.equal(sent.runtimeSnapshotVersion, 1, "the lane sends the encoded form");
  const runnable = cpus => cpus.filter(cpu => require("../src/modules/shared/runtime/host-capabilities").architectureSupport(cpu).supported);
  assert.deepEqual(Object.keys(restored.catalog.architectureCatalogs).sort(), runnable(["arm64", "x64"]));
  assert.deepEqual(Object.keys(restored.sections[0].catalog.architectureCatalogs), runnable(["arm64"]));
  assert.ok(raw.catalog.architectureCatalogs.sparc, "the manager's own state is unchanged");
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  assert.equal(/snapshotRuntimeState|withRunnableBuilds/.test(source), false, "the main process does not encode or filter runtime states again");
});

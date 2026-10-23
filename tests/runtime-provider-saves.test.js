const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { composeRuntimeProviders } = require("../src/modules/shared/runtime/providers");
const { hydrateGameSaveLocations, selectKnownSaveLocation, saveDirectoryForEntry } = require("../src/core/save-locations");
const { createSaveService } = require("../src/core/save-service");

function fixture(root = "/tmp/provider-saves") {
  const native = path.join(root, "native"), nativeOverride = path.join(root, "native-custom");
  const provider = runtimeId => ({ runtimeId, supportsEntry: () => true, launchRuntime: () => {},
    supports: { saveLocation: true, saveEditing: false },
    resolveSaveLocations: () => ({ primaryDirectory: path.join(root, runtimeId), directories: [
      { directory: path.join(root, runtimeId), role: "primary" },
      { directory: path.join(root, `${runtimeId}-custom`), role: "alternate" }
    ] }) });
  const mod = composeRuntimeProviders({ id: "engine", manifest: { id: "engine", runtime: { default: "native", supported: ["native"] } } },
    [provider("wine"), provider("local-wine")]);
  return { root, registry: { getModule: () => mod, getModuleInfo: () => mod.manifest }, entry: {
    moduleId: "engine", gameId: "save-game", runtimeId: "native", defaultSaveDir: native, saveDirOverride: nativeOverride,
    saveLocations: [{ directory: native, role: "primary" }], moduleData: { preserved: true }
  } };
}

test("provider saves suspend an engine override and recover it when the native runtime returns", () => {
  const { registry, entry } = fixture();
  const selected = hydrateGameSaveLocations({ ...entry, runtimeId: "wine" }, registry);
  assert.equal(selected.saveDirOverride, null);
  assert.equal(saveDirectoryForEntry(selected, registry), "/tmp/provider-saves/wine");
  assert.equal(saveDirectoryForEntry(selected, registry, "native"), entry.saveDirOverride);
  const restored = hydrateGameSaveLocations({ ...selected, runtimeId: "native" }, registry);
  assert.equal(restored.saveDirOverride, entry.saveDirOverride);
  assert.equal(restored.defaultSaveDir, entry.defaultSaveDir);
  assert.deepEqual(restored.saveLocations, entry.saveLocations);
  assert.deepEqual(entry.moduleData, { preserved: true });
});

test("different providers retain independent selected save folders across native round trips", () => {
  const { registry, entry } = fixture();
  const choose = (value, id) => selectKnownSaveLocation({ ...value, runtimeId: id }, `/tmp/provider-saves/${id}-custom`, registry);
  let selected = choose(entry, "wine");
  selected = choose(selected, "local-wine");
  assert.equal(selected.saveDirOverride, "/tmp/provider-saves/local-wine-custom");
  assert.equal(saveDirectoryForEntry(selected, registry, "wine"), "/tmp/provider-saves/wine-custom");
  selected = hydrateGameSaveLocations({ ...selected, runtimeId: "native" }, registry);
  assert.equal(selected.saveDirOverride, entry.saveDirOverride);
  selected = hydrateGameSaveLocations({ ...selected, runtimeId: "wine" }, registry);
  assert.equal(selected.saveDirOverride, "/tmp/provider-saves/wine-custom");
  selected = selectKnownSaveLocation(selected, selected.defaultSaveDir, registry);
  assert.equal(selected.saveDirOverride, null);
  selected = hydrateGameSaveLocations({ ...selected, runtimeId: "local-wine" }, registry);
  assert.equal(selected.saveDirOverride, "/tmp/provider-saves/local-wine-custom");
  selected = hydrateGameSaveLocations({ ...selected, runtimeId: "wine" }, registry);
  assert.equal(selected.saveDirOverride, null);
  assert.equal(saveDirectoryForEntry(selected, registry), "/tmp/provider-saves/wine");
});

test("old provider metadata recovers the engine override without assigning it to a new provider", () => {
  const { registry, entry } = fixture();
  const legacy = { ...entry, runtimeId: "wine", defaultSaveDir: null, saveLocations: [], moduleData: {
    runtimeProviderSaveLocations: { moduleId: "engine", defaultSaveDir: entry.defaultSaveDir, saveLocations: entry.saveLocations }
  } };
  const selected = hydrateGameSaveLocations(legacy, registry);
  assert.equal(selected.saveDirOverride, null);
  assert.equal(saveDirectoryForEntry(selected, registry), "/tmp/provider-saves/wine");
  const restored = hydrateGameSaveLocations({ ...selected, runtimeId: "native" }, registry);
  assert.equal(restored.saveDirOverride, entry.saveDirOverride);
  assert.equal(restored.defaultSaveDir, entry.defaultSaveDir);
  const directlyRestored = hydrateGameSaveLocations({ ...legacy, runtimeId: "native" }, registry);
  assert.equal(directlyRestored.saveDirOverride, entry.saveDirOverride);
});

test("save snapshots for a provider copy its private files and leave the original engine saves intact", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "provider-snapshot-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { registry, entry } = fixture(root);
  for (const dir of [entry.saveDirOverride, path.join(root, "wine")]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(entry.saveDirOverride, "save.dat"), "original engine save");
  fs.writeFileSync(path.join(root, "wine", "save.dat"), "private Windows save");
  const service = createSaveService({ userDataDir: root, registry });
  const selected = hydrateGameSaveLocations({ ...entry, runtimeId: "wine" }, registry);
  const snapshot = service.createSnapshot(selected);
  assert.equal(snapshot.sourceDirectory, path.join(root, "wine"));
  assert.equal(fs.readFileSync(path.join(root, "games", entry.gameId, "save-snapshots", snapshot.id, "files", "save.dat"), "utf8"), "private Windows save");
  assert.equal(fs.readFileSync(path.join(entry.saveDirOverride, "save.dat"), "utf8"), "original engine save");
});

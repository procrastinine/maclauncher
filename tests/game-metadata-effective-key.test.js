const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const GameStore = require("../src/core/game-store");
const Installers = require("../src/modules/shared/installers");
const Inno = require("../src/modules/shared/installers/inno");
const Launcher = require("../src/core/launcher");

test("effective runtime and Inno hit bookkeeping share warm metadata while real identities invalidate", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "metadata-effective-key-")));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const userDataDir = path.join(root, "data"), original = path.join(root, "original"), moduleDir = path.join(root, "module");
  fs.mkdirSync(original);const installer = path.join(original, "setup.exe");
  fs.writeFileSync(installer, "fixture installer");fs.mkdirSync(moduleDir);
  const helperSource = path.join(moduleDir, "metadata-helper.js");fs.writeFileSync(helperSource, "one");
  let detected = 0, prepared = 0, gamePath, receipt, cacheFile, helperIdentity = "sealed-helper-one";
  const info = {id: "fixture", label: "Fixture", runtime: {default: "runner-a", supported: ["runner-a", "runner-b"],
    entries: {"runner-a": {}, "runner-b": {}}, manager: {"runner-a": "fixture-runtime", "runner-b": "fixture-runtime"}}};
  const mod = {id: info.id, manifest: info, metadataSources: ["metadata-helper.js"],
    normalizeRuntimeId: id => id === "alias-b" ? "runner-b" : id,
    resolveDefaultRuntime: (_entry, settings) => settings.defaultRuntime || "runner-a",
    resolveGameMetadata: () => ({moduleData: {helper: fs.readFileSync(helperSource, "utf8")}}),
    runtimeManagers: [{id: "fixture-runtime", getState() { assert.fail("Metadata keys must not enumerate runtime state"); }}]};
  const registry = {listModuleIds: () => [info.id], listModules: () => [info],
    getModuleInfo: id => id === info.id ? info : null, getModule: id => id === info.id ? mod : null,
    getModuleDir: () => moduleDir, listSharedRuntimeManagers: () => [],
    async detectGameAsync(input) {
      detected++;assert.equal(input, gamePath);
      return {moduleId: info.id, gamePath, contentRootDir: gamePath, name: "Fixture",
        moduleData: {version: fs.readFileSync(path.join(gamePath, "version.txt"), "utf8")}};
    }};
  t.mock.method(Installers, "prepareInput", async (input, {gameId}) => {
    prepared++;assert.equal(input, installer);
    const parent = path.join(userDataDir, "games", gameId, "containers/inno"), generation = path.join(parent, "generation");
    gamePath = path.join(generation, "files");receipt = path.join(generation, "receipt.json");
    if (!fs.existsSync(gamePath)) {
      fs.mkdirSync(gamePath, {recursive: true});fs.writeFileSync(path.join(gamePath, "version.txt"), "1.0");
      fs.writeFileSync(receipt, "sealed receipt");fs.writeFileSync(path.join(parent, "current.json"), "sealed current generation");
    }
    return {inputPath: gamePath, containerData: {format: "inno", version: "6.4", sourcePath: installer,
      key: "a".repeat(64), helperVersion: "1", helperIdentity, helperCacheIdentity: "exact-helper-cache",
      extractedRoot: gamePath, sources: [{path: installer, identity: Inno.identity(installer), sha256: "b".repeat(64)}], cached: prepared > 1}};
  });
  const create = Launcher.createLauncher;
  let runtimeResolutions = 0;
  t.mock.method(Launcher, "createLauncher", options => {
    const launcher = create(options), runtime = launcher.resolveEntryRuntimeId;
    launcher.resolveEntryRuntimeId = (...args) => {runtimeResolutions++;return runtime(...args);};
    launcher.resolveEntryChecks = () => assert.fail("Metadata keys must not run runtimeSupport, availability or save checks");
    return launcher;
  });
  // Load after installing the construction spy, as the real backend does.
  const backendPath = require.resolve("../src/core/backend-operations"), previousBackend = require.cache[backendPath];
  delete require.cache[backendPath];
  t.after(() => {if (previousBackend) require.cache[backendPath] = previousBackend;else delete require.cache[backendPath];});
  const {createBackendOperations} = require(backendPath);
  const backend = () => createBackendOperations({userDataDir, registry, appInfo: {version: "1.0.0"}});
  let operations = backend(), settings = {modules: {fixture: {}}, runtimes: {"fixture-runtime": {defaultVersion: "1"}}};
  const imported = await operations.importEntry(installer, settings);
  assert.equal(imported.runtimeId, null);assert.equal(imported.containerData.cached, false);
  assert.equal(detected, 1);assert.equal(prepared, 1);assert.ok(runtimeResolutions > 0);
  cacheFile = path.join(userDataDir, "games", imported.gameId, "metadata.json");
  const initialCache = fs.readFileSync(cacheFile);
  // Main persists the same effective runtime and current Inno cache-hit fact.
  const write = GameStore.writeGameRecord;
  let entry = {...imported, schemaVersion: GameStore.CURRENT_RECORD_SCHEMA_VERSION, runtimeId: "runner-a", notes: "Keep edited notes",
    containerData: {...imported.containerData, cached: true}, customField: {preserved: true}};
  write(userDataDir, entry);
  let recordWrites = 0, cacheWrites = 0;
  t.mock.method(GameStore, "writeGameRecord", (...args) => {recordWrites++;return write(...args);});
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (...args) => {if (args[1] === cacheFile) cacheWrites++;return rename(...args);});
  const refresh = async (patch = {}, nextSettings = settings) => {
    entry = {...entry, ...patch};write(userDataDir, entry);
    entry = await operations.refreshEntry(entry, nextSettings, {persist: false, availability: {available: true}});
    settings = nextSettings;return entry;
  };
  await refresh();
  assert.equal(detected, 1);assert.equal(prepared, 1);
  assert.equal(cacheWrites, 0);assert.deepEqual(fs.readFileSync(cacheFile), initialCache);
  assert.equal(recordWrites, 0);assert.equal(entry.notes, "Keep edited notes");assert.deepEqual(entry.customField, {preserved: true});
  // Explicit aliases still use the real module normalization policy.
  await refresh({runtimeId: "alias-b"});assert.equal(detected, 2);
  const afterRuntime = cacheWrites;
  await refresh({runtimeId: "runner-b"});assert.equal(detected, 2);assert.equal(cacheWrites, afterRuntime);
  await refresh({}, {...settings, runtimes: {"fixture-runtime": {defaultVersion: "2"}}});assert.equal(detected, 3);
  helperIdentity = "sealed-helper-two";
  await refresh({containerData: {...entry.containerData, helperIdentity}});assert.equal(detected, 4);
  // Receipt/inventory and original installer signatures remain real inputs.
  fs.writeFileSync(receipt, "changed sealed inventory");await refresh();assert.equal(detected, 5);
  fs.writeFileSync(installer, "changed original installer bytes");await refresh();assert.equal(detected, 6);
  fs.writeFileSync(path.join(gamePath, "version.txt"), "2.0 changed");await refresh();
  assert.equal(detected, 7);assert.equal(entry.moduleData.version, "2.0 changed");
  // Source/profile invalidation also remains intact across a service restart.
  fs.writeFileSync(helperSource, "new metadata implementation");operations = backend();await refresh();assert.equal(detected, 8);
  assert.equal(Installers.containerSourcesUnchanged(entry.containerData), true, "Changed source identities survive the fresh-record merge");
  const beforeWarm = {detected, prepared, cacheWrites};await refresh();
  assert.deepEqual({detected, prepared, cacheWrites}, beforeWarm);
  assert.equal(recordWrites, 0, "F11 persist:false keeps the main writer authoritative on misses and hits");
  assert.equal(entry.notes, "Keep edited notes");assert.deepEqual(entry.customField, {preserved: true});
});

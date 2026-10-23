const test = require("node:test");
const assert = require("node:assert/strict");
const { composeRuntimeProviders, listRuntimeProviders, decorateRuntimeEntry } = require("../src/modules/shared/runtime/providers");
const { canLaunchEntry, resolveRuntimeSupportForEntry } = require("../src/core/launch-capability");
const { prepareForLaunch } = require("../src/core/runtime-preparation");

test("composed providers preserve engine-owned runtime save capabilities", () => {
  const engineProvider = { runtimeId: "owned", supports: { saveLocation: true } };
  const external = { runtimeId: "external", supportsEntry: () => true, launchRuntime() {} };
  const composed = composeRuntimeProviders({ manifest: { runtime: { supported: ["owned"] } },
    getRuntimeProvider: id => id === "owned" ? engineProvider : null }, [external]);
  assert.equal(composed.getRuntimeProvider("owned"), engineProvider);
  assert.equal(composed.getRuntimeProvider("external"), external);
  assert.equal(composed.getRuntimeProvider("missing"), null);
});

function fixture({ engineHooks = true } = {}) {
  const calls = [];
  const mod = { id: "engine", manifest: { id: "engine", runtime: {
    supported: ["runner", "inspection"], default: "runner", entries: { inspection: { launch: false } }
  } }, normalizeRuntimeId: () => "runner", canLaunchRuntime: id => id === "runner",
  filterRuntimeSupport: (_entry, supported) => supported.filter(id => id === "runner"),
  launchRuntime: id => calls.push(id) };
  if (engineHooks) for (const hook of ["ensureRuntime", "prepareLaunch", "prepareInput", "getRuntimeRequirements", "getSteamApiRequirement"]) {
    mod[hook] = () => { calls.push(hook); return hook === "getRuntimeRequirements" ? [] : null; };
  }
  const provider = { runtimeId: "portable", managerId: "local-apps", runtime: { label: "Portable", settings: { fields: [{ key: "locale", type: "string" }] } },
    supportsEntry: (entry, _settings, context) => entry.windows === true && context.available === true,
    decorateEntry: entry => ({ ...entry, windows: entry.extension === ".exe" }),
    ensureRuntime: () => { calls.push("provider-ensure"); return null; },
    launchRuntime: () => calls.push("provider-launch") };
  return { mod: composeRuntimeProviders(mod, [provider]), provider, calls };
}

test("native app modules exclude Windows providers from their runtime metadata and hooks", () => {
  const nativeApp = require("../src/modules/generic-app/main"), { provider } = fixture();
  const composed = composeRuntimeProviders(nativeApp, [provider, { ...provider, runtimeId: "sikarugir" }]);
  assert.equal(composed, nativeApp);
  assert.deepEqual(composed.manifest.runtime.supported, ["native"]);
  assert.deepEqual(Object.keys(composed.manifest.runtime.entries), ["native"]);
  assert.equal(composed.getRuntimeProvider, undefined);
});

test("graphics inputs follow the selected renderer provider rather than the detected engine", () => {
  const { provider } = fixture();
  const engine = { source: "engine" }, portable = { source: "portable" };
  const mod = composeRuntimeProviders({ manifest: { runtime: { supported: ["native"] } }, resolveGraphicsInputs: () => engine },
    [{ ...provider, resolveGraphicsInputs: () => portable }]);
  assert.deepEqual(mod.resolveGraphicsInputs({}, { runtimeId: "native" }), engine);
  assert.deepEqual(mod.resolveGraphicsInputs({}, { runtimeId: "portable" }), portable);
});

test("runtime providers retain engine identity and add a format/installation gated choice", () => {
  const { mod } = fixture(), entry = { windows: true }, context = { available: true };
  assert.equal(mod.id, "engine");
  assert.equal(mod.manifest.runtime.manager.portable, "local-apps");
  assert.equal(mod.manifest.runtime.entries.portable.settings.fields[0].key, "locale");
  assert.deepEqual(resolveRuntimeSupportForEntry(mod, mod.manifest, entry, {}, context), ["runner", "portable"]);
  assert.deepEqual(resolveRuntimeSupportForEntry(mod, mod.manifest, entry, {}, {}), ["runner"]);
  assert.deepEqual(resolveRuntimeSupportForEntry(mod, mod.manifest, {}, {}, context), ["runner"]);
  assert.equal(mod.normalizeRuntimeId("portable"), "portable");
  assert.equal(mod.normalizeRuntimeId("other"), "runner");
  assert.equal(canLaunchEntry({ mod, info: mod.manifest, entry, runtimeId: "portable", context }), true);
  assert.equal(canLaunchEntry({ mod, info: mod.manifest, entry, runtimeId: "portable", context: {} }), false);
});

test("provider preparation and launch do not call engine setup or Steam hooks", async () => {
  const { mod, calls } = fixture(), entry = { windows: true }, context = { runtimeId: "portable", available: true };
  await prepareForLaunch({ entry, mod, info: mod.manifest, context, registry: { listModules: () => [] }, report: () => {}, install: () => assert.fail("Local backend must not download") });
  assert.equal(mod.prepareInput(entry, context), entry);
  assert.equal(mod.getSteamApiRequirement(entry, context), null);
  await mod.launchRuntime("portable", entry, context);
  assert.deepEqual(calls, ["provider-ensure", "provider-launch"]);
  calls.length = 0;
  await mod.launchRuntime("runner", entry, { runtimeId: "runner" });
  mod.prepareLaunch(entry, { runtimeId: "runner" });
  assert.deepEqual(calls, ["runner", "prepareLaunch"]);
});

test("an engine without its own setup hook still prepares a provider", async () => {
  const { mod, calls } = fixture({ engineHooks: false });
  assert.equal(mod.ensureRuntime, undefined);
  await prepareForLaunch({ entry: {}, mod, info: mod.manifest, context: { runtimeId: "portable" }, registry: { listModules: () => [] }, report: () => {} });
  assert.deepEqual(calls, ["provider-ensure"]);
});

test("inspection-only engines can play through an eligible provider", () => {
  const { mod } = fixture();
  mod.manifest.supports = { launch: false };
  const entry = { windows: true }, context = { available: true };
  assert.equal(canLaunchEntry({ mod, info: mod.manifest, entry, runtimeId: "portable", context }), true);
  assert.equal(canLaunchEntry({ mod, info: mod.manifest, entry, runtimeId: "runner", context }), false);
});

test("provider discovery and detection decoration are generic and reject duplicate identities", () => {
  const { provider } = fixture();
  assert.deepEqual(listRuntimeProviders([{ runtimeProvider: provider }, {}]), [provider]);
  assert.throws(() => listRuntimeProviders([{ runtimeProvider: provider }, { runtimeProvider: provider }]), /Duplicate/);
  assert.deepEqual(decorateRuntimeEntry({ extension: ".exe" }, [provider]), { extension: ".exe", windows: true });
});

test("provider arrays expose multiple backends and take precedence over a legacy alias", () => {
  const { provider } = fixture();
  const managed = { ...provider, runtimeId: "managed", managerId: "downloads" };
  assert.deepEqual(listRuntimeProviders([
    { runtimeProviders: [provider, managed], runtimeProvider: provider },
    { runtimeProviders: [null, { runtimeId: "incomplete" }] }
  ]), [provider, managed]);
  assert.deepEqual(listRuntimeProviders([{ runtimeProviders: [], runtimeProvider: provider }]), []);
  assert.deepEqual(listRuntimeProviders([{ runtimeProviders: null, runtimeProvider: provider }]), [provider]);
  assert.throws(() => listRuntimeProviders([{ runtimeProviders: [provider, provider] }]), /Duplicate runtime provider: portable/);
  assert.throws(() => listRuntimeProviders([
    { runtimeProviders: [provider, managed] }, { runtimeProvider: managed }
  ]), /Duplicate runtime provider: managed/);
});

test("multiple providers keep independent eligibility and preparation while retaining engine defaults", async () => {
  const calls = [];
  const mod = { id: "engine", manifest: { id: "engine", runtime: {
    default: "native-engine", supported: ["native-engine"]
  } }, ensureRuntime: () => calls.push("engine"), launchRuntime: () => calls.push("engine-launch") };
  const local = { runtimeId: "local", managerId: "local-apps", runtime: { label: "Local" },
    supportsEntry: (entry, _settings, context) => entry.windows && context.localInstalled,
    ensureRuntime: () => { calls.push("local"); return null; },
    launchRuntime: () => calls.push("local-launch") };
  const managed = { runtimeId: "managed", managerId: "downloaded", runtime: { label: "Managed" },
    supportsEntry: entry => entry.windows === true,
    ensureRuntime: () => { calls.push("managed"); return { managerId: "downloaded", version: "2" }; },
    launchRuntime: () => calls.push("managed-launch") };
  const composed = composeRuntimeProviders(mod, [local, managed]);
  assert.equal(composed.manifest.runtime.default, "native-engine");
  assert.deepEqual(resolveRuntimeSupportForEntry(composed, composed.manifest, { windows: true }, {}, {}), ["native-engine", "managed"]);
  assert.deepEqual(resolveRuntimeSupportForEntry(composed, composed.manifest, { windows: true }, {}, { localInstalled: true }), ["native-engine", "local", "managed"]);
  assert.deepEqual(resolveRuntimeSupportForEntry(composed, composed.manifest, { windows: false }, {}, { localInstalled: true }), ["native-engine"]);
  assert.deepEqual(composed.ensureRuntime({ windows: true }, { runtimeId: "managed" }), { managerId: "downloaded", version: "2" });
  await composed.launchRuntime("managed", { windows: true }, { runtimeId: "managed" });
  composed.ensureRuntime({ windows: true }, { runtimeId: "local" });
  await composed.launchRuntime("local", { windows: true }, { runtimeId: "local" });
  composed.ensureRuntime({}, { runtimeId: "native-engine" });
  assert.deepEqual(calls, ["managed", "managed-launch", "local", "local-launch", "engine"]);
});

test("refreshing executable evidence retains an explicit per-game runtime version", () => {
  const { mergeDetectedEntry } = require("../src/core/launch-utils");
  const previous = { runtimeData: { portable: { version: "local-selected", windowsExecutablePath: "/old/game.exe" } } };
  const detected = { runtimeData: { portable: { windowsExecutablePath: "/new/game.exe", executableArchitecture: "x86_64" } } };
  const refreshed = mergeDetectedEntry(previous, detected);
  assert.deepEqual(refreshed.runtimeData.portable, { version: "local-selected", windowsExecutablePath: "/new/game.exe", executableArchitecture: "x86_64" });
  assert.equal(mergeDetectedEntry(refreshed, { runtimeData: { portable: { windowsExecutablePath: null } } }).runtimeData.portable.version, "local-selected");
  assert.equal(previous.runtimeData.portable.windowsExecutablePath, "/old/game.exe");
});

test("a provider with unknown save locations cannot snapshot or edit an original engine save override", () => {
  const { createSaveService } = require("../src/core/save-service");
  const { mod, provider } = fixture();
  provider.supports = { saveLocation: false, saveEditing: false };
  const registry = { getModule: () => mod, getModuleInfo: () => mod.manifest };
  const service = createSaveService({ userDataDir: "/tmp/runtime-provider-test", registry });
  assert.throws(() => service.createSnapshot({ moduleId: "engine", runtimeId: "portable", saveDirOverride: "/tmp/original-saves" }), /Save tools are unavailable for this runtime/);
});

test("returning from a provider restores engine saves without exposing them to the provider", () => {
  const { hydrateGameSaveLocations, saveDirectoryForEntry } = require("../src/core/save-locations");
  const { mod, provider } = fixture();
  provider.supports = { saveLocation: false };
  provider.resolveSaveLocations = () => ({ primaryDirectory: null, directories: [] });
  // Recompose after adding the save-location declaration.
  const original = { id: "engine", manifest: { id: "engine", runtime: { supported: ["runner"] } } };
  const composed = composeRuntimeProviders(original, [provider]);
  const registry = { getModule: () => composed };
  const source = { moduleId: "engine", runtimeId: "runner", defaultSaveDir: "/tmp/original-saves",
    saveDirOverride: "/tmp/custom-saves", saveLocations: [{ directory: "/tmp/original-saves", role: "primary" }], moduleData: { kept: true } };
  let selected = hydrateGameSaveLocations({ ...source, runtimeId: "portable" }, registry);
  assert.equal(selected.defaultSaveDir, null); assert.deepEqual(selected.saveLocations, []);
  assert.equal(saveDirectoryForEntry(selected, registry), null);
  assert.equal(saveDirectoryForEntry(selected, registry, "runner"), "/tmp/custom-saves");
  selected = hydrateGameSaveLocations(selected, registry);
  const restored = hydrateGameSaveLocations({ ...selected, runtimeId: "runner" }, registry);
  assert.equal(restored.defaultSaveDir, source.defaultSaveDir); assert.deepEqual(restored.saveLocations, source.saveLocations);
  assert.equal(restored.saveDirOverride, source.saveDirOverride); assert.equal(restored.moduleData.kept, true);
  assert.equal(restored.moduleData.runtimeProviderSaveLocations, null);
  assert.deepEqual(source.moduleData, { kept: true });
  assert.equal(mod.id, "engine");
});

test("engine hydration refreshes restored saves and provider changes preserve their original engine", () => {
  const { hydrateGameSaveLocations } = require("../src/core/save-locations");
  const provider = id => ({ runtimeId: id, supportsEntry: () => true, launchRuntime: () => {},
    resolveSaveLocations: () => ({ primaryDirectory: null, directories: [] }) });
  const original = { id: "engine", manifest: { id: "engine", runtime: { supported: ["runner"] } },
    resolveSaveLocations: entry => { assert.equal(entry.defaultSaveDir, "/tmp/old"); return { primaryDirectory: "/tmp/refreshed", directories: [] }; } };
  const mod = composeRuntimeProviders(original, [provider("first"), provider("second")]);
  const registry = { getModule: () => mod };
  let entry = { moduleId: "engine", defaultSaveDir: "/tmp/old", runtimeId: "first" };
  entry = hydrateGameSaveLocations(entry, registry);
  entry = hydrateGameSaveLocations({ ...entry, runtimeId: "second" }, registry);
  entry = hydrateGameSaveLocations({ ...entry, runtimeId: "runner" }, registry);
  assert.equal(entry.defaultSaveDir, "/tmp/refreshed");
});

test("a provider with unknown saves does not claim another game's original engine save root", async t => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { EventEmitter } = require("node:events");
  const { createLauncher } = require("../src/core/launcher");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-save-roots-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null });
  t.after(() => { child.exitCode = 0; child.emit("exit", 0); child.emit("close", 0); });
  const provider = { runtimeId: "portable", supportsEntry: () => true, launchRuntime: () => child,
    ensureRuntime: () => null, supports: { saveLocation: false }, resolveSaveLocations: () => ({ primaryDirectory: null, directories: [] }) };
  const mod = composeRuntimeProviders({ id: "engine", manifest: { id: "engine", label: "Engine", runtime: { default: "runner", supported: ["runner"] } } }, [provider]);
  const registry = { listModules: () => [mod.manifest], getModule: () => mod, getModuleInfo: () => mod.manifest, listSharedRuntimeManagers: () => [] };
  const launcher = createLauncher({ userDataDir: root, registry });
  const entry = { moduleId: "engine", gameId: "portable-game", gamePath: path.join(root, "game"), runtimeId: "portable", saveDirOverride: path.join(root, "shared-saves") };
  await launcher.launchEntry(entry, { runtimeId: "portable", strict: true });
  assert.throws(() => launcher.saveService.assertWriteAllowed(entry), /Stop the game/);
  assert.doesNotThrow(() => launcher.saveService.assertWriteAllowed({ ...entry, gameId: "engine-game", gamePath: path.join(root, "other"), runtimeId: "runner" }));
});

test("returning to an engine restores saves before preparation and keeps a newly prepared location", async t => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { EventEmitter } = require("node:events");
  const { createLauncher } = require("../src/core/launcher");
  const { hydrateGameSaveLocations } = require("../src/core/save-locations");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-save-prepare-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalSave = path.join(root, "original"), newSave = path.join(root, "prepared");
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null });
  t.after(() => { child.exitCode = 0; child.emit("exit", 0); child.emit("close", 0); });
  const provider = { runtimeId: "portable", supportsEntry: () => true, launchRuntime: () => {},
    resolveSaveLocations: () => ({ primaryDirectory: null, directories: [] }) };
  const mod = composeRuntimeProviders({ id: "engine", manifest: { id: "engine", label: "Engine", runtime: { default: "runner", supported: ["runner"] } },
    prepareLaunch: entry => { assert.equal(entry.defaultSaveDir, originalSave); entry.defaultSaveDir = newSave; },
    launchRuntime: () => child }, [provider]);
  const registry = { listModules: () => [mod.manifest], getModule: () => mod, getModuleInfo: () => mod.manifest, listSharedRuntimeManagers: () => [] };
  const launcher = createLauncher({ userDataDir: root, registry });
  const entry = hydrateGameSaveLocations({ moduleId: "engine", gameId: "fixture", gamePath: path.join(root, "game"),
    runtimeId: "portable", defaultSaveDir: originalSave }, registry);
  await launcher.launchEntry(entry, { runtimeId: "runner", strict: true });
  assert.equal(entry.defaultSaveDir, newSave); assert.equal(entry.moduleData.runtimeProviderSaveLocations, null);
});

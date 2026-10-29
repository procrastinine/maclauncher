// Writes the demo's starting launcher state (state.json) from the launcher's
// own code: the module registry supplies every game type and its runtime
// choices, the Node backend each runtime manager's state for an empty profile,
// and the graphics modules the effect catalog. Run `pnpm run demo:data` in
// a prepared checkout (one whose included helpers are built) after module,
// runtime or effect changes; the website build reports stale data.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../../..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-demo-"));
const output = process.argv[2] || path.join(__dirname, "state.json");
const APP_ROOT = "/Applications/MacLauncher.app/Contents/Resources/app";
const LIBRARY = "/Users/Shared/Games";

const Modules = require(path.join(repoRoot, "src/modules/registry"));
const { createBackendOperations, listRuntimeManagers } = require(path.join(repoRoot, "src/core/backend-operations"));

// Paths from this checkout become the packaged app's; anything else that is
// not inside the temporary profile describes the build machine and is dropped.
function local(value) {
  const text = JSON.stringify(value);
  const paths = text.match(/"\/[^"]*"/g) || [];
  return paths.every(quoted => {
    const item = JSON.parse(quoted);
    return item.startsWith(repoRoot) || item.startsWith(profile) || !fs.existsSync(item);
  });
}
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = key === "installed" && Array.isArray(item) ? item.filter(local).map(scrub) : scrub(item);
    }
    return out;
  }
  if (typeof value === "string") return value.split(repoRoot).join(APP_ROOT).split(profile).join("/Users/Shared/MacLauncher Demo");
  return value;
}

// "Example Godot Game", "Example Siglus Visual Novel", "Example Video": the
// type's name as the library shows it, and what a library item of that kind is.
function exampleName(info) {
  let name = String(info.label || info.id).split(" (")[0].split(" / ")[0].replace(/ Game$/, "");
  if (/ [a-z]/.test(name)) name = info.shortLabel || name;
  const kind = info.family === "media" ? "" : info.family === "visual-novel" ? " Visual Novel" : " Game";
  return `Example ${name}${kind}`;
}

// An example stands for a typical import of its kind, so it gets the runtime
// the launcher would select for one. When the engine's own runtimes cannot
// play it, that is the first shared provider that is installed or that Play
// can download: a Windows build plays through Sikarugir when the user's own
// CrossOver is absent. Launch follows the launcher's capability rule.
function exampleRuntime(info, managers) {
  const runtime = info.runtime || {}, entries = runtime.entries || {}, supported = runtime.supported || [];
  const playable = id => Boolean(id) && entries[id]?.launch !== false &&
    (info.supports?.launch !== false || entries[id]?.runtimeProvider === true);
  const available = id => {
    const manager = managers[runtime.manager?.[id] || id];
    return !manager || manager.installed?.length > 0 || manager.catalog?.delivery !== "local";
  };
  const preferred = runtime.default || supported[0] || "native";
  const runtimeId = playable(preferred) ? preferred
    : supported.find(id => entries[id]?.runtimeProvider && playable(id) && available(id)) || preferred;
  return { runtimeId, launch: playable(runtimeId) };
}

// An example is imported the way its type's detection lists first: an app
// bundle, a standalone file with the type's own extension (an .apk), or a
// folder. A slash in the name ("2000/2003") is a dash in the file name.
function importName(info, title) {
  const kind = info.detection?.inputKinds?.[0], name = title.replaceAll("/", "-");
  if (kind === "app") return `${name}.app`;
  const extension = kind === "file" && info.detection.extensions?.find(item => item.exclusive)?.extension;
  return extension ? `${name}${extension}` : name;
}

function recentFor(info, index, name = exampleName(info), managers = {}) {
  const { runtimeId, launch } = exampleRuntime(info, managers);
  const slug = `${info.id}-${name}`.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const gamePath = `${info.family === "media" ? "/Users/Shared/Videos" : LIBRARY}/${importName(info, name)}`;
  return {
    gameId: `demo-${slug}`, schemaVersion: 1, order: index, createdAt: 0, updatedAt: 0,
    gamePath, importPath: gamePath, contentRootDir: gamePath, name, notes: "",
    networkAccess: false, moduleId: info.id, moduleFamily: info.family || "", moduleLabel: info.label,
    moduleShortLabel: info.shortLabel || info.label, moduleRuntimeSupport: info.runtime?.supported || [],
    moduleSupports: { ...info.supports, launch }, gameType: info.gameType || null, indexDir: null, indexHtml: null,
    defaultSaveDir: null, saveDirOverride: null, nativeAppPath: null, lastBuiltAt: null,
    runtimeId,
    runtimeData: {}, runtimeSettings: {}, launchArguments: "", moduleData: {}, cheats: null,
    iconPath: null, iconSource: null, iconUrl: null, lastPlayedAt: null, effects: null
  };
}

async function main() {
  const runtimeStates = {}, moduleStates = {};
  const operations = createBackendOperations({ userDataDir: profile,
    appInfo: { appPath: repoRoot, isPackaged: false, version: require(path.join(repoRoot, "package.json")).version,
      paths: { home: os.homedir(), temp: profile, appData: profile, desktop: profile, documents: profile, downloads: profile } },
    emit: (event, payload) => {
      if (event === "runtimeState") runtimeStates[payload.id] = payload.state;
      else if (event === "moduleState") moduleStates[payload.id] = payload.state;
    } });
  await operations.runtimeStates({}, []);
  await operations.moduleStates({});
  const runtimeManagers = {};
  for (const manager of listRuntimeManagers(Modules)) {
    if (typeof manager.getState !== "function") continue;
    const state = runtimeStates[manager.id] || { installed: [], catalog: { versions: [] } };
    runtimeManagers[manager.id] = { label: manager.label || manager.id, ...state, id: manager.id,
      ui: Modules.getRuntimeManagerUi(manager.id) || state.ui || manager.ui || undefined };
  }
  const modules = Modules.listModules();
  const moduleSettings = Object.fromEntries(modules.map(info => [info.id,
    { ...(info.settingsDefaults || {}), defaultRuntime: info.runtime?.default }]));
  // The graphics catalog and each graphics host's effects editor, as the
  // launcher builds them for a game that has not been launched yet.
  const app = { isPackaged: false, getPath: () => profile, getAppPath: () => repoRoot,
    getVersion: () => "0.0.0", getName: () => "MacLauncher" };
  const ReShade = require(path.join(repoRoot, "src/modules/shared/reshade"));
  const EffectsRuntime = require(path.join(repoRoot, "src/modules/shared/effects/runtime"));
  const Hardware = require(path.join(repoRoot, "src/modules/shared/reshade/hardware-support"));
  const graphicsHardware = Hardware.snapshot(ReShade.runtimeRoot(app));
  const graphics = { catalog: ReShade.getState({ app, userDataDir: profile, settings: {} }), hosts: {} };
  // One example per game type. Runtime providers such as 32-bit Mac declare no
  // detection and appear only as runtimes of the game types that offer them.
  const recents = modules.filter(info => info.detection).map((info, index) => recentFor(info, index, undefined, runtimeManagers));
  // Imports that detection turns into a different kind of entry, such as a
  // folder of videos becoming a playlist, made from small sample files.
  const gameActions = {};
  const samples = path.join(profile, "samples");
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("webm"), Buffer.from([0x83, 0x81, 0x01]), Buffer.alloc(16)]);
  for (const [name, files] of [["Example Playlist", ["Episode 1.webm", "Episode 2.webm", "Episode 3.webm"]]]) {
    const folder = path.join(samples, name);
    fs.mkdirSync(folder, { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(folder, file), webm);
    const detected = Modules.detectGame(folder);
    const info = modules.find(item => item.id === detected?.moduleId);
    if (!info) throw new Error(`${name} was not detected.`);
    const entry = { ...recentFor(info, recents.length, name, runtimeManagers), moduleData: detected.moduleData || {} };
    recents.push(entry);
    // The inspector's entry choices (the playlist's videos) for this import.
    const mod = Modules.getModule(info.id), local = { ...entry, gamePath: folder, contentRootDir: folder, importPath: folder };
    for (const selector of info.ui?.entrySelectors || []) {
      try { gameActions[entry.gamePath] = { ...gameActions[entry.gamePath], [selector.optionsAction]: { result: await mod.actions[selector.optionsAction](local, {}, { userDataDir: profile, settings: {} }) } }; }
      catch (error) { gameActions[entry.gamePath] = { ...gameActions[entry.gamePath], [selector.optionsAction]: { error: String(error?.message || error) } }; }
    }
  }
  for (const entry of recents) {
    const info = modules.find(item => item.id === entry.moduleId);
    const graphicsHost = info?.runtime?.entries?.[entry.runtimeId]?.graphicsHost;
    const key = String(graphicsHost ?? "none");
    if (graphics.hosts[key]) continue;
    const options = { userDataDir: profile, app, settings: {}, graphicsHost, graphicsInputs: null, graphicsHardware, running: false, runningPids: [] };
    graphics.hosts[key] = { info: EffectsRuntime.info(entry, options), templates: EffectsRuntime.templates(entry, options) };
  }
  // What each game type's settings read through its settings actions (setting
  // choices, file status, provider settings, accounts) for the empty profile,
  // keyed "module:action:runtime". A failure is kept as its message.
  const settingsActions = {};
  async function record(moduleId, action, payload) {
    const key = [moduleId, action, payload.runtimeId || ""].join(":");
    if (Object.hasOwn(settingsActions, key)) return;
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("No answer.")), 5000); });
    try { settingsActions[key] = { result: await Promise.race([operations.moduleSettingsAction(moduleId, action, payload), timeout]) ?? null }; }
    catch (error) { settingsActions[key] = { error: String(error?.message || error) }; }
    finally { clearTimeout(timer); }
  }
  for (const info of modules) {
    for (const [runtimeId, entry] of Object.entries(info.runtime?.entries || {})) {
      const settings = entry?.settings;
      for (const field of settings?.fields || []) {
        if (field.optionsAction) await record(info.id, field.optionsAction, { runtimeId });
        if (field.fileStatusAction) await record(info.id, field.fileStatusAction, { runtimeId, filePath: settings.defaults?.[field.key] ?? "" });
      }
      if (settings?.provider?.readAction) await record(info.id, settings.provider.readAction, { runtimeId });
    }
    for (const descriptor of [info.ui?.accounts, ...(info.ui?.accountProviders || [])]) {
      if (descriptor?.stateAction) await record(info.id, descriptor.stateAction, { refresh: false });
    }
  }
  const state = {
    recents,
    modules,
    moduleSettings,
    moduleStates,
    runtimeManagers,
    runtimeDefaults: {},
    launcherSettings: {},
    running: {},
    downloads: [],
    debug: false,
    logPath: "/Users/Shared/MacLauncher Demo/logs/maclauncher.log"
  };
  fs.writeFileSync(output, JSON.stringify(scrub({ state, graphics, settingsActions, gameActions })));
}

main().then(() => {
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(0);
}, error => {
  fs.rmSync(profile, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});

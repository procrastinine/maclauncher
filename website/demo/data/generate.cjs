// Writes the demo's starting launcher state (state.json) from the launcher's
// own code: the module registry supplies every game type and its runtime
// choices, the Node backend each runtime manager's state for an empty profile,
// and the graphics modules the effect catalog. A few examples add what an
// empty profile lacks: a game on a disconnected drive, installed runtime and
// translator versions, one of them damaged, a downloaded file, a Switch 2
// dump and a running window graphics session. The file also records what
// each runtime, package and graphics method needs. state.json is not checked
// in: `pnpm dev` and `pnpm build` generate it when it is missing (ensure.cjs),
// so the website workflow, which builds a fresh checkout, publishes the data
// of the commit being built. Run `pnpm run demo:data` after module, runtime or
// effect changes; the website build reports stale data.
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
const GameAvailability = require(path.join(repoRoot, "src/core/game-availability"));
const { createAppUpdater } = require(path.join(repoRoot, "src/main/app-update"));

// An example game kept on an external drive that is not connected, so the
// library shows its unavailable state and Locate….
const EXTERNAL_DRIVE = { moduleId: "unity", folder: "/Volumes/Games" };
// Example installations. ScummVM has an older version that is ready and the
// default version with damaged files, which Runtimes marks Needs repair and
// the example game's inspector offers to repair; the demo's Refresh lists the
// same versions. The graphics translators are the versions that
// docs/runtimes/TRANSLATORS.md names, each described by the Direct3D
// libraries it places, so a Windows game's Runtime Settings lists them as
// choices through the launcher's own option lists.
const TEMPLATE = { kind: "template", label: "Sikarugir Template 1.0.24" };
const ready = version => [{ version, ready: true, status: "ready" }];
const EXAMPLE_INSTALLS = [
  { managerId: "scummvm", defaultVersion: "2.9.1", installs: [
    { version: "2.9.1", ready: false, status: "damaged" }, { version: "2.9.0", ready: true, status: "ready" }] },
  { managerId: "dxvk", defaultVersion: "3.1.1", installs: ready("3.1.1"), translator: { engine: "dxvk", component: "d3d-renderer",
    source: { kind: "builds", label: "MacLauncher DXVK" }, files: ["d3d8.dll", "d3d9.dll", "d3d10core.dll", "d3d11.dll", "dxgi.dll"] } },
  { managerId: "translator-vkd3d-proton", defaultVersion: "3.1", installs: ready("3.1"), translator: { engine: "vkd3d-proton", component: "d3d12",
    files: ["d3d12.dll", "d3d12core.dll"] } },
  { managerId: "translator-d3dmetal", defaultVersion: "4.0b3", installs: ready("4.0b3"), translator: { engine: "d3dmetal", component: "d3d-renderer",
    source: TEMPLATE, files: ["d3d11.dll", "d3d12.dll", "dxgi.dll"] } }
];
// A window graphics session, started from File → Apply Graphics… on a game
// window, and the windows and display that the Apply Graphics window lists.
// The library entry, its targets and the picker come from the window game
// type's own code.
const APPLY_GRAPHICS = {
  displays: [{ id: 1, name: "Built-in Retina Display", width: 1512, height: 982 }],
  windows: [
    { id: 101, pid: 4101, application: "Minecraft", title: "Minecraft", onScreen: true },
    { id: 102, pid: 4102, application: "QuickTime Player", title: "Trailer.mov", onScreen: true, bundleIdentifier: "com.apple.QuickTimePlayerX" },
    { id: 103, pid: 4103, application: "Preview", title: "Map.png", onScreen: false, bundleIdentifier: "com.apple.Preview" }],
  session: "window:101"
};
// A decrypted Switch 2 dump: detection reads the folder, and preparation
// records the title's generation, which names the entry Nintendo Switch 2.
const SWITCH_2 = { name: "Example Nintendo Switch 2 Game", generation: 2 };
// An example cache that the Steam window fills, so Runtimes → Tools →
// Downloaded files lists one file through the launcher's own listing.
const EXAMPLE_DOWNLOADED = { folder: "steam/catalog", file: "versions.json", contents: "{}\n" };

// The demo shows what this checkout builds, just as docs/ describes the
// current source. The graphics features declared in features.json are added to
// the record of the graphics package included in the checkout. Lists are
// merged, so the features that the included package added for its optional
// providers stay.
const RuntimeRecord = require(path.join(repoRoot, "src/modules/shared/reshade/runtime-record"));
const DECLARED_GRAPHICS = require(path.join(repoRoot, "src/modules/shared/reshade/features.json")).graphics;
function withDeclared(included, declared) {
  if (Array.isArray(included) && Array.isArray(declared)) return [...new Set([...included, ...declared])];
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  if (!object(included) || !object(declared)) return declared === undefined ? included : declared;
  return Object.fromEntries([...new Set([...Object.keys(included), ...Object.keys(declared)])]
    .map(key => [key, withDeclared(included[key], declared[key])]));
}
const readRecord = RuntimeRecord.read;
RuntimeRecord.read = root => {
  const record = readRecord(root);
  return { ...record, features: { ...record.features, graphics: withDeclared(record.features?.graphics || {}, DECLARED_GRAPHICS) } };
};

// An example translator installation as the launcher describes it: its engine,
// version, source and the Windows libraries it places.
const Translators = require(path.join(repoRoot, "src/modules/shared/runtime/wine-translators"));
const Description = require(path.join(repoRoot, "src/modules/shared/runtime/translator-description"));
function translatorChoice({ managerId, defaultVersion, translator }) {
  return { ...Description.description({ id: `${managerId}:${defaultVersion}`, component: translator.component, engine: translator.engine,
    version: defaultVersion, form: "native", source: translator.source || {},
    files: translator.files.map(name => ({ relative: `x64/${name}`, path: `x64/${name}`, format: "pe" })) }),
    managerId, runtimeVersion: defaultVersion, sectionId: "default" };
}
// A Windows game's translator lists before its Wine runtime is installed:
// the runtime's automatic choice and the versions installed in Runtimes. A
// D3DMetal installation also serves Direct3D 12.
function translatorOptions(recorded, runtime) {
  const choices = EXAMPLE_INSTALLS.filter(item => item.translator).map(translatorChoice)
    .flatMap(value => value.engine === "d3dmetal" ? [value, { ...value, id: `${value.id}:d3d12`, component: "d3d12" }] : [value]);
  const context = { runtimeSettings: {} };
  const inventory = Translators.inventory(null, runtime, context, { includedInventory: { included: [], warnings: [], layout: null }, choices, managers: [] });
  const plan = Translators.optionsPlan(inventory, context);
  return { ...recorded, ...Translators.optionLists(null, runtime, context, { inventory, plan }),
    translatorEnvironments: Translators.environmentIds(plan, runtime) };
}

// What runtimes, Runtimes packages and graphics methods need, read from the
// launcher's declarations: each feature's minimum macOS and processor, each
// runtime's stated requirements, and how each package is delivered.
const Features = require(path.join(repoRoot, "src/modules/shared/runtime/feature-requirements"));
const feature = value => value && { label: value.label, ...(value.minimumMacOS ? { macOS: String(value.minimumMacOS).replace(/(\.0)+$/, "") } : {}),
  ...(value.hardwareArchitectures?.join() === "arm64" ? { appleSilicon: true } : {}) };
const namedFeature = name => feature(String(name).split(".").reduce((value, key) => value?.[key], Features));
// The graphics methods with a requirement of their own: neural models run on
// the MLX provider, and the others have their own platform minimum.
function methodFeature(row) {
  const [kind, method] = row.id.split(":");
  if (row.runtimeManagerId === "graphics-neural-models") return Features.NEURAL;
  if (kind === "frame-generation") return Features.FRAME_GENERATION[method] || (method === "metalfx" ? Features.METALFX.interpolation : null);
  return { "temporal:metalfx-denoised": Features.METALFX.denoised, "temporal:fsr4": Features.FSR4 }[row.id] || null;
}
function requirementData(modules, runtimeManagers, graphics, graphicsRoot) {
  const runtimes = {}, managers = {}, methods = {};
  for (const info of modules) for (const [id, entry] of Object.entries(info.runtime?.entries || {})) {
    if (runtimes[id]) continue;
    const manager = info.runtime.manager?.[id];
    runtimes[id] = { label: entry.label || id, ...(manager ? { manager } : {}), ...(entry.hostFeature ? { feature: namedFeature(entry.hostFeature) } : {}),
      ...(entry.requirements ? { text: entry.requirements } : {}) };
  }
  for (const [id, manager] of Object.entries(runtimeManagers)) {
    const sections = [manager, ...(Array.isArray(manager.sections) ? manager.sections : [])];
    const delivery = sections.map(section => section.catalog?.delivery).find(Boolean);
    // A version that comes with the app is marked included in its list.
    const included = sections.some(section => Object.values(section.catalog?.versionRequirements || {}).some(item => item?.included === true));
    managers[id] = { label: manager.label || id, ...(delivery ? { delivery } : {}), ...(included ? { included } : {}),
      ...(manager.ui?.hostFeature ? { feature: namedFeature(manager.ui.hostFeature) } : {}) };
  }
  for (const host of Object.values(graphics.hosts)) for (const row of host.info.catalog) {
    const value = methodFeature(row);
    if (value && !methods[row.id]) methods[row.id] = feature(value);
  }
  // Video export's minimum is the included graphics package's video host's.
  const manifest = require(path.join(repoRoot, "src/modules/shared/reshade/publication")).forRoot(graphicsRoot);
  const video = manifest.files.find(row => row.path === "maclauncher-graphics-video");
  const videoMacOS = video?.optionalLoad?.minimumMacOS || video?.minimumMacOS || manifest.minimumMacOS;
  return { launcher: { macOS: require(path.join(repoRoot, "package.json")).build.mac.minimumSystemVersion.replace(/(\.0)+$/, "") },
    features: { window: feature(Features.WINDOW_GRAPHICS), videoExport: { label: "Video export", macOS: String(videoMacOS).replace(/(\.0)+$/, "") },
      dxmt: feature(Features.WINE_BACKENDS.dxmt), d3dmetal: feature(Features.WINE_BACKENDS.d3dmetal), kosmickrisp: feature(Features.TEMPLATE_RENDERERS.kosmickrisp),
      wineTemporal: feature(Features.WINE_TEMPORAL), wineVulkan: feature(Features.WINE_MODERN_VULKAN) },
    runtimes, managers, methods };
}

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
      // Keys can be paths too, such as a running game's.
      out[scrub(key)] = key === "installed" && Array.isArray(item) ? item.filter(local).map(scrub) : scrub(item);
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
  // A Switch program metadata file (NPDM) whose access control section names
  // the program; the Title ID it carries is not shown.
  const npdm = Buffer.alloc(160);
  npdm.write("META", 0, "ascii"); npdm.writeUInt32LE(128, 112); npdm.writeUInt32LE(32, 116);
  npdm.write("ACI0", 128, "ascii"); npdm.writeBigUInt64LE(0x0100000000a00000n, 144);
  for (const [name, files] of [["Example Playlist", { "Episode 1.webm": webm, "Episode 2.webm": webm, "Episode 3.webm": webm }],
    [SWITCH_2.name, { "base/exefs/main.npdm": npdm, "base/romfs/data.arc": Buffer.alloc(16) }]]) {
    const folder = path.join(samples, name);
    for (const [file, bytes] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
      fs.writeFileSync(path.join(folder, file), bytes);
    }
    const detected = Modules.detectGame(folder);
    const info = modules.find(item => item.id === detected?.moduleId);
    if (!info) throw new Error(`${name} was not detected.`);
    const moduleData = detected.moduleData || {};
    const entry = { ...recentFor(info, recents.length, name, runtimeManagers),
      moduleData: name === SWITCH_2.name ? { ...moduleData, titleId: null, generation: SWITCH_2.generation } : moduleData };
    recents.push(entry);
    // The inspector's entry choices (the playlist's videos) for this import.
    const mod = Modules.getModule(info.id), local = { ...entry, gamePath: folder, contentRootDir: folder, importPath: folder };
    for (const selector of info.ui?.entrySelectors || []) {
      try { gameActions[entry.gamePath] = { ...gameActions[entry.gamePath], [selector.optionsAction]: { result: await mod.actions[selector.optionsAction](local, {}, { userDataDir: profile, settings: {} }) } }; }
      catch (error) { gameActions[entry.gamePath] = { ...gameActions[entry.gamePath], [selector.optionsAction]: { error: String(error?.message || error) } }; }
    }
  }
  // The launcher's own availability check reports the example's files missing
  // at their saved location.
  const away = recents.find(entry => entry.moduleId === EXTERNAL_DRIVE.moduleId);
  if (!away) throw new Error(`The external drive example needs the ${EXTERNAL_DRIVE.moduleId} game type.`);
  away.gamePath = away.importPath = away.contentRootDir = `${EXTERNAL_DRIVE.folder}/${path.basename(away.gamePath)}`;
  const { available, reason, message } = GameAvailability.checkGameAvailabilitySync(away, { userDataDir: profile });
  away.availability = { available, reason, message };
  // A manager with a list per CPU names each installation's build, as its
  // architecture manager does.
  const cpu = section => section.catalog?.architectureCatalogs && section.automaticArchitecture;
  for (const example of EXAMPLE_INSTALLS) {
    const owner = runtimeManagers[example.managerId];
    if (!owner) throw new Error(`The example installations need the ${example.managerId} runtime manager.`);
    const label = example.translator && Description.label(translatorChoice(example));
    const installs = section => example.installs.map(install => ({ ...install,
      installDir: path.join(profile, "runtimes", owner.id, install.version), source: "download",
      ...(cpu(section) ? { architecture: cpu(section), variant: `architecture:${cpu(section)}` } : {}) }));
    const install = section => ({ ...section, defaultVersion: example.defaultVersion, installed: installs(section),
      ...(label ? { versionLabels: { ...section.versionLabels, [example.defaultVersion]: label } } : {}) });
    runtimeManagers[owner.id] = { ...install(owner), ...(Array.isArray(owner.sections) ? { sections: owner.sections.map(install) } : {}) };
  }
  // The window graphics session and the Apply Graphics window's targets.
  const windowInfo = modules.find(info => info.id === "window");
  const ApplyGraphics = Modules.getModule("window").appActions;
  const thumbnail = (title, hue) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100">` +
    `<rect width="160" height="100" rx="6" fill="hsl(${hue} 35% 30%)"/><rect width="160" height="14" rx="6" fill="hsl(${hue} 20% 82%)"/>` +
    `<circle cx="9" cy="7" r="3" fill="#ff5f57"/><circle cx="19" cy="7" r="3" fill="#febc2e"/><circle cx="29" cy="7" r="3" fill="#28c840"/>` +
    `<text x="80" y="61" font-family="-apple-system, sans-serif" font-size="12" fill="#fff" text-anchor="middle">${title}</text></svg>`)}`;
  const pickerModel = ApplyGraphics.catalogModel(APPLY_GRAPHICS, new Map(), new Map());
  const pickerTargets = pickerModel.sections.flatMap(section => section.targets);
  const picker = { model: { title: windowInfo.ui.appActions[0].label.replace(/…$/, ""), ...pickerModel,
    thumbnails: Object.fromEntries(pickerTargets.map((target, index) => [target.id, thumbnail(target.label, 200 + index * 47)])) },
    // Each target's library entry as the session would add it.
    entries: Object.fromEntries(pickerTargets.map((target, index) => {
      const created = ApplyGraphics.applyGraphics.createEntry(target.target, { userDataDir: profile, gameId: `demo-window-${index + 1}` });
      return [target.id, { ...recentFor(windowInfo, recents.length, created.name, runtimeManagers), ...created,
        sessionTargets: ApplyGraphics.applyGraphics.sessionTargets(created) }];
    })) };
  const session = picker.entries[APPLY_GRAPHICS.session];
  recents.push(session);
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
  // Windows games list the example translator installations.
  for (const [key, answer] of Object.entries(settingsActions)) {
    const runtime = /:listTranslatorOptions:(crossover|sikarugir)$/.exec(key)?.[1];
    if (runtime && "result" in answer) settingsActions[key] = { result: translatorOptions(answer.result, runtime) };
  }
  // Downloaded files as the launcher lists them, with the example cache.
  const downloaded = path.join(profile, EXAMPLE_DOWNLOADED.folder);
  fs.mkdirSync(downloaded, { recursive: true });
  fs.writeFileSync(path.join(downloaded, EXAMPLE_DOWNLOADED.file), EXAMPLE_DOWNLOADED.contents);
  const components = await operations.componentAction("list", {});
  // Check for Updates as a new profile shows it: this version, not checked yet.
  const updater = createAppUpdater({ userDataDir: profile, currentVersion: require(path.join(repoRoot, "package.json")).version,
    packaged: true, appPath: "/Applications/MacLauncher.app", source: { discover: async () => [] } });
  const state = {
    recents,
    modules,
    moduleSettings,
    moduleStates,
    runtimeManagers,
    runtimeDefaults: {},
    launcherSettings: {},
    // Settings → Environment variables lists every translator's variables.
    translatorEnvironments: Modules.listTranslatorEnvironments(),
    // A window graphics entry exists only while its session runs.
    running: { [session.gamePath]: 1 },
    downloads: [],
    appUpdate: updater.snapshot(),
    debug: false,
    logPath: "/Users/Shared/MacLauncher Demo/logs/maclauncher.log"
  };
  const requirements = requirementData(modules, runtimeManagers, graphics, ReShade.runtimeRoot(app));
  fs.writeFileSync(output, JSON.stringify(scrub({ state, graphics, settingsActions, gameActions, components, picker, requirements })));
}

main().then(() => {
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(0);
}, error => {
  fs.rmSync(profile, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});

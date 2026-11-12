// The launch preparation steps that every Wine source shares. A source keeps
// only its own invocation: how its environment, loader and Windows environment
// are made and how its Wine is started.
const fs = require("node:fs");
const path = require("node:path");
const GameData = require("../../shared/game-data");
const Writable = require("../../shared/writable-input");
const Environments = require("../../shared/runtime/wine-environment");
const Translators = require("../../shared/runtime/wine-translators");

function runtimeDirectory(entry, context, source) {
  if (!path.isAbsolute(context.userDataDir || "") || !/^[\w-]+$/.test(entry.gameId || "")) {
    throw new Error(`${source.label} requires a saved game and launcher data directory.`);
  }
  return GameData.resolveGameRuntimeDir(context.userDataDir, entry.gameId, source.id);
}
function safeText(value, label) {
  const text = String(value ?? "");
  if (/[\0\r\n]/.test(text)) throw new Error(`${label} must not contain newlines or NUL bytes.`);
  return text;
}
// The graphics view's overrides come first; the game's own rules follow. BepInEx
// adds winhttp only when no rule names winhttp or every library.
function dllOverrides(settings, graphicsOverrides = []) {
  const values = [...(Array.isArray(graphicsOverrides) ? graphicsOverrides : []),
    ...(Array.isArray(settings.dllOverrides) ? settings.dllOverrides : [])]
    .map(value => safeText(value, "DLL overrides").trim()).filter(Boolean);
  const explicitWinhttp = values.some(value => value.split("=", 1)[0].split(",")
    .some(name => /^(?:\*|winhttp(?:\.dll)?)$/i.test(name.trim())));
  if (settings.bepInExWinhttp && !explicitWinhttp) values.push("winhttp=n,b");
  for (const value of values) {
    if (!/^[\w.*,-]+=(?:n(?:ative)?|b(?:uiltin)?|[nb],\s*[nb]|[nb]\s*,\s*[nb]|)$/i.test(value)) {
      throw new Error("DLL overrides must use Wine library=order syntax, such as winhttp=n,b.");
    }
  }
  return values.join(";");
}
function localeEnvironment(settings) {
  if (!settings.locale) return {};
  const locale = safeText(settings.locale, "Locale");
  if (!/^[A-Za-z0-9_.@-]+$/.test(locale)) throw new Error("Locale must use a locale identifier, such as ja_JP.UTF-8.");
  return { LANG: locale, LC_ALL: locale, LC_MESSAGES: locale };
}
// An existing CrossOver bottle or Sikarugir wrapper chosen for the game. Its own
// settings stay unless the game sets them; a running one keeps its
// synchronization and display scaling.
async function existingEnvironment(context, source) {
  const existing = await require("../../shared/runtime/wine-processes").prepareEnvironment(
    Environments.readEnvironment(context.runtimeSettings?.environmentReference), context, context.processOptions);
  if (existing && existing.kind !== source.environmentKind) throw new Error(source.environmentKind
    ? `Choose a ${source.labels.environmentName} for this runtime.` : `${source.label} runs games in MacLauncher's own Windows environments.`);
  let settings = existing ? require("../../shared/runtime/wine-settings").explicitSettings(context.runtimeSettings || {}) : context.runtimeSettings || {};
  context.wineEnvironment = existing;
  if (existing?.running) settings = { ...settings, synchronization: existing.settings.synchronization, retina: Environments.INHERIT };
  return { existingEnvironment: existing, settings };
}
// The DXMT and D3DMetal camera adapters and the FidelityFX scene adapter
// replace game DLLs in one launch folder. A plan whose files could not be
// placed is dropped; the game then starts from the folder that holds the other
// plan, or its own folder. The Vulkan DLSS route's camera replaces no file.
async function launchFolder(entry, context, { source, directory, originalRoot, executable, executableArchitecture, cameraBridge, scenePlan }) {
  const plans = [...(cameraBridge ? [{ kind: "camera", plan: cameraBridge }] : []), ...(scenePlan?.packageReady ? [{ kind: "scene", plan: scenePlan }] : [])];
  if (!plans.length) return { view: null, gameRoot: originalRoot, executablePath: executable, cameraBridge: null, sceneReady: false };
  const folder = await require("../temporal/game-view").prepareLaunchFolder(entry, context, { runtimeId: source.id, label: source.label,
    directory, originalRoot, executable, executableArchitecture, plans });
  return { view: folder.view, gameRoot: folder.gameRoot, executablePath: folder.executablePath,
    cameraBridge: folder.ready.has("camera") ? cameraBridge : null, sceneReady: folder.ready.has("scene") };
}
// Keep known Windows profile folders private instead of the environment's
// default aliases into macOS Documents, Desktop and other shared save locations.
function detachProfileAliases(prefixPath) {
  const users = path.join(prefixPath, "drive_c", "users");
  if (!fs.existsSync(users)) return;
  Writable.assertOwnDirectory(prefixPath, users, { create: false });
  for (const user of fs.readdirSync(users, { withFileTypes: true })) {
    if (!user.isDirectory()) continue;
    const profile = path.join(users, user.name);
    for (const item of fs.readdirSync(profile, { withFileTypes: true })) {
      if (!item.isSymbolicLink()) continue;
      const link = path.join(profile, item.name);
      let target; try { target = fs.realpathSync(link); } catch { target = null; }
      if (target && require("../detect").inside(prefixPath, target)) continue;
      fs.unlinkSync(link);
      fs.mkdirSync(link, { mode: 0o700 });
    }
  }
}

// The bridge helper starts the game through the Steam client when the game
// declares a Steam application.
async function steamBridge(entry, context, { install, prefixPath, architecture, environment, executablePath }) {
  const bridge = await require("../runtime/steam-bridge").prepare(entry, context, { installation: install, prefixPath, architecture, environment });
  const launch = bridge ? require("../runtime/steam-bridge-launch").resolve(executablePath, architecture) : null;
  return { bridge, launch, environment: bridge ? bridge.environment : environment, executablePath: launch ? launch.executablePath : executablePath };
}
function adapterDescription(environment, { translatorPlan, host, signal, existingEnvironment }) {
  return require("../../shared/runtime/dxgi-adapter-description").prepare({ ...existingEnvironment?.environment, ...environment }, { translatorPlan, host, signal });
}
// The drive covers the imported game folder, so paths above the executable's
// folder resolve. Drive links are allocated in the prefix that runs the game.
function gamePaths(entry, prefixPath, { originalRoot, gameRoot, executable, executablePath, directory }) {
  if (directory) require("../temporal/game-view").releaseEarlierDrives(prefixPath, directory);
  const workingDirectory = path.dirname(executable), driveRoot = require("../game-drive").gameDriveRoot(entry, originalRoot, executable);
  const paths = require("../../shared/runtime/wine-game-paths").prepareGamePaths(prefixPath,
    { gameRoot: gameRoot === originalRoot ? driveRoot : gameRoot, executablePath, workingRoot: driveRoot, workingDirectory });
  return { workingDirectory, ...paths };
}

// ntdll derives WINEDATADIR from its own location, including the game bundle.
// Its Unix-to-Windows conversion recognizes drive roots by device/inode, so a
// mapping of the original data directory also covers the bundle's share link.
// Keep Mono discovery inside Wine's MAX_PATH buffers without copying runtime
// files or selecting a Mono version independently of the chosen Wine engine.
function runtimeDataPath(prefixPath, install) {
  const root = require("../../shared/runtime/wine-layout").wineLayout(install).root;
  const data = path.join(root, "share", "wine");
  if (!fs.existsSync(data)) return null;
  return require("../../shared/runtime/wine-game-paths").windowsDirectoryPath(prefixPath, data, data);
}
function shaderCache(directory, prefixPath) {
  return require("../runtime/shader-cache").prepare(directory, prefixPath);
}
// A launch folder is remembered for the source and watched for game writes.
function keepLaunchFolder(entry, context, { runtimeId, directory, view }) {
  if (!view) return;
  const GameView = require("../temporal/game-view");
  GameView.remember(entry, context, runtimeId, view);
  GameView.watch(entry, context, directory, runtimeId, view);
}
function recordRuntime(entry, context, { runtimeId, match, gameRoot, existingEnvironment, steamBridge, translatorPlan, requestedSettings, install, values }) {
  entry.runtimeData = { ...entry.runtimeData, [runtimeId]: { ...entry.runtimeData?.[runtimeId], ...values,
    sourceRoot: match.sourceRoot, gameRoot,
    ...(existingEnvironment ? { environmentReference: existingEnvironment.reference } : {}),
    steamBridge: steamBridge ? { version: steamBridge.packageVersion } : null,
    translatorRows: Translators.inspectorRows(translatorPlan),
    translatorPlanInputs: Translators.planInputs(requestedSettings, context.wineEnvironment?.install || install),
    cameraAdapterNotice: context.cameraAdapterNotice || null, graphicsInputs: context.graphicsInputs } };
  context.onEntryChange?.(entry);
}

module.exports = { runtimeDirectory, safeText, dllOverrides, localeEnvironment, existingEnvironment, launchFolder, detachProfileAliases,
  steamBridge, adapterDescription, gamePaths, runtimeDataPath, shaderCache, keepLaunchFolder, recordRuntime };

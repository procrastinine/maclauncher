const fs = require("node:fs");
const path = require("node:path");
const GameData = require("../../game-data");
const Asar = require("../../runtime/asar");
const { bindNativeAppStop } = require("../../runtime/native-app-stop");
const { spawnForegroundNativeGame } = require("../../runtime/native-focus");
const GameQuarantine = require("../../runtime/game-quarantine");
const { STOP_GRACE_MS } = require("../../runtime/publisher-app");
const manager = require("./electron-manager");

const RUNTIME_ID = manager.APP_RECORD;
const PACKAGE_BYTES = 1024 * 1024;
const STEAM_LIBRARY = "libsteam_api.dylib";
const LOADER = path.resolve(__dirname, "../../../../runtime/electron-app.js");

// The loader is unpacked beside app.asar, so every Electron release can read it.
function loaderPath(file = LOADER) {
  return file.split(path.sep).map(part => part === "app.asar" ? "app.asar.unpacked" : part).join(path.sep);
}

function stat(file) {
  try { return fs.statSync(file); } catch { return null; }
}
function inside(file, root) {
  const relative = path.relative(root, file);
  return relative === "" || !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
// The folder holding the game's release: the imported folder or app, or the
// folder of an imported file.
function gameRoot(entry) {
  const gamePath = entry?.gamePath;
  if (typeof gamePath !== "string" || !path.isAbsolute(gamePath)) return null;
  return stat(gamePath)?.isDirectory() ? gamePath : path.dirname(gamePath);
}

// The script Electron starts: package.json `main`, or index.js. A web page as
// `main` belongs to an NW.js app.
function mainScript(packageJson) {
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) return null;
  const main = typeof packageJson.main === "string" && packageJson.main.trim() ? packageJson.main.trim() : "index.js";
  if (main.includes("\0") || path.isAbsolute(main) || /^[a-z][a-z0-9+.-]*:/i.test(main) || /\.html?$/i.test(main)) return null;
  return main;
}
// The files Node loads for `main`, in its order.
function mainCandidates(main) {
  const normalized = path.posix.normalize(main.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../")) return [];
  return [normalized, `${normalized}.js`, path.posix.join(normalized, "index.js")];
}

function readFolderApp(root) {
  const real = fs.realpathSync(root);
  const file = path.join(real, "package.json"), info = stat(file);
  if (!info?.isFile() || info.size > PACKAGE_BYTES) return false;
  const main = mainScript(JSON.parse(fs.readFileSync(file, "utf8")));
  return Boolean(main) && mainCandidates(main).some(candidate => {
    const target = path.join(real, ...candidate.split("/"));
    if (!stat(target)?.isFile()) return false;
    return inside(fs.realpathSync(target), real);
  });
}

function asarNode(header, relative) {
  let node = header;
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." || !node?.files || !Object.hasOwn(node.files, part)) return null;
    node = node.files[part];
  }
  return node;
}
const asarFile = node => node && typeof node === "object" && !node.files && !node.link;
function readAsarText(archive, relative, header, dataOffset) {
  const node = asarNode(header, relative), size = Number(node?.size);
  if (!asarFile(node) || !Number.isSafeInteger(size) || size < 0 || size > PACKAGE_BYTES) return null;
  if (node.unpacked) {
    const file = path.join(`${archive}.unpacked`, ...relative.split("/"));
    return stat(file)?.isFile() && stat(file).size <= PACKAGE_BYTES ? fs.readFileSync(file, "utf8") : null;
  }
  const offset = dataOffset + Number(node.offset);
  if (!Number.isSafeInteger(offset)) return null;
  const bytes = Buffer.alloc(size), fd = fs.openSync(archive, "r");
  try { if (fs.readSync(fd, bytes, 0, size, offset) !== size) return null; } finally { fs.closeSync(fd); }
  return bytes.toString("utf8");
}
function readAsarApp(archive) {
  const { header, dataOffset } = Asar.readAsarHeader(archive);
  const text = readAsarText(archive, "package.json", header, dataOffset);
  const main = text !== null && mainScript(JSON.parse(text));
  return Boolean(main) && mainCandidates(main).some(candidate => {
    const node = asarNode(header, candidate);
    if (!asarFile(node)) return false;
    return !node.unpacked || Boolean(stat(path.join(`${archive}.unpacked`, ...candidate.split("/")))?.isFile());
  });
}

// Electron starts a packaged app from the app folder in its resources folder,
// otherwise from app.asar there. The game's content folder and the folders
// above it inside the game's release show where that resources folder is.
function appCandidates(entry, base) {
  const candidates = [];
  for (let current = entry.contentRootDir; typeof current === "string" && path.isAbsolute(current) && inside(current, base); current = path.dirname(current)) {
    if (/^resources$/i.test(path.basename(current))) candidates.push(path.join(current, "app"), path.join(current, "app.asar"));
    if (current === base) break;
  }
  for (const folder of [["resources"], ["Contents", "Resources"]]) candidates.push(path.join(base, ...folder, "app"), path.join(base, ...folder, "app.asar"));
  return [...new Set(candidates)];
}

function findApp(entry) {
  const base = gameRoot(entry);
  if (!base) return null;
  const realBase = fs.realpathSync(base);
  for (const candidate of appCandidates(entry, base)) {
    const info = stat(candidate);
    if (!info) continue;
    try {
      if (!inside(fs.realpathSync(candidate), realBase)) continue;
      if (info.isDirectory() ? readFolderApp(candidate) : info.isFile() && /\.asar$/i.test(candidate) && readAsarApp(candidate))
        return { app: path.relative(base, candidate) };
    } catch {}
  }
  return null;
}

// A Node binding of the Steam API, such as steamworks.js or Greenworks, carries
// Steam's macOS library among the app's Node modules.
function folderHasSteamLibrary(folder) {
  let items;
  try { items = fs.readdirSync(folder, { withFileTypes: true }); } catch { return false; }
  return items.some(item => item.name === STEAM_LIBRARY && item.isFile()) ||
    items.some(item => item.isDirectory() && folderHasSteamLibrary(path.join(folder, item.name)));
}
function nodeHasSteamLibrary(node) {
  const files = node?.files;
  return Boolean(files) && (asarFile(files[STEAM_LIBRARY]) || Object.values(files).some(nodeHasSteamLibrary));
}
function usesSteamApi(appRoot) {
  try {
    const info = stat(appRoot);
    if (info?.isDirectory()) return folderHasSteamLibrary(path.join(appRoot, "node_modules"));
    return Boolean(info?.isFile()) && nodeHasSteamLibrary(asarNode(Asar.readAsarHeader(appRoot).header, "node_modules"));
  } catch { return false; }
}

const applies = entry => entry?.gameType === "web" && Boolean(gameRoot(entry));
// The recorded app path, relative to the game's release folder.
function recorded(entry) {
  const value = entry?.runtimeData?.[RUNTIME_ID]?.app;
  if (entry?.gameType !== "web" || typeof value !== "string" || !value || value.includes("\0") || path.isAbsolute(value) ||
    value.split(/[\\/]/).includes("..")) return null;
  const base = gameRoot(entry);
  return base ? path.join(base, value) : null;
}

// The launcher's development settings and Node options never reach the game.
// The app runs as a packaged app with the user's own home, so its saves,
// settings and caches land where the game's own releases put them
// (`Library/Application Support/<app name>`), and Chromium's stored-data key
// stays out of the login keychain (`--use-mock-keychain`).
function gameEnvironment(base) {
  const environment = { ...base, ELECTRON_FORCE_IS_PACKAGED: "true" };
  for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ASAR", "ELECTRON_START_URL", "ELECTRON_IS_DEV", "NODE_OPTIONS", "NODE_ENV", "CFFIXED_USER_HOME"]) delete environment[key];
  return environment;
}

async function dockIcon(entry, context) {
  if (!entry?.iconPath || !/^[A-Za-z0-9_-]+$/.test(entry.gameId || "")) return null;
  try {
    return await require("../../dock-icon").prepare(entry.iconPath, GameData.resolveGameIconsDir(context.userDataDir, entry.gameId));
  } catch (error) {
    context.logger?.warn?.(`[electron-app] Dock icon: ${error.message}`);
    return null;
  }
}

// The version choice belongs to the runtime the inspector shows: Electron, or
// this runtime in a game type without MacLauncher's hosted Electron.
const subject = (entry, context) => ({ ...entry, runtimeId: context?.runtimeId || RUNTIME_ID });
const select = (entry, context) => manager.resolveSelection(subject(entry, context), context.settings, context.userDataDir);
// Versions other than MacLauncher's own Electron run the game's app.
function ownsVersion(entry, context) {
  if (!recorded(entry)) return false;
  const selected = select(entry, context);
  return Boolean(selected) && selected.version !== manager.INCLUDED;
}

async function launchRuntime(id, entry, context) {
  if (id !== RUNTIME_ID) return null;
  const appRoot = recorded(entry);
  if (!appRoot || !stat(appRoot)) throw new Error("The game's Electron app is missing.");
  // Downloads carry the quarantine attribute, and loading a quarantined native
  // library in the game's app waits for approval that nothing answers. The
  // launch drops it from the app's own folders, as installation does for the
  // runtimes it downloads.
  try {
    await GameQuarantine.removeGameQuarantine({ appRoot, gameRoot: gameRoot(entry) },
      { platform: context.platform || process.platform, logger: context.logger });
  } catch (error) {
    // The game still runs when its app is approved by hand; launch is not blocked.
    context.logger?.warn?.(`[electron-app] quarantine: ${error.message}`);
  }
  const selected = select(entry, context);
  if (!selected?.ready) throw new Error(selected?.reason || "The selected Electron version is not installed.");
  const executablePath = selected.install.executablePath, icon = await dockIcon(entry, context);
  // The app's own Steam API reaches the running Steam client, which the
  // launcher starts and network isolation permits as for other Steam games.
  if (usesSteamApi(appRoot)) await context.useSteamClient?.(true);
  const gameArguments = require("../../runtime/launch-arguments").validate(context.gameArguments || []);
  const args = [loaderPath(), `--maclauncher-electron-app=${appRoot}`, "--use-mock-keychain",
    ...(icon ? [`--maclauncher-dock-icon=${icon}`] : []),
    ...(gameArguments.length ? [`--maclauncher-game-arguments=${Buffer.from(JSON.stringify(gameArguments), "utf8").toString("base64")}`] : [])];
  context.logger?.info?.(`[electron-app] launch ${selected.version} ${appRoot}`);
  const originalSpawn = context.onProcessSpawn;
  context.onProcessSpawn = async child => {
    bindNativeAppStop(child, { executablePath, platform: context.platform || process.platform, graceMs: STOP_GRACE_MS, logger: context.logger });
    await originalSpawn?.(child);
  };
  try {
    return await spawnForegroundNativeGame({ context, executablePath, args,
      // The game starts in the folder holding its resources folder, as it
      // does from its own executable.
      options: { cwd: path.dirname(path.dirname(appRoot)), env: gameEnvironment(process.env) },
      needsRosetta: Boolean(selected.install.needsRosetta || selected.requiresRosetta) });
  } finally { context.onProcessSpawn = originalSpawn; }
}

// Every web game whose release holds an Electron app can run that app: its
// main-process script, the preload scripts its windows name and its own
// handling of saves, under a separately installed Electron version. These
// versions join the game type's Electron runtime, beside MacLauncher's own
// Electron, which keeps hosting the game. A game type without that runtime
// lists Electron as a runtime of its own, which runs the app on every version.
// Detection records the app's location; runtime choices read only that record.
const provider = {
  runtimeId: RUNTIME_ID, managerId: manager.id,
  runtime: { label: "Electron", input: { gameTypes: ["web"] }, versionsOf: "electron" },
  supports: { saveLocation: false, saveEditing: false, cheats: false, cheatsPatcher: false },
  // Detection runs at import and at each library refresh, so a game imported
  // earlier gains the record, and a release that no longer holds an app loses it.
  decorateEntry: entry => {
    if (!applies(entry)) return entry;
    let found = null;
    try { found = findApp(entry); } catch {}
    return { ...entry, runtimeData: { ...entry.runtimeData, [RUNTIME_ID]: found ? { ...entry.runtimeData?.[RUNTIME_ID], ...found } : null } };
  },
  supportsEntry: entry => Boolean(recorded(entry)),
  ownsVersion,
  ensureRuntime: (entry, context) => {
    const selected = select(entry, context);
    return selected?.ready ? null : { managerId: manager.id, version: selected?.version || null,
      ...(selected?.discoveryRequired || !selected?.version ? { discoveryRequired: true } : {}), installOptions: {} };
  },
  launchRuntime
};

module.exports = { provider, RUNTIME_ID, findApp, recorded, gameEnvironment, loaderPath, mainScript, usesSteamApi, __test: { appCandidates, readAsarApp, readFolderApp } };

const fs = require("node:fs"), path = require("node:path");
const { parseSteamVdf } = require("../../../core/steam-installed-games");
const { positiveAppId } = require("./steamworks/app-id");
const { readPeVersion } = require("./pe-version");

const title = value => typeof value === "string" && value.trim() && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
function read(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024 ? fs.readFileSync(file, "utf8") : null;
  } catch { return null; }
}
function json(file) { try { return JSON.parse(read(file)); } catch { return null; } }
function entries(root) {
  try { const rows = fs.readdirSync(root, { withFileTypes: true }); return rows.length <= 2048 ? rows : []; }
  catch { return []; }
}
function cachedSteamTitle(userDataDir, appId) {
  if (!userDataDir || !appId) return null;
  const root = path.join(userDataDir, "steam"), accounts = path.join(root, "accounts");
  const stores = [root, ...entries(accounts).filter(row => row.isDirectory() && /^[a-f0-9]{24}$/.test(row.name)).slice(0, 256).map(row => path.join(accounts, row.name))];
  for (const store of stores) {
    const catalog = json(path.join(store, "catalog", `${appId}.json`));
    if (Number(catalog?.appId) === appId && title(catalog.name)) return title(catalog.name);
    const library = json(path.join(store, "library.json"))?.library;
    const found = Array.isArray(library) && library.find(row => Number(row.appId) === appId && title(row.name));
    if (found) return title(found.name);
  }
  return null;
}
function steamTitle(root, userDataDir) {
  const receipt = json(path.join(root, ".maclauncher-steam.json"));
  if (receipt?.complete === true && receipt.platform === "windows" && positiveAppId(receipt.appId) && title(receipt.name)) return title(receipt.name);
  const appId = positiveAppId(read(path.join(root, "steam_appid.txt"))) ||
    positiveAppId(read(path.join(root, "steam_settings", "steam_appid.txt")));
  const manifests = [root];
  const common = path.dirname(root), steamapps = path.dirname(common);
  if (path.basename(common).toLowerCase() === "common" && path.basename(steamapps).toLowerCase() === "steamapps") manifests.push(steamapps);
  for (const directory of manifests) for (const row of entries(directory)) {
    const match = /^appmanifest_([1-9]\d*)\.acf$/i.exec(row.name);
    if (!row.isFile() || !match || appId && Number(match[1]) !== appId) continue;
    try {
      const text = read(path.join(directory, row.name)), document = text && parseSteamVdf(text);
      const appState = document && Object.entries(document).find(([key]) => key.toLowerCase() === "appstate")?.[1];
      const state = appState && Object.fromEntries(Object.entries(appState).map(([key, value]) => [key.toLowerCase(), value]));
      if (Number(state?.appid) !== Number(match[1]) || !title(state?.name)) continue;
      if (directory !== root && state.installdir !== path.basename(root)) continue;
      return title(state.name);
    } catch {}
  }
  return cachedSteamTitle(userDataDir, appId);
}
function cleanFolder(name) {
  return name.replace(/-windows-[a-z0-9._-]+?-\d+(?:-[a-z0-9-]+)?$/i, "");
}
function windowsTitle(entry, { userDataDir } = {}) {
  const data = entry.moduleData || {}, recorded = entry.runtimeData?.crossover;
  const source = entry.importPath || entry.gamePath;
  const executable = data.originalRunnerPath || data.executablePath || recorded?.windowsExecutablePath || (/\.exe$/i.test(source || "") ? source : null);
  // Windows games and modules that title games from PE metadata share this precedence. Another engine detected
  // from a Windows carrier (an RPG Maker Game.exe, a packed Tyrano or Godot executable) keeps its authored title.
  if (!data.originalRunner?.strings && (entry.gameType ? entry.gameType !== "windows" : !/\.exe$/i.test(source || ""))) return null;
  let root = entry.releaseRootDir || entry.contentRootDir || entry.gamePath;
  try { if (!fs.statSync(root).isDirectory()) root = path.dirname(root); } catch { root = executable ? path.dirname(executable) : null; }
  if (!root) return null;
  // Unreal shipping programs live under <install>/<project>/Binaries/Win64.
  // That path proves the install scope without treating the project as a title.
  if (/^Win(?:32|64)$/i.test(path.basename(root)) && /^Binaries$/i.test(path.basename(path.dirname(root))))
    root = path.dirname(path.dirname(path.dirname(root)));
  const steam = steamTitle(root, userDataDir);
  if (steam) return steam;
  const folder = title(cleanFolder(path.basename(root)));
  if (folder && !/^(?:downloads?|desktop|documents|games?|bin|binaries|win32|win64|windows|payload|files)$/i.test(folder)) return folder;
  const unreal = /-Win(?:32|64)-(?:Shipping|Development|DebugGame)\.exe$/i.test(executable || "") ||
    executable && fs.existsSync(path.join(root, path.basename(executable, ".exe"), "Binaries", "Win64", path.basename(executable, ".exe") + "-Win64-Shipping.exe"));
  const strings = data.originalRunner?.strings || (!unreal && executable && readPeVersion(executable)?.strings) || {};
  if (!unreal) for (const candidate of [strings.ProductName, strings.FileDescription]) {
    const name = title(candidate);
    if (name && !/^(?:Unreal(?: Engine)?|UE[45]Game|Unity(?: Player)?|Game|Application|Launcher|nw|node-webkit|Electron)(?:\s+\d.*)?$/i.test(name)) return name;
  }
  // An engine can supply its own title without a PE version resource.
  if (!unreal && !strings.ProductName && !strings.FileDescription && title(entry.name) && entry.name !== path.basename(executable || "", path.extname(executable || ""))) return title(entry.name);
  return executable ? path.basename(executable, path.extname(executable)) : title(entry.name);
}
module.exports = { windowsTitle };

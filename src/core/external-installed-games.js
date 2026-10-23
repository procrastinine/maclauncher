const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { pathToFileURL } = require("node:url");
const { discoverInstalledSteamGames, discoverManagedSteamDownloads } = require("./steam-installed-games");
const { inspectInstalledMacArchitecture } = require("./steam-architectures");

const MAX_ENTRIES = 8192;
const platformName = value => ({ windows: "windows", win32: "windows", win64: "windows", mac: "macos", macos: "macos", macosx: "macos", osx: "macos", linux: "linux", android: "android" })[String(value || "").toLowerCase()] || null;
const inside = (root, value) => { const relative = path.relative(root, value); return !relative || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); };
async function entries(directory, maximum = MAX_ENTRIES) {
  let handle;
  try { handle = await fs.opendir(directory); const out = []; for (let entry; out.length < maximum && (entry = await handle.read());) out.push(entry); return out; }
  catch { return []; } finally { await handle?.close().catch(() => {}); }
}
async function directory(location) {
  if (typeof location !== "string" || !path.isAbsolute(location) || location.includes("\0")) return null;
  try { return (await fs.stat(location)).isDirectory() ? await fs.realpath(location) : null; } catch { return null; }
}
async function json(file) {
  let handle;
  try {
    if (!(await fs.lstat(file)).isFile()) return null;
    handle = await fs.open(file, "r"); const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    const data = Buffer.alloc(stat.size + 1), { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead > 8 * 1024 * 1024) return null;
    return JSON.parse(data.subarray(0, bytesRead).toString("utf8"));
  } catch { return null; } finally { await handle?.close().catch(() => {}); }
}
async function translateInstallPath(location, bottle) {
  if (typeof location !== "string" || location.includes("\0")) return null;
  if (path.isAbsolute(location)) return location;
  if (!bottle || !/^[a-z]:[\\/]/i.test(location)) return null;
  const parts = location.slice(3).split(/[\\/]/).filter(Boolean);
  if (parts.some(part => part === "." || part === "..")) return null;
  const drive = location[0].toLowerCase(), root = await directory(path.join(bottle.path, "dosdevices", `${drive}:`)) ||
    (drive === "c" ? await directory(path.join(bottle.path, "drive_c")) : null);
  return root ? path.join(root, ...parts) : null;
}
async function importedPaths(games) {
  const out = [];
  for (const game of games || []) for (const value of [game?.gamePath, game?.importPath, game?.contentRootDir]) {
    if (typeof value !== "string" || !path.isAbsolute(value)) continue;
    try { out.push({ path: await fs.realpath(value), gameId: String(game.gameId || "") }); } catch {}
  }
  return out;
}
async function iconFile(candidates) {
  for (const file of candidates) {
    if (typeof file !== "string" || !path.isAbsolute(file) || !/\.(?:png|jpe?g|webp|gif|ico)$/i.test(file)) continue;
    try { const stat = await fs.lstat(file); if (stat.isFile() && stat.size > 0 && stat.size <= 16 * 1024 * 1024) return await fs.realpath(file); } catch {}
  }
  return null;
}
async function makeRow({ store, appId, name, location, platform, source, bottle, manifestPath, version, versionName, buildId, branch, iconCandidates = [], complete = true }, imports) {
  if (!complete || !["epic", "gog", "itch", "google-play", "fdroid", "izzy"].includes(store) || !["string", "number"].includes(typeof appId) || !/^[a-z0-9_.-]{1,240}$/i.test(String(appId))) return null;
  const gamePath = await directory(await translateInstallPath(location, bottle));
  if (!gamePath) return null;
  const exactPlatform = platformName(platform), fallback = bottle ? "windows" : "macos";
  const imported = imports.filter(item => inside(gamePath, item.path));
  const iconPath = await iconFile(iconCandidates);
  const architecture = (exactPlatform || fallback) === "macos" ? await inspectInstalledMacArchitecture(gamePath) : {};
  const text = value => ["string", "number"].includes(typeof value) ? String(value).trim().slice(0, 160) || null : null;
  return {
    id: `${store}-${appId}-${crypto.createHash("sha256").update(gamePath).digest("hex").slice(0, 16)}`,
    appId: String(appId), name: typeof name === "string" && name.trim() ? name.trim() : `${({ gog: "GOG", epic: "Epic", itch: "itch.io", "google-play": "Google Play", fdroid: "F-Droid", izzy: "IzzyOnDroid" })[store]} game ${appId}`,
    path: gamePath, gamePath, platform: exactPlatform || fallback, platformSource: exactPlatform ? "manifest" : "client",
    ...architecture,
    source, store, libraryPath: path.dirname(gamePath), bottle: bottle?.name || null, manifestPath,
    version: text(versionName || version), versionName: text(versionName || version), buildId: text(buildId), branch: text(branch),
    iconPath, iconUrl: iconPath ? pathToFileURL(iconPath).href : null, imported: imported.length > 0,
    importedGameIds: [...new Set(imported.map(item => item.gameId).filter(Boolean))]
  };
}
async function bottleLocations(homeDir) {
  const results = [], seen = new Set();
  for (const root of [path.join(homeDir, "Library/Application Support/CrossOver/Bottles"), path.join(homeDir, "Applications/CrossOver/Bottles")]) {
    for (const entry of await entries(root, 512)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const location = await directory(path.join(root, entry.name));
      if (location && !seen.has(location)) { seen.add(location); results.push({ name: entry.name, path: location }); }
    }
  }
  return results;
}
async function epicManifests(root, bottle, imports) {
  const rows = [];
  for (const file of await entries(root)) {
    if (!file.isFile() || !/\.item$/i.test(file.name)) continue;
    const manifestPath = path.join(root, file.name), value = await json(manifestPath);
    if (!value || value.bIsIncompleteInstall === true || value.bIsApplication === false) continue;
    const executable = typeof value.LaunchExecutable === "string" ? value.LaunchExecutable : "";
    const platform = value.Platform || value.platform || (/\.exe$/i.test(executable) ? "windows" : /\.app(?:\/|$)/i.test(executable) ? "macos" : null);
    const row = await makeRow({ store: "epic", appId: value.MainGameAppName || value.AppName || value.CatalogItemId, name: value.DisplayName,
      location: value.InstallLocation, platform, source: bottle ? "crossover" : "native", bottle, manifestPath,
      version: value.AppVersionString || value.BuildVersion, buildId: value.BuildId,
      iconCandidates: [value.IconPath, value.icon_path] }, imports);
    if (row) rows.push(row);
  }
  return rows;
}
function installedRecords(value) {
  if (!value || typeof value !== "object") return [];
  const records = value.installed || value;
  return Array.isArray(records) ? records.map(record => [record?.appName || record?.app_name || record?.id, record]) : Object.entries(records);
}
async function installedJson(file, store, source, imports, configRoot) {
  const rows = [];
  for (const [key, value] of installedRecords(await json(file)).slice(0, MAX_ENTRIES)) {
    if (!value || typeof value !== "object" || value.is_dlc || value.isDLC || value.is_installed === false || value.installationState === "not_installed") continue;
    const appId = value.appName || value.app_name || value.gameId || value.id || key;
    const row = await makeRow({ store, appId, name: value.title || value.name, location: value.install_path || value.installPath || value.path,
      platform: value.platform, source, manifestPath: file,
      version: value.version || value.build_version || value.appVersion, buildId: value.buildId || value.build_id,
      iconCandidates: [value.iconPath, value.icon_path, path.join(configRoot, "images", `${appId}.jpg`), path.join(configRoot, "images", `${appId}.png`), path.join(configRoot, "icons", `${appId}.png`)] }, imports);
    if (row) rows.push(row);
  }
  return rows;
}
async function gogInfoAt(gamePath, bottle, imports) {
  const rows = [], metadataDirs = [gamePath];
  if (/\.app$/i.test(gamePath)) metadataDirs.push(...["Contents/Resources", "Contents/Resources/game", "Contents/Resources/support"].map(part => path.join(gamePath, part)));
  for (const root of metadataDirs) for (const entry of await entries(root, 1024)) {
    const match = /^goggame-(\d{1,20})\.info$/i.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    const manifestPath = path.join(root, entry.name), metadata = await json(manifestPath);
    if (!metadata || String(metadata.gameId || metadata.rootGameId || "") !== match[1]) continue;
    const executable = (Array.isArray(metadata.playTasks) ? metadata.playTasks : []).find(task => task.isPrimary)?.path || "";
    const row = await makeRow({ store: "gog", appId: match[1], name: metadata.name, location: gamePath,
      platform: metadata.platform || (/\.exe$/i.test(executable) ? "windows" : /\.app$/i.test(gamePath) ? "macos" : null),
      version: metadata.version || metadata.versionName, buildId: metadata.buildId,
      source: bottle ? "crossover" : "native", bottle, manifestPath,
      iconCandidates: [path.join(root, `goggame-${match[1]}.png`), path.join(root, `goggame-${match[1]}.ico`)] }, imports);
    if (row) rows.push(row);
  }
  return rows;
}
async function gogRoots(roots, bottle, imports) {
  const rows = [];
  for (const root of roots) {
    rows.push(...await gogInfoAt(root, bottle, imports));
    for (const entry of await entries(root, 2048)) if (entry.isDirectory()) rows.push(...await gogInfoAt(path.join(root, entry.name), bottle, imports));
  }
  return rows;
}
async function managedRows(userDataDir, imports) {
  if (!path.isAbsolute(userDataDir || "")) return [];
  const records = await json(path.join(userDataDir, "external/installations.json"));
  if (!Array.isArray(records)) return [];
  const rows = [];
  for (const record of records.slice(0, MAX_ENTRIES)) {
    const gamePath = await directory(typeof record === "string" ? record : record?.path);
    if (!gamePath) continue;
    const manifestPath = path.join(gamePath, ".maclauncher-external.json"), metadata = await json(manifestPath);
    if (metadata?.complete !== true || await directory(metadata.path) !== gamePath) continue;
    const row = await makeRow({ ...metadata, location: gamePath, source: "managed", manifestPath }, imports);
    if (row) {
      const importCandidate = typeof metadata.importPath === "string" ? metadata.importPath : typeof metadata.filename === "string" ? path.resolve(gamePath, metadata.filename) : gamePath;
      try {
        const input = await fs.realpath(importCandidate);
        if (inside(gamePath, input)) row.importPath = input;
      } catch { /* Completed metadata can outlive a manually removed archive. */ }
      rows.push(row);
    }
  }
  return rows;
}

async function itchRoots(roots, bottle, imports) {
  const rows = [];
  for (const root of roots) {
    const locations = [root, ...(await entries(root, 2048)).filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name))];
    for (const location of locations) {
      const plain = path.join(location, ".itch/receipt.json"), compressed = plain + ".gz";
      let receipt = await json(plain), manifestPath = plain;
      if (!receipt) {
        try {
          const stat = await fs.lstat(compressed);
          if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
          receipt = JSON.parse(zlib.gunzipSync(await fs.readFile(compressed), { maxOutputLength: 8 * 1024 * 1024 }).toString("utf8"));
          manifestPath = compressed;
        } catch { continue; }
      }
      const game = receipt.game || {}, upload = receipt.upload || {};
      const platforms = upload.platforms || {};
      let platform = receipt.platform || receipt.installInfo?.platform;
      if (!platform) {
        const available = Object.entries(platforms).filter(([, value]) => value === true || value === 1).map(([name]) => platformName(name)).filter(Boolean);
        if (available.length === 1) platform = available[0];
      }
      const row = await makeRow({ store: "itch", appId: game.id, name: game.title, location, platform,
        version: receipt.build?.userVersion || receipt.build?.user_version || receipt.build?.version,
        buildId: receipt.build?.id,
        source: bottle ? "crossover" : "itch", bottle, manifestPath,
        iconCandidates: [path.join(location, ".itch/icon.png"), path.join(location, ".itch/cover.png")] }, imports);
      if (row) rows.push(row);
    }
  }
  return rows;
}

async function discoverExternalInstalledGames({ homeDir = os.homedir(), userDataDir, games = [], systemApplicationsDir = "/Applications", sharedDir = path.join(path.dirname(homeDir), "Shared") } = {}) {
  const rows = (await discoverInstalledSteamGames({ homeDir, userDataDir, games })).map(row => ({ ...row, store: "steam" }));
  const imports = await importedPaths(games), bottles = await bottleLocations(homeDir);
  for (const root of [path.join(sharedDir, "Epic Games/Launcher/Data/Manifests"), path.join(homeDir, "Library/Application Support/Epic/EpicGamesLauncher/Data/Manifests")]) rows.push(...await epicManifests(root, null, imports));
  const heroicRoots = [path.join(homeDir, "Library/Application Support/heroic"), path.join(homeDir, ".config/heroic")];
  for (const root of heroicRoots) {
    rows.push(...await installedJson(path.join(root, "gog_store/installed.json"), "gog", "heroic", imports, root));
    rows.push(...await installedJson(path.join(root, "legendaryConfig/legendary/installed.json"), "epic", "heroic", imports, root));
  }
  for (const root of [path.join(homeDir, ".config/legendary"), path.join(homeDir, "Library/Application Support/legendary")]) rows.push(...await installedJson(path.join(root, "installed.json"), "epic", "legendary", imports, root));
  const nativeRoots = [systemApplicationsDir, path.join(systemApplicationsDir, "GOG Games"), path.join(homeDir, "Applications"), path.join(homeDir, "Applications/GOG Games"), path.join(homeDir, "GOG Games")];
  rows.push(...await gogRoots(nativeRoots, null, imports));
  rows.push(...await itchRoots([path.join(homeDir, "Library/Application Support/itch/apps"), path.join(homeDir, ".config/itch/apps"), path.join(homeDir, "Games/itch"), path.join(homeDir, "Applications/itch")], null, imports));
  for (const bottle of bottles) {
    const drive = path.join(bottle.path, "drive_c");
    rows.push(...await epicManifests(path.join(drive, "ProgramData/Epic/EpicGamesLauncher/Data/Manifests"), bottle, imports));
    rows.push(...await gogRoots([path.join(drive, "GOG Games"), ...["Program Files (x86)", "Program Files"].map(part => path.join(drive, part, "GOG Galaxy/Games"))], bottle, imports));
    for (const user of await entries(path.join(drive, "users"), 128)) if (user.isDirectory()) {
      rows.push(...await itchRoots([path.join(drive, "users", user.name, "AppData/Roaming/itch/apps"), path.join(drive, "users", user.name, "Local Settings/Application Data/itch/apps")], bottle, imports));
    }
  }
  const seen = new Set();
  return rows.filter(row => { const key = `${row.store}:${row.gamePath}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => a.name.localeCompare(b.name) || a.store.localeCompare(b.store) || a.path.localeCompare(b.path));
}

async function discoverDownloadedGames({ homeDir = os.homedir(), userDataDir, games = [] } = {}) {
  const rows = [...await discoverManagedSteamDownloads({ homeDir, userDataDir, games }), ...await managedRows(userDataDir, await importedPaths(games))];
  const seen = new Set();
  return rows.filter(row => { if (seen.has(row.gamePath)) return false; seen.add(row.gamePath); return true; })
    .sort((a, b) => a.name.localeCompare(b.name) || a.store.localeCompare(b.store) || a.path.localeCompare(b.path));
}

module.exports = { discoverExternalInstalledGames, discoverDownloadedGames };

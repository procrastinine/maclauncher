const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { inspectInstalledMacArchitecture } = require("./steam-architectures");

const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 16384;
const APP_ID = /^\d{1,10}$/;
const IMAGE = /\.(?:png|jpe?g|webp|gif)$/i;

// Steam's text KeyValues format is used by app manifests and library lists.
// Unknown escapes stay intact, so ordinary Windows paths remain usable too.
function parseSteamVdf(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error("Steam metadata is too large.");
  const tokens = [];
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) { index++; continue; }
    if (text.startsWith("//", index)) {
      const end = text.indexOf("\n", index); index = end < 0 ? text.length : end + 1; continue;
    }
    if (char === "{" || char === "}") { tokens.push(char); index++; }
    else if (char === '"') {
      let value = "", closed = false; index++;
      while (index < text.length) {
        const current = text[index++];
        if (current === '"') { closed = true; break; }
        if (current === "\\" && index < text.length) {
          const next = text[index++];
          value += next === "\\" || next === '"' ? next : `\\${next}`;
        } else value += current;
      }
      if (!closed) throw new Error("Steam metadata contains an unterminated string.");
      tokens.push({ value });
    } else {
      const start = index;
      while (index < text.length && !/[\s{}]/.test(text[index])) index++;
      const value = text.slice(start, index);
      // Platform conditionals follow a complete value rather than introduce a key.
      if (!/^\[\$!?\w+\]$/.test(value)) tokens.push({ value });
    }
    if (tokens.length > 250000) throw new Error("Steam metadata contains too many entries.");
  }
  let cursor = 0;
  function object(depth, nested) {
    if (depth > 32) throw new Error("Steam metadata is nested too deeply.");
    const result = Object.create(null);
    while (cursor < tokens.length) {
      const key = tokens[cursor++];
      if (key === "}") {
        if (!nested) throw new Error("Steam metadata contains an unexpected closing brace.");
        return result;
      }
      if (!key || typeof key !== "object") throw new Error("Steam metadata contains an invalid key.");
      const value = tokens[cursor++];
      if (value === "{") result[key.value] = object(depth + 1, true);
      else if (value && typeof value === "object") result[key.value] = value.value;
      else throw new Error("Steam metadata contains an invalid value.");
    }
    if (nested) throw new Error("Steam metadata contains an unclosed object.");
    return result;
  }
  return object(0, false);
}

function field(object, key) {
  if (!object || typeof object !== "object") return undefined;
  const found = Object.keys(object).find(name => name.toLowerCase() === key.toLowerCase());
  return found === undefined ? undefined : object[found];
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
async function realDirectory(directory) {
  try { return (await fs.stat(directory)).isDirectory() ? await fs.realpath(directory) : null; } catch { return null; }
}
async function readSmall(file) {
  let handle;
  try {
    // Refuse symbolic-link metadata; an installation may move while scanning.
    if (!(await fs.lstat(file)).isFile()) return null;
    handle = await fs.open(file, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > MAX_TEXT_BYTES ? null : buffer.subarray(0, bytesRead).toString("utf8");
  } catch { return null; } finally { await handle?.close().catch(() => {}); }
}
async function readVdf(file) {
  const text = await readSmall(file);
  if (!text) return null;
  try { return parseSteamVdf(text); } catch { return null; }
}
async function entries(directory, limit = MAX_DIRECTORY_ENTRIES) {
  let handle;
  try {
    handle = await fs.opendir(directory);
    const found = [];
    for (let entry; found.length < limit && (entry = await handle.read());) found.push(entry);
    return found.sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; } finally { await handle?.close().catch(() => {}); }
}
function platformName(value) {
  if (typeof value !== "string") return null;
  return ({ macos: "macos", macosx: "macos", osx: "macos", mac: "macos", windows: "windows", win32: "windows", linux: "linux" })[value.toLowerCase()] || null;
}

async function registeredLibraryPath(value, bottlePath) {
  if (typeof value !== "string" || value.includes("\0")) return null;
  if (path.isAbsolute(value)) return value;
  if (!bottlePath || !/^[a-z]:[\\/]/i.test(value)) return null;
  const segments = value.slice(3).split(/[\\/]/).filter(Boolean);
  if (segments.some(segment => segment === "." || segment === "..")) return null;
  const drive = value[0].toLowerCase();
  const driveRoot = await realDirectory(path.join(bottlePath, "dosdevices", `${drive}:`)) ||
    (drive === "c" ? await realDirectory(path.join(bottlePath, "drive_c")) : null);
  return driveRoot ? path.join(driveRoot, ...segments) : null;
}

async function findLibraries(homeDir) {
  const clients = [{ root: path.join(homeDir, "Library/Application Support/Steam"), platform: "macos", source: "steam", bottlePath: null }];
  const seenBottles = new Set();
  for (const base of ["Library/Application Support/CrossOver/Bottles", "Applications/CrossOver/Bottles"]) {
    const bottlesRoot = path.join(homeDir, base);
    for (const entry of await entries(bottlesRoot, 512)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const bottlePath = await realDirectory(path.join(bottlesRoot, entry.name));
      if (!bottlePath || seenBottles.has(bottlePath)) continue;
      seenBottles.add(bottlePath);
      for (const programFiles of ["Program Files (x86)", "Program Files"]) {
        clients.push({ root: path.join(bottlePath, "drive_c", programFiles, "Steam"), platform: "windows", source: "crossover", bottlePath, bottle: entry.name });
      }
    }
  }
  const libraries = [], seen = new Set();
  for (const client of clients) {
    if (!await realDirectory(path.join(client.root, "steamapps"))) continue;
    const metadata = await readVdf(path.join(client.root, "steamapps/libraryfolders.vdf"));
    const folders = field(metadata, "libraryfolders"), roots = [client.root];
    for (const [key, value] of Object.entries(folders || {}).slice(0, 1024)) {
      if (!/^\d+$/.test(key)) continue;
      const location = await registeredLibraryPath(typeof value === "string" ? value : field(value, "path"), client.bottlePath);
      if (location) roots.push(location);
    }
    for (const root of roots) {
      const steamapps = await realDirectory(path.join(root, "steamapps"));
      if (!steamapps || seen.has(steamapps)) continue;
      seen.add(steamapps);
      libraries.push({ ...client, libraryPath: path.dirname(steamapps), steamapps });
    }
  }
  return libraries;
}

async function binaryPlatform(gamePath) {
  const directories = [{ directory: gamePath, depth: 0 }], found = new Set();
  let remaining = 1024, reads = 0;
  while (directories.length && remaining > 0) {
    const { directory, depth } = directories.shift();
    for (const entry of await entries(directory, Math.min(remaining, 512))) {
      if (--remaining < 0) break;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (/\.app$/i.test(entry.name) && await realDirectory(path.join(file, "Contents"))) found.add("macos");
        else if (depth < 1 && !/^(?:_CommonRedist|redist|node_modules|\.git)$/i.test(entry.name)) directories.push({ directory: file, depth: depth + 1 });
      } else if (entry.isFile() && reads < 32 && (/\.(?:exe|x86_64|x86|bin)$/i.test(entry.name) || !path.extname(entry.name))) {
        if (/^(?:unins\d*|setup|install|uninstall|vcredist|dxsetup)/i.test(entry.name)) continue;
        let handle;
        try {
          reads++; handle = await fs.open(file, "r"); const buffer = Buffer.alloc(4);
          if ((await handle.read(buffer, 0, 4, 0)).bytesRead < 4) continue;
          const magic = buffer.toString("hex");
          if (magic.startsWith("4d5a")) found.add("windows");
          else if (magic === "7f454c46") found.add("linux");
          else if (["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic)) found.add("macos");
        } catch { /* A running Steam client can replace files during discovery. */ }
        finally { await handle?.close().catch(() => {}); }
      }
    }
  }
  return found;
}

async function localIcon(clientRoots, appId) {
  for (const root of clientRoots) {
    const cache = path.join(root, "appcache/librarycache");
    const appCache = path.join(cache, appId);
    const candidates = [path.join(cache, `${appId}_icon.jpg`), path.join(cache, `${appId}_icon.png`), path.join(appCache, "icon.jpg"), path.join(appCache, "icon.png")];
    // Current Steam caches icons as content-addressed JPEGs inside an app folder.
    const appEntries = await entries(appCache, 256);
    candidates.push(...appEntries.filter(entry => entry.isFile() && /^[a-f\d]{32,64}\.(?:png|jpe?g)$/i.test(entry.name)).map(entry => path.join(appCache, entry.name)));
    candidates.push(path.join(appCache, "library_600x900.jpg"), path.join(appCache, "header.jpg"), path.join(cache, `${appId}_header.jpg`));
    for (const file of candidates) {
      try {
        const stat = await fs.lstat(file);
        if (stat.isFile() && stat.size > 0 && stat.size <= 16 * 1024 * 1024 && IMAGE.test(file)) return await fs.realpath(file);
      } catch { /* Artwork is optional and stays local. */ }
    }
  }
  return null;
}

async function importedPaths(games) {
  const results = [];
  for (const game of Array.isArray(games) ? games : []) {
    for (const value of [game?.gamePath, game?.importPath, game?.contentRootDir]) {
      if (typeof value !== "string" || !path.isAbsolute(value)) continue;
      try { results.push({ path: await fs.realpath(value), gameId: String(game.gameId || "") }); } catch { /* A missing old import is not an installed game. */ }
    }
  }
  return results;
}

async function installedRows(library, iconRoots, imports) {
  const rows = [], common = await realDirectory(path.join(library.steamapps, "common"));
  if (!common) return rows;
  for (const entry of await entries(library.steamapps)) {
    const match = /^appmanifest_(\d{1,10})\.acf$/i.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    const manifestPath = path.join(library.steamapps, entry.name);
    const state = field(await readVdf(manifestPath), "appstate");
    const appId = field(state, "appid"), installDir = field(state, "installdir");
    if (typeof appId !== "string" || appId !== match[1] || !APP_ID.test(appId) || Number(appId) < 1 ||
      typeof installDir !== "string" || !installDir || installDir === "." || installDir === ".." || /[\\/\0]/.test(installDir)) continue;
    const stateFlags = field(state, "StateFlags");
    // Steam retains manifests for queued and unfinished downloads too. Its
    // FullyInstalled bit remains set for installed games awaiting an update.
    if (typeof stateFlags === "string" && /^\d+$/.test(stateFlags) && (Number(stateFlags) & 4) === 0) continue;
    const gamePath = await realDirectory(path.join(common, installDir));
    if (!gamePath || !inside(common, gamePath) || gamePath === common) continue;
    const override = platformName(field(field(state, "UserConfig"), "platform_override_dest"));
    const binaries = override ? new Set() : await binaryPlatform(gamePath);
    const platform = override || (binaries.has(library.platform) ? library.platform : binaries.values().next().value) || library.platform;
    const iconPath = await localIcon([library.root, ...iconRoots.filter(root => root !== library.root)], appId);
    const importedGameIds = [...new Set(imports.filter(item => inside(gamePath, item.path)).map(item => item.gameId).filter(Boolean))];
    const imported = imports.some(item => inside(gamePath, item.path));
    const manifestName = field(state, "name");
    const architecture = platform === "macos" ? await inspectInstalledMacArchitecture(gamePath) : {};
    rows.push({
      id: `steam-${appId}-${createHash("sha256").update(gamePath).digest("hex").slice(0, 16)}`,
      appId, name: typeof manifestName === "string" && manifestName.trim() ? manifestName.trim() : installDir,
      path: gamePath, gamePath, platform, platformSource: override ? "manifest" : binaries.size ? "binary" : "client",
      ...architecture,
      source: library.source, libraryPath: library.libraryPath, bottle: library.bottle || null,
      manifestPath, buildId: field(state, "buildid") || null,
      branch: field(field(state, "UserConfig"), "BetaKey") || null,
      iconPath, iconUrl: iconPath ? pathToFileURL(iconPath).href : null, imported, importedGameIds
    });
  }
  return rows;
}

async function managedRows(userDataDir, iconRoots, imports) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) return [];
  const text = await readSmall(path.join(userDataDir, "steam/installations.json"));
  let installations;
  try { installations = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(installations)) return [];
  const rows = [];
  for (const installation of installations.slice(0, MAX_DIRECTORY_ENTRIES)) {
    const location = typeof installation === "string" ? installation : installation?.path;
    if (typeof location !== "string" || !path.isAbsolute(location)) continue;
    const gamePath = await realDirectory(location);
    if (!gamePath) continue;
    const metadataPath = path.join(gamePath, ".maclauncher-steam.json");
    let metadata;
    try { metadata = JSON.parse(await readSmall(metadataPath)); } catch { continue; }
    const appId = String(metadata?.appId || ""), platform = platformName(metadata?.platform);
    if (metadata?.complete !== true || !APP_ID.test(appId) || Number(appId) < 1 || !platform ||
      typeof metadata.path !== "string" || !path.isAbsolute(metadata.path) || await realDirectory(metadata.path) !== gamePath) continue;
    const iconPath = await localIcon(iconRoots, appId);
    const importedGameIds = [...new Set(imports.filter(item => inside(gamePath, item.path)).map(item => item.gameId).filter(Boolean))];
    const architecture = platform === "macos" ? await inspectInstalledMacArchitecture(gamePath) : {};
    rows.push({
      id: `steam-${appId}-${createHash("sha256").update(gamePath).digest("hex").slice(0, 16)}`,
      appId, name: typeof metadata.name === "string" && metadata.name.trim() ? metadata.name.trim() : `Steam app ${appId}`,
      path: gamePath, gamePath, platform, platformSource: "manifest", source: "managed", libraryPath: path.dirname(gamePath), bottle: null,
      ...architecture,
      manifestPath: metadataPath, buildId: metadata.buildId || null, branch: metadata.branch || null,
      version: typeof metadata.version === "string" ? metadata.version : null,
      iconPath, iconUrl: iconPath ? pathToFileURL(iconPath).href : null,
      imported: imports.some(item => inside(gamePath, item.path)), importedGameIds
    });
  }
  return rows;
}

async function discoverInstalledSteamGames({ homeDir = os.homedir(), userDataDir, games = [] } = {}) {
  const libraries = await findLibraries(homeDir);
  const iconRoots = [...new Set(libraries.map(library => library.root))];
  const imports = await importedPaths(games), rows = [];
  for (const library of libraries) rows.push(...await installedRows(library, iconRoots, imports));
  const seen = new Set();
  return rows.filter(row => { if (seen.has(row.gamePath)) return false; seen.add(row.gamePath); return true; })
    .sort((a, b) => a.name.localeCompare(b.name) || a.platform.localeCompare(b.platform) || a.path.localeCompare(b.path));
}

async function discoverManagedSteamDownloads({ homeDir = os.homedir(), userDataDir, games = [] } = {}) {
  const seen = new Set();
  return (await managedRows(userDataDir, [path.join(homeDir, "Library/Application Support/Steam")], await importedPaths(games)))
    .filter(row => { if (seen.has(row.gamePath)) return false; seen.add(row.gamePath); return true; })
    .map(row => ({ ...row, store: "steam" }));
}

module.exports = { discoverInstalledSteamGames, discoverManagedSteamDownloads, parseSteamVdf };

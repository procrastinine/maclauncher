const fs = require("node:fs");
const path = require("node:path");
const { readAppManifest } = require("./app-id");

const failure = (code, message) => Object.assign(new Error(message), { code });

// Inspect only the library containing the selected app. Steam accounts, global
// library discovery and game files are neither read nor changed here.
function findInstalledApp(appPath) {
  if (!path.isAbsolute(appPath || "")) return null;
  let current;
  try { current = fs.realpathSync(appPath); } catch { return null; }
  for (let depth = 0; depth < 16; depth++) {
    const common = path.dirname(current), library = path.dirname(common);
    if (path.basename(common).toLowerCase() === "common" && path.basename(library).toLowerCase() === "steamapps") {
      const matches = [], directory = fs.opendirSync(library);
      let count = 0;
      try {
        for (let item; (item = directory.readSync());) {
          if (++count > 8192) throw failure("STEAM_LIBRARY_TOO_LARGE", "This Steam library contains too many entries to identify the game.");
          if (!item.isFile() || !/^appmanifest_\d{1,10}\.acf$/i.test(item.name)) continue;
          const manifestPath = path.join(library, item.name);
          let manifest;
          try { manifest = readAppManifest(manifestPath, library); } catch { continue; }
          if (!manifest.installDir || path.basename(manifest.installDir) !== manifest.installDir || /[\\\0]/.test(manifest.installDir)) continue;
          let installed;
          try { installed = fs.realpathSync(path.join(common, manifest.installDir)); } catch { continue; }
          if (installed === current) matches.push({ appId: manifest.value, installRoot: current, manifestPath, manifestSha256: manifest.sha256 });
        }
      } finally { directory.closeSync(); }
      if (matches.length > 1) throw failure("STEAM_APP_ID_CONFLICT", "Multiple Steam application manifests identify this game. Repair its installation in Steam before playing.");
      return matches[0] || null;
    }
    if (common === current) break;
    current = common;
  }
  return null;
}

async function prepareNativeLaunch(appPath, { baseEnvironment = process.env } = {}) {
  const installation = findInstalledApp(appPath);
  if (!installation) return { environment: baseEnvironment, installation: null };
  // These identify the real installed game to its publisher-supplied API. Steam
  // remains responsible for license/authentication checks; no API is replaced.
  const environment = { ...baseEnvironment, SteamAppId: String(installation.appId), SteamGameId: String(installation.appId) };
  delete environment.SteamOverlayGameId;
  return { environment, installation };
}

module.exports = { findInstalledApp, prepareNativeLaunch };

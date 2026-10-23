const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const Bundle = require("../bundled-native");

const INTERFACE = /^(?:Steam(?:Client|User|Friends|Utils|Networking(?:Messages|Sockets|Utils)?|Controller|Input|MatchMaking(?:Servers)?|MatchGameSearch|Parties)\d{3}|STEAM[A-Z_]+(?:\d{3}|_V\d{3}))$/;
const MAIN = "[main::general]\nenable_voice_chat=0\n[main::connectivity]\noffline=1\ndisable_networking=1\ndisable_source_query=1\ndownload_steamhttp_requests=0\ndisable_lobby_creation=1\nshare_leaderboards_over_network=0\n[main::misc]\nforce_steamhttp_success=0\nenable_steam_preowned_ids=0\ndisable_steamoverlaygameid_env_var=1\n";
const OVERLAY = "[overlay::general]\nenable_experimental_overlay=0\n";
const APPS = "[app::dlcs]\nunlock_all=0\n";

function configurationFiles({ appId, interfaces, language = "english" }) {
  if (!Number.isInteger(appId) || appId < 1 || appId > 0xffffffff) throw new Error("A positive Steam application ID is required for the offline API.");
  if (!Array.isArray(interfaces) || interfaces.length < 1 || interfaces.length > 128 ||
      new Set(interfaces).size !== interfaces.length || interfaces.some(value => !INTERFACE.test(value))) throw new Error("Exact Steam interface versions are required.");
  if (interfaces.filter(value => /^SteamClient\d{3}$/.test(value)).length !== 1) throw new Error("Select exactly one Steam client ABI version.");
  if (!/^[a-z]{2,24}$/.test(language)) throw new Error("Invalid Steam API language.");
  return {
    "steam_appid.txt": `${appId}\n`,
    "steam_interfaces.txt": interfaces.join("\n") + "\n",
    "configs.main.ini": MAIN,
    "configs.overlay.ini": OVERLAY,
    "configs.app.ini": APPS,
    "configs.user.ini": `[user::general]\naccount_name=Player\naccount_steamid=76561197960265729\nlanguage=${language}\n`
  };
}

function writeOwnedConfiguration(directory, files) {
  if (!path.isAbsolute(directory || "")) throw new Error("The Steam API configuration directory must be absolute and launcher-owned.");
  Bundle.realDirectory(directory, { create: true });
  const names = Object.keys(files);
  if (fs.readdirSync(directory).some(name => !names.includes(name))) throw new Error("Steam API configuration contains unrelated files; they were preserved.");
  for (const name of names) {
    const file = path.join(directory, name);
    if (fs.existsSync(file)) Bundle.readRegular(file, 32 * 1024);
  }
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(directory, name);
    if (fs.existsSync(file) && Bundle.readRegular(file, 32 * 1024).bytes.toString("utf8") === contents) continue;
    const temporary = path.join(directory, `.${name}-${randomUUID()}`);
    try { fs.writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
}

/** Child-only loader/configuration environment. Never changes process.env. */
function prepareEnvironment({ libraryPath, ownedDirectory, appId, interfaces, language, baseEnvironment = process.env }) {
  if (!path.isAbsolute(libraryPath || "") || !path.isAbsolute(ownedDirectory || "")) throw new Error("Absolute native library and owned state paths are required.");
  const files = configurationFiles({ appId, interfaces, language });
  const settingsPath = path.join(ownedDirectory, "settings"), savePath = path.join(ownedDirectory, "state");
  writeOwnedConfiguration(settingsPath, files);
  Bundle.realDirectory(savePath, { create: true });
  // Upstream merges the local save profile after game configuration. Restore
  // our offline values there too so a previous profile cannot re-enable LAN.
  writeOwnedConfiguration(path.join(savePath, "settings"), files);
  const environment = { ...baseEnvironment, DYLD_LIBRARY_PATH: path.dirname(libraryPath), MACLAUNCHER_STEAM_SETTINGS: settingsPath,
    GseSavePath: savePath, SteamAppId: String(appId), SteamGameId: String(appId) };
  // A Steam-launched parent may retain a different game's identity. No global
  // settings, account identity, overlay, LAN, HTTP or voice configuration is read.
  delete environment.SteamOverlayGameId;
  return { environment, settingsPath, savePath, appId, mode: "offline" };
}

module.exports = { INTERFACE, configurationFiles, writeOwnedConfiguration, prepareEnvironment };

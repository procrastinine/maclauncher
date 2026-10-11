const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const Inspect = require("./inspect");
const Disc = require("./disc");
const manager = require("./runtime/manager");
const Build = require("./runtime/build");
const Portable = require("./runtime/portable-build");
const Native = require("../shared/runtime/local-native");
const Bundle = require("../shared/runtime/bundled-native");
const GameData = require("../shared/game-data");
const SUPPORTED_VERSIONS = [Build.LEGACY_VERSION, Build.VERSION, Portable.VERSION];
const DISC_VERSIONS = [Build.VERSION, Portable.VERSION];

function directoryFor(entry, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "")) throw new Error("AI5 requires a persisted game id.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id);
}
function refreshGame(entry, context) {
  const root = entry.contentRootDir || entry.gamePath;
  const data = Inspect.inspectGame(root, { inputPath: entry.moduleData?.originalRunnerPath || entry.moduleData?.iniPath });
  if (!data) throw new Error("AI5 configuration or script data was not found.");
  const configuredProfile = context.runtimeSettings?.gameProfile;
  const requestedProfile = configuredProfile && configuredProfile !== "auto" ? configuredProfile : data.gameProfile;
  if (!Object.hasOwn(Inspect.SUPPORTED, requestedProfile || "")) throw new Error("This AI5 game profile is unrecognized. Select a supported profile in Runtime Settings.");
  const disc = Disc.matchingData(root, requestedProfile);
  if (disc) data.requiredNativeProfile = Portable.VERSION;
  entry.moduleData = data;
  return { root, data, profile: requestedProfile, disc };
}

const profileCache = new Set();
function verifyProfile(install) {
  if (!SUPPORTED_VERSIONS.includes(install.version) || install.upstreamRevision !== Build.REVISION) throw new Error("AI5 1.5.0 for Mac is required for automatic per-game saves.");
  const profileKey = `${install.version}:${install.sha256}`;
  if (profileCache.has(profileKey)) return;
  const size = fs.statSync(install.executablePath).size;
  if (size > 8 * 1024 * 1024) throw new Error("AI5 executable exceeds the native profile inspection limit.");
  const bytes = fs.readFileSync(install.executablePath);
  if (!["MACLAUNCHER_AI5_SAVE_DIR", "MACLAUNCHER_AI5_OUTPUT_DIR", "MACLAUNCHER_AI5_FONT_DIR", "MACLAUNCHER_AI5_INI"].every(key => bytes.includes(Buffer.from(key)))) {
    throw new Error("This interpreter lacks per-game save support. Select Automatic in Runtime Settings to use the included AI5 runtime.");
  }
  if (DISC_VERSIONS.includes(install.version) && !bytes.includes(Buffer.from("MACLAUNCHER_AI5_RESOURCE_DIR"))) throw new Error("This interpreter lacks AI5's original-disc adapter.");
  if (install.version === Portable.VERSION && !bytes.includes(Buffer.from(Portable.VERSION))) throw new Error("AI5 executable does not match the selected Mac v3 version.");
  if (profileCache.size >= 32) profileCache.delete(profileCache.values().next().value);
  profileCache.add(profileKey);
}

function fontDirectory(install) {
  const shipped = Bundle.resolveInstalledAsset(install, "fontGothic");
  const directory = shipped ? path.dirname(shipped) : path.resolve(path.dirname(install.executablePath), "../share/ai5-sdl2/fonts");
  for (const name of ["DotGothic16-Regular.ttf", "Kosugi-Regular.ttf", "NotoSansJP-Thin.ttf", "wine_tahoma.ttf"]) {
    if (!fs.statSync(path.join(directory, name)).isFile()) throw new Error("AI5 needs its complete native distribution and font files.");
  }
  return directory;
}

function writeConfiguration(data, file, { textCapture = "off" } = {}) {
  let text = Inspect.decodeIni(fs.readFileSync(data.iniPath));
  if (data.extraIniPath) text += "\n" + Inspect.decodeIni(fs.readFileSync(data.extraIniPath));
  const references = new Map(data.archiveReferences.map(reference => [reference.key, reference.path]));
  const remaining = new Map(references);
  let section = "";
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).flatMap(line => {
    const heading = /^\s*\[([^\]]+)\]/.exec(line); if (heading) section = heading[1].trim().toLowerCase();
    const field = /^\s*([^=]+)=(.*)$/.exec(line);
    if (!field) return [line];
    const key = field[1].trim().toLowerCase();
    if (section === "file" && references.has(key)) { remaining.delete(key); return [`${field[1].trim()}=${references.get(key)}`]; }
    // Fonts are selected separately after configuration parsing. This prevents
    // obsolete C:\Windows font paths from overriding packaged defaults.
    if (section === "ai5sdl2" && ["font", "fontface"].includes(key)) return [];
    return [line];
  });
  // Native INIs are parsed after command-line flags. Persist the requested
  // capture mode last so an old companion INI cannot override the user's Off.
  if (remaining.size) lines.push("[FILE]", ...[...remaining].map(([key, file]) => `${key}=${file}`));
  const force = data.archiveReferences.filter(ref => ref.forceArchive);
  if (force.length) lines.push("[FILE]", ...force.map(ref => `bARC${ref.type.toUpperCase()}=1`));
  lines.push("[AI5SDL2]", `TEXTHOOKSTDOUT=${textCapture === "console" ? 1 : 0}`,
    `TEXTHOOKCLIPBOARD=${textCapture === "clipboard" ? 1 : 0}`);
  const temporary = file + `.tmp-${crypto.randomUUID()}`;
  try { fs.writeFileSync(temporary, lines.join("\n") + "\n", { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
  return file;
}

function prepareLaunch(entry, context, install) {
  verifyProfile(install);
  const { root, data, profile, disc } = refreshGame(entry, context), directory = directoryFor(entry, context);
  const capture = context.runtimeSettings?.textCapture || "off";
  if (!["off", "console", "clipboard"].includes(capture)) throw new Error("Choose a supported text-capture mode.");
  const saves = entry.saveDirOverride || path.join(directory, "saves"), screenshots = path.join(directory, "screenshots");
  if (!path.isAbsolute(saves)) throw new Error("AI5 save directory must be absolute.");
  fs.mkdirSync(saves, { recursive: true }); fs.mkdirSync(screenshots, { recursive: true });
  if (disc && !DISC_VERSIONS.includes(install.version)) throw new Error("This original disc layout needs AI5 1.5.0 Mac v2 or later.");
  const resources = DISC_VERSIONS.includes(install.version) ? Disc.prepareResources(root, data, profile, directory, saves, disc) : { references: data.archiveReferences, env: {}, descriptors: [], seededSaves: [] };
  const configPath = writeConfiguration({ ...data, archiveReferences: resources.references }, path.join(directory, "AI5SDL2.INI"), { textCapture: capture });
  const fonts = fontDirectory(install), custom = context.runtimeSettings?.fontPath?.trim();
  const authoredFont = data.config.ai5sdl2?.font;
  const font = custom || (authoredFont && Inspect.localFile(root, authoredFont, { stat: file => { try { return fs.statSync(file); } catch { return null; } }, readdir: dir => fs.readdirSync(dir, { withFileTypes: true }) }, { windowsInstallPath: true }));
  if (custom && (!path.isAbsolute(custom) || !fs.statSync(custom).isFile())) throw new Error("Choose an existing font file.");
  entry.defaultSaveDir = saves;
  const env = { ...process.env, ...Object.fromEntries(["RESOURCE_DIR", "AUX_ROOT", "BG_BASE", "MES_BASE", "DATA_BASE", "BGM_BASE", "EFFECT_BASE"].map(key => [`MACLAUNCHER_AI5_${key}`, ""])),
    MACLAUNCHER_AI5_SAVE_DIR: saves, MACLAUNCHER_AI5_OUTPUT_DIR: screenshots,
    MACLAUNCHER_AI5_FONT_DIR: fonts, MACLAUNCHER_AI5_INI: configPath, MACLAUNCHER_AI5_FONT: font || "",
    MACLAUNCHER_AI5_ORIGINAL_EXE: data.originalRunnerPath || "", ...resources.env };
  const args = ["--game", profile];
  if (capture === "console") args.push("--texthook-stdout");
  if (capture === "clipboard") args.push("--texthook-clipboard");
  args.push(data.iniPath);
  fs.writeFileSync(path.join(directory, "preparation.json"), JSON.stringify({ profile, runtimeVersion: install.version,
    sourceIniPath: data.iniPath, sourceIniSha256: Native.hashFile(data.iniPath), privateConfigPath: configPath, configSha256: Native.hashFile(configPath),
    originalDataRoot: root, saves, screenshots, copies: [configPath], disc: resources.disc, archiveDescriptors: resources.descriptors, seededSaves: resources.seededSaves }, null, 2));
  return { root, data, profile, directory, saves, screenshots, configPath, args, env };
}

module.exports = { id: manifest.id, manifest, detectGame, runtimeManagers: [manager], normalizeRuntimeId: () => "ai5",
  onImport: (entry, context) => { entry.defaultSaveDir = path.join(directoryFor(entry, context), "saves"); },
  ensureRuntime: (entry, context) => {
    const game = refreshGame(entry, context);
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (selected.version === Build.LEGACY_VERSION && game.disc) {
      throw new Error("AI5 Mac v1 does not support this disc layout. Select Automatic in Runtime Settings to use the Included runtime.");
    }
    if (!SUPPORTED_VERSIONS.includes(selected.version)) throw new Error("Select AI5 1.5.0 for the supported native/save profile.");
    if (selected.ready) verifyProfile(selected.install);
    return selected.ready ? null : { managerId: "ai5", version: selected.version, installOptions: {} };
  },
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId !== "ai5") return null;
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selected.ready) throw new Error(selected.reason);
    const launch = prepareLaunch(entry, context, selected.install);
    context.onEntryChange?.(entry);
    return context.spawnDetachedChecked(selected.install.executablePath, launch.args, { cwd: launch.root, env: launch.env }, selected.install.needsRosetta);
  },
  cleanupGameData: (entry, context) => { fs.rmSync(directoryFor(entry, context), { recursive: true, force: true }); return true; },
  actions: {
    inspectGame: entry => Inspect.inspectGame(entry.contentRootDir || entry.gamePath, { inputPath: entry.moduleData?.originalRunnerPath || entry.moduleData?.iniPath }),
    runtimeStatus: (entry, _payload, context) => manager.resolveSelection(entry, context.settings, context.userDataDir),
    registerRuntime: (entry, payload, context) => {
      const version = payload?.version || Portable.VERSION, runtimePath = payload?.runtimePath || context.runtimeSettings?.runtimePath;
      const selected = Native.resolveLocalRuntime({ runtimePath, runtimeVersion: version, upstreamRevision: Build.REVISION });
      verifyProfile({ ...selected, version });
      const installed = manager.core.registerLocal({ userDataDir: context.userDataDir, version, runtimePath });
      context.onRuntimeStateChange?.(); return installed;
    }
  },
  __test: { prepareLaunch, writeConfiguration, fontDirectory, verifyProfile }
};

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify, isDeepStrictEqual } = require("node:util");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const Inspect = require("./inspect");
const manager = require("./runtime/manager");
const Build = require("./runtime/build");
const Portable = require("./runtime/portable-build");
const Native = require("../shared/runtime/local-native");
const Bundle = require("../shared/runtime/bundled-native");
const GameData = require("../shared/game-data");
const Output = require("./native-output");
const run = promisify(execFile);
const supportedVersions = Object.freeze([Portable.VERSION, ...Build.SUPPORTED_VERSIONS]);

function directoryFor(entry, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(context.userDataDir || "")) throw new Error("Nitroplus requires a persisted game id and launcher data directory.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id);
}
function refreshGame(entry) {
  const root = entry.contentRootDir || entry.gamePath;
  const data = Inspect.inspectGame(root, { inputPath: entry.moduleData?.originalRunnerPath });
  if (!data) throw new Error("A validated Nitroplus NPA v1 archive and NSS boot script were not found.");
  entry.moduleData = data; return { root, data };
}
function requireFormat(data) {
  if (!data.supported) throw new Error(data.compatibility);
}
const profileCache = new Set();
function readProfile(install) {
  const shipped = Bundle.resolveInstalledAsset(install, "profile");
  const root = shipped ? path.dirname(shipped) : path.resolve(path.dirname(install.executablePath), "..");
  const file = shipped || path.join(root, "profile.json");
  if (fs.statSync(file).size > 65536) throw new Error("Nitroplus profile exceeds its metadata limit.");
  return { root, profile: JSON.parse(fs.readFileSync(file, "utf8")) };
}
function verifyPortableProfile(profile, install) {
  const sources = [{ id: "libnpa", upstreamRevision: Portable.NPA_REVISION, sourceTreeSha256: Portable.NPA_TREE_SHA256 }];
  const provenance = install.buildProvenance;
  if (profile.version !== Portable.VERSION || profile.profileRevision !== Portable.PROFILE_REVISION ||
      profile.upstreamRevision !== Portable.REVISION || profile.npaRevision !== Portable.NPA_REVISION ||
      profile.sourceTreeSha256 !== Portable.ENGINE_TREE_SHA256 || !isDeepStrictEqual(profile.additionalSources, sources) ||
      profile.combinedSourceTreeSha256 !== Portable.COMBINED_TREE_SHA256 || profile.architecture !== "arm64" || profile.minimumMacOS !== "13.0" ||
      !/^[a-f0-9]{64}$/.test(profile.overlaySha256 || "") || provenance?.sourceTreeSha256 !== profile.sourceTreeSha256 ||
      provenance?.overlaySha256 !== profile.overlaySha256 || !isDeepStrictEqual(provenance?.additionalSources, sources)) {
    throw new Error("Nitroplus V8 runtime source or adapter metadata differs from its package.");
  }
}
function verifyProfile(install) {
  if (!supportedVersions.includes(install.version) || install.upstreamRevision !== Build.REVISION) throw new Error("libnpengine 0.5.3 for Mac is required for NPA/NSS and per-game saves.");
  if (install.version === Portable.VERSION) verifyPortableProfile(readProfile(install).profile, install);
  const identity = `${install.version}:${install.sha256}`;
  if (profileCache.has(identity)) return;
  if (fs.statSync(install.executablePath).size > 16 * 1024 * 1024) throw new Error("Nitroplus executable exceeds the profile inspection limit.");
  const bytes = fs.readFileSync(install.executablePath);
  const profileMarker = `libnpengine 0.5.3 Mac ${install.version.split("-").at(-1)} /`;
  if (![profileMarker, "MACLAUNCHER_NPENGINE_SAVE_DIR", Build.REVISION, Build.NPA_REVISION, "--check-scripts"].every(marker => bytes.includes(Buffer.from(marker)))) throw new Error("This interpreter lacks NPA/NSS or per-game save support. Select Automatic in Runtime Settings to use the included runtime.");
  if (profileCache.size >= 32) profileCache.delete(profileCache.values().next().value);
  profileCache.add(identity);
}
function distribution(install) {
  const { root, profile } = readProfile(install);
  if (profile.version !== install.version || !supportedVersions.includes(profile.version) || profile.upstreamRevision !== Build.REVISION || profile.npaRevision !== Build.NPA_REVISION ||
      JSON.stringify(profile.plugins) !== JSON.stringify(Build.PLUGINS)) throw new Error("Nitroplus runtime libraries are missing or incompatible.");
  if (profile.version === Portable.VERSION) verifyPortableProfile(profile, install);
  if ([Build.VERSION, Build.PREVIOUS_VERSION, Build.V5_VERSION, Build.V4_VERSION, Build.V3_VERSION].includes(profile.version) &&
      (profile.profileRevision !== `macos-npa-nss-private-${profile.version.split("-").at(-1)}` ||
      !/^[a-f0-9]{64}$/.test(profile.sourceTreeSha256 || "") || !/^[a-f0-9]{64}$/.test(profile.overlaySha256 || ""))) throw new Error("The current Nitroplus Mac profile needs its exact source and overlay metadata.");
  const plugins = path.join(root, "lib/gstreamer-1.0");
  for (const plugin of Build.PLUGINS) if (!fs.statSync(path.join(plugins, `libgst${plugin}.dylib`)).isFile()) throw new Error("Nitroplus GStreamer plugin payload is incomplete.");
  if (!fs.statSync(path.join(root, "fontconfig.conf")).isFile()) throw new Error("Nitroplus needs its native font configuration.");
  return { root, plugins };
}
function prepareLaunch(entry, context, install) {
  verifyProfile(install);
  const { root, data } = refreshGame(entry); requireFormat(data);
  const directory = directoryFor(entry, context), saves = entry.saveDirOverride || path.join(directory, "saves");
  if (!path.isAbsolute(saves)) throw new Error("Nitroplus save directory must be absolute.");
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(saves, { recursive: true });
  const runtime = distribution(install);
  entry.defaultSaveDir = saves;
  const args = ["--game-root", path.resolve(root), "--save-dir", saves, "--boot", data.bootScript,
    "--title", data.title, "--width", String(data.width), "--height", String(data.height)];
  const sound = data.configuration["サウンド"] || data.configuration.sound || {}, font = data.configuration["フォント"] || data.configuration.font || {};
  const integer = (value, fallback, minimum, maximum) => /^\d+$/.test(value || "") ? Math.max(minimum, Math.min(maximum, Number(value))) : fallback;
  for (const [key, field, fallback] of [["--bgm-volume", "bgm_volume", 700], ["--sound-volume", "se_volume", 700], ["--voice-volume", "voice_volume", 1000]]) args.push(key, String(integer(sound[field], fallback, 0, 1000)));
  args.push("--font-face", font.face || "sans-serif", "--font-size", String(integer(font.size, 18, 8, 128)), "--font-weight", String(integer(font.weight, 500, 100, 1000)));
  const env = { ...process.env, MACLAUNCHER_NPENGINE_SAVE_DIR: saves,
    GST_PLUGIN_PATH_1_0: runtime.plugins, GST_PLUGIN_SYSTEM_PATH_1_0: "", GST_REGISTRY_1_0: path.join(directory, "gstreamer-registry.bin"),
    GST_REGISTRY_FORK: "no", FONTCONFIG_FILE: path.join(runtime.root, "fontconfig.conf"), XDG_CACHE_HOME: path.join(directory, "cache") };
  for (const key of Object.keys(env)) if (key.startsWith("DYLD_")) delete env[key];
  fs.writeFileSync(path.join(directory, "preparation.json"), JSON.stringify({ runtimeVersion: install.version,
    engineRevision: Build.REVISION, npaRevision: Build.NPA_REVISION, originalDataRoot: path.resolve(root),
    archives: data.archives.map(archive => ({ path: path.resolve(archive.path), bytes: archive.bytes, indexBytes: archive.indexBytes })),
    bootScript: data.bootScript, saves, copies: [] }, null, 2) + "\n", { mode: 0o600 });
  return { root, data, directory, saves, args, env };
}

function extractScripts(entry, context) {
  const root = entry.contentRootDir || entry.gamePath, data = Inspect.inspectGame(root, { includeEntries: true });
  if (!data) throw new Error("Nitroplus script archive was not found.");
  const archive = data.archives.find(item => item.path === data.scriptArchivePath);
  if (archive.encrypted) throw new Error("This NSS encryption format is unsupported.");
  const parent = directoryFor(entry, context); fs.mkdirSync(parent, { recursive: true });
  const destination = path.join(parent, "extracted"), staging = fs.mkdtempSync(path.join(parent, ".extract-"));
  if (fs.existsSync(destination)) { fs.rmSync(staging, { recursive: true, force: true }); throw new Error("Nitroplus scripts are already extracted. Remove the private output before extracting again."); }
  let count = 0, total = 0;
  try {
    for (const item of archive.entries.filter(item => item.type === "file" && /\.nss$/i.test(item.name))) {
      total += item.size; if (total > 64 * 1024 * 1024) throw new Error("Nitroplus script extraction exceeds its total byte limit.");
      const file = path.join(staging, item.name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Inspect.decode(Inspect.readEntry(archive, item, { maximum: 4 * 1024 * 1024 })), { flag: "wx", mode: 0o600 }); count++;
    }
    fs.renameSync(staging, destination); return { directory: destination, count, encoding: "UTF-8", sourceEncoding: "CP932" };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

module.exports = { id: manifest.id, manifest, detectGame, runtimeManagers: [manager], normalizeRuntimeId: () => "npengine",
  onImport: (entry, context) => { entry.defaultSaveDir = path.join(directoryFor(entry, context), "saves"); },
  ensureRuntime: (entry, context) => {
    const { data } = refreshGame(entry); requireFormat(data);
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!supportedVersions.includes(selected.version)) throw new Error("libnpengine 0.5.3 for Mac is required.");
    if (selected.ready) verifyProfile(selected.install);
    return selected.ready ? null : { managerId: manager.id, version: selected.version, installOptions: {} };
  },
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId !== "npengine") return null;
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selected.ready) throw new Error(selected.reason);
    const launch = prepareLaunch(entry, context, selected.install); context.onEntryChange?.(entry);
    const child = await context.spawnDetachedChecked(selected.install.executablePath, [...launch.args, ...(context.gameArguments || [])],
      { cwd: launch.directory, env: launch.env, stdio: ["ignore", "pipe", "pipe"] }, selected.install.needsRosetta);
    return Output.retainNativeOutput(child, { directory: launch.directory, entry, context, version: selected.version });
  },
  cleanupGameData: (entry, context) => { fs.rmSync(directoryFor(entry, context), { recursive: true, force: true }); return true; },
  actions: {
    readNativeLog: (entry, _payload, context) => Output.readNativeLog(directoryFor(entry, context), entry),
    inspectGame: entry => Inspect.inspectGame(entry.contentRootDir || entry.gamePath),
    extractScripts: (entry, _payload, context) => extractScripts(entry, context),
    checkScripts: async (entry, payload, context) => {
      if (payload?.scope !== undefined && !["bootstrap", "all"].includes(payload.scope)) throw new Error("Choose the bootstrap or all script compiler scope.");
      const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
      if (!selected.ready) throw new Error(selected.reason);
      const launch = prepareLaunch(entry, context, selected.install);
      const result = await run(selected.install.executablePath, [...launch.args, payload?.scope === "bootstrap" ? "--check-bootstrap" : "--check-scripts"],
        { cwd: launch.directory, env: launch.env, timeout: 30000, maxBuffer: 128 * 1024 });
      return { version: selected.version, output: result.stdout.trim() };
    },
    runtimeStatus: (entry, _payload, context) => manager.resolveSelection(entry, context.settings, context.userDataDir),
    registerRuntime: (entry, payload, context) => {
      const version = payload?.version || Build.VERSION, runtimePath = payload?.runtimePath || context.runtimeSettings?.runtimePath;
      const selected = Native.resolveLocalRuntime({ runtimePath, runtimeVersion: version, upstreamRevision: Build.REVISION });
      verifyProfile({ ...selected, version }); distribution(selected);
      const installed = manager.core.registerLocal({ userDataDir: context.userDataDir, version, runtimePath }); context.onRuntimeStateChange?.(); return installed;
    }
  },
  __test: { directoryFor, refreshGame, verifyProfile, verifyPortableProfile, distribution, prepareLaunch, extractScripts }
};

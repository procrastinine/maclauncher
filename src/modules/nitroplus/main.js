const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify, isDeepStrictEqual } = require("node:util");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const Inspect = require("./inspect");
const manager = require("./runtime/manager");
const Native = require("../shared/runtime/local-native");
const Bundle = require("../shared/runtime/bundled-native");
const GameData = require("../shared/game-data");
const Output = require("./native-output");
const run = promisify(execFile);

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
// The installed runtime describes itself. Its shipped profile names the engine and
// libnpa revisions and the GStreamer plugins, and agrees with the package's build
// provenance when the package records one. The runner carries the same revisions
// and the launcher's save-directory and script-check interface.
function verifyProfile(install) {
  const { profile } = readProfile(install), provenance = install.buildProvenance, revision = value => /^[a-f0-9]{40}$/.test(value || "");
  if (!revision(profile.upstreamRevision) || profile.upstreamRevision !== install.upstreamRevision || !revision(profile.npaRevision) ||
      provenance && (provenance.sourceTreeSha256 !== profile.sourceTreeSha256 || provenance.overlaySha256 !== profile.overlaySha256 ||
        !isDeepStrictEqual(provenance.additionalSources, profile.additionalSources))) {
    throw new Error("The Nitroplus runtime profile differs from its package.");
  }
  const identity = `${install.version}:${install.sha256}`;
  if (profileCache.has(identity)) return profile;
  if (fs.statSync(install.executablePath).size > 16 * 1024 * 1024) throw new Error("Nitroplus executable exceeds the profile inspection limit.");
  const bytes = fs.readFileSync(install.executablePath);
  if (![profile.upstreamRevision, profile.npaRevision, "MACLAUNCHER_NPENGINE_SAVE_DIR", "--check-scripts"].every(marker => bytes.includes(Buffer.from(marker)))) throw new Error("This interpreter lacks NPA/NSS or per-game save support. Select Automatic in Runtime Settings to use the recommended runtime.");
  if (profileCache.size >= 32) profileCache.delete(profileCache.values().next().value);
  profileCache.add(identity);
  return profile;
}
function distribution(install) {
  const { root, profile } = readProfile(install);
  if (!Array.isArray(profile.plugins) || !profile.plugins.length || !profile.plugins.every(plugin => /^[a-z0-9]+$/.test(plugin)))
    throw new Error("Nitroplus runtime libraries are missing or incompatible.");
  const plugins = path.join(root, "lib/gstreamer-1.0");
  for (const plugin of profile.plugins) if (!fs.statSync(path.join(plugins, `libgst${plugin}.dylib`)).isFile()) throw new Error("Nitroplus GStreamer plugin payload is incomplete.");
  if (!fs.statSync(path.join(root, "fontconfig.conf")).isFile()) throw new Error("Nitroplus needs its native font configuration.");
  return { root, plugins, profile };
}
const catalogEntry = (version, context) => manager.core.listCatalog({ userDataDir: context.userDataDir }).find(pin => pin?.version === version);
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
    engineRevision: install.upstreamRevision, npaRevision: runtime.profile.npaRevision, originalDataRoot: path.resolve(root),
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
    if (selected.version && catalogEntry(selected.version, context)?.upstreamTag) throw new Error("The selected Nitroplus source release has no Mac runtime asset.");
    if (selected.ready) verifyProfile(selected.install);
    return selected.ready ? null : { managerId: manager.id, version: selected.version, ...(selected.discoveryRequired ? { discoveryRequired: true } : {}), installOptions: {} };
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
      const version = payload?.version || manager.resolveSelection(entry, context.settings, context.userDataDir).version, runtimePath = payload?.runtimePath || context.runtimeSettings?.runtimePath;
      const pin = version && catalogEntry(version, context);
      if (!pin) throw new Error("No Nitroplus versions are available to download.");
      const selected = Native.resolveLocalRuntime({ runtimePath, runtimeVersion: version, upstreamRevision: pin.upstreamRevision });
      verifyProfile({ ...selected, version }); distribution(selected);
      const installed = manager.core.registerLocal({ userDataDir: context.userDataDir, version, runtimePath }); context.onRuntimeStateChange?.(); return installed;
    }
  },
  __test: { directoryFor, refreshGame, verifyProfile, distribution, prepareLaunch, extractScripts }
};

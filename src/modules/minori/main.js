const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const Inspect = require("./inspect");
const manager = require("./runtime/manager");
const Build = require("./runtime/build");
const Native = require("../shared/runtime/local-native");
const Bundle = require("../shared/runtime/bundled-native");
const GameData = require("../shared/game-data");
const run = promisify(execFile);
const PROFILES = new Set(["paz-bf-slot0-rc4-v1", "paz-pe-keytables-rc4-v1"]);
const COMPILED_VERSION = manager.core.catalog.find(pin => pin.version === Build.VERSION)?.sourceArtifact?.directoryRelative
  ?.split("/").pop()?.replace(/-source\.tar\.gz$/, "") || Build.VERSION;
const verifiedData = new Map();
function gameDirectory(entry, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(context.userDataDir || "")) throw new Error("Minori needs a persisted game id and an absolute launcher data directory.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id);
}
function scriptsDirectory(entry, context, { required = false } = {}) {
  const directory = path.join(gameDirectory(entry, context), "scripts");
  let present = false;
  try { const stat = fs.lstatSync(directory); present = stat.isDirectory() && !stat.isSymbolicLink(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  entry.moduleData = { ...entry.moduleData, scriptsDirectory: present ? directory : null };
  if (required && !present) throw new Error("Extract scripts first.");
  return present ? directory : null;
}
function readProfile(install) {
  if (![Build.VERSION, COMPILED_VERSION].includes(install.version) || install.upstreamRevision !== Build.REVISION) throw new Error("Select the pinned Minori Mac profile.");
  const shipped = Bundle.resolveInstalledAsset(install, "profile");
  const directory = shipped ? path.dirname(shipped) : path.resolve(path.dirname(install.executablePath), "..");
  const file = shipped || path.join(directory, "profile.json");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("Minori profile metadata is invalid.");
  const profile = JSON.parse(fs.readFileSync(file, "utf8"));
  if (profile.version !== COMPILED_VERSION || profile.upstreamRevision !== Build.REVISION || profile.profileRevision !== Build.PROFILE ||
      ![...PROFILES].every(value => profile.dataProfiles?.includes(value)) || !/^[a-f0-9]{64}$/.test(profile.sourceTreeSha256 || "") ||
      !profile.nativeFeatures?.includes("private-saves") || !profile.nativeFeatures?.includes("coretext-fonts") ||
      profile.executables?.eden !== install.sha256) throw new Error("The selected Minori interpreter lacks its matching native distribution.");
  const probe = Bundle.resolveInstalledAsset(install, "pazProbe") || path.join(directory, "bin/maclauncher-minori-probe");
  if (Native.hashFile(probe) !== profile.executables["maclauncher-minori-probe"]) throw new Error("Minori runtime companion checksum changed.");
  const movieDecoder = profile.movieDecoder && (Bundle.resolveInstalledAsset(install, "movieDecoder") || path.join(directory, "bin/maclauncher-minori-movie"));
  if (movieDecoder && Native.hashFile(movieDecoder) !== profile.movieDecoder.sha256) throw new Error("The Minori movie decoder differs from its profile.");
  if (movieDecoder) {
    if (!Array.isArray(profile.movieDecoder.files) || profile.movieDecoder.files.length !== 6) throw new Error("Minori movie dependency inventory is incomplete.");
    for (const file of profile.movieDecoder.files) {
      if (!/^(?:bin\/maclauncher-minori-movie|lib\/lib(?:avformat|avcodec|avutil|swscale|swresample)\.\d+\.dylib)$/.test(file.path || "") ||
          !/^[a-f0-9]{64}$/.test(file.sha256 || "")) throw new Error("Minori movie dependency metadata is invalid.");
      const target = path.join(directory, file.path), stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || Native.hashFile(target) !== file.sha256) throw new Error("A Minori movie dependency differs from its profile.");
    }
  }
  return { directory, profile, probe, movieDecoder };
}
function selection(entry, context) {
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
  if (!selected.ready) throw new Error(selected.reason);
  return { selected, distribution: readProfile(selected.install) };
}
function originalData(entry) {
  const root = entry.contentRootDir || entry.gamePath;
  const data = Inspect.inspectGame(root, { inputPath: entry.moduleData?.originalRunnerPath });
  if (!data) throw new Error("The original Minori PAZ companion archives are missing or changed.");
  return { root, data };
}
function validVerification(result) {
  return result?.schema === 1 && PROFILES.has(result.profile) && Number.isInteger(result.xorKey) && result.xorKey >= 0 && result.xorKey <= 255 &&
    result.bootScript === "a001.sc" && Number.isInteger(result.scriptCount) && result.scriptCount >= 1 && result.scriptCount <= 50000 &&
    Array.isArray(result.archives) && result.archives.length >= 2 && result.archives.length <= Inspect.LIMITS.archives &&
    result.archives.every(archive => Inspect.GROUPS.includes(archive.group) && Number.isInteger(archive.entries) && archive.entries > 0 && archive.entries <= 50000) &&
    result.archives.some(archive => archive.group === "scr") && result.archives.some(archive => archive.group === "sys");
}
async function verifyData(entry, context, distribution, { refresh = false } = {}) {
  const { root, data } = originalData(entry);
  const identity = JSON.stringify([Build.VERSION, distribution.profile.executables["maclauncher-minori-probe"],
    data.archives.map(archive => [archive.path, archive.identity]), data.originalRunnerIdentity]);
  const cacheFile = entry.gameId && context.userDataDir ? path.join(gameDirectory(entry, context), "verification.json") : null;
  let result = !refresh && verifiedData.get(identity);
  if (!result && cacheFile && !refresh) {
    try {
      const stat = fs.lstatSync(cacheFile);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        if (cached.identity === identity && validVerification(cached.result)) result = cached.result;
      }
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  }
  if (!result) {
    const output = await run(distribution.probe, ["inspect", path.resolve(root)], { timeout: 30000, maxBuffer: 64 * 1024,
      env: { ...process.env, ...(data.originalRunnerPath ? { MACLAUNCHER_MINORI_ORIGINAL_RUNNER: data.originalRunnerPath } : {}) } });
    result = JSON.parse(output.stdout);
    if (!validVerification(result)) throw new Error("Minori PAZ verification returned an invalid profile.");
    if (cacheFile) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const temporary = cacheFile + `.tmp-${require("node:crypto").randomUUID()}`;
      try { fs.writeFileSync(temporary, JSON.stringify({ identity, result }) + "\n", { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, cacheFile); }
      finally { fs.rmSync(temporary, { force: true }); }
    }
    if (verifiedData.size >= 64) verifiedData.delete(verifiedData.keys().next().value);
    verifiedData.set(identity, result);
  }
  entry.moduleData = { ...data, cryptoProfile: result.profile, supported: true, compatibility: null,
    xorKey: result.xorKey, scriptCount: result.scriptCount, bootScript: result.bootScript };
  if (entry.gameId && context.userDataDir) scriptsDirectory(entry, context);
  context.onEntryChange?.(entry); return { root, data: entry.moduleData, verification: result };
}
async function prepareLaunch(entry, context, distribution) {
  const original = await verifyData(entry, context, distribution);
  const directory = gameDirectory(entry, context), saves = entry.saveDirOverride || path.join(directory, "saves");
  if (!path.isAbsolute(saves)) throw new Error("Minori save directory must be absolute.");
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(saves, { recursive: true });
  const env = { ...process.env, MACLAUNCHER_MINORI_SAVE_DIR: saves,
    MACLAUNCHER_MINORI_CACHE_DIR: path.join(directory, "cache"), MACLAUNCHER_MINORI_TITLE: entry.name || original.data.title,
    MACLAUNCHER_MINORI_PAZ_XOR: original.data.xorKey.toString(16),
    ...(original.data.originalRunnerPath ? { MACLAUNCHER_MINORI_ORIGINAL_RUNNER: original.data.originalRunnerPath } : {}),
    ...(distribution.movieDecoder ? { MACLAUNCHER_MINORI_MOVIE_DECODER: distribution.movieDecoder } : {}) };
  if (original.verification.archives.some(archive => archive.group === "mov") && !distribution.movieDecoder) throw new Error("This Minori game needs the native distribution’s movie decoder.");
  entry.defaultSaveDir = saves; context.onEntryChange?.(entry);
  return { ...original, directory, saves, env, args: ["--game-root", path.resolve(original.root)] };
}
async function extractScripts(entry, context) {
  const { distribution } = selection(entry, context), { root } = await verifyData(entry, context, distribution);
  const directory = gameDirectory(entry, context); fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, "scripts");
  if (fs.existsSync(destination)) throw new Error("Private scripts are already extracted.");
  const staging = fs.mkdtempSync(path.join(directory, ".scripts-"));
  try {
    const output = path.join(staging, "output");
    const result = await run(distribution.probe, ["scripts", path.resolve(root), output], { timeout: 30000, maxBuffer: 64 * 1024,
      env: { ...process.env, ...(entry.moduleData?.originalRunnerPath ? { MACLAUNCHER_MINORI_ORIGINAL_RUNNER: entry.moduleData.originalRunnerPath } : {}) } });
    const metadata = JSON.parse(result.stdout);
    if (metadata.schema !== 1 || !Number.isInteger(metadata.count) || metadata.count < 1 || metadata.encoding !== "UTF-8") throw new Error("Invalid Minori extraction result.");
    fs.renameSync(output, destination); scriptsDirectory(entry, context); context.onEntryChange?.(entry);
    return { directory: destination, ...metadata };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
module.exports = { id: manifest.id, manifest, detectGame, runtimeManagers: [manager], normalizeRuntimeId: () => "reminori",
  onImport: (entry, context) => { entry.defaultSaveDir = path.join(gameDirectory(entry, context), "saves"); scriptsDirectory(entry, context); },
  ensureRuntime: (entry, context) => {
    originalData(entry);
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (selected.version !== Build.VERSION) throw new Error("Select the pinned Minori Mac profile for native play.");
    if (selected.ready) readProfile(selected.install);
    return selected.ready ? null : { managerId: manager.id, version: selected.version, installOptions: {} };
  },
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId !== "reminori") return null;
    const { selected, distribution } = selection(entry, context), launch = await prepareLaunch(entry, context, distribution);
    const child = await context.spawnDetachedChecked(selected.install.executablePath, [...launch.args, ...(context.gameArguments || [])],
      { cwd: launch.directory, env: launch.env, stdio: ["ignore", "pipe", "pipe"] }, selected.install.needsRosetta);
    const log = path.join(launch.directory, "native.log");
    const fd = fs.openSync(log, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
    let written = 0, tail = "", closed = false;
    const append = bytes => { if (closed) return; tail = (tail + bytes.toString()).slice(-4096); const count = Math.min(bytes.length, 256 * 1024 - written); if (count > 0) { fs.writeSync(fd, bytes, 0, count); written += count; } };
    child.stdout?.on("data", append); child.stderr?.on("data", append);
    child.once("close", (code, signal) => {
      if (!closed) { closed = true; fs.closeSync(fd); }
      if (code !== 0 && code != null || ["SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL"].includes(signal)) {
        entry.moduleData = { ...entry.moduleData, nativeRuntimeError: tail.trim() || `Minori ended with ${signal || code}.` };
        context.onEntryChange?.(entry); context.logger?.error?.(entry.moduleData.nativeRuntimeError);
      }
    });
    return child;
  },
  cleanupGameData: (entry, context) => { fs.rmSync(gameDirectory(entry, context), { recursive: true, force: true }); return true; },
  actions: {
    inspectArchives: async (entry, _payload, context) => verifyData(entry, context, selection(entry, context).distribution, { refresh: true }).then(result => result.verification),
    extractScripts: (entry, _payload, context) => extractScripts(entry, context),
    revealScripts: (entry, _payload, context) => { const directory = scriptsDirectory(entry, context, { required: true }); context.revealInFinder?.(directory); return { directory }; },
    removeScripts: (entry, _payload, context) => {
      const directory = scriptsDirectory(entry, context, { required: true });
      fs.rmSync(directory, { recursive: true }); scriptsDirectory(entry, context); context.onEntryChange?.(entry); return { removed: true };
    },
    registerRuntime: (entry, payload, context) => {
      const runtimePath = payload?.runtimePath || context.runtimeSettings?.runtimePath;
      const install = Native.resolveLocalRuntime({ runtimePath, runtimeVersion: Build.VERSION, upstreamRevision: Build.REVISION });
      readProfile({ ...install, version: Build.VERSION });
      const registered = manager.core.registerLocal({ userDataDir: context.userDataDir, version: Build.VERSION, runtimePath });
      context.onRuntimeStateChange?.(); return registered;
    }
  }, __test: { gameDirectory, readProfile, originalData, validVerification, verifyData, prepareLaunch, extractScripts, verifiedData }
};

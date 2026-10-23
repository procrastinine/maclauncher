const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const AppBundle = require("../../shared/runtime/app-bundle");
const Native = require("../../shared/runtime/local-native");
const GameData = require("../../shared/game-data");

const MUTABLE_CONFIG = "Contents/Game/mkxp.json";
const MAX_FILES = 20000;
const observations = new Map();
const cpuDirectories = new Map();
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

function safeSegment(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") throw new Error("Invalid MKXP-Z " + label + ".");
}
function ownedDirectory(root, target) {
  if (!inside(root, target)) throw new Error("MKXP-Z session directory escapes game data.");
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("MKXP-Z session directories must not use symlinks.");
  }
  return target;
}
const metadata = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);

function applicationReceipt(directory) {
  try {
    const file = path.join(directory, "application.json"), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return null; }
}
function applicationFootprint(app) {
  const rows = []; let count = 0;
  function visit(directory, depth = 0) {
    if (depth > 8) throw new Error("Native application entry is nested too deeply.");
    for (const name of fs.readdirSync(directory).sort()) {
      if (++count > MAX_FILES) throw new Error("Native application entry contains too many files.");
      const file = path.join(directory, name), stat = fs.lstatSync(file, { bigint: true });
      rows.push([path.relative(app, file), stat.isSymbolicLink() ? ["link", fs.readlinkSync(file)] : stat.isDirectory() ? "directory" : metadata(stat)]);
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(file, depth + 1);
    }
  }
  visit(app); return digest(JSON.stringify(rows));
}
async function retireApplications(directory, current, withMutation) {
  if (typeof withMutation !== "function") return;
  try {
    const rows = fs.readdirSync(directory, { withFileTypes: true }).filter(item => item.isDirectory() && /^[a-f0-9]{64}$/.test(item.name));
    if (rows.length <= 2 || rows.length > 128) return;
    const candidates = rows.filter(item => item.name !== current).map(item => ({ directory: path.join(directory, item.name), receipt: applicationReceipt(path.join(directory, item.name)) }))
      .filter(item => item.receipt?.retirement?.identity === path.basename(item.directory) && item.receipt.retirement.leaseManaged === true &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.receipt.retirement.version || "") && Number.isSafeInteger(item.receipt.retirement.createdAt) &&
        /^[a-f0-9]{64}$/.test(item.receipt.retirement.footprint || "") && item.receipt.basis?.cloneOnly === true);
    candidates.sort((a, b) => b.receipt.retirement.createdAt - a.receipt.retirement.createdAt);
    for (const item of candidates.slice(1)) {
      try {
        await withMutation({ managerId: "mkxpz", version: item.receipt.retirement.version, sourcePath: item.directory }, () => {
          const stat = fs.lstatSync(item.directory), name = require("../../shared/native-application").bundleName(item.receipt.basis.title);
          const app = path.join(item.directory, name), appStat = fs.lstatSync(app);
          if (!stat.isDirectory() || stat.isSymbolicLink() || !appStat.isDirectory() || appStat.isSymbolicLink() ||
              fs.readdirSync(item.directory).some(name => ![path.basename(app), "application.json"].includes(name)) ||
              JSON.stringify(applicationReceipt(item.directory)) !== JSON.stringify(item.receipt) ||
              applicationFootprint(app) !== item.receipt.retirement.footprint) return;
          fs.rmSync(item.directory, { recursive: true, force: true });
        });
      } catch { /* Active, changed and uninspectable entries remain available. */ }
    }
  } catch { /* Derived cache retirement never prevents Play or Stop. */ }
}

function cpuLibraryNames(library, cpu) {
  const key = library + "\0" + cpu, identity = JSON.stringify(metadata(fs.lstatSync(library, { bigint: true })));
  const prior = cpuDirectories.get(key);
  if (prior?.identity === identity) return prior.names;
  const names = fs.readdirSync(library);
  if (names.length > MAX_FILES) throw new Error("MKXP-Z standard library contains too many direct entries.");
  const pattern = new RegExp("^" + cpu + "-darwin(?:[0-9]+(?:\\.[0-9]+)*)?$");
  const matches = names.filter(name => pattern.test(name)).sort((a, b) =>
    a === cpu + "-darwin" ? -1 : b === cpu + "-darwin" ? 1 : b.localeCompare(a, undefined, { numeric: true }));
  if (cpuDirectories.size >= 8 && !cpuDirectories.has(key)) cpuDirectories.delete(cpuDirectories.keys().next().value);
  cpuDirectories.set(key, { identity, names: matches });
  return matches;
}

function sourceLayout(appPath, architectures) {
  const game = path.join(appPath, "Contents", "Game"), parent = path.dirname(appPath);
  let info;
  try { info = fs.lstatSync(game); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (info) {
    const canonical = fs.realpathSync(game);
    if (!fs.statSync(game).isDirectory() || !inside(appPath, canonical)) throw new Error("MKXP-Z source config directory is invalid.");
    return { sourceConfigDir: canonical, configLayout: "bundle-game", runtimeRubyLoadpaths: [] };
  }
  let config;
  try { config = fs.lstatSync(path.join(parent, "mkxp.json")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!config) return { sourceConfigDir: game, configLayout: "bundle-game", runtimeRubyLoadpaths: [] };
  if (!config.isFile() || config.isSymbolicLink()) throw new Error("MKXP-Z publisher config must be a regular file.");
  const runtimeRubyLoadpaths = [], library = path.join(parent, "stdlib");
  const hostCPU = process.arch === "x64" ? "x86_64" : process.arch;
  const cpu = architectures.includes(hostCPU) ? hostCPU : architectures[0];
  const directories = [library];
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index];
    let stat;
    try { stat = fs.lstatSync(directory); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error("MKXP-Z runtime libraries must remain inside the selected runtime.");
    runtimeRubyLoadpaths.push(directory);
    if (index === 0) directories.push(...cpuLibraryNames(library, cpu).map(name => path.join(library, name)));
  }
  return { sourceConfigDir: parent, configLayout: "bundle-parent", runtimeResourceRoot: parent, runtimeRubyLoadpaths };
}

function sourceInventory(appPath, source) {
  const previous = observations.get(appPath) || new Map();
  const prefix = path.basename(appPath) + "/";
  const known = new Map((source.bundle?.manifest?.files || []).filter(file => file.path.startsWith(prefix)).map(file => [file.path.slice(prefix.length), file]));
  const files = [], refreshed = new Map();
  const native = relative => relative.startsWith("Contents/MacOS/") || /\.(?:dylib|so|bundle)$/i.test(relative) || relative.includes(".framework/");
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), relative = path.relative(appPath, file).split(path.sep).join("/");
      // A legacy managed installation may contain another game's stale config.
      // It is neither read nor inherited into this launch.
      if (relative === MUTABLE_CONFIG) continue;
      const before = fs.lstatSync(file, { bigint: true }), identity = metadata(before);
      if (relative === "Contents/Game" && before.isDirectory()) { walk(file); continue; }
      const item = { relative, mode: Number(before.mode & 0o777n) };
      if (before.isDirectory()) item.type = "directory";
      else if (before.isSymbolicLink()) {
        if (!inside(appPath, fs.realpathSync(file))) throw new Error("MKXP-Z runtime symlink escapes its app.");
        item.type = "symlink"; item.target = fs.readlinkSync(file);
      } else if (before.isFile()) {
        item.type = "file"; item.size = Number(before.size);
        const prior = previous.get(relative), pinned = known.get(relative);
        if (prior && JSON.stringify(prior.metadata) === JSON.stringify(identity)) item.sha256 = prior.sha256;
        else if (!native(relative) && pinned && pinned.size === item.size && pinned.mode === item.mode) item.sha256 = pinned.sha256;
        else item.sha256 = Native.hashFile(file);
        if (native(relative) && pinned && item.sha256 !== pinned.sha256) throw new Error("The selected MKXP-Z native bytes changed.");
        if (JSON.stringify(metadata(fs.lstatSync(file, { bigint: true }))) !== JSON.stringify(identity)) throw new Error("MKXP-Z source changed while being checked.");
        refreshed.set(relative, { metadata: identity, sha256: item.sha256,
          ...(prior?.plist && JSON.stringify(prior.metadata) === JSON.stringify(identity) ? { plist: prior.plist } : {}) });
      } else throw new Error("MKXP-Z runtime contains an unsupported file type.");
      files.push(item);
      if (files.length > MAX_FILES) throw new Error("MKXP-Z runtime contains too many files.");
      if (before.isDirectory()) walk(file);
    }
  }
  walk(appPath);
  if (observations.size >= 8 && !observations.has(appPath)) observations.delete(observations.keys().next().value);
  observations.set(appPath, refreshed);
  return { treeSha256: digest(JSON.stringify(files.sort((a, b) => a.relative.localeCompare(b.relative)))), files };
}

function prepareGameRuntime({ userDataDir, gameId, source, helper }) {
  safeSegment(gameId, "game id"); safeSegment(source?.version, "version");
  if (!userDataDir || !source?.appPath || !helper?.version) throw new Error("Missing MKXP-Z source or config helper.");
  const inspected = AppBundle.validateAppBundle(fs.realpathSync(source.appPath), { allowContainedAbsoluteSymlinks: true });
  const executablePath = fs.realpathSync(path.join(inspected.appPath, inspected.executableRelative));
  if (!inside(path.join(inspected.appPath, "Contents", "MacOS"), executablePath)) throw new Error("MKXP-Z executable must remain inside its app's Contents/MacOS directory.");
  const architectures = Native.readMachOArchitectures(executablePath);
  if (!architectures.some(arch => helper.architectures.includes(arch))) throw new Error("The selected MKXP-Z build is incompatible with the config helper CPU.");
  const layout = sourceLayout(inspected.appPath, architectures);
  const tree = sourceInventory(inspected.appPath, source);
  const binary = tree.files.find(file => file.relative === path.relative(inspected.appPath, executablePath).split(path.sep).join("/"));
  if (!binary?.sha256) throw new Error("MKXP-Z source executable identity is missing.");
  const sourceIdentity = digest(JSON.stringify([source.version, inspected.appPath, tree.treeSha256, source.bundle?.manifestSha256 || null, helper.version, helper.binarySha256]));
  fs.mkdirSync(userDataDir, { recursive: true });
  const userRoot = fs.realpathSync(userDataDir);
  const parent = ownedDirectory(userRoot, path.join(GameData.resolveGameRuntimeDir(userRoot, gameId, "mkxpz"), source.version, "sessions"));
  if (inside(inspected.appPath, parent) || inside(parent, inspected.appPath)) throw new Error("MKXP-Z source and session directories overlap.");
  const sessionId = crypto.randomUUID(), sessionDir = path.join(parent, sessionId);
  fs.mkdirSync(sessionDir, { mode: 0o700 });
  const configDir = ownedDirectory(userRoot, path.join(sessionDir, "config"));
  return { sessionId, sessionDir, configDir, configPath: path.join(configDir, "mkxp.json"),
    logPath: path.join(sessionDir, "rgss-mkxpz.log"), snapshotPath: path.join(sessionDir, "launch.json"),
    appPath: inspected.appPath, executablePath, sourceAppPath: inspected.appPath, ...layout,
    sourceIdentity, sourceTreeSha256: tree.treeSha256, binarySha256: binary.sha256, architectures,
    helperVersion: helper.version, runtimeCopied: false };
}

function writeGameConfig(prepared, config) {
  const stat = fs.lstatSync(prepared.configDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(prepared.configDir) !== prepared.configDir ||
      path.dirname(prepared.configPath) !== prepared.configDir) throw new Error("MKXP-Z private config directory changed.");
  if (prepared.runtimeRubyLoadpaths?.length && !config.rubyLoadpath?.length) {
    config.rubyLoadpath = [...new Set([...(typeof config.gameFolder === "string" && config.gameFolder ? [config.gameFolder] : []), ...prepared.runtimeRubyLoadpaths])];
  }
  const bytes = JSON.stringify(config, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new Error("MKXP-Z launch config exceeds its limit.");
  // Each launch publishes exactly one new config. Never overwrite the JSON
  // another running process is about to read.
  fs.writeFileSync(prepared.configPath, bytes, { flag: "wx", mode: 0o600 });
  return digest(bytes);
}

async function prepareApplication({ prepared, userDataDir, gameName, gameIcon, logger, signal, useRuntime, withRuntimeMutation }) {
  try {
    signal?.throwIfAborted();
    if (typeof gameName !== "string" || !gameName.trim() || gameName.includes("\0") || Buffer.byteLength(gameName) > 1024) return prepared;
    const title = gameName.trim(), sourceApp = prepared.sourceAppPath;
    const sourceFiles = observations.get(sourceApp), infoRecord = sourceFiles?.get("Contents/Info.plist");
    const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ?
      Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
    const originalInfo = infoRecord?.plist || ordered(AppBundle.readInfoPlist(sourceApp));
    if (!originalInfo?.CFBundleIdentifier) throw new Error("The selected runtime has no application identifier.");
    if (infoRecord) infoRecord.plist = originalInfo;
    let iconFile, iconIdentity;
    if (typeof gameIcon === "string" && path.isAbsolute(gameIcon)) {
      try {
        const canonical = fs.realpathSync(gameIcon), stat = fs.lstatSync(canonical, { bigint: true });
        if (stat.isFile() && stat.size > 0n && stat.size <= 8n * 1024n * 1024n) { iconFile = canonical; iconIdentity = metadata(stat); }
      } catch {} // An optional icon never prevents the native game entry.
    }
    const identity = digest(JSON.stringify([prepared.sourceIdentity, title, iconFile || null, iconIdentity || null]));
    const userRoot = fs.realpathSync(userDataDir), versionRoot = path.dirname(path.dirname(prepared.sessionDir));
    const directory = ownedDirectory(userRoot, path.join(versionRoot, "applications", identity));
    const links = {}, resourceLinks = {}, nativeLinks = {}, contents = path.join(sourceApp, "Contents");
    const collect = (directory, output, excluded = []) => {
      if (!fs.existsSync(directory)) return;
      const entries = fs.readdirSync(directory).sort();
      if (entries.length > MAX_FILES) throw new Error("MKXP-Z runtime contains too many direct resource entries.");
      for (const name of entries) if (!excluded.includes(name)) {
        const source = fs.realpathSync(path.join(directory, name));
        if (!inside(sourceApp, source)) throw new Error("MKXP-Z application resources leave the selected runtime.");
        output[name] = source;
      }
    };
    collect(contents, links, ["Info.plist", "_CodeSignature", "MacOS", "Resources", "Game"]);
    collect(path.join(contents, "Resources"), resourceLinks, iconFile ? ["Application.icns"] : []);
    collect(path.join(contents, "MacOS"), nativeLinks, [path.basename(prepared.executablePath)]);
    const application = await require("../../shared/native-application").prepare({
      executablePath: prepared.executablePath, directory, title, iconFile, links, resourceLinks, nativeLinks,
      identifier: originalInfo.CFBundleIdentifier, originalInfo, showInDock: true, cloneOnly: true, applicationLabel: "MKXP-Z", signal
    });
    // The engine selects Contents/Game by existence before it calls chdir.
    // Keep only an empty directory here; each process redirects that transition
    // to its own immutable launch config, never a shared mutable Game link.
    const sourceConfigDir = path.join(application.app, "Contents", "Game");
    try { fs.mkdirSync(sourceConfigDir); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const gameDirectory = fs.lstatSync(sourceConfigDir);
    if (!gameDirectory.isDirectory() || gameDirectory.isSymbolicLink() || fs.readdirSync(sourceConfigDir).length)
      throw new Error("The native application config directory changed.");
    // Reuse the existing source-identity cache for the small owned entry. Warm
    // launches neither sign again nor hash the publisher or cloned executable.
    const relative = path.relative(application.app, application.executablePath).split(path.sep).join("/");
    const current = metadata(fs.lstatSync(application.executablePath, { bigint: true }));
    const old = observations.get(application.app)?.get(relative);
    const unchanged = old && JSON.stringify(old.metadata) === JSON.stringify(current);
    if (!unchanged) await require("./mkxpz-config-helper").assertInjectionCompatible(application.executablePath);
    const binarySha256 = unchanged ? old.sha256 : Native.hashFile(application.executablePath);
    if (observations.size >= 8 && !observations.has(application.app)) observations.delete(observations.keys().next().value);
    observations.set(application.app, new Map([[relative, { metadata: current, sha256: binarySha256 }]]));
    await useRuntime?.(application.app);
    const result = { ...prepared, appPath: application.app, executablePath: application.executablePath,
      sourceConfigDir, configLayout: "bundle-game",
      sourceBinarySha256: prepared.binarySha256, binarySha256, executableCloned: true, applicationIdentity: identity };
    if (typeof withRuntimeMutation === "function") {
      try {
        const receipt = applicationReceipt(directory);
        if (receipt && !receipt.retirement) require("../../../core/json-files").writeJsonAtomic(path.join(directory, "application.json"), {
          ...receipt, retirement: { identity, version: path.basename(versionRoot), createdAt: Date.now(), leaseManaged: true, footprint: applicationFootprint(application.app) }
        });
        Object.defineProperty(result, "retire", { value: () => retireApplications(path.dirname(directory), identity, withRuntimeMutation) });
      } catch { /* An unmarked entry stays cached without automatic retirement. */ }
    }
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.name === "AbortError") throw error;
    try { Promise.resolve(logger?.warn?.("[mkxpz] Game application identity is unavailable; using the selected runtime directly.", error.message)).catch(() => {}); } catch {}
    return prepared;
  }
}

module.exports = { prepareGameRuntime, prepareApplication, writeGameConfig, MUTABLE_CONFIG };

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const AppBundle = require("../../shared/runtime/app-bundle");
const Native = require("../../shared/runtime/local-native");
const GameData = require("../../shared/game-data");

const MUTABLE_CONFIG = "Contents/Game/mkxp.json";
const MAX_FILES = 20000;
const observations = new Map();
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
        if (!native(relative) && pinned && pinned.size === item.size && pinned.mode === item.mode) item.sha256 = pinned.sha256;
        else if (!native(relative) && prior && JSON.stringify(prior.metadata) === JSON.stringify(identity)) item.sha256 = prior.sha256;
        else item.sha256 = Native.hashFile(file);
        if (native(relative) && pinned && item.sha256 !== pinned.sha256) throw new Error("The selected MKXP-Z native bytes changed.");
        if (JSON.stringify(metadata(fs.lstatSync(file, { bigint: true }))) !== JSON.stringify(identity)) throw new Error("MKXP-Z source changed while being checked.");
        refreshed.set(relative, { metadata: identity, sha256: item.sha256 });
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
  const originalConfigDir = path.join(inspected.appPath, "Contents", "Game");
  let sourceConfigDir = originalConfigDir;
  if (fs.existsSync(originalConfigDir)) {
    sourceConfigDir = fs.realpathSync(originalConfigDir);
    if (!inside(inspected.appPath, sourceConfigDir) || !fs.statSync(sourceConfigDir).isDirectory()) throw new Error("MKXP-Z source config directory is invalid.");
  }
  return { sessionId, sessionDir, configDir, configPath: path.join(configDir, "mkxp.json"),
    logPath: path.join(sessionDir, "rgss-mkxpz.log"), snapshotPath: path.join(sessionDir, "launch.json"),
    appPath: inspected.appPath, executablePath, sourceAppPath: inspected.appPath, sourceConfigDir,
    sourceIdentity, sourceTreeSha256: tree.treeSha256, binarySha256: binary.sha256, architectures,
    helperVersion: helper.version, runtimeCopied: false };
}

function writeGameConfig(prepared, config) {
  const stat = fs.lstatSync(prepared.configDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(prepared.configDir) !== prepared.configDir ||
      path.dirname(prepared.configPath) !== prepared.configDir) throw new Error("MKXP-Z private config directory changed.");
  const bytes = JSON.stringify(config, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new Error("MKXP-Z launch config exceeds its limit.");
  // Each launch publishes exactly one new config. Never overwrite the JSON
  // another running process is about to read.
  fs.writeFileSync(prepared.configPath, bytes, { flag: "wx", mode: 0o600 });
  return digest(bytes);
}

module.exports = { prepareGameRuntime, writeGameConfig, MUTABLE_CONFIG };

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const GameStore = require("../core/game-store");
const GameData = require("../modules/shared/game-data");
const { readJsonObject, writeJsonAtomic } = require("../core/json-files");

const digest = value => createHash("sha256").update(value).digest("hex");
const indexPath = (userDataDir, gameId) => path.join(GameData.resolveGameDir(userDataDir, gameId), "shortcuts.json");
const commandFiles = file => {
  const files = readJsonObject(file)?.files;
  return Array.isArray(files) ? files.filter(item => typeof item?.path === "string") : [];
};

function sanitizeFileName(value) {
  return String(value || "").trim().replace(/[:/\\]/g, "-")
    .replace(/[^0-9A-Za-z ._-]+/g, "_").replace(/\s+/g, " ") || "MacLauncher";
}

function shellEscape(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

/** Both distributions run the shared Node entry point without the library UI. */
function buildGameCommandScript({ gamePath, userDataDir, executablePath, appBundlePath, repoRoot, packaged }) {
  const lines = ["#!/bin/zsh", "set -e", `GAME_PATH=${shellEscape(gamePath)}`,
    `USER_DATA=${shellEscape(userDataDir)}`];
  if (packaged) {
    lines.push(`APP_PATH=${shellEscape(appBundlePath)}`);
    lines.push('if [ ! -d "$APP_PATH" ]; then');
    lines.push('  APP_PATH=$(/usr/bin/osascript -e \'POSIX path of (path to application id "com.maclauncher.launcher")\' 2>/dev/null) || true');
    lines.push("fi");
    lines.push(`EXECUTABLE="$APP_PATH/Contents/MacOS/"${shellEscape(path.basename(executablePath))}`);
    lines.push('if [ -f "$APP_PATH/Contents/Resources/app.asar" ]; then');
    lines.push('  APP_ROOT="$APP_PATH/Contents/Resources/app.asar"');
    lines.push("else");
    lines.push('  APP_ROOT="$APP_PATH/Contents/Resources/app"');
    lines.push("fi");
  } else {
    lines.push(`APP_ROOT=${shellEscape(repoRoot)}`);
    lines.push(`EXECUTABLE=${shellEscape(executablePath)}`);
    lines.push('if [ ! -f "$APP_ROOT/src/core/game-cli.js" ]; then');
    lines.push('  echo "MacLauncher source directory not found: $APP_ROOT" >&2');
    lines.push("  exit 1");
    lines.push("fi");
  }
  lines.push('if [ ! -x "$EXECUTABLE" ]; then');
  lines.push('  echo "MacLauncher executable not found: $EXECUTABLE" >&2');
  lines.push("  exit 1");
  lines.push("fi");
  lines.push('exec /usr/bin/env ELECTRON_RUN_AS_NODE=1 "$EXECUTABLE" "$APP_ROOT/src/core/game-cli.js" --game "$GAME_PATH" --user-data "$USER_DATA"');
  return `${lines.join("\n")}\n`;
}

function writeGameCommand(filePath, options) {
  const target = filePath.toLowerCase().endsWith(".command") ? filePath : `${filePath}.command`;
  fs.writeFileSync(target, buildGameCommandScript(options), { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(target, 0o755);
  if (options.gameId) {
    const file = indexPath(options.userDataDir, options.gameId);
    const files = commandFiles(file);
    writeJsonAtomic(file, { files: [...files.filter(item => item.path !== target), { path: target, sha256: digest(fs.readFileSync(target)) }] });
  }
  return target;
}

// Parse only our complete generated script. An edited script remains the
// user's file; Locate must not replace it with a fresh template.
function commandOptions(script) {
  const quoted = "('(?:[^']|'\\\\'')*')";
  const value = name => {
    const match = script.match(new RegExp("^" + name + "=" + quoted + "$", "m"));
    return match ? match[1].slice(1, -1).split("'\\''").join("'") : null;
  };
  const gamePath = value("GAME_PATH"), userDataDir = value("USER_DATA"), appBundlePath = value("APP_PATH");
  const packaged = appBundlePath !== null;
  const binary = packaged ? script.match(new RegExp('^EXECUTABLE="\\$APP_PATH/Contents/MacOS/"' + quoted + '$', 'm')) : null;
  const options = { gamePath, userDataDir, packaged, appBundlePath, repoRoot: value("APP_ROOT"),
    executablePath: packaged && binary ? binary[1].slice(1, -1).split("'\\''").join("'") : value("EXECUTABLE") };
  if (!gamePath || !userDataDir || !options.executablePath || (!packaged && !options.repoRoot)) return null;
  return buildGameCommandScript(options) === script ? options : null;
}

function relocateGameCommands({ userDataDir, gameId, from, to, desktopDir }) {
  const file = indexPath(userDataDir, gameId), saved = commandFiles(file);
  const candidates = new Map(saved.map(item => [item.path, item]));
  // Older shortcuts were not indexed. Recognize the unmodified ones in the
  // Save dialog's default directory, without searching unrelated folders.
  if (desktopDir) {
    try {
      for (const item of fs.readdirSync(desktopDir, { withFileTypes: true })) {
        if (item.isFile() && /\.command$/i.test(item.name)) {
          const target = path.join(desktopDir, item.name);
          if (!candidates.has(target)) candidates.set(target, { path: target });
        }
      }
    } catch {}
  }
  const files = [];
  for (const item of candidates.values()) {
    try {
      const stat = fs.lstatSync(item.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) { if (item.sha256) files.push({ ...item, stale: true }); continue; }
      const script = fs.readFileSync(item.path, "utf8"), options = commandOptions(script);
      if (!options || options.userDataDir !== userDataDir || item.sha256 && digest(script) !== item.sha256) {
        if (item.sha256) files.push({ ...item, stale: true }); continue;
      }
      // A generated command names its game's root exactly. A path inside the
      // root may belong to another library game that has not moved.
      if (options.gamePath !== from) { if (item.sha256) files.push(item); continue; }
      writeGameCommand(item.path, { ...options, gamePath: to });
      files.push({ path: item.path, sha256: digest(fs.readFileSync(item.path)) });
    } catch { if (item.sha256) files.push({ ...item, stale: true }); }
  }
  if (saved.length || files.length) writeJsonAtomic(file, { files });
}

function rememberGameCommandPaths(entry, previous) {
  return { ...entry, shortcutPathHashes: [...new Set([...(Array.isArray(previous.shortcutPathHashes) ? previous.shortcutPathHashes : []),
    ...[previous.gamePath, previous.importPath].filter(value => typeof value === "string" && path.isAbsolute(value)).map(value => digest(path.resolve(value)))])] };
}

// Shortcuts made before the index existed may have been saved anywhere. Their
// old --game argument still identifies the same library entry after Locate.
// Hashes retain that association across repeated moves without keeping a
// second set of filesystem paths for the launcher to follow.
function resolveGameCommandPath(userDataDir, gamePath) {
  const requested = path.resolve(gamePath), games = GameStore.loadGames(userDataDir);
  if (games.some(entry => [entry.gamePath, entry.importPath].includes(requested)) || fs.existsSync(requested)) return gamePath;
  const matches = games.filter(entry => Array.isArray(entry.shortcutPathHashes) && entry.shortcutPathHashes.includes(digest(requested)));
  return matches.length === 1 ? matches[0].gamePath : gamePath;
}

module.exports = { sanitizeFileName, buildGameCommandScript, writeGameCommand, relocateGameCommands, rememberGameCommandPaths, resolveGameCommandPath };

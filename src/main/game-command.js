const fs = require("node:fs");
const path = require("node:path");

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
  return target;
}

module.exports = { sanitizeFileName, buildGameCommandScript, writeGameCommand };

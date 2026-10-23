const fs = require("node:fs");
const path = require("node:path");

// Electron 42+ downloads on require('electron'). Resolve installed files without
// importing it so running a native engine or diagnosing a web game stays offline.
function resolveElectronBinary() {
  if (process.env.MACLAUNCHER_ELECTRON_PATH?.trim()) {
    return process.env.MACLAUNCHER_ELECTRON_PATH.trim();
  }
  // Exported shortcuts run the included executable in Node mode. Packaged apps
  // do not contain the development-only electron npm package.
  if (process.versions.electron) return process.execPath;
  const packageDir = path.dirname(require.resolve("electron/package.json"));
  let relative;
  try { relative = fs.readFileSync(path.join(packageDir, "path.txt"), "utf8").trim(); } catch {}
  const binary = process.env.ELECTRON_OVERRIDE_DIST_PATH
    ? path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH, relative || "electron")
    : relative && path.join(packageDir, "dist", relative);
  if (!binary || !fs.existsSync(binary)) {
    throw new Error("Electron is not installed. Run pnpm electron:install explicitly, or set MACLAUNCHER_ELECTRON_PATH to an installed binary.");
  }
  return binary;
}

/** Explicit entry points also work with renamed development Electron bundles. */
function createElectronHostLaunch({ executable, appPath, gamePath, runtimeId = "electron", userDataDir,
  env = process.env, gameArguments = [] } = {}) {
  for (const [name, value] of Object.entries({ executable, appPath, gamePath, runtimeId, userDataDir })) {
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`Missing Electron host ${name}.`);
  }
  const environment = { ...env };
  delete environment.ELECTRON_RUN_AS_NODE;
  // The child hosts the game independently of the launcher's development server.
  delete environment.ELECTRON_START_URL;
  const argumentsForGame = require("../modules/shared/runtime/launch-arguments").validate(gameArguments);
  return { executable, args: [appPath, "--maclauncher-runtime-host", `--game=${gamePath}`,
    `--runtime=${runtimeId}`, `--user-data=${userDataDir}`,
    ...(argumentsForGame.length ? [`--maclauncher-game-arguments=${Buffer.from(JSON.stringify(argumentsForGame), "utf8").toString("base64")}`] : [])], env: environment };
}

module.exports = { resolveElectronBinary, createElectronHostLaunch };

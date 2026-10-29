const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { findInstalledApp } = require("./installed-client");
const { findClient } = require("../../reshade/steam-client-models");

const READY_TIMEOUT_MS = 60 * 1000;
const POLL_MS = 500;
const MAX_SCAN_ENTRIES = 4096;
const MAX_SCAN_DEPTH = 6;
const MAX_LOG_TAIL = 64 * 1024;
// Steam's connection log records a completed account sign-in with this line.
const SIGNED_IN = /\[Logged On, [^\]\n]*\][^\n]*RecvMsgClientLogOnResponse\(\) : processing complete/;

// Steam API libraries by the platform of the client they connect to.
function steamApiPlatform(name, directory) {
  const lower = name.toLowerCase();
  if (directory) return lower === "steam_api.bundle" ? "macos" : null;
  if (lower === "libsteam_api.dylib") return "macos";
  return lower === "steam_api.dll" || lower === "steam_api64.dll" ? "windows" : null;
}

// Breadth-first and bounded: Steam API libraries sit near the game root or
// inside its app bundle. Links are not followed.
function findSteamApiPlatforms(root) {
  const platforms = new Set(), queue = [{ directory: root, depth: 0 }];
  let budget = MAX_SCAN_ENTRIES;
  while (queue.length && budget > 0) {
    const { directory, depth } = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (--budget < 0) break;
      const platform = steamApiPlatform(entry.name, entry.isDirectory());
      if (platform && (entry.isFile() || entry.isDirectory())) platforms.add(platform);
      if (entry.isDirectory() && depth < MAX_SCAN_DEPTH) queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
    }
  }
  return platforms;
}

// The game's Steam library installation, identified by an app manifest that
// names its folder. DRM-free copies, including launcher downloads, have none.
function steamInstallation(entry) {
  for (const candidate of [entry?.nativeAppPath, entry?.gamePath, entry?.importPath, entry?.contentRootDir]) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) continue;
    try {
      const installation = findInstalledApp(candidate);
      if (installation) return installation;
    } catch { return null; }
  }
  return null;
}

// Only the game's own Steam API talks to the Steam client; the included helper
// supplies local state without it. A native Mac app runs its own library, and
// it is a consumer when its installation ships the macOS Steam API. Windows
// Steam APIs run inside private Wine environments that no Steam client
// outside them can serve.
function nativeAppNeedsClient(installation) {
  return Boolean(installation?.installRoot && findSteamApiPlatforms(installation.installRoot).has("macos"));
}

// A prepared shared Steam API needs the client when it selected the game's own
// library (mode "native") for a game that a Steam library installed.
function preparedApiNeedsClient(prepared, entry) {
  return prepared?.mode === "native" && Boolean(steamInstallation(entry));
}

// Games for which Play can start Steam, shown with the per-game setting. The
// launch-time preparation still decides for engine runtimes. Results are kept
// for the launcher session because the check reads the game folder.
const eligibility = new Map();
function clientEligible(entry) {
  const key = JSON.stringify([entry?.nativeAppPath, entry?.gamePath, entry?.importPath, entry?.contentRootDir]);
  if (!eligibility.has(key)) {
    if (eligibility.size >= 1024) eligibility.clear();
    eligibility.set(key, nativeAppNeedsClient(steamInstallation(entry)));
  }
  return eligibility.get(key);
}

function startPreference(value) {
  // Legacy On predates startup consent. Only the explicit new choice grants it.
  return value === false || value === "never" ? "never" : value === "automatic" ? "automatic" : "ask";
}
function clientStartPreference(entry, settings) {
  return startPreference(entry?.startSteamClient ?? settings?.launcher?.startSteamClient);
}
function clientStartEnabled(entry, settings) { return clientStartPreference(entry, settings) !== "never"; }

// pgrep exits 0 with a match and 1 without one. Any other result, including a
// failed spawn, leaves the client's state unknown (null).
function clientRunning() {
  const result = spawnSync("/usr/bin/pgrep", ["-x", "steam_osx"], { stdio: "ignore" });
  return result.error || ![0, 1].includes(result.status) ? null : result.status === 0;
}

function run(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", () => resolve(-1));
    child.once("exit", code => resolve(code ?? -1));
  });
}

// Launch Services starts Steam outside the launcher's and the game's process
// trees. -g and -j ask it not to activate Steam and to start it hidden;
// -silent keeps Steam's main window closed. Steam can still activate itself.
async function startClient({ home = os.homedir() } = {}) {
  const executable = findClient({ home });
  if (!executable) throw new Error("Steam for Mac is not installed.");
  if (await run("/usr/bin/open", ["-g", "-j", "-a", path.resolve(executable, "../../.."), "--args", "-silent"]) === 0) return;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:DYLD_|ELECTRON_)/.test(key)));
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ["-silent"], { detached: true, stdio: "ignore", env });
    child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
  });
}

function readAppended(file, cursor) {
  let handle;
  try {
    handle = fs.openSync(file, "r");
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) return "";
    // Steam replaces the log when it rotates it at startup.
    if (stat.ino !== cursor.inode || stat.size < cursor.offset) cursor.offset = 0;
    cursor.inode = stat.ino;
    const data = Buffer.alloc(Math.min(1024 * 1024, Math.max(0, stat.size - cursor.offset)));
    cursor.offset += fs.readSync(handle, data, 0, data.length, cursor.offset);
    return data.toString("utf8");
  } catch { return ""; } finally { if (handle !== undefined) fs.closeSync(handle); }
}

async function waitForSignIn({ logPath, cursor, isRunning, timeoutMs, pollMs, now }) {
  const deadline = now() + timeoutMs;
  let tail = "";
  for (;;) {
    tail = (tail + readAppended(logPath, cursor)).slice(-MAX_LOG_TAIL);
    // A new sign-in counts unless the client's process is known to be gone.
    if (SIGNED_IN.test(tail) && isRunning() !== false) return true;
    if (now() >= deadline) return false;
    await delay(pollMs);
  }
}

function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error("Launch cancelled."), { name: "AbortError" }));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

let pending = null;

/**
 * Start Steam if it is not running and wait for its sign-in. Callers decide
 * that the game needs the client; the launcher allows this only during Play.
 * A timeout or failed start returns a notice, and Play continues either way.
 */
async function ensureClient({ signal, report, logger, mode = "ask", confirmRuntimeInstall, home = os.homedir(), timeoutMs = READY_TIMEOUT_MS, pollMs = POLL_MS,
  isRunning = clientRunning, start = startClient, now = Date.now } = {}) {
  signal?.throwIfAborted();
  if (startPreference(mode) === "never") return { started: false };
  // Concurrent launches in this process share one start and one wait, even
  // after Steam's process appears and before it has signed in.
  if (!pending) {
    const running = isRunning();
    if (running) return { started: false };
    // An unknown state could be a running client: neither ask nor start it.
    if (running !== false) {
      logger?.warn?.("[steam] The Steam client's state could not be checked; the game starts without starting Steam.");
      return { started: false, notice: "Steam's state could not be checked, so the game started without starting Steam." };
    }
  }
  if (!pending && startPreference(mode) !== "automatic") {
    const consent = await confirmRuntimeInstall?.({ kind: "client-start", managerId: "steam-client", label: "Steam",
      requiresDownload: false, message: "Start Steam for this game?", confirmLabel: "Start Steam", cancelLabel: "Launch without Steam",
      detail: "This game uses the Steam client, which connects to the Internet and signs in. The game can also launch without it." });
    signal?.throwIfAborted();
    if (consent !== true && consent?.approved !== true) return { started: false };
    if (!pending && isRunning() !== false) return { started: false };
  }
  report?.("Starting Steam…");
  pending ||= (async () => {
    const logPath = path.join(home, "Library/Application Support/Steam/logs/connection_log.txt");
    const stat = fs.statSync(logPath, { throwIfNoEntry: false }), cursor = { offset: stat?.size || 0, inode: stat?.ino };
    try { await start({ home }); }
    catch (error) {
      logger?.warn?.("[steam] Steam could not be started.", error?.message || String(error));
      return { started: false, notice: "Steam could not be started, so the game started without it." };
    }
    if (await waitForSignIn({ logPath, cursor, isRunning, timeoutMs, pollMs, now })) return { started: true, ready: true };
    logger?.warn?.(`[steam] Steam did not sign in within ${Math.round(timeoutMs / 1000)} s; starting the game.`);
    return { started: true, ready: false,
      notice: `Steam did not finish signing in within ${Math.round(timeoutMs / 1000)} seconds, so the game started without waiting for it.` };
  })().finally(() => { pending = null; });
  return abortable(pending, signal);
}

module.exports = { ensureClient, steamInstallation, nativeAppNeedsClient, preparedApiNeedsClient, clientEligible, clientStartEnabled, clientStartPreference, startPreference, findSteamApiPlatforms,
  startClient, clientRunning, SIGNED_IN };

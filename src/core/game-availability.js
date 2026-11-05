const fs = require("node:fs");
const path = require("node:path");
const PathStat = require("./path-stat-probe");

// One rule for every per-game path: while a game's files are not on disk, for
// example on a disconnected drive, nothing verifies, scans, follows or rewrites
// what the launcher stored for it. Callers ask here first and skip the work.
const CODE = "GAME_FILES_UNAVAILABLE";
const TIMEOUT_MS = 3000;
const AVAILABLE = Object.freeze({ available: true });
const TIMED_OUT = "ETIMEDOUT";

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};

// The game's root on disk: its folder or single file, or the imported original
// when the playable copy is launcher-owned, such as an unpacked installer.
function rootPath(entry, { userDataDir } = {}) {
  const owned = typeof userDataDir === "string" && path.isAbsolute(userDataDir) ? path.resolve(userDataDir) : null;
  for (const value of [entry?.gamePath, entry?.importPath]) {
    if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) continue;
    const file = path.resolve(value);
    if (!owned || !inside(owned, file)) return file;
  }
  return null;
}

function describe(code, file) {
  const result = (reason, message) => ({ available: false, reason, path: file, message });
  if (code === "ENOENT" || code === "ENOTDIR") return result("missing", "The game's files were not found at their saved location.");
  if (code === TIMED_OUT) return result("unresponsive", "The game's location is not responding.");
  if (code === "EACCES" || code === "EPERM") return result("unreadable", "MacLauncher does not have permission to read the game's files.");
  return result("unreadable", `The game's files cannot be read (${code}).`);
}

function errorCode(error) {
  return typeof error?.code === "string" && error.code ? error.code : "EIO";
}

// One outstanding stat per path. A location that stops responding then holds a
// single isolated probe thread, however often the library or a window asks again.
const pendingByStat = new WeakMap();
function statOnce(file, stat) {
  let pending = pendingByStat.get(stat);
  if (!pending) pendingByStat.set(stat, pending = new Map());
  let probe = pending.get(file);
  if (!probe) {
    probe = { started: Date.now() };
    probe.result = Promise.resolve().then(() => stat(file)).then(() => null, errorCode).then(code => {
      if (pending.get(file) === probe) pending.delete(file);
      return code;
    });
    pending.set(file, probe);
  }
  return probe;
}

// Resolves to { available: true } or { available: false, reason, path, message }
// with reason "missing", "unresponsive" or "unreadable". It stats the game's
// root once and never walks the folder. A stat that outlasts timeoutMs reports
// "unresponsive", and later checks of that path report it at once until the
// stat finishes.
async function checkGameAvailability(entry, { userDataDir, stat = PathStat.statPath, timeoutMs = TIMEOUT_MS } = {}) {
  const file = rootPath(entry, { userDataDir });
  if (!file) return AVAILABLE;
  const probe = statOnce(file, stat);
  const remaining = timeoutMs - (Date.now() - probe.started);
  if (remaining <= 0) return describe(TIMED_OUT, file);
  let timer;
  // The probe threads never keep the process running, so this wait does.
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, remaining, TIMED_OUT); });
  try {
    const code = await Promise.race([probe.result, timeout]);
    return code ? describe(code, file) : AVAILABLE;
  } finally { clearTimeout(timer); }
}

// The same check for synchronous backend code, such as the save service. It
// never runs in the launcher's main process.
function checkGameAvailabilitySync(entry, { userDataDir, statSync = fs.statSync } = {}) {
  const file = rootPath(entry, { userDataDir });
  if (!file) return AVAILABLE;
  try { statSync(file); return AVAILABLE; } catch (error) { return describe(errorCode(error), file); }
}

// True when a path, such as a save folder, lies inside the missing game root.
// Creating it there would recreate an empty copy of the game folder, so callers
// refuse instead.
function affectsPath(availability, file) {
  if (!availability || availability.available !== false || typeof availability.path !== "string") return false;
  if (typeof file !== "string" || !path.isAbsolute(file)) return false;
  return inside(availability.path, path.resolve(file));
}

// True when a file, such as a stored icon, lies inside the game's root.
function insideRoot(entry, file, options) {
  const root = rootPath(entry, options);
  return Boolean(root) && typeof file === "string" && path.isAbsolute(file) && inside(root, path.resolve(file));
}

function unavailableError(availability, prefix = "The game's files are unavailable.") {
  const error = new Error(`${prefix} ${availability.message}`);
  error.code = CODE;
  error.availability = availability;
  return error;
}

async function assertGameAvailable(entry, options) {
  const availability = await checkGameAvailability(entry, options);
  if (!availability.available) throw unavailableError(availability);
  return availability;
}

function sameAvailability(a, b) {
  if (!a || !b) return a === b;
  return a.available === b.available && a.reason === b.reason && a.path === b.path && a.message === b.message;
}

module.exports = {
  CODE, TIMEOUT_MS, rootPath, checkGameAvailability, checkGameAvailabilitySync,
  assertGameAvailable, unavailableError, affectsPath, insideRoot, sameAvailability
};

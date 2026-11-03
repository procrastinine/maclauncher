const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Upkeep of derived data under userData: files and folders the app can rebuild
// or no longer needs, such as per-launch records, superseded helper versions
// and download archives that were already extracted. Owners declare stores;
// this one retention path applies them. A store declaration:
//   id           stable name used in logs
//   directories  (context) => absolute folders holding the store's entries
//   match        anchored RegExp (^…$) naming the store's entries exactly;
//                other entries are never touched
//   keep         optional async (directory, context) => (name) => boolean,
//                entries that must stay, such as those of a live launch
//   newest       how many of the remaining entries stay, newest first (0)
//   minAgeMs     entries modified more recently stay (one hour)
// Stores run in declaration order, so a store can keep what an earlier store
// in the same pass left in place. Games, saves, settings and installed
// runtimes are not derived stores, and a game's missing or disconnected files
// never make its data prunable.
//
// The launcher starts one pass per app start, while no game runs or prepares
// and nothing downloads, and asks again before every removal; a busy launcher
// stops the pass. An entry is first renamed to a hidden trash name in its
// folder, so the store never shows a partly removed entry, and then deleted
// without following links or entering another volume. A pass that stops, or
// a deletion that fails, leaves the trash entry, and the next pass finishes
// trash before anything else. Errors are logged once per store and never
// reach the caller.
const HOUR = 60 * 60 * 1000;
const TRASH_PREFIX = ".maclauncher-trash-";
const TRASH = /^\.maclauncher-trash-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
const pause = () => new Promise(resolve => setImmediate(resolve));

// Bounded JSON read for small records; null when absent or unreadable.
function readJson(file, maxBytes = 1024 * 1024) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return null; }
}

function createContext({ userDataDir, now = Date.now(), alive = processAlive }) {
  let games;
  return {
    userDataDir, now, processAlive: alive, readJson,
    // Saved game IDs with a folder under games/.
    gameIds() {
      if (!games) {
        try {
          games = fs.readdirSync(path.join(userDataDir, "games"), { withFileTypes: true })
            .filter(item => item.isDirectory() && /^[\w-]{1,128}$/.test(item.name)).map(item => item.name);
        } catch { games = []; }
      }
      return games;
    }
  };
}

// Makes a directory the app sealed read-only writable again, through a
// descriptor that never follows a link, after checking it is the same entry.
function unseal(directory, stat) {
  if ((stat.mode & 0o700) === 0o700) return;
  if (stat.uid !== process.getuid()) throw Object.assign(new Error(`${directory} belongs to another user.`), { code: "EACCES" });
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw Object.assign(new Error(`${directory} changed during upkeep.`), { code: "EAGAIN" });
    fs.fchmodSync(fd, (stat.mode & 0o7777) | 0o700);
  } finally { fs.closeSync(fd); }
}

// Deletes a trash entry depth first. Links are removed, never followed, and
// nothing on another volume, such as a mounted image, is entered.
async function removeTree(file, device, total) {
  const stat = fs.lstatSync(file);
  if (stat.dev !== device) throw Object.assign(new Error(`${file} is on another volume.`), { code: "EXDEV" });
  if (!stat.isDirectory()) { fs.unlinkSync(file); total.bytes += stat.size; return; }
  unseal(file, stat);
  for (const name of fs.readdirSync(file)) await removeTree(path.join(file, name), device, total);
  fs.rmdirSync(file);
  if (++total.folders % 256 === 0) await pause();
}

/** Moves a file or folder the app owns to a trash name in `trashFolder` (its
 * own folder by default), which must be on the same volume, and returns the
 * trash path. Upkeep finishes trash in its declared store folders; a caller
 * that still needs the entry passes another `name`, which upkeep ignores. */
function moveToTrash(file, { trashFolder = path.dirname(file), name = TRASH_PREFIX + crypto.randomUUID() } = {}) {
  const stat = fs.lstatSync(file), folder = fs.lstatSync(trashFolder);
  if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) throw new Error(`${file} is not a file or folder.`);
  if (stat.dev !== folder.dev) throw Object.assign(new Error(`${file} is on another volume.`), { code: "EXDEV" });
  // Moving a read-only folder to another folder needs write access to it.
  if (stat.isDirectory() && path.dirname(file) !== trashFolder) unseal(file, stat);
  const trash = path.join(trashFolder, name);
  fs.renameSync(file, trash);
  return trash;
}
/** Deletes a trash entry and returns the bytes freed. */
async function removeTrash(trash) {
  const total = { bytes: 0, folders: 0 };
  await removeTree(trash, fs.lstatSync(path.dirname(trash)).dev, total);
  return total.bytes;
}

/** Applies every store once. Never throws; returns what was removed and the
 * stores that kept entries after errors. Nothing runs while a game runs. */
async function maintainStorage({ userDataDir, stores, running = {}, busy = () => false, logger, now = Date.now(), alive } = {}) {
  const summary = { removed: 0, bytes: 0, stores: [], errors: [], interrupted: false };
  if (!path.isAbsolute(userDataDir || "")) return { ...summary, skipped: "unavailable" };
  if (Object.keys(running || {}).length) return { ...summary, skipped: "running" };
  let root;
  try { root = fs.realpathSync(userDataDir); } catch { return { ...summary, skipped: "unavailable" }; }
  const context = createContext({ userDataDir, now, alive });
  // Asked before every removal: a running or preparing game or a download
  // stops the pass, and the rest waits for the next start.
  const quiet = async () => {
    if (summary.interrupted) return false;
    try { if (!await busy()) return true; } catch {}
    summary.interrupted = true; return false;
  };

  const reports = new Map();
  const report = store => {
    if (!reports.has(store)) reports.set(store, { id: store?.id || "store", removed: 0, bytes: 0, errors: [] });
    return reports.get(store);
  };
  // Renames a candidate to trash, or takes a trash entry as it is, and deletes it.
  async function retire(entry, folder, row) {
    const file = path.join(folder.directory, entry.name), stat = fs.lstatSync(file);
    if (stat.dev !== folder.stat.dev || stat.ino !== entry.ino) return;
    const trash = entry.trash ? file : path.join(folder.directory, TRASH_PREFIX + crypto.randomUUID());
    if (!entry.trash) { fs.renameSync(file, trash); row.removed++; }
    const total = { bytes: 0, folders: 0 };
    try { await removeTree(trash, folder.stat.dev, total); } finally { row.bytes += total.bytes; }
  }
  // Each declared folder is listed once per pass; a folder that cannot be
  // opened is reported once.
  const listings = new Map();
  function list(directory) {
    if (!listings.has(directory)) {
      try {
        let stat = null;
        try { stat = fs.lstatSync(directory); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!stat?.isDirectory()) { listings.set(directory, null); return null; }
        const real = fs.realpathSync(directory);
        if (!inside(root, real)) throw new Error(`${directory} is outside the launcher data folder.`);
        listings.set(directory, { folder: { directory, stat }, items: fs.readdirSync(directory, { withFileTypes: true }) });
      } catch (error) { listings.set(directory, { error }); throw error; }
    }
    const listing = listings.get(directory);
    if (listing?.error) throw Object.assign(new Error(listing.error.message), { reported: true });
    return listing;
  }
  const failed = (row, error) => { if (!error?.reported) row.errors.push(error); };

  const plan = [];
  for (const store of stores || []) {
    try {
      const match = store?.match;
      if (typeof store?.directories !== "function" || !(match instanceof RegExp) || !match.source.startsWith("^") || !match.source.endsWith("$"))
        throw new Error("The derived store declaration is incomplete.");
      const directories = (store.directories(context) || []).filter(directory => path.isAbsolute(directory || ""));
      plan.push({ store, directories });
    } catch (error) { report(store).errors.push(error); }
  }

  // Trash left by an earlier pass is finished first.
  for (const { store, directories } of plan) {
    const row = report(store);
    for (const directory of directories) {
      try {
        const listing = list(directory);
        for (const item of listing?.items || []) {
          if (!TRASH.test(item.name) || item.isSymbolicLink()) continue;
          if (!await quiet()) break;
          try { await retire({ name: item.name, ino: fs.lstatSync(path.join(directory, item.name)).ino, trash: true }, listing.folder, row); }
          catch (error) { failed(row, error); }
        }
      } catch (error) { failed(row, error); }
    }
  }

  for (const { store, directories } of plan) {
    const row = report(store), minAge = Number.isFinite(store.minAgeMs) ? store.minAgeMs : HOUR;
    for (const directory of directories) {
      if (!await quiet()) break;
      await pause();
      try {
        const listing = list(directory);
        if (!listing) continue;
        const keep = store.keep ? await store.keep(directory, context) : () => false;
        const candidates = [];
        for (const item of listing.items) {
          if (item.isSymbolicLink() || !(item.isFile() || item.isDirectory()) || TRASH.test(item.name) || !store.match.test(item.name) || keep(item.name)) continue;
          let stat;
          try { stat = fs.lstatSync(path.join(directory, item.name)); } catch { continue; }
          if (stat.dev !== listing.folder.stat.dev || now - stat.mtimeMs < minAge) continue;
          candidates.push({ name: item.name, ino: stat.ino, mtime: stat.mtimeMs });
        }
        candidates.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
        for (const entry of candidates.slice(Math.max(0, store.newest || 0))) {
          if (!await quiet()) break;
          try { await retire(entry, listing.folder, row); } catch (error) { failed(row, error); }
        }
      } catch (error) { failed(row, error); }
    }
  }

  for (const row of reports.values()) {
    summary.removed += row.removed; summary.bytes += row.bytes;
    if (row.removed) summary.stores.push({ id: row.id, removed: row.removed, bytes: row.bytes });
    if (row.errors.length) {
      const first = row.errors[0];
      summary.errors.push({ id: row.id, count: row.errors.length, error: String(first?.message || first) });
      logger?.warn?.(`[storage] ${row.id}: ${row.errors.length} entr${row.errors.length === 1 ? "y" : "ies"} kept after errors; first: ${first?.message || first}`);
    }
  }
  if (summary.removed) {
    logger?.info?.(`[storage] removed ${summary.removed} derived entries (${Math.round(summary.bytes / 1024)} KB): ` +
      summary.stores.map(store => `${store.id} ${store.removed}`).join(", "));
  }
  if (summary.interrupted) logger?.info?.("[storage] the launcher became busy; the rest waits for the next start.");
  return summary;
}

/** Core-owned stores followed by those modules and shared services declare. */
function listStores(registry = require("../modules/registry")) {
  return [...require("./derived-stores"), ...(registry.listDerivedStores?.() || [])];
}

module.exports = { maintainStorage, moveToTrash, removeTrash, listStores, processAlive, readJson, TRASH };

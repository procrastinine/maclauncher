const fs = require("node:fs"), path = require("node:path");
const { cloneOrCopySync } = require("./copy-file");
const { atomicWrite } = require("./writable-input");

// A private game folder that mirrors one or more source folders. Read-only
// resources are symbolic links to the originals; other files are private
// clones that a game may write to. A record of every entry the overlay made,
// with each copied original's size, modification time and inode, lets each
// launch refresh exactly what changed: an edited original replaces its private
// copy, a new file appears and a removed one disappears, unless the game wrote
// to that copy. Unchanged files are not read again, a private file the game
// edited or deleted stays that way until its original changes, and entries the
// game created are never touched. An unavailable source folder stops the pass
// before anything changes, so a reconnected drive finds the overlay as it was.
const SCHEMA = 1;

const lstat = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
const signature = stat => `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
// Copies keep the original's size and modification time until written; an
// in-process copy can round the time below a millisecond.
const untouched = (stat, recorded) => {
  const [size, mtime] = recorded.split(":").map(Number);
  return stat.isFile() && stat.size === size && Math.abs(stat.mtimeMs - mtime) < 1;
};
const inside = (parent, file) => file === parent || file.startsWith(parent + path.sep);

function readRecord(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record?.schemaVersion === SCHEMA && record.entries && typeof record.entries === "object") return record.entries;
  } catch {}
  return {};
}

/** Brings `destination` up to date with `layers` ({ source, into, optional };
 * later layers win). `link(name, relative)` names files to alias and
 * `skip(name, relative, directory)` entries to leave out. Returns { changed }. */
function syncOverlay({ destination, recordPath, layers, link = () => false, skip = () => false, maxDepth = 32 }) {
  destination = path.resolve(destination);
  // Without the folder its record describes nothing that still exists.
  const previous = lstat(destination)?.isDirectory() ? readRecord(recordPath) : {};
  const plan = new Map();
  const replace = (relative, entry) => {
    if (plan.get(relative)?.kind === "directory") for (const key of plan.keys()) if (key.startsWith(relative + path.sep)) plan.delete(key);
    plan.delete(relative); plan.set(relative, entry);
  };
  function walk(directory, relative, depth) {
    if (depth > maxDepth) throw new Error("The game folder is too deeply nested.");
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = relative ? path.join(relative, item.name) : item.name, from = path.join(directory, item.name);
      // Links inside the originals are not followed.
      if (item.isDirectory()) {
        if (skip(item.name, child, true) || inside(from, destination)) continue;
        if (plan.get(child)?.kind !== "directory") replace(child, { kind: "directory" });
        walk(from, child, depth + 1);
      } else if (item.isFile() && !skip(item.name, child, false)) replace(child, { kind: link(item.name, child) ? "link" : "copy", from });
    }
  }
  for (const layer of layers) {
    const source = path.resolve(layer.source);
    let stat;
    try { stat = fs.statSync(source); } catch (error) { if (layer.optional && error.code === "ENOENT") continue; throw error; }
    if (!stat.isDirectory()) {
      if (layer.optional) continue;
      throw Object.assign(new Error("The game folder is not a directory."), { code: "ENOTDIR", path: source });
    }
    const into = layer.into ? path.normalize(layer.into) : "";
    if (into) into.split(path.sep).forEach((_, index, parts) => {
      const relative = parts.slice(0, index + 1).join(path.sep);
      if (plan.get(relative)?.kind !== "directory") replace(relative, { kind: "directory" });
    });
    walk(source, into, 0);
  }

  const entries = {}, occupied = [];
  let changed = false;
  fs.mkdirSync(destination, { recursive: true });
  for (const [relative, want] of plan) {
    if (occupied.some(prefix => relative.startsWith(prefix + path.sep))) continue;
    const to = path.join(destination, relative), old = previous[relative];
    if (want.kind === "directory") {
      const stat = lstat(to);
      if (!stat?.isDirectory()) {
        // A file the game made at this path stays, and so does what is below it.
        if (stat && !stat.isSymbolicLink() && !old) { occupied.push(relative); continue; }
        if (stat) fs.rmSync(to, { force: true });
        fs.mkdirSync(to); changed = true;
      }
      entries[relative] = "d"; continue;
    }
    if (want.kind === "link") {
      const target = "l:" + want.from;
      if (old === target) { entries[relative] = old; continue; }
      const stat = lstat(to);
      if (stat?.isSymbolicLink() && fs.readlinkSync(to) === want.from) { entries[relative] = target; continue; }
      if (stat?.isDirectory()) continue;
      // An untouched copy becomes a link; a file the game changed stays.
      if (stat?.isFile() && !untouched(stat, signature(fs.statSync(want.from)))) continue;
      if (stat) fs.rmSync(to, { force: true });
      fs.symlinkSync(want.from, to); entries[relative] = target; changed = true; continue;
    }
    const recorded = "c:" + signature(fs.statSync(want.from));
    // An unchanged original keeps the private file as the game left it.
    if (old === recorded) { entries[relative] = old; continue; }
    const stat = lstat(to);
    if (stat?.isDirectory()) continue;
    // A private file the overlay did not record, such as one from an older
    // layout or one the game created, is kept and followed from now on.
    if (stat?.isFile() && !old?.startsWith("c:")) { entries[relative] = recorded; continue; }
    cloneOrCopySync(want.from, to);
    entries[relative] = recorded; changed = true;
  }

  // Children before their folders. Entries that are still planned stay.
  for (const relative of Object.keys(previous).filter(key => !plan.has(key)).sort().reverse()) {
    const old = previous[relative], to = path.join(destination, relative), stat = lstat(to);
    if (!stat) continue;
    try {
      if (old === "d" && stat.isDirectory()) fs.rmdirSync(to);
      else if (old.startsWith("l:") && stat.isSymbolicLink()) fs.unlinkSync(to);
      else if (old.startsWith("c:") && untouched(stat, old.slice(2))) fs.unlinkSync(to);
      else continue;
      changed = true;
    } catch (error) { if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(error.code)) throw error; }
  }
  const text = JSON.stringify({ schemaVersion: SCHEMA, entries });
  let stored = null;
  try { stored = fs.readFileSync(recordPath, "utf8"); } catch {}
  if (stored !== text) atomicWrite(recordPath, text, { root: path.dirname(recordPath) });
  return { changed };
}

module.exports = { syncOverlay };

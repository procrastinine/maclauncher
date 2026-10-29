"use strict";
const fs = require("node:fs"), path = require("node:path");

// Prepared rows of each game's live plan file, for its bound launch only. The
// rows, all prepared from immutable inputs, persist in the application's own
// data directory (configure), so a launcher restarted while the game still
// runs reuses them. A stored row is reused only for the same preparation code,
// launch and row inputs, and only while the compiled file it names exists.
// Main configures it; other processes keep the rows in memory.
const MAX_TARGETS = 16, MAX_ROWS = 64, MAX_STORE_BYTES = 8 * 1024 * 1024;
const live = new Map();
let store = null;

function configure({userDataDir} = {}) {
  if (store?.timer) clearTimeout(store.timer);
  store = userDataDir ? {userDataDir, file: path.join(userDataDir, "graphics", "live-prepared-rows.json"), targets: null, timer: null} : null;
  live.clear();
}
function preparer() {
  return require("../source-identity").identity(path.join(__dirname, "runtime.js"));
}
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validRow = row => object(row) && /^[a-f0-9]{64}$/.test(row.key || "") && object(row.node) && object(row.requirements) &&
  object(row.environment) && Object.values(row.environment).every(value => typeof value === "string") && typeof row.preservesCoordinates === "boolean" &&
  (row.node.file === undefined || typeof row.node.file === "string" && path.isAbsolute(row.node.file) && fs.existsSync(row.node.file));
// An unreadable or foreign store is a cache miss; the rows are prepared again.
function storedTargets() {
  if (!store || store.targets) return store?.targets;
  store.targets = new Map();
  const identity = preparer();
  if (!identity) return store.targets;
  try {
    const stat = fs.lstatSync(store.file);
    if (!stat.isFile() || stat.size > MAX_STORE_BYTES) return store.targets;
    const value = JSON.parse(fs.readFileSync(store.file, "utf8"));
    if (value?.schema !== 1 || value.preparer !== identity || !object(value.targets)) return store.targets;
    for (const [target, entry] of Object.entries(value.targets).slice(-MAX_TARGETS))
      if (typeof entry?.identity === "string" && object(entry.rows)) store.targets.set(target, entry);
  } catch {}
  return store.targets;
}
// Writes pending changes now; changes are otherwise written after a second.
function flush() {
  if (!store?.timer) return;
  clearTimeout(store.timer);store.timer = null;
  const identity = preparer();
  if (!identity) return;
  const targets = [...store.targets];
  let text;
  while ((text = JSON.stringify({schema: 1, preparer: identity, targets: Object.fromEntries(targets)})).length > MAX_STORE_BYTES && targets.length) targets.shift();
  try {require("../writable-input").atomicWrite(store.file, text, {root: store.userDataDir});} catch {}
}
function changed(target, identity, rows) {
  const targets = storedTargets();
  if (!targets) return;
  targets.delete(target);targets.set(target, {identity, rows: Object.fromEntries(rows)});
  while (targets.size > MAX_TARGETS) targets.delete(targets.keys().next().value);
  store.timer ||= setTimeout(flush, 1000);store.timer.unref?.();
}
// The rows of one plan file for one launch.
function rows(target, launch) {
  const identity = `${launch.launchId}:${launch.pid}`;
  let value = live.get(target);
  if (value?.identity !== identity) {
    const stored = storedTargets()?.get(target);
    const entries = stored?.identity === identity ? Object.entries(stored.rows).filter(([, row]) => validRow(row)) : [];
    value = {identity, rows: new Map(entries)};
    live.delete(target);live.set(target, value);
    if (live.size > MAX_TARGETS) live.delete(live.keys().next().value);
  }
  const current = value;
  return {
    get: id => current.rows.get(id),
    set(id, row) {
      current.rows.delete(id);current.rows.set(id, row);
      while (current.rows.size > MAX_ROWS) current.rows.delete(current.rows.keys().next().value);
      changed(target, identity, current.rows);
    },
    delete(id) {
      if (current.rows.delete(id)) changed(target, identity, current.rows);
    }
  };
}

module.exports = {configure, rows, flush};

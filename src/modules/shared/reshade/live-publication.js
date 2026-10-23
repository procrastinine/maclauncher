const fs = require("node:fs"), path = require("node:path");
const Writable = require("../writable-input");

const stale = () => Object.assign(new Error("Graphics settings will apply on the next launch."), {code: "GRAPHICS_LIVE_STALE"});
function snapshot(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error("Graphics controls must be ordinary files.");
    return fs.readFileSync(file);
  } catch (error) { if (error.code === "ENOENT") return null;throw error; }
}
const equal = (left, right) => left === null ? right === null : right !== null && left.equals(right);

// Only small accepted-pointer documents are buffered. Compiler outputs remain
// immutable files, so a native candidate can use them before shared activation.
function createPublication({isCurrent} = {}) {
  const records = new Map(), guards = new Set(), metadata = {};let state = "prepared", deferred = false, restored = true;
  const current = () => [...guards].every(guard => guard() === true);
  const preparing = () => { if (state !== "prepared") throw new Error("Graphics publication is already finished."); };
  function guard(callback) {
    preparing();
    if (typeof callback !== "function") throw new TypeError("Graphics publication requires a current-launch guard.");
    guards.add(callback);
  }
  if (isCurrent !== undefined) guard(isCurrent);
  function observe(file, {root = path.dirname(file)} = {}) {
    preparing();file = path.resolve(file);root = path.resolve(root);
    Writable.assertOwnDirectory(root, path.dirname(file), {create: false});
    if (!records.has(file)) records.set(file, {file, root, before: snapshot(file), bytes: undefined, activation: false});
    else if (records.get(file).root !== root) throw new Error("Graphics publication roots must agree.");
    return records.get(file);
  }
  function read(file, encoding) {
    preparing();file = path.resolve(file);
    const record = records.get(file), bytes = record ? record.bytes === undefined ? record.before : record.bytes : snapshot(file);
    if (bytes === null) throw Object.assign(new Error("Graphics controls do not exist."), {code: "ENOENT"});
    return encoding ? bytes.toString(encoding) : Buffer.from(bytes);
  }
  function readOriginal(file, encoding) {
    preparing();file = path.resolve(file);
    const record = records.get(file), bytes = record ? record.before : snapshot(file);
    if (bytes === null) throw Object.assign(new Error("Graphics controls do not exist."), {code: "ENOENT"});
    return encoding ? bytes.toString(encoding) : Buffer.from(bytes);
  }
  function write(file, contents, options = {}) {
    const record = observe(file, options);
    record.bytes = Buffer.isBuffer(contents) ? Buffer.from(contents) : Buffer.from(contents, options.encoding || "utf8");
    record.activation = options.activation === true;
  }
  const rows = () => [...records.values()].filter(record => record.bytes !== undefined)
    .sort((left, right) => Number(left.activation) - Number(right.activation));
  function check() {
    preparing();
    if (deferred || !current() || [...records.values()].some(record => !equal(snapshot(record.file), record.before))) throw stale();
    return true;
  }
  function restore(applied) {
    // Stop/relaunch and newer publications own their bytes. Never undo them.
    if (!current() || applied.some(record => !equal(snapshot(record.file), record.bytes))) return false;
    for (const record of [...applied].reverse()) {
      if (!current()) return false;
      if (record.before === null) fs.rmSync(record.file, {force: true});
      else Writable.atomicWrite(record.file, record.before, {root: record.root});
    }
    return true;
  }
  function commit() {
    check();const applied = [];
    try {
      for (const record of rows()) {
        if (!current()) throw stale();
        Writable.atomicWrite(record.file, record.bytes, {root: record.root});applied.push(record);
      }
      state = "committed";return true;
    } catch (error) {
      try { restored = restore(applied); } catch { restored = false; }
      error.publicationRestored = restored;
      state = "rolled-back";throw error;
    }
  }
  function rollback() {
    if (state === "rolled-back") return restored;
    if (state === "prepared") { state = "rolled-back";return true; }
    restored = restore(rows());state = "rolled-back";return restored;
  }
  return {guard, observe, read, readOriginal, write, check, commit, rollback, metadata, defer() { preparing();deferred = true; },
    get changedFiles() { return rows().filter(record => !equal(record.before, record.bytes)).map(record => record.file); },
    get deferred() { return deferred; }, get pending() { return rows().length; }, get committed() { return state === "committed"; }, get state() { return state; }};
}
module.exports = {createPublication};

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Plan = require("./plan"), Writable = require("../writable-input"), Items = require("../item-results");
const LIMITS = Object.freeze({ entries: 128, bytes: 16 * 1024 * 1024, name: 128 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const nameKey = value => value.normalize("NFKC").toLocaleLowerCase("en-US");
function location(root) {
  if (!path.isAbsolute(root || "")) throw new Error("Graphics presets require the application's data directory.");
  return path.join(root, "graphics", "effects-presets.json");
}
function name(value) {
  if (typeof value !== "string" || !value.trim() || value.length > LIMITS.name || /[\x00-\x1f]/.test(value))
    throw new Error("Enter a preset name of up to 128 characters without control characters.");
  return value.trim();
}
// The library envelope must be readable. Each preset is read on its own: a
// plan with unreadable rows keeps its readable rows and lists `notices`, and
// a preset that cannot be read at all is kept in the file but not listed; the
// library reports it as a notice. Stored bytes are rewritten only for the
// preset being saved.
function stored(root) {
  const file = location(root);
  Writable.assertOwnDirectory(root, path.dirname(file), { create: false });
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return { rows: [], retained: [], notices: [] };throw error; }
  let data;
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.bytes) throw new Error();
    data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.schema !== 1 || !Array.isArray(data.presets) || data.presets.length > LIMITS.entries) throw new Error();
  } catch { throw new Error("Graphics presets could not be read. Restore the saved preset file before editing presets."); }
  const ids = new Set(), names = new Set(), StoredPlan = require("./stored-plan");
  const read = Items.settle(data.presets, raw => {
    if (!raw || !UUID.test(raw.id) || ids.has(raw.id) || names.has(nameKey(name(raw.name))) || !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < 1)
      throw new Error("This graphics preset could not be read.");
    const inspected = StoredPlan.inspect(raw.plan);
    if (inspected.error) throw new Error(inspected.error.message);
    ids.add(raw.id);names.add(nameKey(raw.name));
    const notices = StoredPlan.notices(inspected), cost = measuredCost(raw.measuredCost);
    return Object.defineProperty({ id: raw.id, name: name(raw.name), updatedAt: raw.updatedAt, plan: inspected.plan, ...(notices.length ? { notices } : {}),
      ...(cost ? { measuredCost: cost } : {}) }, "raw", { value: raw });
  }, { id: (_raw, index) => index });
  return { rows: read.results, retained: read.failures.map(row => data.presets[row.id]),
    notices: read.failures.map(row => {
      const label = typeof data.presets[row.id]?.name === "string" ? `"${data.presets[row.id].name.slice(0, LIMITS.name)}"` : `number ${row.id + 1}`;
      return { message: `Saved preset ${label} could not be read and is not listed. ${row.reason}` };
    }) };
}
const read = root => stored(root).rows;
const notices = root => stored(root).notices;
function write(root, presets, retained = []) {
  const contents = JSON.stringify({ schema: 1, presets: [...presets.map(row => row.raw || row), ...retained] }, null, 2) + "\n";
  if (presets.length + retained.length > LIMITS.entries || Buffer.byteLength(contents) > LIMITS.bytes)
    throw new Error("The graphics preset library is full. Remove an unused preset before saving another.");
  Writable.atomicWrite(location(root), contents, { root });
  return presets;
}
// The last GPU time measured while a preset's rows ran in a game, with the
// game's image size: one value per preset that each new measurement replaces.
// Saving an edited preset drops it, since the rows it measured changed.
function measuredCost(value) {
  if (!value || typeof value !== "object" || !Number.isFinite(value.milliseconds) || value.milliseconds <= 0 || value.milliseconds > 10000 ||
      ![value.width, value.height].every(size => Number.isInteger(size) && size > 0 && size <= 65536) || !Number.isSafeInteger(value.measuredAt) || value.measuredAt < 1) return undefined;
  return { milliseconds: value.milliseconds, width: value.width, height: value.height, measuredAt: value.measuredAt };
}
// Enabled rows without their identities: a preset applied to a game keeps
// running the same chain while these are equal.
const chain = plan => JSON.stringify((plan?.video || []).filter(row => row.enabled !== false).map(({ id, enabled, ...row }) => row));
// One context's total: each row's own GPU interval plus each shared command
// buffer once. Every enabled row must report a measurement.
function chainCost(stages, ids) {
  let total = 0;const sections = new Map();
  for (const id of ids) {
    const gpu = stages.find(stage => stage.id === id)?.gpu;if (!gpu) return null;
    if (gpu.scope === "row") total += gpu.milliseconds;else sections.set(gpu.section, Math.max(sections.get(gpu.section) || 0, gpu.milliseconds));
  }
  for (const value of sections.values()) total += value;
  return total > 0 ? Math.round(total * 100) / 100 : null;
}
// Records a running game's measured chain cost on every preset with the same
// rows. A recent value at the same image size is kept, so status reads do not
// rewrite the library each time. Returns whether a preset changed.
function recordCost(root, plan, contexts, now = Date.now()) {
  const ids = (plan?.video || []).filter(row => row.enabled !== false).map(row => row.id);
  if (!ids.length || !Array.isArray(contexts)) return false;
  for (const context of contexts) {
    if (context.identityState !== "matching" || context.historical) continue;
    const milliseconds = chainCost(context.stages || [], ids);if (milliseconds == null) continue;
    const cost = measuredCost({ milliseconds, width: context.input?.width, height: context.input?.height, measuredAt: now });if (!cost) continue;
    const signature = chain(plan), { rows, retained } = stored(root);let changed = false;
    const next = rows.map(row => {
      if (chain(row.plan) !== signature) return row;
      const previous = measuredCost(row.raw.measuredCost);
      if (previous && previous.width === cost.width && previous.height === cost.height && now - previous.measuredAt < 30000) return row;
      changed = true;return Object.defineProperty({ ...row, measuredCost: cost }, "raw", { value: { ...row.raw, measuredCost: cost } });
    });
    if (changed) write(root, next, retained);
    return changed;
  }
  return false;
}
function find(rows, id, updatedAt) {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Choose a graphics preset.");
  const index = rows.findIndex(row => row.id === id);
  if (index < 0) throw new Error("The graphics preset was removed. Reload the preset library.");
  if (updatedAt !== rows[index].updatedAt) throw new Error("The graphics preset changed in another window. Reload it before saving.");
  return index;
}
function save(root, value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["id", "name", "plan", "updatedAt"].includes(key)))
    throw new Error("Choose a preset name and Advanced effects chain.");
  const { rows, retained } = stored(root), index = value.id == null ? -1 : find(rows, value.id, value.updatedAt), nextName = name(value.name);
  if (rows.some((row, i) => i !== index && nameKey(row.name) === nameKey(nextName))) throw new Error("A graphics preset with this name already exists.");
  const row = { id: index < 0 ? crypto.randomUUID() : rows[index].id, name: nextName,
    updatedAt: Math.max(Date.now(), index < 0 ? 1 : rows[index].updatedAt + 1), plan: Plan.migrate(value.plan) };
  if (index < 0) rows.push(row);else rows[index] = row;
  write(root, rows, retained);return row;
}
function remove(root, id, updatedAt) {
  const { rows, retained } = stored(root), index = find(rows, id, updatedAt);
  rows.splice(index, 1);return write(root, rows, retained);
}
module.exports = { LIMITS, location, list: read, notices, save, remove, recordCost };

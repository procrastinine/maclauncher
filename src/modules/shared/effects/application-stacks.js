const fs = require("node:fs"), path = require("node:path");
const Writable = require("../writable-input");
const { readJsonDocument } = require("../../../core/json-files");

// The graphics stack of each app or display that received window graphics:
// its plan and its capture settings. A session starts from its stack and
// saves the stack back when it ends. The file holds JSON settings only and stays
// bounded: a stack equal to the default is not stored, the least recently
// used app goes first beyond 50 apps or 2 MiB, a stack over 64 KiB is not
// saved, and apps that are no longer installed are removed.
const LIMITS = Object.freeze({ apps: 50, stackBytes: 64 * 1024, fileBytes: 2 * 1024 * 1024 });
// An unchanged stack refreshes its last use at most once a day.
const REFRESH_MS = 24 * 60 * 60 * 1000;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validName = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);

function location(root) {
  if (!path.isAbsolute(root || "")) throw new Error("Application stacks require the application's data directory.");
  return path.join(root, "graphics", "application-stacks.json");
}
// Bundle identifier, else executable path and name for a process without a
// bundle. A display by its stable identifier, else its name; All Displays
// has one stack.
function key(identity) {
  if (identity?.target === "all-displays") return "all-displays";
  if (identity?.target === "display")
    return validName(identity.uuid) ? "display:" + identity.uuid : validName(identity.name) ? "display-name:" + identity.name : null;
  if (validName(identity?.bundleIdentifier)) return "bundle:" + identity.bundleIdentifier;
  if (path.isAbsolute(identity?.executablePath || "") && validName(identity.name)) return "executable:" + JSON.stringify([identity.executablePath, identity.name]);
  return null;
}
function settingsValue(value) {
  if (!object(value)) return null;
  const entries = Object.entries(value).filter(([name, item]) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) && ["boolean", "number", "string"].includes(typeof item));
  return entries.length ? Object.fromEntries(entries) : null;
}
function stored(root) {
  const file = location(root);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > LIMITS.fileBytes) return {};
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data?.schema === 1 && object(data.stacks) ? data.stacks : {};
  } catch { return {}; }
}
// The saved stack for an app, or null. A plan that cannot be read is left out.
function lookup(root, identity, { prepareEffects = value => value } = {}) {
  const name = key(identity), stacks = name ? stored(root) : {}, value = Object.hasOwn(stacks, name) ? stacks[name] : null;
  if (!object(value)) return null;
  const StoredPlan = require("./stored-plan"), inspected = value.effects == null ? null : StoredPlan.inspect(prepareEffects(value.effects));
  const effects = inspected && !inspected.error ? StoredPlan.serialize(inspected.plan) : null, runtimeSettings = settingsValue(value.runtimeSettings);
  return effects || runtimeSettings ? { ...(effects ? { effects } : {}), ...(runtimeSettings ? { runtimeSettings } : {}) } : null;
}
function write(root, stacks) {
  Writable.assertOwnDirectory(root, path.dirname(location(root)));
  Writable.atomicWrite(location(root), JSON.stringify({ schema: 1, stacks }, null, 2) + "\n", { root });
}
function readForUpdate(root, logger) {
  const value = readJsonDocument(location(root), { onPreserved: copy => logger?.warn?.("[graphics] Unreadable application stacks were kept as", copy) });
  return value?.schema === 1 && object(value.stacks) ? { ...value.stacks } : {};
}
// Saves an app's stack: "saved", "removed", "unchanged", "too-large" or
// "skipped" (no identity).
function save(root, identity, { effects, runtimeSettings } = {}, { now = Date.now(), logger } = {}) {
  const name = key(identity);
  if (!name) return "skipped";
  const StoredPlan = require("./stored-plan");
  const inspected = effects == null ? null : StoredPlan.inspect(effects);
  const plan = inspected && !inspected.error ? inspected.plan : null;
  const settings = settingsValue(runtimeSettings);
  const isDefault = (!plan || StoredPlan.canonical(plan) === StoredPlan.canonical(StoredPlan.read({}).plan)) && !settings;
  const stacks = readForUpdate(root, logger), previous = stacks[name];
  if (isDefault) {
    if (!Object.hasOwn(stacks, name)) return "unchanged";
    delete stacks[name];write(root, stacks);
    return "removed";
  }
  const value = { usedAt: now, ...(plan ? { effects: StoredPlan.serialize(plan) } : {}), ...(settings ? { runtimeSettings: settings } : {}) };
  if (Buffer.byteLength(JSON.stringify(value)) > LIMITS.stackBytes) return "too-large";
  const content = item => StoredPlan.canonical({ effects: item?.effects, runtimeSettings: item?.runtimeSettings });
  if (object(previous) && content(previous) === content(value) && Number.isFinite(previous.usedAt) && now - previous.usedAt < REFRESH_MS) return "unchanged";
  stacks[name] = value;
  const order = Object.keys(stacks).filter(item => item !== name)
    .sort((a, b) => (Number(stacks[a]?.usedAt) || 0) - (Number(stacks[b]?.usedAt) || 0));
  while (order.length && (Object.keys(stacks).length > LIMITS.apps ||
    Buffer.byteLength(JSON.stringify({ schema: 1, stacks }, null, 2)) + 1 > LIMITS.fileBytes)) delete stacks[order.shift()];
  write(root, stacks);
  return "saved";
}
function bundleIdentifiers(root) {
  return Object.keys(stored(root)).filter(name => name.startsWith("bundle:")).map(name => name.slice(7));
}
// Removes the stacks of apps that are no longer installed. `installed` maps
// bundle identifiers to the helper's offline answer.
function prune(root, installed = {}, { exists = fs.existsSync, logger } = {}) {
  const current = stored(root);
  const removed = Object.keys(current).filter(name => {
    if (name.startsWith("bundle:")) return installed[name.slice(7)] === false;
    if (!name.startsWith("executable:")) return false;
    try { return !exists(JSON.parse(name.slice(11))[0]); } catch { return true; }
  });
  if (!removed.length) return [];
  const stacks = readForUpdate(root, logger);
  for (const name of removed) delete stacks[name];
  write(root, stacks);
  return removed;
}

module.exports = { LIMITS, location, key, lookup, save, prune, bundleIdentifiers };

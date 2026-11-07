// Translator environments. A translator (a Wine runtime, a Direct3D translator,
// a Vulkan driver, an Android execution engine and so on) declares the
// environment variables it reads, the variables the launcher must set itself
// and its global defaults. The global value applies to every game that uses
// the translator, and a game's own value replaces, adds or removes variables
// for that game only. Values are literal text: no shell expansion, quoting or
// substitution is applied. Main, the backend and the renderer share this file.

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;
export const LIMITS = Object.freeze({ entries: 256, name: 256, value: 32768 });
export const SOURCES = Object.freeze(["default", "global", "game"]);
const isRecord = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const text = (value, limit = 4096) => typeof value === "string" && value.length <= limit ? value : "";

export function isVariableName(name) {
  return typeof name === "string" && name.length <= LIMITS.name && NAME.test(name);
}
export function isVariableValue(value) {
  return typeof value === "string" && value.length <= LIMITS.value && !/[\0\r\n]/.test(value);
}
export function isTranslatorId(id) {
  return typeof id === "string" && id.length <= 64 && ID.test(id);
}

// A declaration is data. Unknown fields are ignored, and a malformed key,
// lock or default is a programming error in the declaring module.
export function normalizeDeclaration(input) {
  if (!isRecord(input) || !isTranslatorId(input.id)) throw new TypeError("A translator environment needs an id.");
  if (!text(input.label, 128)) throw new TypeError(`Translator environment ${input.id} needs a label.`);
  const locked = (Array.isArray(input.locked) ? input.locked : []).map(rule => {
    const key = rule?.key, prefix = rule?.prefix;
    if ((key === undefined) === (prefix === undefined) || key !== undefined && !isVariableName(key) ||
        prefix !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix) || !text(rule.reason, 512))
      throw new TypeError(`Translator environment ${input.id} has an invalid locked variable.`);
    return Object.freeze(key !== undefined ? { key, reason: rule.reason } : { prefix, reason: rule.reason });
  });
  const lockedBy = name => locked.find(rule => rule.key === name || rule.prefix && name.startsWith(rule.prefix)) || null;
  const keys = (Array.isArray(input.keys) ? input.keys : []).map(item => {
    if (!isVariableName(item?.key) || !text(item.description, 512)) throw new TypeError(`Translator environment ${input.id} has an invalid variable.`);
    if (lockedBy(item.key)) throw new TypeError(`Translator environment ${input.id} lists locked variable ${item.key}.`);
    return Object.freeze({ key: item.key, description: item.description,
      ...(text(item.launcher, 512) ? { launcher: item.launcher } : {}) });
  });
  if (new Set(keys.map(item => item.key)).size !== keys.length) throw new TypeError(`Translator environment ${input.id} lists a variable twice.`);
  const defaults = {};
  for (const [name, value] of Object.entries(isRecord(input.defaults) ? input.defaults : {})) {
    if (!isVariableName(name) || !isVariableValue(value) || lockedBy(name)) throw new TypeError(`Translator environment ${input.id} has an invalid default.`);
    defaults[name] = value;
  }
  return Object.freeze({ id: input.id, label: input.label,
    ...(text(input.description, 1024) ? { description: input.description } : {}),
    managerIds: Object.freeze((Array.isArray(input.managerIds) ? input.managerIds : []).filter(id => typeof id === "string" && id)),
    keys: Object.freeze(keys), locked: Object.freeze(locked), defaults: Object.freeze(defaults) });
}

export function lockedRule(declarations, name) {
  for (const declaration of declarations || []) for (const rule of declaration?.locked || [])
    if (rule.key === name || rule.prefix && typeof name === "string" && name.startsWith(rule.prefix)) return rule;
  return null;
}
export function knownVariable(declaration, name) {
  return declaration?.keys?.find(item => item.key === name) || null;
}

// Values edited in the UI or received over IPC. A null value removes a
// variable inherited from a lower layer. Invalid input throws with a message
// that names the variable.
export function normalizeValues(values, { declarations = [] } = {}) {
  if (values == null) return {};
  if (!isRecord(values)) throw new Error("Environment variables must be pairs of a name and a value.");
  const entries = Object.entries(values);
  if (entries.length > LIMITS.entries) throw new Error(`A translator environment holds at most ${LIMITS.entries} variables.`);
  const result = {};
  for (const [name, value] of entries) {
    if (!isVariableName(name)) throw new Error(`${name || "An empty name"} is not a valid variable name. Names use letters, digits and underscores, and do not start with a digit.`);
    const rule = lockedRule(declarations, name);
    if (rule) throw new Error(`${name} is set by MacLauncher. ${rule.reason}`);
    if (value !== null && !isVariableValue(value)) throw new Error(`The value of ${name} must be one line of text.`);
    result[name] = value;
  }
  return result;
}

// Stored values are read leniently: an entry that is not a valid name and a
// one-line text value (or null) is left out, and the other entries apply.
export function readValues(values) {
  if (!isRecord(values)) return {};
  const result = {};
  for (const [name, value] of Object.entries(values).slice(0, LIMITS.entries))
    if (isVariableName(name) && (value === null || isVariableValue(value))) result[name] = value;
  return result;
}
export function readStore(store) {
  if (!isRecord(store)) return {};
  const result = {};
  for (const [id, values] of Object.entries(store)) if (isTranslatorId(id) && isRecord(values)) result[id] = readValues(values);
  return result;
}
// A store with one translator's values replaced; empty values remove the entry.
export function withValues(store, id, values) {
  if (!isTranslatorId(id)) throw new Error("Unknown translator.");
  const next = readStore(store);
  const normalized = readValues(values);
  if (Object.keys(normalized).length) next[id] = normalized;
  else delete next[id];
  return next;
}

// The layers of one translator, lowest first.
function layers(declaration, { global, game } = {}) {
  return [["default", declaration.defaults || {}], ["global", readValues(global)], ["game", readValues(game)]];
}
function applyLayer(target, values, skip, source, sources) {
  for (const [name, value] of Object.entries(values)) {
    if (skip(name)) continue;
    if (value === null) { delete target[name]; if (sources) delete sources[name]; }
    else { target[name] = value; if (sources) sources[name] = source; }
  }
}

// The effective values of one translator up to and including `through`.
export function effectiveValues(declaration, values = {}, { through = "game" } = {}) {
  const result = {}, sources = {};
  const skip = name => Boolean(lockedRule([declaration], name));
  for (const [source, layer] of layers(declaration, values)) {
    applyLayer(result, layer, skip, source, sources);
    if (source === through) break;
  }
  return { values: result, sources };
}

// Rows for an editor at one scope. Inherited rows come from the layers below
// the scope, and `own` holds the values stored at the scope itself.
export function editorRows(declaration, { scope = "global", global, game } = {}) {
  const below = scope === "game" ? effectiveValues(declaration, { global }, { through: "global" })
    : effectiveValues(declaration, {}, { through: "default" });
  const ownValues = readValues(scope === "game" ? game : global);
  const names = [...Object.keys(below.values), ...Object.keys(ownValues).filter(name => !own(below.values, name))];
  return names.map(name => {
    const inherited = own(below.values, name), changed = own(ownValues, name);
    const value = changed ? ownValues[name] : below.values[name];
    return { name, value, state: !changed ? "inherited" : value === null ? "removed" : inherited ? "changed" : "added",
      ...(inherited ? { inheritedValue: below.values[name], inheritedSource: below.sources[name] } : {}),
      known: knownVariable(declaration, name), locked: lockedRule([declaration], name) };
  });
}

// The translators of one runtime manager. The runtime's own translator, whose
// id is the manager id, comes first.
export function managerDeclarations(declarations, managerId) {
  const listed = (declarations || []).filter(item => item?.managerIds?.includes(managerId));
  return [...listed.filter(item => item.id === managerId), ...listed.filter(item => item.id !== managerId)];
}

// The blocks of Settings → Environment variables. A runtime's own translator,
// whose id is one of its manager ids, opens a block with the translators that
// run with it (managerDeclarations); every other translator has a block of its
// own. A translator is shown once, in the first block that lists it, and
// `companions` keeps the runtime's other translators, whose locks still apply
// to the runtime's own values (lockingDeclarations).
export function settingsBlocks(declarations) {
  const list = declarations || [], shown = new Set(), blocks = [];
  const block = (owner, group) => {
    const rows = group.filter(item => !shown.has(item.id));
    for (const item of rows) shown.add(item.id);
    blocks.push({ id: owner.id, label: owner.label, ...(owner.description ? { description: owner.description } : {}),
      declarations: rows, companions: group.filter(item => !rows.includes(item)) });
  };
  for (const item of list) if (item?.managerIds?.includes(item.id) && !shown.has(item.id)) block(item, managerDeclarations(list, item.id));
  for (const item of list) if (item?.id && !shown.has(item.id)) block(item, [item]);
  return blocks;
}

// The translator that stores a variable in a table of `declarations`, the
// runtime's own translator first: the translator that already lists the name
// at this scope, then the translator that suggests it, and otherwise the
// runtime's own translator, which applies to every game the runtime launches.
export function variableOwner(declarations, name, { scope = "global", global, game } = {}) {
  const list = declarations || [];
  return list.find(declaration => editorRows(declaration, { scope, global: readStore(global)[declaration.id], game: readStore(game)[declaration.id] })
    .some(row => row.name === name)) || list.find(declaration => knownVariable(declaration, name)) || list[0] || null;
}

// The translators whose locks apply to a variable stored for `declaration`.
// A game's translators all run together, and the runtime's own translator
// runs with each of the others, so their locks apply too. At global scope a
// translator's own variables only follow its own locks, because the other
// translators on the tab, such as the JVM and ART execution engines, need not
// run with it.
export function lockingDeclarations(declarations, declaration, { scope = "global" } = {}) {
  const list = declarations || [];
  return scope === "game" || !declaration || declaration.id === list[0]?.id ? list : [declaration];
}

// The values a launch adds for the chosen translators, in the order the
// consumer lists them. Every layer is applied across all chosen translators
// before the next layer, so a game's value replaces a global or default value
// whichever translator declares it. Variables locked by any chosen
// translator are never taken from these values.
export function launchValues(declarations, ids, { global, game } = {}) {
  const byId = new Map((declarations || []).map(item => [item.id, item]));
  const chosen = [...new Set(ids || [])].map(id => byId.get(id)).filter(Boolean);
  const skip = name => Boolean(lockedRule(chosen, name));
  const globalStore = readStore(global), gameStore = readStore(game);
  const values = {}, sources = {};
  for (const source of SOURCES) for (const declaration of chosen) {
    const layer = source === "default" ? declaration.defaults : source === "global" ? globalStore[declaration.id] : gameStore[declaration.id];
    applyLayer(values, layer || {}, skip, declaration.id, sources);
  }
  return { values, translators: chosen.map(item => item.id), sources };
}

// Variables in `values` that the consumer may set. A consumer passes its own
// required names, and each one stays with the launcher's value.
export function applyEnvironment(environment, values, { required = [] } = {}) {
  const keep = new Set(required);
  const result = { ...environment };
  for (const [name, value] of Object.entries(values || {})) if (!keep.has(name)) result[name] = value;
  return result;
}

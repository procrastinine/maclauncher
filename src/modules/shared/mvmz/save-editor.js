const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { decodeSave, encodeSave } = require("./rpgmaker-save");
const { writeSaveWithBackup } = require("../save-files");

const LIMITS = Object.freeze({ encodedBytes: 16 * 1024 * 1024, jsonBytes: 64 * 1024 * 1024,
  databaseBytes: 8 * 1024 * 1024, nodes: 1000000, depth: 128, index: 100000,
  changes: 1000, stringLength: 1024 * 1024 });
const ACTOR_FIELDS = Object.freeze({ hp: ["_hp", "HP", 0], mp: ["_mp", "MP", 0],
  tp: ["_tp", "TP", 0], level: ["_level", "Level", 1] });
const CATEGORIES = ["items", "weapons", "armors"];
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const scalar = value => value === null || ["string", "boolean", "number"].includes(typeof value);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const utf8 = bytes => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

function validateTree(data) {
  const stack = [{ value: data, depth: 0 }];
  const visited = new Set();
  let count = 0;
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (++count > LIMITS.nodes || depth > LIMITS.depth) throw new Error("Save structure exceeds limits");
    if (value === null || typeof value !== "object") {
      if (!scalar(value)) throw new Error("Save contains a non-JSON value");
      continue;
    }
    if (visited.has(value)) throw new Error("Use serialized JsonEx references, not JavaScript object cycles");
    visited.add(value);
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) {
      throw new Error("Save contains an unsupported object type");
    }
    if (Array.isArray(value) && value.length > LIMITS.index) throw new Error("Save array exceeds index limit");
    for (const key of Object.keys(value)) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!own(desc, "value")) throw new Error("Save accessors are unsupported");
      stack.push({ value: desc.value, depth: depth + 1 });
    }
  }
  if (!record(data)) throw new Error("Save contents must be an object");
}

// Track token spans without decoding JsonEx or constructing game classes. This
// also rejects duplicate JSON keys, which would make a patch target ambiguous.
function parseDocument(json) {
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > LIMITS.jsonBytes) {
    throw new Error("Save JSON exceeds size limit");
  }
  const data = JSON.parse(json);
  validateTree(data);
  const spans = new WeakMap();
  const ends = new WeakMap();
  let cursor = 0;
  const whitespace = () => { while (/[\t\n\r ]/.test(json[cursor] || "x")) cursor += 1; };
  function stringEnd() {
    cursor += 1;
    while (cursor < json.length) {
      if (json[cursor] === "\\") cursor += 2;
      else if (json[cursor++] === '"') return;
    }
    throw new Error("Unterminated JSON string");
  }
  function scan(value) {
    whitespace();
    const start = cursor;
    if (value !== null && typeof value === "object") {
      const array = Array.isArray(value);
      cursor += 1;
      whitespace();
      const properties = new Map();
      let index = 0;
      while (json[cursor] !== (array ? "]" : "}")) {
        let key;
        if (array) key = String(index++);
        else {
          const keyStart = cursor;
          stringEnd();
          key = JSON.parse(json.slice(keyStart, cursor));
          if (properties.has(key)) throw new Error("Duplicate JSON keys are unsupported");
          whitespace();
          cursor += 1; // colon, already checked by JSON.parse
        }
        properties.set(key, scan(value[key]));
        whitespace();
        if (json[cursor] !== ",") break;
        cursor += 1;
        whitespace();
      }
      ends.set(value, cursor);
      spans.set(value, properties);
      cursor += 1;
    } else if (json[cursor] === '"') stringEnd();
    else while (cursor < json.length && !/[\t\n\r ,\]}]/.test(json[cursor])) cursor += 1;
    return { start, end: cursor };
  }
  scan(data);
  return { data, spans, ends };
}

function parseSaveData(json) { return parseDocument(json).data; }

function createGraph(data) {
  validateTree(data);
  const identities = new Map();
  const locations = new WeakMap();
  const stack = [data];
  let ordinal = 0;
  while (stack.length) {
    const value = stack.pop();
    if (value === null || typeof value !== "object") continue;
    locations.set(value, ordinal++);
    if (own(value, "@c")) {
      const id = value["@c"];
      if (!Number.isSafeInteger(id) || id < 1 || identities.has(id)) {
        throw new Error("Invalid or duplicate JsonEx identity marker");
      }
      identities.set(id, value);
    }
    for (const key of Object.keys(value)) if (value[key] !== null && typeof value[key] === "object") stack.push(value[key]);
  }
  function resolve(value) {
    const seen = new Set();
    while (record(value) && (own(value, "@r") || own(value, "@a"))) {
      if (seen.has(value)) throw new Error("Circular JsonEx container reference");
      seen.add(value);
      if (own(value, "@r")) {
        const target = identities.get(value["@r"]);
        if (!target) throw new Error("Unresolved JsonEx reference");
        value = target;
      } else {
        if (!Array.isArray(value["@a"])) throw new Error("Unsupported JsonEx array wrapper");
        value = value["@a"];
      }
    }
    return value;
  }
  return { resolve, locations };
}

function labels(database, category) { return Array.isArray(database?.[category]) ? database[category] : []; }
function nameFor(database, category, id, fallback) {
  const row = labels(database, category)[id];
  const value = typeof row === "string" ? row : row?.name;
  return typeof value === "string" && value.trim() ? value : `${fallback} ${id}`;
}
function hasLabel(database, category, id) {
  const list = labels(database, category);
  return id < list.length && (category === "switches" || category === "variables" || record(list[id]));
}
function positiveId(id) {
  if (!Number.isSafeInteger(id) || id < 1 || id >= LIMITS.index) throw new Error("Invalid field ID");
  return id;
}
function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Value must be a safe integer of at least ${minimum}`);
}
function scalarEditable(value) {
  return scalar(value) && (typeof value !== "number" || Number.isFinite(value));
}
function containers(data, graph) {
  function objectField(value, key, array = false) {
    value = graph.resolve(value);
    if (!record(value) || !own(value, key)) return null;
    const resolved = graph.resolve(value[key]);
    return (array ? Array.isArray(resolved) : record(resolved)) ? resolved : null;
  }
  return { switches: objectField(data.switches, "_data", true), variables: objectField(data.variables, "_data", true),
    party: record(graph.resolve(data.party)) ? graph.resolve(data.party) : null,
    actors: objectField(data.actors, "_data", true), objectField };
}

function inspectSaveData(data, database = {}) {
  const graph = createGraph(data);
  const warnings = [...(database.warnings || [])];
  let parts;
  try { parts = containers(data, graph); }
  catch (error) {
    return { sections: { switches: [], variables: [], gold: null, inventory: { items: [], weapons: [], armors: [] }, actors: [] },
      warnings: [...warnings, error.message] };
  }
  const sections = { switches: [], variables: [], gold: null, inventory: { items: [], weapons: [], armors: [] }, actors: [] };
  for (const category of ["switches", "variables"]) {
    const list = parts[category];
    if (!list) { warnings.push(`Unsupported or missing ${category} data`); continue; }
    const length = Math.max(list.length, labels(database, category).length);
    if (length > LIMITS.index) throw new Error("Database exceeds index limit");
    for (let id = 1; id < length; id += 1) {
      const stored = own(list, id) ? list[id] : null;
      const editable = category === "switches" ? stored === null || typeof stored === "boolean" : scalarEditable(stored);
      const value = stored === null ? (category === "switches" ? false : 0) : stored;
      sections[category].push({ id, name: nameFor(database, category, id, category === "switches" ? "Switch" : "Variable"),
        value: editable ? value : null, valueType: editable ? typeof value : "object", editable,
        ...(!editable ? { reason: "Serialized objects and special values are read-only" } : {}) });
    }
  }
  const party = parts.party;
  if (party && own(party, "_gold")) {
    const value = party._gold;
    const editable = Number.isSafeInteger(value) && value >= 0;
    sections.gold = { value: editable ? value : null, editable,
      ...(!editable ? { reason: "Gold has an unsupported representation" } : {}) };
  } else warnings.push("Unsupported or missing party gold");
  for (const category of CATEGORIES) {
    let counts;
    try { counts = parts.objectField(party, `_${category}`); }
    catch (error) { warnings.push(`${category}: ${error.message}`); continue; }
    if (!counts) { warnings.push(`Unsupported or missing ${category} inventory`); continue; }
    const ids = new Set();
    for (const key of Object.keys(counts)) if (/^[1-9]\d*$/.test(key) && Number(key) < LIMITS.index) ids.add(Number(key));
    labels(database, category).forEach((entry, id) => { if (id > 0 && record(entry)) ids.add(id); });
    for (const id of [...ids].sort((a, b) => a - b)) {
      positiveId(id);
      const value = own(counts, id) ? counts[id] : 0;
      const editable = Number.isSafeInteger(value) && value >= 0;
      sections.inventory[category].push({ id, name: nameFor(database, category, id, category.slice(0, -1)),
        value: editable ? value : null, editable, ...(!editable ? { reason: "Inventory entry has an unsupported representation" } : {}) });
    }
  }
  if (parts.actors) for (let index = 1; index < parts.actors.length; index += 1) {
    let actor;
    try { actor = graph.resolve(parts.actors[index]); }
    catch (error) { warnings.push(`Actor ${index}: ${error.message}`); continue; }
    if (!record(actor)) continue;
    if (own(actor, "_actorId") && actor._actorId !== index) { warnings.push(`Actor ${index} has a mismatched ID`); continue; }
    const fields = Object.entries(ACTOR_FIELDS).filter(([, [key]]) => own(actor, key)).map(([key, [storedKey, label, minimum]]) => {
      const value = actor[storedKey];
      const editable = Number.isSafeInteger(value) && value >= minimum;
      return { key, label, value: editable ? value : null, editable,
        ...(!editable ? { reason: "Actor value has an unsupported representation" } : {}) };
    });
    sections.actors.push({ id: index, name: typeof actor._name === "string" && actor._name.trim()
      ? actor._name : nameFor(database, "actors", index, "Actor"), fields });
  }
  if (!sections.switches.length && !sections.variables.length && !sections.gold && !sections.actors.length) {
    warnings.push("This file may be configuration, global save information, or a plugin-specific save");
  }
  if (sections.actors.some(actor => actor.fields.some(field => field.key === "level"))) {
    warnings.push("Actor edits change stored values only; game logic may recalculate HP, MP, TP, or level. Level edits do not update experience.");
  }
  return { sections, warnings };
}

function collectChanges(data, changes, database) {
  if (!Array.isArray(changes) || changes.length > LIMITS.changes) throw new Error("Invalid or excessive save changes");
  const graph = createGraph(data);
  const parts = containers(data, graph);
  const operations = [];
  const targets = new Set();
  for (const change of changes) {
    if (!record(change)) throw new Error("Invalid save change");
    let container;
    let key;
    const value = change.value;
    if (change.kind === "switch" || change.kind === "variable") {
      const id = positiveId(change.id);
      const category = change.kind === "switch" ? "switches" : "variables";
      container = parts[category];
      if (!container || (!own(container, id) && !hasLabel(database, category, id))) throw new Error("Unknown switch or variable ID");
      const previous = own(container, id) ? container[id] : null;
      if (change.kind === "switch") {
        if ((previous !== null && typeof previous !== "boolean") || typeof value !== "boolean") throw new Error("Switch values must be booleans");
      } else {
        if (!scalarEditable(previous) || !scalarEditable(value)) throw new Error("Only finite scalar variables can be edited");
        if (typeof value === "string" && value.length > LIMITS.stringLength) throw new Error("Variable string exceeds size limit");
      }
      key = String(id);
    } else if (change.kind === "gold") {
      container = parts.party;
      key = "_gold";
      if (!container || !own(container, key)) throw new Error("Missing party gold");
      integer(container[key]);
      integer(value);
    } else if (change.kind === "inventory") {
      const id = positiveId(change.id);
      if (!CATEGORIES.includes(change.category)) throw new Error("Unknown inventory category");
      container = parts.objectField(parts.party, `_${change.category}`);
      key = String(id);
      if (!container || (!own(container, key) && !hasLabel(database, change.category, id))) throw new Error("Unknown inventory ID");
      if (own(container, key)) integer(container[key]);
      integer(value);
    } else if (change.kind === "actor") {
      const id = positiveId(change.id);
      const field = ACTOR_FIELDS[change.field];
      if (!field || !parts.actors || !own(parts.actors, id)) throw new Error("Unknown actor or actor field");
      container = graph.resolve(parts.actors[id]);
      key = field[0];
      if (!record(container) || !own(container, key) || (own(container, "_actorId") && container._actorId !== id)) throw new Error("Unsupported actor data");
      integer(container[key], field[2]);
      integer(value, field[2]);
    } else throw new Error("Unknown save change kind");
    const target = `${graph.locations.get(container)}:${key}`;
    if (targets.has(target)) throw new Error("Duplicate changes to the same save field");
    targets.add(target);
    if (!own(container, key) || !Object.is(container[key], value)) operations.push({ container, key, value });
  }
  return operations;
}

function cloneTree(value) {
  if (value === null || typeof value !== "object") return value;
  const clone = Array.isArray(value) ? new Array(value.length) : {};
  for (const key of Object.keys(value)) Object.defineProperty(clone, key,
    { value: cloneTree(value[key]), writable: true, enumerable: true, configurable: true });
  return clone;
}
function assignOperation({ container, key, value }) {
  if (Array.isArray(container)) while (container.length < Number(key)) container.push(null);
  Object.defineProperty(container, key, { value, writable: true, enumerable: true, configurable: true });
}
function applySaveChanges(data, changes, database = {}) {
  validateTree(data);
  const clone = cloneTree(data);
  for (const operation of collectChanges(clone, changes, database)) assignOperation(operation);
  validateTree(clone);
  return clone;
}
function jsonScalar(value) { return Object.is(value, -0) ? "-0" : JSON.stringify(value); }
function applyJsonSaveChanges(json, changes, database = {}) {
  const document = parseDocument(json);
  const operations = collectChanges(document.data, changes, database);
  const patches = [];
  const additions = new Map();
  for (const operation of operations) {
    const span = document.spans.get(operation.container)?.get(operation.key);
    if (span) patches.push({ ...span, text: jsonScalar(operation.value) });
    else {
      const list = additions.get(operation.container) || [];
      list.push(operation);
      additions.set(operation.container, list);
    }
  }
  for (const [container, list] of additions) {
    let text;
    if (Array.isArray(container)) {
      const values = new Map(list.map(op => [Number(op.key), op.value]));
      const last = Math.max(...values.keys());
      const tokens = [];
      for (let index = container.length; index <= last; index += 1) tokens.push(values.has(index) ? jsonScalar(values.get(index)) : "null");
      text = (container.length ? "," : "") + tokens.join(",");
    } else text = (Object.keys(container).length ? "," : "") + list.map(op => `${JSON.stringify(op.key)}:${jsonScalar(op.value)}`).join(",");
    const end = document.ends.get(container);
    patches.push({ start: end, end, text });
  }
  let result = json;
  for (const patch of patches.sort((a, b) => b.start - a.start)) result = result.slice(0, patch.start) + patch.text + result.slice(patch.end);
  const expected = applySaveChanges(document.data, changes, database);
  if (!isDeepStrictEqual(parseSaveData(result), expected)) throw new Error("Edited save failed semantic verification");
  return { json: result, changed: operations.length };
}

function readBounded(filePath, maxBytes) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Save or database file is not a regular file within size limits");
    const data = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const read = fs.readSync(fd, data, offset, data.length - offset, null);
      if (!read) break;
      offset += read;
    }
    if (offset !== stat.size) throw new Error("File changed while reading");
    return data.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}
function loadDatabaseLabels(indexDir) {
  const database = { warnings: [] };
  if (!indexDir) { database.warnings.push("Game database unavailable; using save IDs"); return database; }
  const root = path.join(indexDir, "data");
  const files = { system: "System.json", actors: "Actors.json", items: "Items.json", weapons: "Weapons.json", armors: "Armors.json" };
  for (const [category, fileName] of Object.entries(files)) {
    try {
      const file = path.join(root, fileName);
      const realRoot = fs.realpathSync(root);
      const realFile = fs.realpathSync(file);
      const relative = path.relative(realRoot, realFile);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Database path escapes data directory");
      const parsed = JSON.parse(readBounded(file, LIMITS.databaseBytes).toString("utf8"));
      validateTree({ parsed });
      if (category === "system") {
        for (const key of ["switches", "variables"]) if (Array.isArray(parsed[key])) database[key] = parsed[key];
      } else if (Array.isArray(parsed)) database[category] = parsed;
      else throw new Error("Invalid database shape");
    } catch (error) { database.warnings.push(`${fileName} labels unavailable: ${error.code === "ENOENT" ? "file not found" : error.message}`); }
  }
  return database;
}
function resolveSavePath(entry, fileName, context = {}) {
  const saveDir = entry?.saveDirOverride || entry?.defaultSaveDir || context.saveDir;
  if (!saveDir) throw new Error("Save directory is unavailable");
  if (typeof fileName !== "string" || !fileName || fileName !== path.basename(fileName) || fileName.includes("\\") || [".", ".."].includes(fileName)) {
    throw new Error("Invalid save file name");
  }
  const realRoot = fs.realpathSync(saveDir);
  const filePath = path.join(realRoot, fileName);
  if (!fs.lstatSync(filePath).isFile()) throw new Error("Save target must be a regular file");
  return filePath;
}
function inspection(engineId, fileName, bytes, database) {
  const json = decodeSave(engineId, utf8(bytes), { maxOutputBytes: LIMITS.jsonBytes });
  return { engineId, fileName, sourceHash: hash(bytes), ...inspectSaveData(parseSaveData(json), database) };
}
function inspectStructuredSave(engineId, entry, { fileName } = {}, context = {}) {
  const filePath = resolveSavePath(entry, fileName, context);
  const database = loadDatabaseLabels(entry?.indexDir || (entry?.indexHtml ? path.dirname(entry.indexHtml) : entry?.contentRootDir));
  return inspection(engineId, fileName, readBounded(filePath, LIMITS.encodedBytes), database);
}
async function editStructuredSave(engineId, entry, { fileName, expectedHash, changes } = {}, context = {}) {
  context.assertSaveWriteAllowed?.();
  if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("A valid source hash is required");
  const filePath = resolveSavePath(entry, fileName, context);
  const original = readBounded(filePath, LIMITS.encodedBytes);
  if (hash(original) !== expectedHash) throw new Error("Save changed since inspection; reload it before editing");
  const database = loadDatabaseLabels(entry?.indexDir || (entry?.indexHtml ? path.dirname(entry.indexHtml) : entry?.contentRootDir));
  const json = decodeSave(engineId, utf8(original), { maxOutputBytes: LIMITS.jsonBytes });
  const edited = applyJsonSaveChanges(json, changes, database);
  if (!edited.changed) return { ...inspection(engineId, fileName, original, database), changed: 0, backupPath: null };
  const encoded = encodeSave(engineId, edited.json);
  const replacement = Buffer.from(encoded, "utf8");
  if (replacement.length > LIMITS.encodedBytes) throw new Error("Encoded save exceeds size limit");
  if (decodeSave(engineId, encoded, { maxOutputBytes: LIMITS.jsonBytes }) !== edited.json) throw new Error("Edited save failed codec verification");
  if (hash(readBounded(filePath, LIMITS.encodedBytes)) !== expectedHash) throw new Error("Save changed during editing; reload it before editing");
  const snapshot = await context.snapshotSaves?.({ reason: "structured-edit" });
  context.assertSaveWriteAllowed?.();
  if (hash(readBounded(filePath, LIMITS.encodedBytes)) !== expectedHash) throw new Error("Save changed during backup; reload it before editing");
  writeSaveWithBackup(filePath, encoded, { expectedHash });
  return { ...inspection(engineId, fileName, replacement, database), changed: edited.changed,
    backupPath: `${filePath}.maclauncher.bak`, ...(snapshot ? { snapshotId: snapshot.snapshotId || snapshot.id || snapshot } : {}) };
}

module.exports = { LIMITS, parseSaveData, inspectSaveData, applySaveChanges, applyJsonSaveChanges,
  loadDatabaseLabels, inspectStructuredSave, editStructuredSave };

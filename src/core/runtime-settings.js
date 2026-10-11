const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("./json-files");

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function resolveRuntimeSettingsSchema(moduleInfo, runtimeId) {
  const entries = isRecord(moduleInfo?.runtime?.entries) ? moduleInfo.runtime.entries : {};
  const entry = isRecord(entries[runtimeId]) ? entries[runtimeId] : null;
  if (!isRecord(entry?.settings)) return null;
  const fields = Array.isArray(entry.settings.fields) ? entry.settings.fields.filter(isRecord) : [];
  return fields.length ? { ...entry.settings, fields } : null;
}

function resolveRuntimeSettingFallback(field) {
  if (!isRecord(field)) return null;
  if (Object.prototype.hasOwnProperty.call(field, "default")) return field.default;
  const type = typeof field.type === "string" ? field.type : "string";
  if (type === "boolean") return false;
  if (type === "number") return 0;
  if (type === "list") return [];
  return "";
}

function normalizeListValue(value) {
  if (Array.isArray(value)) {
    return value.map(entry => String(entry ?? "").trim()).filter(entry => entry.length > 0);
  }
  if (typeof value === "string") {
    return value.split(/\r?\n|,/).map(entry => entry.trim()).filter(entry => entry.length > 0);
  }
  return [];
}

function normalizeRuntimeSettingValue(field, value, fallback) {
  const type = typeof field?.type === "string" ? field.type : "string";
  if (type === "boolean") {
    if (value === true || value === false) return value;
    return fallback === true || fallback === false ? fallback : false;
  }
  if (type === "number") {
    const num = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(num)) return num;
    const fb = typeof fallback === "number" ? fallback : Number(fallback);
    return Number.isFinite(fb) ? fb : 0;
  }
  if (type === "list") {
    return normalizeListValue(value === null || value === undefined ? fallback : value);
  }
  if (type === "select") {
    const options = Array.isArray(field.options) ? field.options : [];
    const values = options.map(opt => opt?.value ?? opt?.id)
      .filter(value => typeof value === "string" && value.length > 0);
    // Declarative migrations retain an explicit older preference when a field
    // grows additional options. Never coerce unknown values into an option.
    const aliases = Array.isArray(field.legacyValues) ? field.legacyValues : [];
    const migrated = aliases.find(alias => isRecord(alias) && Object.is(alias.value, value));
    if (typeof migrated?.replacement === "string" && values.includes(migrated.replacement)) return migrated.replacement;
    if (typeof value === "string" && values.includes(value)) return value;
    if (typeof fallback === "string" && values.includes(fallback)) return fallback;
    return values[0] || "";
  }
  if (typeof value === "string") return value;
  return typeof fallback === "string" ? fallback : "";
}

function buildRuntimeSettingsDefaults(schema) {
  if (!isRecord(schema)) return {};
  const base = isRecord(schema.defaults) ? schema.defaults : {};
  const out = {};
  for (const field of Array.isArray(schema.fields) ? schema.fields : []) {
    if (!isRecord(field) || typeof field.key !== "string" || !field.key) continue;
    const value = Object.prototype.hasOwnProperty.call(base, field.key) ? base[field.key] : undefined;
    out[field.key] = normalizeRuntimeSettingValue(field, value, resolveRuntimeSettingFallback(field));
  }
  return out;
}

function normalizeRuntimeSettings(schema, incoming, defaults) {
  if (!isRecord(schema)) return {};
  const base = isRecord(defaults) ? defaults : buildRuntimeSettingsDefaults(schema);
  const raw = isRecord(incoming) ? incoming : {};
  const out = {};
  for (const field of Array.isArray(schema.fields) ? schema.fields : []) {
    if (!isRecord(field) || typeof field.key !== "string" || !field.key) continue;
    const fallback = Object.prototype.hasOwnProperty.call(base, field.key)
      ? base[field.key] : resolveRuntimeSettingFallback(field);
    out[field.key] = normalizeRuntimeSettingValue(field, raw[field.key], fallback);
  }
  return out;
}

function mergeRuntimeSettingsMap(base, incoming) {
  const out = {};
  for (const source of [base, incoming]) {
    if (!isRecord(source)) continue;
    for (const [runtimeId, value] of Object.entries(source)) {
      if (!isRecord(value)) continue;
      out[runtimeId] = { ...out[runtimeId], ...value };
    }
  }
  return out;
}

// Pure resolution accepts already-read runtime defaults; the store supplies disk access.
function resolveModuleRuntimeSettings(settings, moduleId, moduleInfo, runtimeId, runtimeDefaults) {
  const schema = resolveRuntimeSettingsSchema(moduleInfo, runtimeId);
  if (!schema) return null;
  const modules = isRecord(settings?.modules) ? settings.modules : {};
  const moduleSettings = isRecord(modules[moduleId]) ? modules[moduleId] : {};
  const overrides = isRecord(moduleSettings.runtimeSettings) ? moduleSettings.runtimeSettings : {};
  return normalizeRuntimeSettings(schema, overrides[runtimeId], runtimeDefaults);
}

function resolveRuntimeSettingsForEntry(entry, settings, moduleInfo, runtimeId, runtimeDefaults) {
  const schema = resolveRuntimeSettingsSchema(moduleInfo, runtimeId);
  if (!schema) return null;
  // Metadata is authoritative, including for legacy entries whose moduleId is a fallback.
  const moduleId = [moduleInfo?.id, entry?.moduleId, entry?.engine]
    .find(value => typeof value === "string" && value.trim())?.trim() || "unknown";
  const defaults = resolveModuleRuntimeSettings(settings, moduleId, moduleInfo, runtimeId, runtimeDefaults);
  const overrides = isRecord(entry?.runtimeSettings) ? entry.runtimeSettings : {};
  return normalizeRuntimeSettings(schema, overrides[runtimeId], defaults);
}

function cloneSettings(settings) {
  return Object.fromEntries(Object.entries(settings).map(([key, value]) => [
    key, Array.isArray(value) ? [...value] : value
  ]));
}

/**
 * Owns a cache for one userData directory, independent of Electron and the registry.
 * Reads never create or rewrite files. Explicit writeDefaults(runtimeId, moduleInfo,
 * values) persists normalized values and preserves keys owned by other module schemas.
 * Resolution precedence: schema defaults, disk defaults, module overrides, game overrides.
 */
function createRuntimeSettingsStore({ userDataDir } = {}) {
  if (typeof userDataDir !== "string" || !userDataDir) {
    throw new TypeError("Missing userDataDir for runtime settings.");
  }
  const cache = new Map();

  function settingsPath(runtimeId) {
    return path.join(userDataDir, "runtimes", runtimeId, "settings.json");
  }

  function readStoredDefaults(runtimeId) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath(runtimeId), "utf8"));
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function readDefaults(runtimeId, moduleInfo) {
    if (!runtimeId) return null;
    const schema = resolveRuntimeSettingsSchema(moduleInfo, runtimeId);
    if (!schema) return null;
    let schemas = cache.get(runtimeId);
    if (!schemas) {
      schemas = new WeakMap();
      cache.set(runtimeId, schemas);
    }
    // resolveRuntimeSettingsSchema returns a copy; key on the original stable schema.
    const identity = moduleInfo.runtime.entries[runtimeId].settings;
    if (!schemas.has(identity)) {
      schemas.set(identity, normalizeRuntimeSettings(schema, readStoredDefaults(runtimeId)));
    }
    return cloneSettings(schemas.get(identity));
  }

  function writeDefaults(runtimeId, moduleInfo, values) {
    if (!runtimeId) return null;
    const schema = resolveRuntimeSettingsSchema(moduleInfo, runtimeId);
    if (!schema) return null;
    const stored = readStoredDefaults(runtimeId);
    const defaults = normalizeRuntimeSettings(schema, stored);
    const normalized = normalizeRuntimeSettings(schema, values, defaults);
    const filePath = settingsPath(runtimeId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeJsonAtomic(filePath, { ...stored, ...normalized });
    // A shared runtime may have several schemas: invalidate all of them after a write.
    cache.delete(runtimeId);
    return cloneSettings(normalized);
  }

  function resolveForModule(settings, moduleId, moduleInfo, runtimeId) {
    return resolveModuleRuntimeSettings(settings, moduleId, moduleInfo, runtimeId,
      readDefaults(runtimeId, moduleInfo));
  }

  function resolveForEntry(entry, settings, moduleInfo, runtimeId) {
    return resolveRuntimeSettingsForEntry(entry, settings, moduleInfo, runtimeId,
      readDefaults(runtimeId, moduleInfo));
  }

  return { readDefaults, writeDefaults, resolveForModule, resolveForEntry };
}

module.exports = {
  resolveRuntimeSettingsSchema,
  resolveRuntimeSettingFallback,
  normalizeListValue,
  normalizeRuntimeSettingValue,
  buildRuntimeSettingsDefaults,
  normalizeRuntimeSettings,
  mergeRuntimeSettingsMap,
  resolveModuleRuntimeSettings,
  resolveRuntimeSettingsForEntry,
  createRuntimeSettingsStore
};

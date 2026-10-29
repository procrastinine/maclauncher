const fs = require("node:fs");
const path = require("node:path");
const { readJsonDocument, writeJsonAtomic } = require("./json-files");
const { settingsUnreadable } = require("./settings-merge");
const { resolveRuntimeSettingFallback, normalizeListValue, normalizeRuntimeSettingValue } = require("./runtime-setting-values.mjs");

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

function buildRuntimeSettingsDefaults(schema) {
  if (!isRecord(schema)) return {};
  const base = isRecord(schema.defaults) ? schema.defaults : {};
  const out = {};
  for (const field of Array.isArray(schema.fields) ? schema.fields : []) {
    if (!isRecord(field) || typeof field.key !== "string" || !field.key || field.type === "display") continue;
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
    if (!isRecord(field) || typeof field.key !== "string" || !field.key || field.type === "display") continue;
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
  const resolved = normalizeRuntimeSettings(schema, overrides[runtimeId], runtimeDefaults);
  const explicitDefaults = buildRuntimeSettingsDefaults(schema);
  for (const field of schema.fields) if (field.gameOnly === true && field.type !== "display") resolved[field.key] = explicitDefaults[field.key];
  return resolved;
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

  function readStoredDefaults(runtimeId, onUnreadable) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath(runtimeId), "utf8"));
      if (isRecord(parsed)) return parsed;
      onUnreadable?.();
      return {};
    } catch (error) {
      if (error.code !== "ENOENT") onUnreadable?.();
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
      let unreadable = false;
      const stored = readStoredDefaults(runtimeId, () => {unreadable = true;});
      const normalized = normalizeRuntimeSettings(schema, stored);
      // A transient read or incomplete document is not a permanent default.
      // Retry only on the next ordinary read; valid and absent files stay cached.
      if (unreadable) return cloneSettings(normalized);
      schemas.set(identity, normalized);
    }
    return cloneSettings(schemas.get(identity));
  }

  function writeDefaults(runtimeId, moduleInfo, values) {
    if (!runtimeId) return null;
    const schema = resolveRuntimeSettingsSchema(moduleInfo, runtimeId);
    if (!schema) return null;
    // A stored document that cannot be read is never replaced with defaults.
    let stored;
    try { stored = readJsonDocument(settingsPath(runtimeId)) || {}; }
    catch (error) { throw settingsUnreadable(error); }
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

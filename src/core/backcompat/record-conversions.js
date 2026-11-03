// Backcompat: pre-current per-game network choices, boolean runtime choices and
// v0.4/schema-1 graphics records through 0.5.1. Converts on the once migration or
// initial record-format boundary, preserving Node/shortcut graphics behavior.
// Remove when these stored record formats are no longer supported.
const { convertLegacyRuntimeSettings } = require('./settings-conversions');
const failedWrites = new Map();
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const oldGraphics = record => Object.hasOwn(record, 'reshade') || Object.hasOwn(record, 'graphics') || record.effects?.schema === 1;
function moduleInfo(registry, id) {
  const info = registry?.getModuleInfo?.(id), mod = info || registry?.getModule?.(id);
  return mod?.manifest || mod;
}
function oldNetworkChoice(entry, runtimeId) {
  const legacy = entry.runtimeSettings?.[entry.runtimeId || runtimeId];
  if (typeof legacy?.networkIsolation === 'boolean') return !legacy.networkIsolation;
  if (typeof legacy?.enableProtections === 'boolean') return !legacy.enableProtections;
  return null;
}
function convertLegacyRecord(entry, { userDataDir, registry, logger = console, currentVersion } = {}) {
  if (!object(entry)) return entry;
  currentVersion ??= require('../game-store').CURRENT_RECORD_SCHEMA_VERSION;
  if (typeof entry.schemaVersion === 'number' && entry.schemaVersion >= currentVersion) return entry;
  let next = entry;
  const legacyNetwork = !Object.hasOwn(entry, 'networkAccess') && Object.values(entry.runtimeSettings || {}).some(value =>
    typeof value?.networkIsolation === 'boolean' || typeof value?.enableProtections === 'boolean');
  const choices = Object.values(entry.runtimeSettings || {}).some(value => object(value) && Object.values(value).some(item => typeof item === 'boolean'));
  if (legacyNetwork || choices) {
    registry ||= require('../../modules/registry');
    const info = moduleInfo(registry, entry.moduleId || entry.engine);
    const runtimeId = entry.runtimeId || info?.runtime?.default;
    if (legacyNetwork) {
      const value = oldNetworkChoice(entry, runtimeId);
      if (value !== null) next = {...next, networkAccess: value};
    }
    for (const [id, settings] of Object.entries(entry.runtimeSettings || {})) {
      const converted = convertLegacyRuntimeSettings(info, id, settings, registry);
      if (converted !== settings) next = {...next, runtimeSettings: {...next.runtimeSettings, [id]: converted}};
    }
  }
  if (oldGraphics(next)) next = require('./graphics-record-upgrade').convertGraphicsRecord(userDataDir, next, {registry});
  return {...next, schemaVersion: currentVersion};
}

// Initial read-format boundary shared by main, backend and plain Node clients.
// Current records do no old-file probes or writes. If persisting actual old
// graphics/privacy choices fails, one named in-memory fallback preserves that
// working choice; identical reads never retry the conversion/write this process.
function upgradeLoadedRecord(userDataDir, record, write, { registry, logger = console, currentVersion } = {}) {
  if (!object(record)) return record;
  currentVersion ??= require('../game-store').CURRENT_RECORD_SCHEMA_VERSION;
  if (typeof record.schemaVersion === 'number' && record.schemaVersion >= currentVersion) return record;
  const key = userDataDir + ':' + (record.gameId || record.gamePath || '');
  const failed = failedWrites.get(key);
  if (failed && failed.input === JSON.stringify(record)) return structuredClone(failed.output);
  let next;
  try { next = convertLegacyRecord(record, {userDataDir, registry, logger, currentVersion}); }
  catch (error) { logger?.warn?.('[backcompat] Old game record was retained.', error.message);return record; }
  if (next === record) return record;
  try { write(next); }
  catch (error) {
    failedWrites.set(key, {input: JSON.stringify(record), output: structuredClone(next)});
    logger?.warn?.('[backcompat] Converted record choices remain active in memory; the original record was retained.', error.message);
  }
  return next;
}
module.exports = { convertLegacyRecord, upgradeLoadedRecord, oldNetworkChoice };

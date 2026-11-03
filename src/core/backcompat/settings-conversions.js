// Backcompat: pre-current library v1 and boolean runtime-choice settings through
// MacLauncher 0.5.1. Runs once before raw settings normalization; no Play scan.
// Remove when those stored settings layouts are no longer supported.
const fs = require('node:fs');
const path = require('node:path');
const { readJsonDocument, writeJsonAtomic } = require('../json-files');
const { CURRENT_SETTINGS_MIGRATION: MIGRATION } = require('../data-migration-ids');
const attempts = new Map(), aliasesCache = new Map(), choiceCache = new Map(), choiceAliases = new WeakMap();
const record = value => value && typeof value === 'object' && !Array.isArray(value);

function runtimeAliases(moduleInfo, registry) {
  const id = moduleInfo?.id;
  if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) return [];
  if (typeof registry?.getLegacyRuntimeSettingAliases === 'function') return registry.getLegacyRuntimeSettingAliases(id) || [];
  const directory = registry?.getModuleDir?.(id) || path.join(__dirname, '../../modules', id);
  const file = path.join(directory, 'backcompat/runtime-settings.js');
  if (!aliasesCache.has(file)) {
    try { aliasesCache.set(file, require(file).runtimeSettingAliases || []); }
    catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND' || !error.message.split('\n')[0].includes(`'${file}'`)) throw error;
      // Transitional source declarations supply the same data until their
      // isolated module facts land. This never runs in the current value parser.
      aliasesCache.set(file, Object.entries(moduleInfo.runtime?.entries || {}).flatMap(([runtimeId, runtime]) =>
        (runtime.settings?.fields || []).filter(field => Array.isArray(field.legacyValues)).map(field => ({runtimeId, key: field.key, values: field.legacyValues}))));
    }
  }
  return aliasesCache.get(file);
}
function convertValues(incoming, aliases, runtimeId) {
  if (!record(incoming)) return incoming;
  let next = incoming;
  for (const alias of aliases) {
    if (alias.runtimeId !== runtimeId || typeof alias.key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(alias.key) || !Object.hasOwn(incoming, alias.key)) continue;
    const match = alias.values?.find(value => Object.is(value.value, incoming[alias.key]));
    if (typeof match?.replacement !== 'string') continue;
    if (next === incoming) next = {...incoming};
    next[alias.key] = match.replacement;
  }
  return next;
}

// Narrow fallback for an actual old choice whose file could not be rewritten.
// Only the defaults store's uncached old typed input calls it. Each distinct old
// value is converted once in memory; cache refills reuse the current patch, with
// no old-file probes/writes. Remove with boolean-choice profile support.
function convertLegacyRuntimeSettings(moduleInfo, runtimeId, incoming, registry) {
  if (!record(incoming)) return incoming;
  const fields = moduleInfo?.runtime?.entries?.[runtimeId]?.settings?.fields || [];
  if (!fields.some(field => field.type === 'select' && typeof incoming[field.key] === 'boolean')) return incoming;
  let known = choiceAliases.get(moduleInfo);
  if (!known) { registry ||= require('../../modules/registry');known = runtimeAliases(moduleInfo, registry);choiceAliases.set(moduleInfo, known); }
  const aliases = known.filter(alias => alias.runtimeId === runtimeId);
  const key = JSON.stringify([moduleInfo?.id, runtimeId, aliases.map(alias => [alias.key, incoming[alias.key]])]);
  if (!choiceCache.has(key)) {
    const converted = convertValues(incoming, aliases, runtimeId), patch = {};
    for (const alias of aliases) if (!Object.is(converted[alias.key], incoming[alias.key])) patch[alias.key] = converted[alias.key];
    choiceCache.set(key, patch);
  }
  const patch = choiceCache.get(key);
  return Object.keys(patch).length ? {...incoming, ...patch} : incoming;
}
function convertLibrarySettings(library) {
  if (!record(library) || !Number.isFinite(library.version) || library.version >= 2) return library;
  return {...library, version: 2, sort: {mode: 'custom', direction: 'asc'}};
}

function migrateLegacySettings(raw, { userDataDir, registry, commitSettings, logger = console } = {}) {
  if (!record(raw) || raw.dataMigrations?.[MIGRATION]?.complete === true) return raw;
  const key = path.resolve(userDataDir), existing = attempts.get(key);
  let state = existing;
  if (!state) {
    state = { modules: [], retained: [], commitAttempted: false, runtimeChanged: false };
    attempts.set(key, state);
    const ids = registry.listModuleIds?.() || registry.listModules?.().map(mod => mod.id || mod.manifest?.id) || [];
    for (const id of ids) {
      const info = registry.getModuleInfo?.(id) || registry.getModule?.(id)?.manifest;
      const aliases = runtimeAliases(info, registry);
      if (aliases.length) state.modules.push({id, aliases});
    }
    const runtimeAliasesById = new Map();
    for (const {aliases} of state.modules) for (const alias of aliases) {
      if (!/^[a-z0-9-]+$/.test(alias.runtimeId || '')) continue;
      const list = runtimeAliasesById.get(alias.runtimeId) || [];list.push(alias);runtimeAliasesById.set(alias.runtimeId, list);
    }
    for (const [runtimeId, aliases] of runtimeAliasesById) {
      const file = path.join(userDataDir, 'runtimes', runtimeId, 'settings.json');
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error('Runtime settings are not a bounded regular document.');
        const previous = readJsonDocument(file);
        const next = convertValues(previous, aliases, runtimeId);
        if (next !== previous) { writeJsonAtomic(file, next);state.runtimeChanged = true; }
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        state.retained.push({runtimeId, reason: error.message});
        logger?.warn?.('[backcompat] Runtime settings retained; the old choice remains readable in memory.', runtimeId, error.message);
      }
    }
  }
  if (state.noConversion) return raw;
  const next = structuredClone(raw);
  let changed = state.runtimeChanged || state.retained.length > 0;
  if (record(next.launcher)) {
    const library = convertLibrarySettings(next.launcher.library);
    changed ||= library !== next.launcher.library;
    next.launcher.library = library;
  }
  for (const {id, aliases} of state.modules) {
    const map = next.modules?.[id]?.runtimeSettings;
    if (!record(map)) continue;
    for (const runtimeId of new Set(aliases.map(alias => alias.runtimeId))) if (record(map[runtimeId])) {
      const converted = convertValues(map[runtimeId], aliases, runtimeId);
      changed ||= converted !== map[runtimeId];
      map[runtimeId] = converted;
    }
  }
  // A read is not a settings edit. Cache a no-op without rewriting current
  // bytes; its completion joins the next ordinary settings transaction.
  if (!changed) { state.noConversion = true;return raw; }
  next.dataMigrations = {...next.dataMigrations, [MIGRATION]: {complete: true, ...(state.retained.length ? {retained: state.retained} : {})}};
  if (!state.commitAttempted) {
    state.commitAttempted = true;
    try {
      if (typeof commitSettings !== 'function') throw Error('Raw settings conversion requires the existing settings coordinator.');
      const committed = commitSettings(raw, next);
      if (!record(committed) || typeof committed.then === 'function') throw Error('Raw settings conversion must commit synchronously.');
      return committed;
    } catch (error) { logger?.warn?.('[backcompat] Converted settings are used in memory; the original document was not replaced.', error.message); }
  }
  return next;
}

// Backcompat completion for an already-checked, unchanged profile. Called only
// by an ordinary settings write; no discovery or filesystem work. Delete with
// the pre-current settings converter above.
function completeDeferredSettingsMigration(userDataDir, settings) {
  if (!record(settings) || settings.dataMigrations?.[MIGRATION]?.complete === true ||
      !attempts.get(path.resolve(userDataDir))?.noConversion) return settings;
  return {...settings, dataMigrations: {...settings.dataMigrations, [MIGRATION]: {complete: true}}};
}

module.exports = { migrateLegacySettings, completeDeferredSettingsMigration, convertLibrarySettings, convertLegacyRuntimeSettings, runtimeAliases, convertValues, MIGRATION };

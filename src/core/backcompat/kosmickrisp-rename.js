// Backcompat: MacLauncher 0.5.3 and earlier published MacLauncher KosmicKrisp
// under the manager ID vulkan-kosmickrisp-gles32, with the Vulkan choices
// kosmickrisp:maclauncher-gles32 and kosmickrisp-gles32:<version>. Saved data
// under those IDs moves once to the current IDs: the manager settings in
// settings.json, each game's runtime data, and every saved Vulkan driver choice
// in settings.json, runtime defaults and game records. Installations under the
// former ID stay in place; the manager reads them through its former IDs. Runs
// from the settings read and once at main startup, never Play. Remove when
// profiles from those versions are no longer supported.
const fs = require('node:fs');
const path = require('node:path');
const { readJsonDocument, writeJsonAtomic } = require('../json-files');
const { KOSMICKRISP_RENAME_MIGRATION: MIGRATION } = require('../data-migration-ids');

const FORMER_ID = 'vulkan-kosmickrisp-gles32';
const FORMER_SELECTION = 'kosmickrisp:maclauncher-gles32';
const FORMER_PREFIX = 'kosmickrisp-gles32:';
const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const managed = () => require('../../modules/shared/vulkan/managed');
const commits = new Set(), runtimeDefaultsConverted = new Set();

// The current form of one saved Vulkan driver choice. Wine translator choices
// name the manager ID; Android, AnyPS5 and Prosper choices use the selection
// forms. An unreadable version becomes Automatic with a warning.
function convertChoice(value, logger) {
  if (typeof value !== 'string') return value;
  if (value === FORMER_SELECTION) return managed().selectionId;
  if (value.startsWith(FORMER_ID + ':')) return managed().projectId + value.slice(FORMER_ID.length);
  if (!value.startsWith(FORMER_PREFIX)) return value;
  const Managed = managed();
  try { return Managed.projectId + ':' + Managed.manager.core.normalizeVersion(value.slice(FORMER_PREFIX.length)); } catch {}
  logger?.warn?.('[runtimes] The saved MacLauncher KosmicKrisp choice could not be read; using Automatic.');
  return 'auto';
}

// A copy of value with every saved choice converted, or value itself when
// nothing changes.
function convertValues(value, logger) {
  if (typeof value === 'string') return convertChoice(value, logger);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map(item => {
      const converted = convertValues(item, logger);
      changed ||= converted !== item;
      return converted;
    });
    return changed ? next : value;
  }
  if (!record(value)) return value;
  let next = null;
  for (const [key, item] of Object.entries(value)) {
    const converted = convertValues(item, logger);
    if (converted !== item) (next ||= { ...value })[key] = converted;
  }
  return next || value;
}

// The former manager settings in the current manager's form, or undefined
// when they cannot be read.
function managerSettings(previous, logger) {
  const { manager } = managed();
  if (record(previous) && (previous.defaultVersion == null || typeof previous.defaultVersion === 'string')) try {
    const normalized = manager.normalizeSettings(previous);
    if (normalized.defaultVersion) manager.core.normalizeVersion(normalized.defaultVersion);
    return normalized;
  } catch {}
  logger?.warn?.('[runtimes] The saved MacLauncher KosmicKrisp settings could not be read; using the manager default.');
  return undefined;
}

// Moves the former key of a record to the current manager ID. A value already
// stored under the current ID stays, and the former key is dropped.
function moveFormerKey(values, convert) {
  if (!record(values) || !Object.hasOwn(values, FORMER_ID)) return values;
  const { [FORMER_ID]: previous, ...rest } = values, { projectId } = managed();
  if (!Object.hasOwn(rest, projectId)) {
    const moved = convert(previous);
    if (moved !== undefined) rest[projectId] = moved;
  }
  return rest;
}

// Runtime defaults live in runtimes/<runtime ID>/settings.json. Each document
// holding a former choice is rewritten once.
function convertRuntimeDefaults(userDataDir, logger) {
  const root = path.join(userDataDir, 'runtimes');
  let names = [];
  try { names = fs.readdirSync(root); } catch { return; }
  for (const name of names) {
    const file = path.join(root, name, 'settings.json');
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) continue;
      const previous = readJsonDocument(file);
      const next = convertValues(previous, logger);
      if (next !== previous) writeJsonAtomic(file, next);
    } catch (error) {
      if (error.code !== 'ENOENT') logger?.warn?.('[backcompat] Runtime defaults keep their MacLauncher KosmicKrisp choice:', name, error.message);
    }
  }
}

// A settings document with its former manager settings and choices converted.
// A document without them is returned unchanged, and startup records the
// completion with its next settings write.
function migrateSettings(raw, { userDataDir, commitSettings, logger = console } = {}) {
  const state = raw?.dataMigrations?.[MIGRATION];
  if (state?.complete === true || state?.settings === true) return raw;
  const key = path.resolve(userDataDir || '.');
  if (userDataDir && !runtimeDefaultsConverted.has(key)) {
    runtimeDefaultsConverted.add(key);
    convertRuntimeDefaults(userDataDir, logger);
  }
  if (!record(raw)) return raw;
  let next = convertValues(raw, logger);
  const runtimes = moveFormerKey(next.runtimes, previous => managerSettings(previous, logger));
  if (runtimes !== next.runtimes) next = { ...next, runtimes };
  if (next === raw) return raw;
  next = { ...next, dataMigrations: { ...next.dataMigrations, [MIGRATION]: { settings: true } } };
  if (!commits.has(key) && typeof commitSettings === 'function') {
    commits.add(key);
    try {
      const committed = commitSettings(raw, next);
      if (record(committed) && typeof committed.then !== 'function') return committed;
    } catch (error) { logger?.warn?.('[backcompat] MacLauncher KosmicKrisp settings are converted in memory; settings were not rewritten.', error.message); }
  }
  return next;
}

// A game record with its former runtime data and choices converted, or null
// when the record has none.
function migrateGameEntry(entry, { logger = console } = {}) {
  if (!record(entry)) return null;
  const runtimeSettings = convertValues(entry.runtimeSettings, logger);
  const runtimeData = moveFormerKey(entry.runtimeData, previous => previous);
  if (runtimeSettings === entry.runtimeSettings && runtimeData === entry.runtimeData) return null;
  const next = { ...entry };
  if (runtimeSettings !== entry.runtimeSettings) next.runtimeSettings = runtimeSettings;
  if (runtimeData !== entry.runtimeData) next.runtimeData = runtimeData;
  return next;
}

module.exports = { migrateSettings, migrateGameEntry, convertChoice, MIGRATION, FORMER_ID };

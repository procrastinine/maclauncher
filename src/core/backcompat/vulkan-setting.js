// Backcompat: non-Wine Vulkan choices saved as vulkanRuntime before the shared
// translatorVulkan role. Runs once from the raw settings read, before settings
// normalization or runtime-default caching, for module defaults, runtime-default
// documents and game records. Remove with support for that settings layout.
const fs = require('node:fs');
const path = require('node:path');
const { readJsonObjectForUpdate, preserveUnreadable, writeJsonAtomic } = require('../json-files');
const { mergeSettingsChanges } = require('../settings-merge');
const GameData = require('../../modules/shared/game-data');
const { VULKAN_SETTING_MIGRATION: MIGRATION } = require('../data-migration-ids');
const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const unchangedProfiles = new Set();

function directories(root) {
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Saved settings directory is not a regular directory.');
    return fs.readdirSync(root, { withFileTypes: true });
  }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function readForConversion(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error('Saved settings are not a bounded regular document.');
  try { return readJsonObjectForUpdate(file); }
  catch (error) {
    if (error instanceof SyntaxError) preserveUnreadable(file);
    throw error;
  }
}

// The current key wins even when its value is empty or null, as with other
// renamed settings. Choice identities remain literal; this does not select a
// source, build or fallback. Undefined means no saved value.
function convertChoiceKey(settings) {
  if (!record(settings) || !Object.hasOwn(settings, 'vulkanRuntime')) return settings;
  const { vulkanRuntime: previous, ...next } = settings;
  if (!Object.hasOwn(next, 'translatorVulkan') && previous !== undefined) next.translatorVulkan = previous;
  return next;
}

function convertRuntimeMap(values) {
  if (!record(values)) return values;
  let next = values;
  for (const [id, settings] of Object.entries(values)) {
    const converted = convertChoiceKey(settings);
    if (converted !== settings) {
      if (next === values) next = { ...values };
      next[id] = converted;
    }
  }
  return next;
}

function migrateGameEntry(entry) {
  if (!record(entry)) return null;
  const runtimeSettings = convertRuntimeMap(entry.runtimeSettings);
  return runtimeSettings === entry.runtimeSettings ? null : { ...entry, runtimeSettings };
}

function migrateSettings(raw, { userDataDir, commitSettings } = {}) {
  if (!record(raw) || raw.dataMigrations?.[MIGRATION]?.complete === true) return raw;
  const key = path.resolve(userDataDir || '.');
  if (unchangedProfiles.has(key)) return raw;
  if (typeof commitSettings !== 'function') throw new TypeError('Vulkan settings conversion requires the settings coordinator.');
  let next = raw;
  for (const [id, settings] of Object.entries(record(raw.modules) ? raw.modules : {})) {
    const runtimeSettings = convertRuntimeMap(settings?.runtimeSettings);
    if (runtimeSettings !== settings?.runtimeSettings)
      next = { ...next, modules: { ...next.modules, [id]: { ...settings, runtimeSettings } } };
  }

  let changed = next !== raw;
  // Existing defaults and record APIs retain atomic writes and unreadable
  // document preservation. A failed conversion does not record completion or
  // let a consumer silently use a default in place of a saved choice.
  if (userDataDir) {
    const root = path.join(userDataDir, 'runtimes');
    for (const entry of directories(root)) {
      if (entry.isSymbolicLink()) throw new Error('A runtime settings directory is a symbolic link.');
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'settings.json');
      const previous = readForConversion(file), converted = convertChoiceKey(previous);
      if (converted !== previous) { writeJsonAtomic(file, converted); changed = true; }
    }
    const GameStore = require('../game-store');
    for (const directory of directories(GameData.resolveGamesRoot(userDataDir))) {
      const id = directory.name;
      if (!/^[0-9A-Za-z_-]+$/.test(id)) continue;
      if (directory.isSymbolicLink()) throw new Error('A game record directory is a symbolic link.');
      if (!directory.isDirectory()) continue;
      const file = GameData.resolveGameDataPath(userDataDir, id);
      const entry = readForConversion(file), converted = migrateGameEntry(entry);
      if (converted) {
        const current = readForConversion(file);
        if (current) {
          GameStore.writeGameRecord(userDataDir, { ...mergeSettingsChanges(entry, converted, current), gameId: id });
          changed = true;
        }
      }
    }
  }
  // An unchanged read is not an edit. As with current-settings conversion,
  // its completion joins the next ordinary settings transaction.
  if (!changed) { unchangedProfiles.add(key); return raw; }
  next = { ...next, dataMigrations: { ...next.dataMigrations, [MIGRATION]: { complete: true } } };
  const committed = commitSettings(raw, next);
  if (!record(committed) || typeof committed.then === 'function') throw new TypeError('Vulkan settings conversion must commit synchronously.');
  return committed;
}

function completeDeferredMigration(userDataDir, settings) {
  if (!record(settings) || settings.dataMigrations?.[MIGRATION]?.complete === true ||
      !unchangedProfiles.has(path.resolve(userDataDir || '.'))) return settings;
  return { ...settings, dataMigrations: { ...settings.dataMigrations, [MIGRATION]: { complete: true } } };
}

module.exports = { migrateSettings, migrateGameEntry, completeDeferredMigration, MIGRATION };

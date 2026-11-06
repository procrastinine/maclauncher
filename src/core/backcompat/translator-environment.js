// Backcompat: the CrossOver and Sikarugir "Environment variables" list setting
// of MacLauncher 0.5.3 and earlier, one NAME=value line per entry. Its lines
// move once into the translator environment store: runtime and game type
// defaults become the runtime's global values, and a game's own lines become
// that game's values. Runs from the settings read and once at main startup,
// never Play. Remove when profiles with that list setting are no longer supported.
const fs = require('node:fs');
const path = require('node:path');
const Contract = require('../../modules/shared/runtime/translator-environment.mjs');
const { TRANSLATOR_ENVIRONMENT_MIGRATION: MIGRATION } = require('../data-migration-ids');

const RUNTIMES = ['crossover', 'sikarugir'];
const LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const commits = new Set();

// The usable lines of one saved list. List settings stored trimmed lines; the
// text after "=" is literal. Locked and malformed lines never applied, so they
// are left out.
function valuesFromLines(lines, declaration) {
  const result = {};
  for (const line of Array.isArray(lines) ? lines : typeof lines === 'string' ? lines.split(/\r?\n/) : []) {
    const match = LINE.exec(String(line).trim());
    if (!match || !Contract.isVariableValue(match[2]) || Contract.lockedRule([declaration], match[1])) continue;
    result[match[1]] = match[2];
  }
  return result;
}

function runtimeDefaults(userDataDir, runtimeId) {
  try {
    const file = path.join(userDataDir, 'runtimes', runtimeId, 'settings.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record(value) ? value : null;
  } catch { return null; }
}

// Declarations of the runtimes whose lists move, read only when lines exist.
function declarationsOf(registry) {
  const source = typeof registry?.listTranslatorEnvironments === 'function' ? registry : require('../../modules/registry');
  return source.listTranslatorEnvironments();
}

// A settings document with the runtime and game type lines moved into
// launcher.translatorEnvironment. A value already stored there stays. When
// sources disagree about one variable, runtime defaults come first and then
// game types in id order; the other values are listed under `retained` in the
// migration record. A document without such lines is returned unchanged, and
// startup records the completion with its next settings write.
function migrateSettings(raw, { userDataDir, registry, commitSettings, logger = console } = {}) {
  const state = raw?.dataMigrations?.[MIGRATION];
  if (!record(raw) || state?.complete === true || state?.settings === true) return raw;
  const lists = RUNTIMES.map(runtimeId => [runtimeId, runtimeDefaults(userDataDir, runtimeId)?.environment]);
  const moduleIds = Object.keys(record(raw.modules) ? raw.modules : {}).sort();
  const listed = moduleIds.some(moduleId => RUNTIMES.some(runtimeId => {
    const settings = raw.modules[moduleId]?.runtimeSettings?.[runtimeId];
    return record(settings) && Object.hasOwn(settings, 'environment');
  }));
  if (!listed && !lists.some(([, lines]) => Array.isArray(lines) ? lines.length : typeof lines === 'string' && lines.trim())) return raw;
  const declarations = declarationsOf(registry), next = structuredClone(raw), retained = [];
  const store = Contract.readStore(next.launcher?.translatorEnvironment);
  for (const runtimeId of RUNTIMES) {
    const declaration = declarations.find(item => item.id === runtimeId);
    if (!declaration) continue;
    const values = { ...(store[runtimeId] || {}) }, taken = new Set(Object.keys(values));
    const sources = [['runtime', lists.find(([id]) => id === runtimeId)[1]]];
    for (const moduleId of moduleIds) {
      const settings = next.modules[moduleId]?.runtimeSettings?.[runtimeId];
      if (!record(settings) || !Object.hasOwn(settings, 'environment')) continue;
      sources.push([moduleId, settings.environment]);
      delete settings.environment;
    }
    const added = {};
    for (const [source, lines] of sources) for (const [name, value] of Object.entries(valuesFromLines(lines, declaration))) {
      if (taken.has(name)) continue;
      if (Object.hasOwn(added, name)) {
        if (added[name] !== value) retained.push({ runtimeId, moduleId: source, name, value });
        continue;
      }
      added[name] = value;
    }
    Object.assign(values, added);
    if (Object.keys(values).length) store[runtimeId] = values;
  }
  if (Object.keys(store).length) next.launcher = { ...(record(next.launcher) ? next.launcher : {}), translatorEnvironment: store };
  next.dataMigrations = { ...next.dataMigrations, [MIGRATION]: { settings: true, ...(retained.length ? { retained } : {}) } };
  if (retained.length) logger?.warn?.('[backcompat] Game types set different values for these Wine variables; the first game type supplies the global value:',
    retained.map(item => `${item.runtimeId} ${item.name} (${item.moduleId})`).join(', '));
  const key = path.resolve(userDataDir || '.');
  if (!commits.has(key) && typeof commitSettings === 'function') {
    commits.add(key);
    try {
      const committed = commitSettings(raw, next);
      if (record(committed) && typeof committed.then !== 'function') return committed;
    } catch (error) { logger?.warn?.('[backcompat] Moved environment variables are used in memory; settings were not rewritten.', error.message); }
  }
  return next;
}

// A game record with its own lines moved into translatorEnvironment, or null
// when the record has no such list. A value the game already stores stays.
function migrateGameEntry(entry, declarations = []) {
  if (!record(entry?.runtimeSettings)) return null;
  const runtimeIds = RUNTIMES.filter(id => record(entry.runtimeSettings[id]) && Object.hasOwn(entry.runtimeSettings[id], 'environment'));
  if (!runtimeIds.length) return null;
  const runtimeSettings = { ...entry.runtimeSettings }, store = Contract.readStore(entry.translatorEnvironment);
  for (const runtimeId of runtimeIds) {
    const { environment: lines, ...rest } = runtimeSettings[runtimeId];
    runtimeSettings[runtimeId] = rest;
    const declaration = declarations.find(item => item.id === runtimeId);
    if (!declaration) continue;
    const values = { ...valuesFromLines(lines, declaration), ...(store[runtimeId] || {}) };
    if (Object.keys(values).length) store[runtimeId] = values;
  }
  const next = { ...entry, runtimeSettings };
  if (Object.keys(store).length) next.translatorEnvironment = store;
  return next;
}

module.exports = { migrateSettings, migrateGameEntry, valuesFromLines, MIGRATION };

// Backcompat: MacLauncher 0.5.1 and earlier module-declared private mirrors.
// Runs only in the one-time settings-backed migration, never ordinary Play.
// Remove when support for profiles containing these obsolete layouts is retired.
const { retireLegacyGameMirror, plainDirectory } = require('./legacy-game-mirrors');
const path = require('node:path');
const { mergeSettingsChanges } = require('../settings-merge');
const { ORIGINAL_GAME_MIRRORS_MIGRATION } = require('../data-migration-ids');
const entryId = entry => [entry?.gameId, entry?.id, entry?.gamePath].find(value => typeof value === 'string' && value);

function validateEntryPatch(patch) {
  const active = new Set();let nodes = 0;
  function visit(value, depth = 0) {
    if (++nodes > 16384 || depth > 32) throw Error('This game type returned an unusable recovery result (a settings change that is too large), so these files were left in place. Copy any needed files from this folder before removing the game.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || active.has(value)) throw Error('This game type returned an unusable recovery result (a settings change that is not plain data or refers to itself), so these files were left in place. Copy any needed files from this folder before removing the game.');
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('This game type returned an unusable recovery result (a settings change that contains special objects), so these files were left in place. Copy any needed files from this folder before removing the game.');
    if (Object.getOwnPropertySymbols(value).length) throw Error('This game type returned an unusable recovery result (a settings change with special keys), so these files were left in place. Copy any needed files from this folder before removing the game.');
    active.add(value);
    if (array) {
      if (value.length > 16384 || Object.keys(value).length !== value.length) throw Error('This game type returned an unusable recovery result (a settings change with an incomplete list), so these files were left in place. Copy any needed files from this folder before removing the game.');
      for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) throw Error('This game type returned an unusable recovery result (a settings change with an incomplete list), so these files were left in place. Copy any needed files from this folder before removing the game.');
    }
    for (const [key, field] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (array && key === 'length') continue;
      if (['__proto__', 'constructor', 'prototype'].includes(key) || !Object.hasOwn(field, 'value') || !field.enumerable)
        throw Error('This game type returned an unusable recovery result (a settings change with an unsafe or computed field), so these files were left in place. Copy any needed files from this folder before removing the game.');
      visit(field.value, depth + 1);
    }
    active.delete(value);
  }
  if (!patch || Array.isArray(patch) || typeof patch !== 'object') throw Error('This game type returned an unusable recovery result (a settings change that is not a set of named settings), so these files were left in place. Copy any needed files from this folder before removing the game.');
  visit(patch);
}

function validateIdentity(value, original, patch = false) {
  for (const key of ['gameId', 'gamePath', 'importPath'])
    if ((!patch || Object.hasOwn(value, key)) && value[key] !== original[key]) throw Error('This game type returned an unusable recovery result (it would change the game\'s identity or location), so these files were left in place. Copy any needed files from this folder before removing the game.');
}
const contains = (root, file) => typeof root === 'string' && path.isAbsolute(root) && typeof file === 'string' && path.isAbsolute(file) &&
  (path.resolve(file) === path.resolve(root) || path.resolve(file).startsWith(path.resolve(root) + path.sep));
function remapSavePaths(entry, successful, failed) {
  const remap = file => {
    if (failed.some(row => contains(row.mirrorRoot, file))) return file;
    let value = file;
    for (const row of successful) if (typeof row.sourceRoot === 'string' && path.isAbsolute(row.sourceRoot) && contains(row.mirrorRoot, value))
      value = path.join(row.sourceRoot, path.relative(path.resolve(row.mirrorRoot), path.resolve(value)));
    return value;
  };
  if (Object.hasOwn(entry, 'defaultSaveDir')) entry.defaultSaveDir = remap(entry.defaultSaveDir);
  if (Array.isArray(entry.saveLocations)) entry.saveLocations = entry.saveLocations.map(row => row && typeof row === 'object'
    ? { ...row, ...(Object.hasOwn(row, 'directory') ? { directory: remap(row.directory) } : {}) } : row);
}
function preserveFailedPaths(entry, original, failed) {
  const blocked = file => failed.some(row => contains(row.mirrorRoot, file));
  for (const key of ['contentRootDir', 'indexDir', 'indexHtml', 'defaultSaveDir', 'saveDirOverride'])
    if (blocked(original[key])) entry[key] = original[key];
  if (!Array.isArray(original.saveLocations)) return;
  const rows = Array.isArray(entry.saveLocations) ? [...entry.saveLocations] : [];
  for (const [index, row] of original.saveLocations.entries()) {
    if (!row || !blocked(row.directory)) continue;
    const same = rows.findIndex(candidate => candidate && (row.id ? candidate.id === row.id : candidate.directory === row.directory));
    if (same >= 0) rows[same] = { ...rows[same], directory: row.directory };
    else if (!row.id && rows[index] && JSON.stringify({ ...rows[index], directory: undefined }) === JSON.stringify({ ...row, directory: undefined }))
      rows[index] = { ...rows[index], directory: row.directory };
    else rows.push(structuredClone(row));
  }
  if (original.saveLocations.some(row => row && blocked(row.directory))) entry.saveLocations = rows;
}

// A retained released route is an ordinary setting, selected only once after
// that root's recovery failed. Modules declare facts; this boundary owns safety.
function retainReleasedSaveRoutes(entry, baseline, groups, successful, successfulPatches, userDataDir, failures) {
  const candidates = [], settingRoots = new Set(['saveDirOverride', 'launchArguments', 'runtimeData', 'runtimeSettings']);
  const leaves = (value, prefix = []) => Object.entries(value).flatMap(([key, field]) =>
    field && typeof field === 'object' && !Array.isArray(field) ? leaves(field, [...prefix, key]) : [[...prefix, key]]);
  const at = (value, keys) => keys.reduce((current, key) => current && typeof current === 'object' && Object.hasOwn(current, key) ? current[key] : undefined, value);
  const assigned = value => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && !value.length);
  const overlaps = (left, right) => left.slice(0, Math.min(left.length, right.length)).every((key, index) => key === right[index]);
  for (const { descriptor, declarations } of groups) {
    try {
      const facts = declarations.map(row => {
        const field = Object.getOwnPropertyDescriptor(row, 'releasedSaveRoute');
        if (!field) return null;
        if (!Object.hasOwn(field, 'value')) throw Error('The earlier save folder could not be kept as this game\'s save location (the game type\'s save details are not plain data). These files were left in place. Copy any needed files from this folder before removing the game.');
        validateEntryPatch({ releasedSaveRoute: field.value });
        return field.value;
      });
      if (facts.every(fact => fact === null)) continue;
      const route = facts[0];
      if (!route || facts.some(fact => JSON.stringify(fact) !== JSON.stringify(route))) throw Error('The earlier save folder could not be kept as this game\'s save location, because the game type gave conflicting save details. These files were left in place. Copy any needed files from this folder before removing the game.');
      if (Object.keys(route).sort().join(',') !== 'directory,entryPatch,explicit,proven' ||
          typeof route.proven !== 'boolean' || typeof route.explicit !== 'boolean') throw Error('The earlier save folder could not be kept as this game\'s save location (the game type\'s save details are invalid). These files were left in place. Copy any needed files from this folder before removing the game.');
      if (!route.proven || route.explicit) continue;
      const directory = route.directory;
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(baseline.gameId || '') || typeof directory !== 'string' || directory.includes('\0') ||
          !path.isAbsolute(directory) || directory !== path.resolve(directory)) throw Error('The earlier save folder could not be kept as this game\'s save location (its folder path is invalid). These files were left in place. Copy any needed files from this folder before removing the game.');
      const gameRoot = path.join(path.resolve(userDataDir), 'games', baseline.gameId);
      if (directory === gameRoot || !contains(gameRoot, directory) || !contains(descriptor.mirrorRoot, directory) ||
          [baseline.gamePath, baseline.contentRootDir].some(root => typeof root === 'string' && path.resolve(root) === directory) ||
          successful.some(row => contains(row.mirrorRoot, directory))) throw Error('The earlier save folder could not be kept as this game\'s save location (the folder is not inside this game\'s unrecovered folder). These files were left in place. Copy any needed files from this folder before removing the game.');
      validateEntryPatch(route.entryPatch); validateIdentity(route.entryPatch, baseline, true);
      if (Object.keys(route.entryPatch).some(key => !settingRoots.has(key))) throw Error('The earlier save folder could not be kept as this game\'s save location (it would change settings other than the save folder, launch arguments or runtime settings). These files were left in place. Copy any needed files from this folder before removing the game.');
      for (const key of ['runtimeData', 'runtimeSettings']) if (Object.hasOwn(route.entryPatch, key)) validateEntryPatch(route.entryPatch[key]);
      if (Object.hasOwn(route.entryPatch, 'launchArguments') && (typeof route.entryPatch.launchArguments !== 'string' || !route.entryPatch.launchArguments.trim())) throw Error('The earlier save folder could not be kept as this game\'s save location (its launch arguments are empty). These files were left in place. Copy any needed files from this folder before removing the game.');
      const paths = leaves(route.entryPatch);
      if (!paths.length) throw Error('The earlier save folder could not be kept as this game\'s save location (it names no setting to change). These files were left in place. Copy any needed files from this folder before removing the game.');
      if (paths.some(keys => assigned(at(baseline, keys)))) continue;
      if (successfulPatches.some(patch => leaves(patch).some(other => paths.some(keys => overlaps(keys, other))))) continue;
      if (paths.some(keys => typeof at(route.entryPatch, keys) === 'string' && at(route.entryPatch, keys).includes('\0'))) throw Error('The earlier save folder could not be kept as this game\'s save location (a setting contains an invalid character). These files were left in place. Copy any needed files from this folder before removing the game.');
      if (Object.hasOwn(route.entryPatch, 'saveDirOverride') && route.entryPatch.saveDirOverride !== directory) throw Error('The earlier save folder could not be kept as this game\'s save location (its save folder setting names a different folder). These files were left in place. Copy any needed files from this folder before removing the game.');
      plainDirectory(directory);
      candidates.push({ descriptor, route, paths });
    } catch (error) { failures.push({ mirrorRoot: descriptor.mirrorRoot, reason: error.message }); }
  }
  for (const { descriptor, route, paths } of candidates) {
    if (candidates.some(other => paths.some(keys => other.paths.some(otherKeys => overlaps(keys, otherKeys) &&
        (JSON.stringify(keys) !== JSON.stringify(otherKeys) || JSON.stringify(at(route.entryPatch, keys)) !== JSON.stringify(at(other.route.entryPatch, otherKeys))))))) {
      failures.push({ mirrorRoot: descriptor.mirrorRoot, reason: 'The earlier save folder could not be kept as this game\'s save location, because two save settings conflict. These files were left in place. Copy any needed files from this folder before removing the game.' }); continue;
    }
    Object.assign(entry, mergeSettingsChanges({}, route.entryPatch, entry));
  }
}

// remainingIds is only the crash-resume queue. Retained failures are diagnostic
// facts, never a reason to probe obsolete paths on subsequent startups.
// Optional onProgress hears { done, total } only while games remain to migrate.
async function runDataMigrations({ settings, games, registry, userDataDir, saveSettings, saveEntry, logger, onProgress } = {}) {
  const previous = settings?.dataMigrations?.[ORIGINAL_GAME_MIRRORS_MIGRATION];
  if (previous?.complete === true) return { settings, complete: true, remainingIds: [],
    pendingIds: previous.pendingIds || [], retained: previous.retained || [] };
  if (typeof saveSettings !== 'function') throw Error('Data migrations require settings persistence.');
  const sharedManagers = (registry.listSharedRuntimeManagers?.() || []).filter(manager =>
    typeof manager?.legacyGameMirrors === 'function' || typeof manager?.migrateLegacyGameData === 'function');
  const providerModules = registry.listRuntimeProviderModules?.() || [];
  const entries = new Map((games || []).map(entry => [entryId(entry), entry]).filter(([id]) => typeof id === 'string' && id));
  const remaining = new Set(previous?.remainingIds || previous?.pendingIds || entries.keys());
  const pending = new Set(previous?.remainingIds ? previous.pendingIds || [] : []);
  const retained = new Map((previous?.retained || []).map(item => [item.id, item]));
  let current = settings || {};
  async function checkpoint() {
    const next = { ...current, dataMigrations: { ...current.dataMigrations,
      [ORIGINAL_GAME_MIRRORS_MIGRATION]: { complete: remaining.size === 0, remainingIds: [...remaining], pendingIds: [...pending],
        ...(retained.size ? { retained: [...retained.values()] } : {}) } } };
    await saveSettings(next);
    current = next;
  }
  // Save the bounded existing IDs before hooks. Mark each attempt before it
  // starts: a crash leaves manual diagnostics, never a second automatic attempt.
  await checkpoint();
  const total = remaining.size;
  if (total) await onProgress?.({ done: 0, total });
  for (const id of [...remaining]) {
    const original = entries.get(id), failures = [], recoveredFiles = [];
    remaining.delete(id);pending.add(id);
    retained.set(id, { id, failures: [{ reason: 'Recovery was interrupted before it finished, so these files were left in place. Copy any needed files from this folder before removing the game.' }] });
    await checkpoint();
    try {
      if (!original) throw Error('The game\'s library entry was removed, so files kept by an earlier MacLauncher version were left in place.');
      const baseline = structuredClone(original);
      const entry = require('./record-conversions').convertLegacyRecord(structuredClone(baseline), { userDataDir, registry, logger });
      const mod = registry.getModule(entry.moduleId);
      const context = { userDataDir, settings: current, games };
      context.describeSaveIdentity = (game, options = context) => {
        const owner = registry.getModule(game.moduleId || game.engine);
        return owner?.resolveSaveIdentity?.(game, options) || null;
      };
      if (!mod) failures.push({ reason: 'The game type of this game is unavailable, so files kept by an earlier MacLauncher version were left in place. Copy any needed files from this folder before removing the game.' });
      const descriptors = [];
      const hooks = new Set();
      const descriptorsByOwner = new Map(), descriptorsByHook = new Map();
      const owners = new Set([mod, ...providerModules, ...sharedManagers]);
      const successfulDescriptors = [], failedDescriptors = [], descriptorResults = [];
      const failed = (descriptor, reason, result = { complete: false, reason }) => {
        failures.push({ mirrorRoot: descriptor?.mirrorRoot, sourceRoot: descriptor?.sourceRoot, reason });
        if (descriptor) failedDescriptors.push(descriptor);
        descriptorResults.push({ descriptor, result });
      };
      for (const owner of owners) {
        if (typeof owner?.legacyGameMirrors !== 'function') continue;
        if (hooks.has(owner.legacyGameMirrors)) { descriptorsByOwner.set(owner, descriptorsByHook.get(owner.legacyGameMirrors) || []);continue; }
        hooks.add(owner.legacyGameMirrors);
        const before = structuredClone(entry);
        try {
          const declared = await owner.legacyGameMirrors(entry, context) || [];
          validateIdentity(entry, original);
          if (!Array.isArray(declared)) throw Error('MacLauncher could not list the folders that earlier versions kept for this game, so they were left in place. Copy any needed files from this folder before removing the game.');
          descriptorsByOwner.set(owner, declared);descriptorsByHook.set(owner.legacyGameMirrors, declared);
          descriptors.push(...declared);
        } catch (error) {
          for (const key of Object.keys(entry)) delete entry[key];Object.assign(entry, before);
          failures.push({ reason: error.message });
        }
      }
      const roots = new Map(), pendingRoutes = [], successfulPatches = [];
      for (const descriptor of descriptors) {
        if (!descriptor || typeof descriptor !== 'object') { failures.push({ reason: 'MacLauncher could not identify a folder that an earlier version kept for this game, so it was left in place. Copy any needed files from this folder before removing the game.' });continue; }
        const root = typeof descriptor?.mirrorRoot === 'string' ? path.resolve(descriptor.mirrorRoot) : descriptor;
        const field = Object.getOwnPropertyDescriptor(descriptor, 'entryPatch'), hasPatch = Boolean(field);
        try {
          if (hasPatch && !Object.hasOwn(field, 'value')) throw Error('This game type returned an unusable recovery result (a settings change that is computed instead of stored), so these files were left in place. Copy any needed files from this folder before removing the game.');
          if (hasPatch) validateEntryPatch(field.value);
          if (hasPatch) validateIdentity(field.value, original, true);
        }
        catch (error) { failed(descriptor, error.message);roots.set(root, null);continue; }
        const entryPatch = field?.value;
        const absolute = value => typeof value === 'string' && path.isAbsolute(value) ? path.resolve(value) : value;
        const generated = descriptor.generated === undefined ? [] : descriptor.generated;
        const layout = { sourceRoot: absolute(descriptor.sourceRoot), retainMirror: Boolean(descriptor.retainMirror),
          createSourceWithin: absolute(descriptor.createSourceWithin),
          generated: Array.isArray(generated) && generated.every(file => typeof file === 'string') ? [...new Set(generated)].sort() : generated };
        if (!roots.has(root)) roots.set(root, { descriptor, layout, patches: hasPatch ? [entryPatch] : [], declarations: [descriptor] });
        else if (roots.get(root) && JSON.stringify(roots.get(root).layout) !== JSON.stringify(layout)) {
          failed(descriptor, 'MacLauncher found conflicting destinations for this folder, so its files were left in place. Copy any needed files from this folder before removing the game.');
          roots.set(root, null);
        } else if (roots.get(root)) {
          roots.get(root).declarations.push(descriptor);
          if (hasPatch) roots.get(root).patches.push(entryPatch);
        }
      }
      for (const group of roots.values()) {
        if (!group) continue;
        const { descriptor, patches } = group;
        const result = await retireLegacyGameMirror(descriptor, { userDataDir });
        if (!result.complete) { failed(descriptor, result.reason, result); pendingRoutes.push(group); }
        else {
          successfulDescriptors.push(descriptor);descriptorResults.push({ descriptor, result });
          for (const patch of patches) { successfulPatches.push(patch); Object.assign(entry, mergeSettingsChanges({}, patch, entry)); }
          remapSavePaths(entry, successfulDescriptors, failedDescriptors);
        }
        recoveredFiles.push(...result.recoveredFiles || []);
      }
      remapSavePaths(entry, successfulDescriptors, failedDescriptors);
      const postHooks = new Set();
      for (const owner of owners) {
        if (typeof owner?.migrateLegacyGameData !== 'function' || postHooks.has(owner.migrateLegacyGameData)) continue;
        postHooks.add(owner.migrateLegacyGameData);
        try {
          const snapshot = structuredClone(entry);
          const ownRoots = new Set((descriptorsByOwner.get(owner) || []).map(row => typeof row?.mirrorRoot === 'string' ? path.resolve(row.mirrorRoot) : row?.mirrorRoot));
          const own = row => ownRoots.has(typeof row?.mirrorRoot === 'string' ? path.resolve(row.mirrorRoot) : row?.mirrorRoot);
          const result = await owner.migrateLegacyGameData(snapshot, { ...context,
            successfulDescriptors, failedDescriptors, descriptorResults,
            ownerSuccessfulDescriptors: successfulDescriptors.filter(own), ownerFailedDescriptors: failedDescriptors.filter(own) });
          if (result == null) {
            if (JSON.stringify(snapshot) !== JSON.stringify(entry)) throw Error('This game type returned an unusable recovery result (it changed the game record directly), so these files were left in place. Copy any needed files from this folder before removing the game.');
            continue;
          }
          if (result?.complete !== true) throw Error(result?.reason || 'This game type could not finish converting its earlier data, so these files were left in place. Copy any needed files from this folder before removing the game.');
          if (Object.hasOwn(result, 'entryPatch')) {
            validateEntryPatch(result.entryPatch);validateIdentity(result.entryPatch, original, true);
            successfulPatches.push(result.entryPatch);
            Object.assign(entry, mergeSettingsChanges({}, result.entryPatch, entry));
          } else if (JSON.stringify(snapshot) !== JSON.stringify(entry)) throw Error('This game type returned an unusable recovery result (it changed the game record directly), so these files were left in place. Copy any needed files from this folder before removing the game.');
          if (Object.hasOwn(result, 'retained')) {
            if (!Array.isArray(result.retained)) failures.push({ reason: 'This game type returned an unusable recovery result (an invalid list of kept folders), so these files were left in place. Copy any needed files from this folder before removing the game.' });
            else for (const row of result.retained) {
              try {
                validateEntryPatch(row);
                if (typeof row.path !== 'string' || !path.isAbsolute(row.path) || typeof row.reason !== 'string' || !row.reason.trim() ||
                  row.runtimeId !== undefined && typeof row.runtimeId !== 'string') throw Error('This game type returned an unusable recovery result (a kept folder without a full path or reason), so these files were left in place. Copy any needed files from this folder before removing the game.');
                failures.push({ mirrorRoot: path.resolve(row.path), reason: row.reason, ...(row.runtimeId ? { runtimeId: row.runtimeId } : {}) });
              } catch (error) { failures.push({ reason: error.message }); }
            }
          }
        } catch (error) { failures.push({ reason: error.message }); }
      }
      remapSavePaths(entry, successfulDescriptors, failedDescriptors);
      preserveFailedPaths(entry, original, failedDescriptors);
      retainReleasedSaveRoutes(entry, baseline, pendingRoutes, successfulDescriptors, successfulPatches, userDataDir, failures);
      validateIdentity(entry, original);
      if (typeof saveEntry === 'function') await saveEntry(entry, baseline);
      else if (JSON.stringify(original) !== JSON.stringify(entry)) throw Error('MacLauncher could not save this game\'s updated record, so these files were left in place. Copy any needed files from this folder before removing the game.');
      Object.assign(original, entry);
    } catch (error) { failures.push({ reason: error.message }); }
    if (failures.length) {
      pending.add(id);retained.set(id, { id, failures, ...(recoveredFiles.length ? { recoveredFiles } : {}) });
      logger?.warn?.('[migration] Private game data retained for manual resolution', id, failures);
    } else { pending.delete(id);retained.delete(id); }
    await checkpoint();
    await onProgress?.({ done: total - remaining.size, total });
  }
  return { settings: current, complete: remaining.size === 0, remainingIds: [...remaining], pendingIds: [...pending], retained: [...retained.values()] };
}

module.exports = { runDataMigrations, ORIGINAL_GAME_MIRRORS_MIGRATION };

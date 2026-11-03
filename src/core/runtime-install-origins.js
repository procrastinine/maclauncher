const path = require("node:path");
const { readJsonObject, writeJsonAtomic } = require("./json-files");
const { compareVersions } = require("../modules/shared/runtime/version-order");
const { usableDefaultVersion } = require("../modules/shared/runtime/version-choices");
const Architecture = require("../modules/shared/runtime/architecture");
const GameData = require("../modules/shared/game-data");

// Runtime versions that Play installed on its own: the manager's own default,
// chosen by the shared planner because no game choice, game recommendation or
// saved default named a version. Module planners never record a version, so
// what they choose stays. A game that later uses a recorded version through
// its own choice or a saved default, and explicit Install, Set default and
// removal in Runtimes, clear the record. Upkeep removes a recorded version
// through Runtimes once the current default is a newer verified version of
// the same runtime and nothing names or resolves to the recorded one.
// Versions without a record stay until they are removed from Runtimes.
const FILE = ["runtimes", "automatic-installs.json"], LIMIT = 512;
const text = value => typeof value === "string" && value !== "" ? value : null;
const same = (a, b) => a.managerId === b.managerId && String(a.version) === String(b.version) &&
  (a.sectionId || "default") === (b.sectionId || "default") && (a.variant || null) === (b.variant || null);
const valid = row => Boolean(row && text(row.managerId) && text(String(row.version ?? "")));
// Whether a settings object or game record names the version anywhere.
const names = (value, version) => { try { return JSON.stringify(value ?? null).includes(JSON.stringify(String(version))); } catch { return true; } };

function read(userDataDir) {
  const installs = readJsonObject(path.join(userDataDir, ...FILE))?.installs;
  return Array.isArray(installs) ? installs.filter(valid) : [];
}
function write(userDataDir, installs) {
  writeJsonAtomic(path.join(userDataDir, ...FILE), { schemaVersion: 1, installs: installs.slice(-LIMIT) });
}
function identity({ managerId, version, sectionId, variant }) {
  return { managerId, version: String(version), sectionId: text(sectionId) || "default", ...(text(variant) ? { variant } : {}) };
}

/** Records a version that the shared planner chose as the manager's default
 * (`plan.automatic`) and Play installed, unless it was installed before or a
 * game record or saved setting names it. Never throws. */
function recordPlayInstall({ userDataDir, manager, plan = {}, result, entry, settings, installedBefore = [], logger } = {}) {
  try {
    const version = text(String(result?.version ?? plan.version ?? ""));
    if (!userDataDir || !manager?.id || plan.automatic !== true || !version || installedBefore.includes(version)) return false;
    if (names(entry?.runtimeData, version) || names(entry?.moduleData, version) || names(settings, version)) return false;
    const row = identity({ managerId: manager.id, version, sectionId: result?.sectionId || plan.installOptions?.sectionId,
      variant: result?.variant || plan.installOptions?.variant });
    const installs = read(userDataDir).filter(item => !same(item, row));
    write(userDataDir, [...installs, { ...row, ...(text(entry?.gameId) ? { gameId: entry.gameId } : {}), installedAt: new Date().toISOString() }]);
    return true;
  } catch (error) {
    logger?.warn?.(`[runtimes] the installation origin could not be recorded: ${error?.message || error}`);
    return false;
  }
}

/** Clears a version's record after an explicit Install, Set default or removal. */
function clearRecord(userDataDir, { managerId, version, sectionId } = {}) {
  try {
    if (!userDataDir || !managerId || version == null) return;
    const installs = read(userDataDir);
    const kept = installs.filter(item => !(item.managerId === managerId && String(item.version) === String(version) &&
      (!sectionId || (item.sectionId || "default") === sectionId)));
    if (kept.length !== installs.length) write(userDataDir, kept);
  } catch {}
}

function installedRows(manager, userDataDir, settings) {
  const state = manager.getState({ userDataDir, settings: settings?.runtimes?.[manager.id], runtimeSettings: settings?.runtimes }) || {};
  const sections = state.sections?.length ? state.sections : [{ ...state, id: "default" }];
  return sections.map(section => ({ section, rows: (section.installed || []).map(row => ({ ...row, sectionId: section.id || "default" })) }));
}
function verified(row) {
  return row.ready !== false && !["damaged", "incomplete", "unsupported-host"].includes(row.status);
}
function sameBuild(a, b) {
  const left = Architecture.targetArchitecture(a.architecture), right = Architecture.targetArchitecture(b.architecture);
  return (a.variant || null) === (b.variant || null) && (!left || !right || left === right);
}

/** Removes recorded versions that a newer verified version of the same runtime
 * supersedes and that no game record, game choice or saved setting resolves
 * to, through `remove` (Runtimes' own removal). Never throws. */
async function pruneSuperseded({ userDataDir, managers = [], settings = {}, gameIds = [], isRunning = () => false, remove, logger } = {}) {
  const removed = [];
  let records;
  try { records = read(userDataDir); } catch { return { removed }; }
  if (!records.length || typeof remove !== "function") return { removed };
  const kept = [];
  let games = null;
  const loadGames = () => games ||= gameIds.map(gameId => {
    const record = readJsonObject(GameData.resolveGameDataPath(userDataDir, gameId));
    return record ? { ...record, gameId } : null;
  }).filter(Boolean);
  for (const manager of managers) {
    const own = records.filter(record => record.managerId === manager?.id);
    if (!own.length) continue;
    let sections;
    try { sections = installedRows(manager, userDataDir, settings); }
    catch { kept.push(...own); continue; }
    for (const record of own) {
      const section = sections.find(item => item.section.id === record.sectionId || !item.section.id && record.sectionId === "default");
      const current = section?.rows.find(row => same(identity({ ...row, managerId: manager.id }), record));
      // A record whose version is no longer installed has nothing left to describe.
      if (!current) continue;
      try {
        // Superseded: the section's current default is a newer verified installation of the same build.
        const latest = usableDefaultVersion(section.section);
        const superseded = latest != null && String(latest) !== String(record.version) && compareVersions(latest, record.version) > 0 &&
          section.rows.some(row => row !== current && String(row.version) === String(latest) && verified(row) && sameBuild(row, current));
        const removable = current.readOnly !== true && current.removable !== false && current.included !== true && current.external !== true;
        if (!superseded || !removable || names(settings, record.version) ||
          await referenced(manager, loadGames(), settings, userDataDir, record.version) || await isRunning()) { kept.push(record); continue; }
        await remove({ managerId: manager.id, version: current.version, sectionId: current.sectionId,
          ...(current.variant ? { variant: current.variant } : {}), ...(current.platformKey ? { platformKey: current.platformKey } : {}) });
        removed.push(identity({ ...record, managerId: manager.id }));
      } catch (error) {
        kept.push(record);
        logger?.warn?.(`[runtimes] ${manager.id} ${record.version} was kept: ${error?.message || error}`);
      }
    }
  }
  kept.push(...records.filter(record => !managers.some(manager => manager?.id === record.managerId)));
  try {
    const latest = read(userDataDir);
    // Records added while this pass ran stay.
    const next = latest.filter(row => kept.some(item => same(item, row)) || !records.some(item => same(item, row)));
    if (next.length !== latest.length) write(userDataDir, next);
  } catch {}
  if (removed.length) logger?.info?.(`[runtimes] removed ${removed.length} superseded automatic installation(s): ` +
    removed.map(row => `${row.managerId} ${row.version}`).join(", "));
  return { removed };
}
// Whether any game record names the version or resolves to it through the
// manager's own selection.
async function referenced(manager, games, settings, userDataDir, version) {
  for (const game of games) {
    if (names(game, version)) return true;
    if (typeof manager.resolveSelection !== "function") continue;
    try {
      const selection = await manager.resolveSelection(game, settings, userDataDir, { verification: "status" });
      if ([selection?.version, selection?.install?.version].some(value => value != null && String(value) === String(version))) return true;
    } catch { return true; }
  }
  return false;
}

module.exports = { recordPlayInstall, clearRecord, pruneSuperseded, read };

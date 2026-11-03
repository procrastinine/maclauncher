// Backcompat: MacLauncher v0.4 graphics fields and schema-1 effect plans.
// Converts only old records, then persists current effects once. A failed write
// keeps working graphics in memory; remove when these records are unsupported.
const StoredPlan = require("../../modules/shared/effects/stored-plan");

// v0.4.0 graphics fields are upgraded where records are read, so the app, its
// backend, shortcuts and command-line launches all see only `effects`. The
// record is rewritten once; concurrent readers write identical bytes.
function context(userDataDir, record, registry = require("../../modules/registry")) {
  const id = record.moduleId || record.engine || "unknown", declared = registry.getModuleInfo?.(id) || registry.getModule?.(id);
  const info = declared?.manifest || declared;
  const runtime = info?.runtime?.entries?.[record.runtimeId || info?.runtime?.default];
  let launch = null;
  try { launch = require("../../modules/shared/reshade/launch-binding").read(record, {userDataDir}); } catch {}
  return {userDataDir, graphicsHost: launch?.graphicsHost || runtime?.graphicsHost,
    graphicsArchitecture: launch?.graphicsArchitecture || launch?.graphicsInputs?.architecture || runtime?.graphicsArchitecture,
    graphicsInputs: launch?.graphicsInputs || null};
}
// Pure conversion is shared by the once migration and initial record boundary.
function convertGraphicsRecord(userDataDir, record, {registry} = {}) {
  if (!StoredPlan.isLegacy(record)) return record;
  // A newer/current graph already supersedes Simple fields. Preserve even an
  // invalid graph byte-equivalent, without probing old launch/provider paths.
  if (record.effects != null && record.effects?.schema !== 1) {
    const {reshade: _reshade, graphics: _graphics, ...next} = record;
    return next;
  }
  let options = {userDataDir};
  try { options = context(userDataDir, record, registry); } catch {}
  const next = StoredPlan.upgradeLegacy(record, options);
  return {...next, effects: StoredPlan.serialize(next.effects)};
}

const failed = new Map();
function upgradeRecord(userDataDir, record, write, logger = console) {
  if (!StoredPlan.isLegacy(record)) return record;
  const key = userDataDir + ':' + JSON.stringify(record);
  if (failed.has(key)) return structuredClone(failed.get(key));
  const next = convertGraphicsRecord(userDataDir, record);
  try { write(next); }
  catch (error) {
    failed.set(key, next);
    logger?.warn?.('[graphics] Converted graphics remain active in memory; the old record was retained.', String(error?.message || error));
  }
  return next;
}
module.exports = {upgradeRecord, convertGraphicsRecord};

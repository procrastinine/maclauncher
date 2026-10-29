const StoredPlan = require("../modules/shared/effects/stored-plan");

// v0.4.0 graphics fields are upgraded where records are read, so the app, its
// backend, shortcuts and command-line launches all see only `effects`. The
// record is rewritten once; concurrent readers write identical bytes.
function context(userDataDir, record) {
  const info = require("../modules/registry").getModuleInfo(record.moduleId || record.engine || "unknown");
  const runtime = info?.runtime?.entries?.[record.runtimeId || info?.runtime?.default];
  let launch = null;
  try { launch = require("../modules/shared/reshade/launch-binding").read(record, {userDataDir}); } catch {}
  return {userDataDir, graphicsHost: launch?.graphicsHost || runtime?.graphicsHost,
    graphicsArchitecture: launch?.graphicsArchitecture || launch?.graphicsInputs?.architecture || runtime?.graphicsArchitecture,
    graphicsInputs: launch?.graphicsInputs || null};
}
// A failed write keeps the upgraded record for this read; the next read retries.
function upgradeRecord(userDataDir, record, write, logger = console) {
  if (!StoredPlan.isLegacy(record)) return record;
  let options = {userDataDir};
  try { options = context(userDataDir, record); } catch {}
  const next = StoredPlan.upgradeLegacy(record, options);
  try { write({...next, effects: StoredPlan.serialize(next.effects)}); }
  catch (error) { logger?.warn?.("[graphics] Upgraded graphics settings could not be saved; the next read upgrades them again.", String(error?.message || error)); }
  return next;
}

module.exports = {upgradeRecord};

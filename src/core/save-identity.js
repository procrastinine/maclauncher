const path = require("node:path");
const { mergeSettingsChanges } = require("./settings-merge");

/** Module facts describe the effective current upstream save namespace and ID
 * (or absolute location with namespace="filesystem"). scope="global" denotes
 * intentionally shared preferences. createPatch returns ordinary visible game
 * settings supported by that upstream, never a library collision decision.
 *
 * @typedef {Object} SaveIdentity
 * @property {string} namespace
 * @property {string} identity
 * @property {"game"|"global"} [scope]
 * @property {boolean} [explicit]
 * @property {boolean} [hostSubstitution] Proven identity change caused by the host.
 * @property {function({entry: Object, gameId: string, reason: string, context: Object}): Object} [createPatch]
 */
function diagnostic(context, error) {
  try { context.logger?.debug?.("[save-identity] Optional adjustment skipped: " + error.message); }
  catch { /* Diagnostics cannot prevent a direct import. */ }
}
function synchronous(value, context) {
  if (typeof value?.then !== "function") return true;
  // A misdeclared async hook is not awaited or used, including a late rejection.
  Promise.resolve(value).catch(() => {});
  diagnostic(context, new Error("Save identity hooks must be synchronous."));
  return false;
}
function facts(entry, describe, context) {
  try {
    const value = describe?.(entry, context);
    if (!synchronous(value, context)) return null;
    // Failed/invalid module facts never fall back to a potentially stale path.
    if (value != null) return value;
    const directory = entry.saveDirOverride || entry.defaultSaveDir;
    return typeof directory === "string" && path.isAbsolute(directory)
      ? { namespace: "filesystem", identity: path.normalize(directory) } : null;
  } catch (error) { diagnostic(context, error); return null; }
}
function key(fact) {
  if (!fact || fact.scope === "global" || typeof fact.namespace !== "string" || !fact.namespace ||
      typeof fact.identity !== "string" || !fact.identity) return null;
  if (fact.namespace === "filesystem" && !path.isAbsolute(fact.identity)) return null;
  const identity = fact.namespace === "filesystem" ? path.join(fact.identity, ".") : fact.identity;
  return JSON.stringify([fact.namespace, identity]);
}

/** Apply once during a new persisted import, or explicitly from once-only
 * backcompat. This function performs no I/O and is never a Play/refresh hook.
 * describe dispatches module resolveSaveIdentity hooks against the loaded library.
 * current, when supplied, is the latest ordinary entry, not a legacy snapshot.
 */
function applySaveIdentity(entry, { games = [], describe, context = {}, current = entry } = {}) {
  try {
    const before = structuredClone(current);
    if (typeof before.gameId !== "string" || !before.gameId) return current;
    const fact = facts(before, describe, context), selected = key(fact);
    if (!selected || typeof fact.createPatch !== "function") return current;
    const collision = games.some(game => game && game.gameId !== before.gameId &&
      key(facts(game, describe, context)) === selected);
    const explicit = fact.explicit || Boolean(before.saveDirOverride);
    const reason = collision ? "collision" : fact.hostSubstitution && !explicit ? "host-substitution" : null;
    if (!reason) return current;
    const patch = fact.createPatch({ entry: before, gameId: before.gameId, reason, context });
    if (patch == null || !synchronous(patch, context)) return current;
    const record = value => value && typeof value === "object" && !Array.isArray(value);
    const optionalPath = value => value == null || typeof value === "string";
    const fields = { launchArguments: value => typeof value === "string", saveDirOverride: optionalPath,
      defaultSaveDir: optionalPath, runtimeData: record,
      saveLocations: value => Array.isArray(value) && value.every(item => record(item) && typeof item.directory === "string") };
    if (!record(patch) || Object.keys(patch).some(field => !Object.hasOwn(fields, field) || !fields[field](patch[field]))) {
      diagnostic(context, new Error("Save identity changes need ordinary visible game settings."));
      return current;
    }
    const after = mergeSettingsChanges({}, patch, before);
    return mergeSettingsChanges(before, after, current);
  } catch (error) { diagnostic(context, error); return current; }
}

module.exports = { applySaveIdentity };

const Shaders = require("./managed-shaders");
const { isAbortError, throwIfAborted } = require("../runtime/download-utils");
const warn = require("../graphics-warning");

// The managed shader effects that the plan's enabled rows use.
function requested(plan, shaders) {
  const ids = new Set();
  for (const node of plan.enabled === false ? [] : plan.video || []) {
    if (!node.enabled || node.kind !== "shader") continue;
    for (const id of node.shader.preset === "chain" ? node.shader.effects || [] : [node.shader.preset]) if (shaders.isId(id)) ids.add(id);
  }
  return ids;
}
// The collection downloads those rows need, one per collection. Reading them is offline.
function downloads(plan, options = {}, dependencies = {}) {
  const shaders = dependencies.shaders || Shaders, plans = new Map();
  for (const id of requested(plan, shaders)) {
    const download = shaders.missingEffectPlan(options.userDataDir, id, options);
    if (download && !plans.has(download.installOptions.sectionId)) plans.set(download.installOptions.sectionId, download);
  }
  return [...plans.values()];
}
// Discovery and acquisition belong to preparation; catalog/status reads stay offline.
async function prepare(plan, options = {}, dependencies = {}) {
  if (!(options.acquireShaders ?? options.launchPreparation === true) || typeof options.confirmRuntimeInstall !== "function") return;
  const shaders = dependencies.shaders || Shaders, acquired = new Set();
  for (const id of requested(plan, shaders)) {
    throwIfAborted(options.signal);
    try {
      const download = shaders.missingEffectPlan(options.userDataDir, id, options);
      if (!download || acquired.has(download.installOptions.sectionId)) continue;
      acquired.add(download.installOptions.sectionId);
      // installRuntime asks once, before fetching either versions or sources.
      const result = await shaders.installRuntime({ ...options, ...download.installOptions, version: download.version });
      if (result) await options.onRuntimeStateChange?.({ managerId: shaders.ID });
    } catch (error) {
      throwIfAborted(options.signal);
      if (!isAbortError(error)) warn(options.logger, "The shader collection could not be installed.", error.message);
    }
  }
}
module.exports = { prepare, downloads };

const Shaders = require("./managed-shaders");
const { isAbortError, throwIfAborted } = require("../runtime/download-utils");
const warn = require("../graphics-warning");

// Discovery and acquisition belong to preparation; catalog/status reads stay offline.
async function prepare(plan, options = {}, dependencies = {}) {
  if (!(options.acquireShaders ?? options.launchPreparation === true) || typeof options.confirmRuntimeInstall !== "function") return;
  const shaders = dependencies.shaders || Shaders, requested = new Set(), acquired = new Set();
  for (const node of plan.enabled === false ? [] : plan.video || []) {
    if (!node.enabled || node.kind !== "shader") continue;
    for (const id of node.shader.preset === "chain" ? node.shader.effects || [] : [node.shader.preset]) if (shaders.isId(id)) requested.add(id);
  }
  for (const id of requested) {
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
module.exports = { prepare };

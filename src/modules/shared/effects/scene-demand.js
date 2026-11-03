const Contracts = require("./operation-contracts.mjs");

// The scene inputs that the enabled rows of a saved plan consume. Engine and
// API adapters that supply scene inputs prepare only for this demand; an
// empty result keeps the game's original launch route.
function sceneDemand(entry, context = {}, {root, graphicsHost, graphicsArchitecture} = {}) {
  const plan = require("./plan.mjs").salvage(entry?.effects).plan;
  if (!plan || plan.enabled === false) return [];
  const inputs = new Set(), add = requirements => Contracts.sceneInputNames(requirements).forEach(name => inputs.add(name));
  for (const node of plan.video) {
    if (!node.enabled) continue;
    const neural = Contracts.NEURAL[node.method], operation = node.kind === "temporal" ? Contracts.TEMPORAL[node.method]
      : node.kind === "frame-generation" ? Contracts.GENERATION[node.method] : null;
    const scene = neural ? neural.kind === node.kind && neural.history === "scene"
      : operation && (node.kind === "temporal" || operation.scene === true);
    if (scene) add(["depth", "motion", ...(operation?.matrices ? ["viewMatrix", "projectionMatrix"] : operation?.camera ? ["camera"] : []), ...(operation?.requires || [])]);
    if (node.kind !== "shader") continue;
    // Only selected source metadata is inspected; its shared cache revalidates
    // source/dependency identity. A fresh implicit FX input remains unknown
    // until ordinary shader preparation reports its compiled requirements.
    const shaders = node.shader.preset === "chain" ? (node.shader.effects || []).map(preset => ({...node.shader, preset})) : [node.shader];
    for (const shader of shaders) try {
      const selected = require("../reshade").resolveShaderSelection({reshade: {...shader, enabled: true}},
        {userDataDir: context.userDataDir, settings: context.settings, graphicsHost, graphicsArchitecture, ...(root ? {root} : {})});
      if (!selected || selected.traits?.sourceError) continue;
      add(selected.requirements);add(selected.traits?.sceneInputs);
      add(require("../reshade/shader-scene-bindings").requirements(selected.sceneBindings || selected.traits?.sceneBindings));
    } catch {} // Unknown or invalid optional metadata never authorizes adapter preparation.
  }
  return [...inputs];
}

module.exports = { sceneDemand };

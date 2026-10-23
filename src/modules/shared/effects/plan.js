const Model = require("./plan.mjs");
const Graphics = require("../reshade/graphics-settings");
function validate(value) {
  const plan = Model.validate(value), ReShade = require("../reshade");
  plan.video = plan.video.map(node => {
    if (node.kind === "neural") {
      if (node.method !== "mlx-dlss") throw new Error("Choose an available neural rendering method.");
      return { ...node, settings: require("../reshade/neural").settings(node.settings) };
    }
    if (node.kind !== "shader") return { ...node, settings: Graphics.updateStageSettings({}, { ...node.settings,
      [node.kind === "spatial" ? "spatialMethod" : node.kind === "temporal" ? "temporalMethod" : "frameGeneration"]: node.method }) };
    // Advanced rows have their own native parameter map, outside the legacy
    // 128-uniform live packet. Validate ordinary shader fields separately.
    const { parameters, ...settings } = node.shader;
    return { ...node, shader: { ...ReShade.updateSettings(settings, { ...settings, enabled: true }),
      ...(parameters != null ? { parameters } : {}) } };
  });
  return plan;
}
function normalize(value) { try { return validate(value); } catch { return null; } }
function fromLegacy(entry = {}) {
  const advanced = normalize(entry.effects); if (advanced) return advanced;
  return validate(Model.fromLegacy({ reshade: require("../reshade").normalizeSettings(entry.reshade), graphics: Graphics.normalizeSettings(entry.graphics) }));
}
function composeSimple(entry = {}, options = {}) {
  const advanced = normalize(entry.effects); if (advanced) return advanced;
  return validate(Model.composeSimple({ reshade: require("../reshade").normalizeSettings(entry.reshade), graphics: Graphics.normalizeSettings(entry.graphics) }, options));
}
function reconstructionPreset(entry = {}, options = {}) {
  return validate(Model.reconstructionPreset({ reshade: require("../reshade").normalizeSettings(entry.reshade), graphics: Graphics.normalizeSettings(entry.graphics) }, options));
}
const label = { nearest: "Nearest neighbor", bicubic: "Bicubic", bilinear: "Bilinear", metalfx: "MetalFX", fsr1: "AMD FSR 1", fsr2: "AMD FSR 2", fsr3: "AMD FSR 3", fsr4: "AMD FSR 4", mako: "Mako", ls1: "Lossless Scaling LS1", lsfg: "Lossless Scaling Frame Generation", libplacebo: "libplacebo" };
function catalog({ reshadeState = {}, graphicsCapabilities = {}, graphicsInputs = null, graphicsHost, graphicsSettings, neuralProvider } = {}) {
  const rows = [], support = graphicsHost !== undefined && graphicsCapabilities.hosts ? graphicsCapabilities.hosts[graphicsHost] || {} : graphicsCapabilities,
    settings = Graphics.normalizeSettings(graphicsSettings), Packs = require("../reshade/shader-packs");
  for (const preset of reshadeState.presets || []) {
    const requirements = [...(Packs.lookup(preset.id)?.effect.requires || [])];
    const depth = requirements.includes("depth") || Array.isArray(preset.depthHosts);
    const reason = preset.traits?.requiresVideoPlanes && graphicsInputs?.nativeVideo !== true ? "This shader requires separate video luma and chroma planes." :
      reshadeState.available !== true ? reshadeState.reason || "Shader effects are unavailable for this runtime." :
      preset.available === false ? preset.reason || "This shader is unavailable." :
      depth && graphicsInputs?.depth !== true ? "This shader requires depth from the current game." :
      depth && preset.depthHosts && !preset.depthHosts.includes(graphicsHost) ? "This shader requires depth from the current presentation path." : null;
    const category = preset.traits?.category;
    const scaling = ["upscaling", "downscaling", "scaling"].includes(category);
    rows.push({ id: /^(shader|filter):/.test(preset.id) ? preset.id : "shader:" + preset.id, kind: "shader", label: preset.label,
      group: scaling ? category === "downscaling" ? "Downscaling" : "Upscaling" : "Shaders and filters",
      category: scaling ? category === "scaling" ? "Resolution-dependent shaders" : preset.traits.neural ? "Neural shaders" : "Scaling shaders"
        : category === "restoration" ? "Restoration and denoise" : category === "chroma" ? "Chroma reconstruction"
          : category === "crt" ? "CRT" : category === "color" ? "Colour" : preset.group || "Effects",
      template: { kind: "shader", enabled: true, shader: { enabled: true, preset: preset.id,
        ...(preset.id === "custom" ? { effectPath: null } : {}) } },
      available: !reason, ...(reason ? { reason } : {}), requirements });
  }
  const models = reshadeState.models || [], modelFor = requirement => settings.modelVersion
    ? models.find(model => model.version === settings.modelVersion && model.capabilities?.includes(requirement))
    : models.find(model => model.version === reshadeState.defaultModelVersion && model.capabilities?.includes(requirement)) || models.find(model => model.capabilities?.includes(requirement));
  for (const kind of ["spatial", "temporal", "frame-generation"]) {
    const methods = kind === "spatial" ? [...new Set([...Graphics.SPATIAL_METHODS, "downsample", ...(support.spatialMethods || [])])].filter(method => method !== "off") :
      kind === "temporal" ? [...new Set([...Graphics.TEMPORAL_METHODS, ...(support.cameraTemporalMethods || [])])].filter(method => method !== "off") : ["lsfg"];
    for (const method of methods) {
      const requirements = kind === "temporal" ? ["temporal-inputs"] : [];
      const supported = kind === "spatial" ? support.spatial === true && support.spatialMethods?.includes(method === "downsample" ? "bilinear" : method) :
        kind === "temporal" ? support.temporal === true && (support.temporalMethods?.includes(method) || support.cameraTemporalMethods?.includes(method)) :
          support.frameGeneration === true && support.frameGenerationMethods?.includes(method);
      const inputs = kind !== "temporal" || graphicsInputs?.methods?.includes(method) &&
        (graphicsInputs.cameraProjection === true || graphicsInputs.depth === true && graphicsInputs.motionVectors === true);
      const requiredModel = method === "ls1" ? settings.ls1Mode === "quality" ? "ls1Quality" : "ls1Performance" :
        kind === "frame-generation" ? "lsfg" + (settings.lsfgFp16 ? "Fp16" : "Fp32") + (settings.lsfgMode === "quality" ? "Quality" : "Performance") : null;
      const model = requiredModel && modelFor(requiredModel); if (requiredModel) requirements.push("models");
      const runtimeReason = !supported ? "This method is unavailable for the current graphics runtime." : !inputs ? "This method requires compatible game depth and motion inputs." : null;
      const reason = runtimeReason || (requiredModel && !model ? "Compatible Lossless Scaling models are required." : null);
      const category = method === "metalfx" ? "MetalFX" : /^fsr\d$/.test(method) ? "AMD FidelityFX" : ["ls1", "lsfg"].includes(method) ? "Lossless Scaling" : "Standard filters";
      rows.push({ id: kind + ":" + method, kind, label: method === "downsample" ? "Downsample" : support.spatialMethodLabels?.[method] || label[method] || (method.startsWith("libplacebo:") ? method.slice(11).replace(/_/g, " ") : method),
        group: kind === "spatial" ? method === "downsample" ? "Downscaling" : "Upscaling" : kind === "temporal" ? "Temporal scaling" : "Frame generation", category,
        template: { kind, enabled: true, method, settings: { ...settings,
          [kind === "spatial" ? "spatialMethod" : kind === "temporal" ? "temporalMethod" : "frameGeneration"]: method,
          ...(kind === "spatial" ? { spatialMultiplier: method === "downsample" ? .5 : null } : {}), ...(model ? { modelVersion: model.version } : {}) } },
        available: !reason, ...(requiredModel ? {availableWithoutModel: !runtimeReason} : {}), ...(reason ? { reason } : {}), requirements });
    }
  }
  rows.push({ id: "neural:mlx-dlss", kind: "neural", label: "DLSS 5 · Experimental", group: "Neural rendering",
    template: { kind: "neural", enabled: true, method: "mlx-dlss", settings: { ...require("../reshade/neural").DEFAULTS } },
    available: Boolean(neuralProvider), ...(!neuralProvider ? { reason: "Requires the optional Apple Silicon neural rendering provider and a local model." } : {}), requirements: ["neural-model"] });
  return rows;
}
module.exports = { MAX_NODES: Model.MAX_NODES, MAX_PARAMETERS: Model.MAX_PARAMETERS, validate, normalize, fromLegacy, composeSimple, reconstructionPreset, catalog,
  simpleGenerationLayout: value => Model.simpleGenerationLayout(validate(value)),
  orderSimple: (value, options) => Model.orderSimple(validate(value), options),
  validateOrdering: (value, capabilities) => Model.validateOrdering(validate(value), capabilities) };

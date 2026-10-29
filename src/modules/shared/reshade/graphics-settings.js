const fs = require("node:fs"), path = require("node:path");
const Models = require("./models");
const SourceResolution = require("./source-resolution");
const ShaderSettings = require("./shader-settings");
const warn = require("../graphics-warning");
const {GENERATION}=require("../effects/operation-contracts.mjs"),{libplaceboFilterLabel}=require("../effects/presentation.mjs");
const generationMethod=value=>value==="off"||Object.hasOwn(GENERATION,value);
const SPATIAL_METHODS = Object.freeze(["off", "bilinear", "metalfx", "fsr1", "mako", "ls1", "nearest", "bicubic"]);
const TEMPORAL_METHODS = Object.freeze(["off", "metalfx", "metalfx-denoised", "fsr2", "fsr3", "fsr4", "xess", "asr", "sgsr2"]);
const RESOLUTION_MULTIPLIERS = Object.freeze([1, 1.5, 2, 3]);
const spatialMethod = value => value === "area" || SPATIAL_METHODS.includes(value) || typeof value === "string" && /^libplacebo:[a-z][a-z0-9_-]{0,63}$/.test(value);
function supportsSpatialMethod(support, method, direction) {
  if (support?.spatial !== true) return false;
  if (method === "area") return direction === "downsample" && support.resizeAPI >= 2;
  if(method?.startsWith("libplacebo:")&&direction==="downsample")return support.downsampleMethods?.includes(method)===true;
  return support.spatialMethods?.includes(method) === true || direction === "downsample" && support.downsampleMethods?.includes(method) === true;
}
const unavailable = message => Object.assign(new Error(message), {code: "GRAPHICS_OPTIONAL_UNAVAILABLE"});
const DEFAULTS = Object.freeze({ spatialMethod: "off", spatialShader: null, spatialMultiplier: null, spatialSharpness: 0.5, temporalMethod: "off", temporalSharpness: 0.5, asrQuality:"quality", fsr4Profile:"exact-fast", xessBackend:"auto", effectPlacement: "before", ls1Mode: "quality", frameGeneration: "off",
  frameMultiplier: 2, framePacing: "fixed", targetFps: 120, smoothCadence: false,
  lsfgMode: "quality", lsfgFp16: true, lsfgFlowScale: 1, modelVersion: null,
  neuralMethod: "off", neuralModelPath: null, neuralInputHeight: null, neuralInputScale: null, neuralIntensity: 1, neuralTemporal: false });
const within = (value, minimum, maximum) => typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
function normalizeSpatialShader(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.enabled === false || typeof value.preset !== "string") return null;
  try { return { ...ShaderSettings.updateSettings(value, value), enabled: true }; }
  catch { return null; }
}
const valid = {
  spatialMethod,
  spatialShader: value => value === null || Boolean(value && typeof value === "object" && !Array.isArray(value) && value.enabled === false) || normalizeSpatialShader(value) !== null,
  neuralMethod: value => value === "off" || value === "mlx-dlss",
  neuralModelPath: value => value === null || typeof value === "string" && value.length <= 4096 && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value),
  neuralInputHeight: value => value === null || Number.isInteger(value) && within(value, 1, 16384),
  neuralInputScale: value => value === null || [.25, .5, 2 / 3, 1].includes(value),
  neuralIntensity: value => within(value, 0, 1),
  neuralTemporal: value => typeof value === "boolean",
  temporalMethod: value => TEMPORAL_METHODS.includes(value),
  temporalSharpness: value => within(value, 0, 1),
  asrQuality: value => ["quality","balanced","performance","ultra-performance"].includes(value),
  fsr4Profile: value => ["exact-fast","lite","lite2"].includes(value),
  xessBackend: value => ["auto","d3d12","vulkan"].includes(value),
  effectPlacement: value => ["before", "after"].includes(value),
  spatialMultiplier: value => value === null || SourceResolution.REQUEST_DIVISORS.includes(value),
  spatialSharpness: value => within(value, 0, 1), ls1Mode: value => ["quality", "performance"].includes(value),
  frameGeneration: generationMethod,
  frameMultiplier: value => Number.isInteger(value) && within(value, 2, 5),
  framePacing: value => ["fixed", "adaptive"].includes(value),
  targetFps: value => Number.isInteger(value) && within(value, 30, 240),
  smoothCadence: value => typeof value === "boolean",
  lsfgMode: value => ["quality", "performance"].includes(value), lsfgFp16: value => typeof value === "boolean",
  lsfgFlowScale: value => within(value, 0.25, 1),
  modelVersion: value => value === null || typeof value === "string" &&
    (/^sha256-[a-f0-9]{64}$/.test(value) || value.startsWith("/") && value.length <= 4096 && !/[\0\r\n]/.test(value))
};
function normalizeSettings(value) {
  const spatialShader = normalizeSpatialShader(value?.spatialShader);
  const result = Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [key,
    key === "spatialShader" ? spatialShader : valid[key](value?.[key]) ? value[key] : fallback]));
  if (spatialShader) result.spatialMethod = "off";
  return result;
}
function updateSettings(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.entries(patch).some(([key, value]) => !valid[key]?.(value)))
    throw new Error("Choose supported graphics settings.");
  const next = { ...normalizeSettings(current), ...patch };
  if (Object.hasOwn(patch, "spatialMethod")) {
    if (patch.spatialMethod !== "off" || !patch.spatialShader) next.spatialShader = null;
  } else if (patch.spatialShader) next.spatialMethod = "off";
  return normalizeSettings(next);
}
// Ordered stage sizes describe processing targets, independently of a renderer's
// ability to lower its own source allocation. Simple render controls stay gated.
function updateStageSettings(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Choose supported graphics settings.");
  const { spatialMultiplier, spatialMethod, ...rest } = patch;
  if (spatialMultiplier !== undefined && spatialMultiplier !== null && !within(spatialMultiplier, 1 / 16, 16))
    throw new Error("Choose a supported stage scale.");
  const result = updateSettings(current, { ...rest, ...(spatialMethod !== undefined ? { spatialMethod: spatialMethod === "downsample" ? "bilinear" : spatialMethod } : {}) });
  return { ...result, ...(spatialMultiplier !== undefined ? { spatialMultiplier } : {}) };
}
function enabled(value) { return value.spatialMethod !== "off" || Boolean(value.spatialShader) || value.frameGeneration !== "off" || Boolean(value.temporalMethod && value.temporalMethod !== "off") || value.neuralMethod === "mlx-dlss"; }
function normalizeCapabilities(graphics, presentation) {
  return { spatial: presentation?.spatial === true, resizeAPI: graphics?.resizeAPI || 0, colorPipeline:graphics?.colorPipelineAPI===1, outputColor:graphics?.outputColorAPI===1, lsfgHDR:graphics?.lsfgHDRAPI===1, shaderInputPolicy:graphics?.shaderInputPolicyAPI===1, comparison:graphics?.comparisonAPI===1, adaptiveQuality:graphics?.adaptiveQualityAPI===1, motionClarity: graphics?.motionClarityAPI === 1, depthTransforms: graphics?.depthTransformAPI === 1, depthInput: graphics?.depthInputAPI === 1, sceneGuideTransforms:graphics?.sceneGuideTransformAPI===1, sceneWindowContinuation:graphics?.sceneWindowContinuationAPI===1,
    downsampleMethods: Array.isArray(graphics?.downsampleMethods) ? graphics.downsampleMethods.filter(spatialMethod) : [],
    temporal: presentation?.temporal === true,
    temporalProfiles:graphics?.temporalProfiles||{},
    providerTemporalMethods:Array.isArray(graphics?.temporalMethods)?TEMPORAL_METHODS.filter(method=>method!=="off"&&graphics.temporalMethods.includes(method)):[],
    effectPlacement: presentation?.effectPlacement === true,
    temporalMethods: presentation?.temporal === true && Array.isArray(graphics?.temporalMethods)
      ? TEMPORAL_METHODS.filter(method => method !== "off" && graphics.temporalMethods.includes(method) &&
        (!Array.isArray(presentation.temporalMethods) || presentation.temporalMethods.includes(method))) : [],
    frameGeneration: presentation?.frameGeneration === true,
    providerGenerationMethods:Array.isArray(graphics?.frameGenerationMethods)?graphics.frameGenerationMethods.filter(method=>generationMethod(method)&&method!=="off"):[],
    adaptive: presentation?.frameGeneration === true && presentation?.adaptive === true,
    liveSwitching: presentation?.liveSwitching === true,
    resolutionMultipliers: presentation?.spatial === true && Array.isArray(presentation.resolutionMultipliers)
      ? RESOLUTION_MULTIPLIERS.filter(factor => presentation.resolutionMultipliers.includes(factor)) : [],
    ...(presentation?.resolutionScope === "metal" ? {resolutionScope: "metal"} : {}),
    ...(graphics?.spatialMethodLabels ? {spatialMethodLabels: graphics.spatialMethodLabels} : {}),
    spatialMethods: Array.isArray(graphics?.spatialMethods) ? graphics.spatialMethods.filter(method => spatialMethod(method) && method !== "off") : [],
    frameGenerationMethods: Array.isArray(graphics?.frameGenerationMethods) ? graphics.frameGenerationMethods.filter(method => generationMethod(method)&&method!=="off") : [] };
}
function capabilities(root, host, options = {}) {
  try {
    const record = require("./runtime-record").read(root);
    const graphics = { ...record.features?.graphics };
    const hardware = options.graphicsHardware || require("./hardware-support").snapshot(root, options);
    if(graphics.generationProviderAPI===1&&(!options.selectedMethods||options.selectedMethods.generation?.includes("fsr3"))&&require("./generation/fsr3").resolve(root,options))graphics.frameGenerationMethods=[...new Set([...(graphics.frameGenerationMethods||[]),"fsr3"])];
    else graphics.frameGenerationMethods=graphics.frameGenerationMethods?.filter(method=>method!=="fsr3");
    if(graphics.xessGenerationAPI===1&&(!options.selectedMethods||options.selectedMethods.generation?.includes("xess"))&&require("./xess").resolve(root,options)?.generation)
      graphics.frameGenerationMethods=[...new Set([...(graphics.frameGenerationMethods||[]),"xess"])];
    else graphics.frameGenerationMethods=graphics.frameGenerationMethods?.filter(method=>method!=="xess");
    if (!options.selectedMethods || options.selectedMethods.spatial?.some(method => method.startsWith("libplacebo:"))) try {
      const filters = JSON.parse(fs.readFileSync(path.join(root, "libplacebo/provider.json"), "utf8")).filters;
      if (Array.isArray(filters) && !require("./shader-providers").availability("libplacebo", {features: record.features?.shaders,
        graphicsArchitecture: options.graphicsArchitecture, macOSVersion: options.macOSVersion})) {
        const valid=filters.filter(filter=>typeof filter.name==="string"&&spatialMethod("libplacebo:"+filter.name));
        graphics.spatialMethods=[...new Set([...(graphics.spatialMethods||[]),...valid.filter(filter=>filter.upscale!==false).map(filter=>"libplacebo:"+filter.name)])];
        graphics.downsampleMethods=[...new Set([...(graphics.downsampleMethods||[]),...valid.filter(filter=>filter.downscale===true).map(filter=>"libplacebo:"+filter.name)])];
      }
      if (Array.isArray(filters)) graphics.spatialMethodLabels = Object.fromEntries(filters.filter(filter => typeof filter.name === "string" && spatialMethod("libplacebo:" + filter.name))
        .map(filter => ["libplacebo:" + filter.name, libplaceboFilterLabel(filter.name, typeof filter.label === "string" ? filter.label.slice(0, 256) : undefined)]));
    } catch {}
    if (options.selectedMethods) graphics.temporalMethods = graphics.temporalMethods?.filter(method => options.selectedMethods.temporal?.includes(method));
    const portable=["fsr2","fsr3","fsr4","asr","sgsr2"],providers=require("./temporal/providers").resolve(root,options,graphics.temporalMethods||[]),installed=providers.flatMap(value=>value.methods);
    graphics.temporalProfiles={...graphics.temporalProfiles,...Object.fromEntries(providers.flatMap(({methods,installed})=>
      Array.isArray(installed.profiles)?methods.map(method=>[method,[...installed.profiles]]):[]))};
    graphics.temporalMethods=graphics.temporalMethods?.filter(method=>!portable.includes(method)||installed.includes(method));
    if(graphics.xessSceneAPI===1&&(!options.selectedMethods||options.selectedMethods.temporal?.includes("xess"))&&require("./xess").resolve(root,options))
      graphics.temporalMethods=[...new Set([...(graphics.temporalMethods||[]),"xess"])];
    else graphics.temporalMethods=graphics.temporalMethods?.filter(method=>method!=="xess");
    const cameraMethods = graphics.temporalCameraAPI === 1
      ? ["fsr2", "fsr3", "asr", "sgsr2"].filter(method => graphics.temporalMethods?.includes(method)) : [];
    const normalize = (presentation, host) => {
      const result = normalizeCapabilities(graphics, presentation);
      result.hardware = hardware;
      const sharedScene=options.graphicsInputs?.sceneFrameAPI===1&&(!options.graphicsInputs.sceneDestinationAPI||graphics.sceneWindowContinuationAPI===1);
      if(sharedScene&&graphics.sharedFrameEncoder===true){result.temporal=true;result.temporalMethods=TEMPORAL_METHODS.filter(method=>method!=="off"&&graphics.temporalMethods?.includes(method));}
      // Normalized Metal scene guides are portable between providers. The
      // producer's original API selection does not restrict XeSS execution.
      if(result.temporal&&graphics.xessSceneAPI===1&&graphics.temporalMethods?.includes("xess"))result.temporalMethods=[...new Set([...result.temporalMethods,"xess"])];
      if (graphics.virtualWindowAPI === 1 && host === "window" && result.spatial) result.virtualWindow = true;
      if (graphics.virtualSourceControlAPI === 1 && result.virtualWindow) result.virtualSourceControl = true;
      if (graphics.virtualSourceActivationAPI === 1 && result.virtualSourceControl)
        result.virtualWindow = {activationAPI: 1, ...(graphics.virtualSourceAutoAPI === 1 ? {autoAPI: 1} : {}),
          ...(graphics.virtualSourcePercentageAPI === 1 ? {percentageAPI: 1} : {}),
          ...(graphics.virtualSourceChannelAPI === 1 ? {channelAPI: 1} : {})};
      result.resolutionMultipliers = SourceResolution.capabilities(host, options.graphicsInputs, result.resolutionMultipliers, result.virtualWindow).multipliers;
      result.cameraTemporalMethods = result.temporal ? cameraMethods : [];
      if (result.temporal && options.graphicsInputs?.cameraProjection === true) {
        result.temporalMethods = TEMPORAL_METHODS.filter(method => result.temporalMethods.includes(method) ||
          result.cameraTemporalMethods.includes(method));
      }
      return result;
    };
    const result = normalize(graphics?.presentation, host);
    if (graphics?.presentation?.hosts) {
      const hosts = Object.fromEntries(["window", "remote", "explicit", "catalyst"].map(key => [key,
        normalize(graphics.presentation.hosts[key], key)]));
      if (host !== undefined) return hosts[host] || normalizeCapabilities(null, null);
      return { ...result, hosts };
    }
    return result;
  } catch { return normalizeCapabilities(null, null); }
}
async function prepare(value, { root, userDataDir, signal, graphicsHost = null, graphicsInputs = null, graphicsCapabilities, resolveModel = Models.resolveModel, useModel, logger,allowPendingInputs=false,stageDirection } = {}) {
  const settings = normalizeSettings(value);
  if (!enabled(settings) && settings.effectPlacement === "before") return {};
  const support = graphicsCapabilities || capabilities(root, graphicsHost, { graphicsInputs });
  if (settings.effectPlacement === "after" && !support.effectPlacement)
    throw unavailable("This graphics runtime requires ReShade effects before spatial scaling. Choose Before spatial scaling.");
  const placementEnvironment = support.effectPlacement ? { RESHADE_EFFECT_PLACEMENT: settings.effectPlacement } : {};
  if (!enabled(settings)) return placementEnvironment;
  if (settings.temporalMethod !== "off" && !(support.temporal&&support.temporalMethods.includes(settings.temporalMethod)||allowPendingInputs&&support.providerTemporalMethods?.includes(settings.temporalMethod)))
    throw unavailable("The selected temporal scaler requires an available implementation and compatible game inputs. Choose Game default or an available method.");
  if(settings.temporalMethod==="fsr4"&&!(support.temporalProfiles?.fsr4||["exact-fast"]).includes(settings.fsr4Profile))
    throw unavailable("This FSR 4 profile is not included in the selected graphics processor.");
  if (settings.spatialMethod !== "off" && !supportsSpatialMethod(support,settings.spatialMethod,stageDirection))
    throw unavailable("The selected spatial scaler cannot be presented by this graphics runtime. Disable scaling or choose an available method.");
  const sourceSupport = SourceResolution.capabilities(graphicsHost, graphicsInputs, support.resolutionMultipliers, support.virtualWindow);
  const sourceRequested = settings.spatialMethod !== "off" && settings.spatialMultiplier !== null;
  const sourceAvailable = sourceRequested && sourceSupport.multipliers.includes(settings.spatialMultiplier);
  if (sourceRequested && !sourceAvailable) {
    if (sourceSupport.control || graphicsHost === "explicit")
      throw unavailable("This graphics runtime cannot use the selected render resolution. Choose Auto or an available resolution multiplier.");
    warn(logger, "[Graphics] This renderer retains its source resolution; keeping the selected spatial filter.");
  }
  if (settings.frameGeneration !== "off" && !(support.frameGeneration&&support.frameGenerationMethods.includes(settings.frameGeneration)||allowPendingInputs&&support.providerGenerationMethods?.includes(settings.frameGeneration)))
    throw unavailable("Frame generation cannot be presented by this graphics runtime. Disable frame generation.");
  if (settings.frameGeneration !== "off" && settings.framePacing === "adaptive" && !support.adaptive)
    throw unavailable("Adaptive frame generation is unavailable for this runtime. Choose Fixed.");
  const required = [];
  if (settings.spatialMethod === "ls1") required.push(settings.ls1Mode === "quality" ? "ls1Quality" : "ls1Performance");
  if (settings.frameGeneration === "lsfg") required.push("lsfg" + (settings.lsfgFp16 ? "Fp16" : "Fp32") + (settings.lsfgMode === "quality" ? "Quality" : "Performance"));
  if (required.length) {
    if (!settings.modelVersion) throw unavailable("Choose installed models in the game's graphics options or import a compatible DLL in Runtimes → Graphics.");
    // Keep the selected model copy installed until the game closes, including
    // resize and model initialization after the original launch preparation.
    await useModel?.(settings.modelVersion);
  }
  let model;
  for (const capability of required) model = await resolveModel(userDataDir, settings.modelVersion, capability, { signal });
  return { ...placementEnvironment, RESHADE_SPATIAL_METHOD: settings.spatialMethod,
    ...(support.temporal ? { RESHADE_TEMPORAL_METHOD: settings.temporalMethod, RESHADE_TEMPORAL_SHARPNESS: String(settings.temporalSharpness) } : {}),
    ...(settings.temporalMethod==="asr"?{RESHADE_ASR_QUALITY:settings.asrQuality}:{}),
    ...(settings.temporalMethod==="fsr4"?{RESHADE_FSR4_PROFILE:settings.fsr4Profile}:{}),
    ...require("./temporal/providers").prepare(root,{},[settings.temporalMethod]),
    ...(settings.frameGeneration==="fsr3"?require("./generation/fsr3").prepare(root):{}),
    ...(sourceAvailable ? { ...SourceResolution.environment(sourceSupport),
      [["engine", "virtual"].includes(sourceSupport.control) ? "RESHADE_RENDER_MULTIPLIER" : "RESHADE_RESOLUTION_MULTIPLIER"]: String(settings.spatialMultiplier) } : {}),
    RESHADE_SPATIAL_SHARPNESS: String(settings.spatialSharpness), RESHADE_LS1_MODE: settings.ls1Mode,
    RESHADE_FRAME_GENERATION: settings.frameGeneration, RESHADE_FRAME_MULTIPLIER: String(settings.frameMultiplier),
    RESHADE_FRAME_PACING: settings.framePacing, RESHADE_TARGET_HZ: String(settings.targetFps),
    RESHADE_STABLE_CADENCE: settings.smoothCadence ? "1" : "0",
    RESHADE_LSFG_MODE: settings.lsfgMode, RESHADE_LSFG_FP16: settings.lsfgFp16 ? "1" : "0", RESHADE_LSFG_FLOW_SCALE: String(settings.lsfgFlowScale),
    ...(model ? { RESHADE_LOSSLESS_MODEL: model.modelPath } : {}) };
}
module.exports = { DEFAULTS, SPATIAL_METHODS, TEMPORAL_METHODS, RESOLUTION_MULTIPLIERS, spatialMethod, supportsSpatialMethod, normalizeSettings, updateSettings, updateStageSettings, enabled, capabilities, prepare };

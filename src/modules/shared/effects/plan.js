const Model = require("./plan.mjs");
const Graphics = require("../reshade/graphics-settings");
const Providers = require("./providers");
const Contracts=require("./contracts.mjs"),Items=require("../item-results");
const {sceneInputNames,sceneInputAvailable,sceneInputLabel,GENERATION,TEMPORAL}=require("./operation-contracts.mjs");
function validate(value) {
  const plan = Model.validate(value), ReShade = require("../reshade");
  plan.video = plan.video.map(node => {
    if (node.kind === "neural" || Providers.neural(node)) {
      if (!Providers.neural(node)) throw new Error("Choose an available neural rendering method.");
      if(Providers.descriptor(node.method).kind!==node.kind)throw new Error("The selected neural operation has a different input and output type.");
      const Neural = require("../reshade/neural");
      const {frameMultiplier,framePacing,targetFps,smoothCadence,...imageSettings}=node.settings;
      const settings=node.method === "mlx-dlss" ? Neural.settings(node.settings) : Neural.settingsForMethod ? Neural.settingsForMethod(node.method, imageSettings) : Neural.settings(imageSettings);
      if(node.kind === "frame-generation"){
        const schedule=Graphics.updateStageSettings({}, {frameGeneration:node.method,
          ...(frameMultiplier !== undefined ? {frameMultiplier} : {}), ...(framePacing !== undefined ? {framePacing} : {}),
          ...(targetFps !== undefined ? {targetFps} : {}), ...(smoothCadence !== undefined ? {smoothCadence} : {})});
        Object.assign(settings,{frameMultiplier:schedule.frameMultiplier,framePacing:schedule.framePacing,targetFps:schedule.targetFps,smoothCadence:schedule.smoothCadence});
      }
      return {...node,settings};
    }
    if (node.kind !== "shader") return { ...node, settings: Graphics.updateStageSettings({}, { ...node.settings,
      [Model.isResize(node) ? "spatialMethod" : node.kind === "temporal" ? "temporalMethod" : "frameGeneration"]: node.method }) };
    // Advanced rows have their own native parameter map, outside the legacy
    // 128-uniform live packet. Validate ordinary shader fields separately.
    const { parameters, ...settings } = node.shader;
    return { ...node, shader: { ...ReShade.updateSettings(settings, { ...settings, enabled: true }),
      ...(parameters != null ? { parameters } : {}) } };
  });
  if(plan.output?.framePacing!==undefined)plan.video=plan.video.map(node=>{
    if(node.kind!=="frame-generation")return node;
    const {framePacing,targetFps,smoothCadence,...settings}=node.settings;return {...node,settings};
  });
  return plan;
}
// The plan.mjs readers with settings and provider checks: a stored plan that
// fails them is reported through the same structured error, never read as absent.
function inspect(value) {
  if (value == null) return {plan: null};
  try { return {plan: validate(value)}; } catch (error) { return {error: Model.planError(value, error)}; }
}
function normalize(value) {
  const {plan, error} = inspect(value);
  if (error) throw Object.assign(new Error(error.message), {code: error.code});
  return plan;
}
// Row-level salvage (plan.mjs) with the same settings and provider checks.
const salvage = value => Model.salvage(value, validate);
function fromLegacy(entry = {}) {
  const advanced = normalize(entry.effects); if (advanced) return advanced;
  return validate(Model.fromLegacy({ reshade: require("../reshade").normalizeSettings(entry.reshade), graphics: Graphics.normalizeSettings(entry.graphics) }));
}
function composeSimple(entry = {}, options = {}) {
  const advanced = normalize(entry.effects); if (advanced) return advanced;
  return validate(Model.composeSimple({ reshade: require("../reshade").normalizeSettings(entry.reshade), graphics: Graphics.normalizeSettings(entry.graphics) }, options));
}
function reconstructionPreset(entry = {}, options = {}) {
  return validate(Model.reconstructionPreset({ effects:normalize(entry.effects),reshade: require("../reshade").normalizeSettings(entry.reshade), graphics: Graphics.normalizeSettings(entry.graphics) }, options));
}
// Built-in method descriptors: the display label and the operations for which
// the method is a common choice. Processor libplacebo kernels, including copies
// of the native kernels, are specialised variants unless described as general.
const METHODS = Object.freeze({ area: {label: "Area", recommended: ["downsample"]}, nearest: {label: "Nearest neighbor", recommended: ["upscale"]},
  bicubic: {label: "Bicubic", recommended: ["upscale", "downsample"]}, bilinear: {label: "Bilinear", recommended: ["upscale", "downsample"]},
  metalfx: {label: "MetalFX", recommended: ["temporal", "frame-generation"]}, "metalfx-denoised": {label: "MetalFX denoised scaling"},
  fsr1: {label: "AMD FSR 1", recommended: ["upscale"]}, fsr2: {label: "AMD FSR 2"}, fsr3: {label: "AMD FSR 3", recommended: ["temporal"]}, fsr4: {label: "AMD FSR 4"},
  xess: {label: "Intel XeSS"}, asr: {label: "Arm ASR"}, sgsr2: {label: "Snapdragon GSR 2"}, mako: {label: "Mako"}, ls1: {label: "Lossless Scaling LS1"},
  lsfg: {label: "Lossless Scaling Frame Generation", recommended: ["frame-generation"]}, libplacebo: {label: "libplacebo"},
  ...Object.fromEntries(["lanczos", "ewa_lanczos", "spline36", "mitchell", "catmull_rom"].map(name => ["libplacebo:" + name, {general: true}])) });
function modelSource(method){
  const sources=require('../reshade/neural/setup').sourcesFor(method),source=sources.find(row=>row.defaultForOperation)||sources[0];
  return source?{setupActionId:source.files?'downloadModel:'+source.version:'downloadDlssMac',label:source.label,bytes:source.bytes}:null;
}
function catalog({ reshadeState = {}, graphicsCapabilities = {}, graphicsInputs = null, graphicsHost, graphicsSettings, neuralProvider, xessProvider, xessGenerationProvider } = {}) {
  const rows = [], support = graphicsHost !== undefined && graphicsCapabilities.hosts ? graphicsCapabilities.hosts[graphicsHost] || {} : graphicsCapabilities,
    settings = Graphics.normalizeSettings(graphicsSettings), Packs = require("../reshade/shader-packs");
  const modelForOperation=method=>require("./neural-selection.mjs").selectNeuralModel(method,reshadeState.neuralModels||[],
    {defaultVersion:reshadeState.defaultNeuralModelVersion,defaultVersions:reshadeState.defaultNeuralModelVersions});
  // A shader whose metadata cannot be described is listed as unavailable with
  // its reason; the other implementations stay listed.
  for (const preset of reshadeState.presets || []) try {
    const declaredModel=preset.modelOperation||preset.traits?.modelOperation||Packs.lookup(preset.id)?.effect.modelOperation;
    const modelOperation=Providers.MODEL_OPERATIONS[declaredModel]?.kind==="attachment"?declaredModel:null;
    const modelProvider=!modelOperation||Boolean(neuralProvider&&(neuralProvider.supportedMethods||neuralProvider.descriptor?.operations||[]).includes(modelOperation));
    const modelInstalled=!modelOperation||Boolean(modelForOperation(modelOperation));
    const source=modelOperation&&modelSource(modelOperation);
    const requirements = [...new Set([...(Packs.lookup(preset.id)?.effect.requires || []),...(preset.traits?.sceneInputs||[])])];
    const depth = requirements.includes("depth") || Array.isArray(preset.depthHosts);
    if(depth&&!requirements.includes("depth"))requirements.push("depth");
    const sceneRequirements=sceneInputNames(requirements),pendingInputs=sceneRequirements.filter(name=>!sceneInputAvailable(name,graphicsInputs));
    const inputReason=pendingInputs.length?"This row waits for matching "+pendingInputs.map(sceneInputLabel).join(", ")+" inputs from the frame source.":null;
    let bindingReason;
    try{bindingReason=require("../reshade/shader-providers").traitsAvailability(preset.format,preset.traits,{features:reshadeState.shaderFeatures});}
    catch(error){bindingReason=error.message;}
    const bound= !bindingReason ? preset.traits?.sceneBindings||{} : {}, auxiliaryInputs=(preset.traits?.auxiliaryInputs||[]).filter(item=>!Object.hasOwn(bound,item.name));
    const baseReason = preset.traits?.sourceError || bindingReason || (auxiliaryInputs.length?"Requires additional shader inputs: "+auxiliaryInputs.map(item=>item.name+" ("+item.type+")").join(", ")+".":null) || (preset.traits?.requiresVideoPlanes && graphicsInputs?.nativeVideo !== true ? "This shader requires separate video luma and chroma planes." :
      reshadeState.available !== true ? reshadeState.reason || "Shader effects are unavailable for this runtime." :
      preset.available === false ? preset.reason || "This shader is unavailable." : null);
    // A curated model downloads during preparation after consent; only an
    // operation without one needs an imported model before selection.
    const reason=baseReason||(!modelProvider?"This filter requires a neural provider with relative-depth inference.":!modelInstalled&&!source?"Import a compatible model in Runtimes.":null);
    const category = preset.traits?.category;
    const outputContract=preset.outputContract||require("../reshade/shader-traits").outputContract(preset.traits);
    // Groups follow the ordinary menus of the shared geometry classifier.
    const scaling=Contracts.catalogGroup({template:{kind:"shader"},outputContract,traits:preset.traits})==="Resize",
      extent=Contracts.defaultShaderExtent({traits:preset.traits,outputContract});
    rows.push({ id: /^(shader|filter):/.test(preset.id) ? preset.id : "shader:" + preset.id, kind: "shader", label: preset.label,
      group: scaling ? "Resize" : "Image filters",
      category: scaling ? preset.traits?.neural ? "Neural shaders" : "Scaling shaders"
        : category === "restoration" ? "Restoration and denoise" : category === "chroma" ? "Chroma reconstruction"
          : category === "crt" ? "CRT" : category === "color" ? "Colour" : preset.group || "Effects",
      ...(typeof preset.collection==="string"?{collection:preset.collection}:{}),...(typeof preset.collection==="string"&&preset.recommendationRank!==0?{recommendationRank:3}:{}),
      // A pack label prefixed to the effect's name is its family. Effects that
      // read renderer depth share the Depth purpose.
      ...(typeof preset.group==="string"&&preset.label?.startsWith(preset.group+" · ")?{family:preset.group}:{}),
      ...(depth||preset.purpose?{purpose:depth?"Depth":preset.purpose}:{}),
      ...(preset.traits?{traits:preset.traits}:{}),...(preset.sourceRevision?{sourceRevision:preset.sourceRevision}:{}),
      ...(modelOperation?{modelOperation,runtimeManagerId:"graphics-neural-models",...(source?{modelSource:source}:{})}:{}),
      ...(preset.traits?.preservesCoordinates===true?{preservesCoordinates:true,coordinateTransform:"identity",preservesSceneInputs:true}:{}),
      ...(support.colorPipeline&&support.shaderInputPolicy&&preset.traits?.inputPolicy==="srgb-sdr"?{colorPolicy:Providers.SDR_COLOR_POLICY}:{}),
      inputContract:{domain:sceneRequirements.length?"scene":"image",color:"rgb",requires:[...sceneRequirements,...(modelOperation?["model:"+modelOperation]:[]),...(preset.traits?.requiresVideoPlanes?["decoder-planes"]:[]),...auxiliaryInputs.map(item=>item.type+":"+item.name)],acceptsSynthetic:!sceneRequirements.length,...(preset.traits?.resizeContext?{requiresResizeContext:preset.traits.resizeContext}:{}),...(preset.traits?.requiresDerivedPlanes?{derives:(preset.traits.inputPlanes||[]).filter(plane=>["luma","chroma","alpha"].includes(plane))}:{})},
      outputContract,
      ...(preset.traits?.recommendedPlacement?{recommendedPlacement:preset.traits.recommendedPlacement}:{}),
      template: { kind: "shader", enabled: true,...(extent?{extent}:{}),...(modelOperation?{settings:{modelPath:null}}:{}), shader: { enabled: true, preset: preset.id,
        ...(preset.id === "custom" ? { effectPath: null } : {}) } },
      available: !reason, ...(modelOperation?{availableWithoutModel:!baseReason&&modelProvider}:{}), ...(pendingInputs.length ? {pendingInputs,availableWithoutInputs:!reason,inputReason} : {}), ...(reason ? { reason } : {}), requirements });
  } catch (error) {
    if (Items.fatal(error)) throw error;
    rows.push({ id: /^(shader|filter):/.test(preset.id) ? preset.id : "shader:" + preset.id, kind: "shader", label: preset.label, group: "Image filters",
      category: preset.group || "Effects", inputContract: {domain: "image", color: "rgb", requires: []}, outputContract: {domain: "image", sizing: "preserve"},
      template: { kind: "shader", enabled: true, shader: { enabled: true, preset: preset.id } }, available: false, reason: Items.reason(error), requirements: [] });
  }
  const models = reshadeState.models || [], modelFor = requirement =>
    models.find(model => model.version === settings.modelVersion && model.capabilities?.includes(requirement)) ||
    models.find(model => model.version === reshadeState.defaultModelVersion && model.capabilities?.includes(requirement)) || models.find(model => model.capabilities?.includes(requirement));
  for (const kind of ["downsample", "upscale", "temporal", "frame-generation"]) {
    const resize = Model.isResize({kind});
    const methods = resize ? kind === "downsample" ? [...Providers.REDUCTION, ...(support.downsampleMethods || [])] : [...new Set([...Graphics.SPATIAL_METHODS, ...(support.spatialMethods || [])])].filter(method => !["off", "area"].includes(method)) :
      kind === "temporal" ? [...new Set([...Graphics.TEMPORAL_METHODS, ...(support.cameraTemporalMethods || [])])].filter(method => method !== "off") : [...new Set(["lsfg","metalfx",...(support.providerGenerationMethods||support.frameGenerationMethods||[])])].filter(method=>method!=="mlx-interpolation");
    for (const method of methods) {
      if(Providers.neural(method))continue;
      const requirements = kind === "temporal" ? ["temporal-inputs"] : [];
      const supported = resize ? Graphics.supportsSpatialMethod(support,method,kind) :
        kind === "temporal" ? support.providerTemporalMethods?.includes(method)||support.temporal === true && (support.temporalMethods?.includes(method) || support.cameraTemporalMethods?.includes(method)) :
          support.providerGenerationMethods?.includes(method)||support.frameGeneration === true && support.frameGenerationMethods?.includes(method);
      const preferredModel = method === "ls1" ? settings.ls1Mode === "quality" ? "ls1Quality" : "ls1Performance" :
        method === "lsfg" ? "lsfg" + (settings.lsfgFp16 ? "Fp16" : "Fp32") + (settings.lsfgMode === "quality" ? "Quality" : "Performance") : null;
      const modelCapabilities=method==="ls1"?["ls1Quality","ls1Performance"]:method==="lsfg"?["lsfgFp16Quality","lsfgFp16Performance","lsfgFp32Quality","lsfgFp32Performance"]:[];
      const requiredModel=preferredModel&&([preferredModel,...modelCapabilities].find(capability=>modelFor(capability))||preferredModel);
      const stageSettings={...settings,...(method==="ls1"?{ls1Mode:requiredModel==="ls1Performance"?"performance":"quality"}:method==="lsfg"?{lsfgMode:requiredModel.endsWith("Performance")?"performance":"quality",lsfgFp16:requiredModel.includes("Fp16")}: {})};
      const model = requiredModel && modelFor(requiredModel); if (requiredModel) requirements.push("models");
      const operation=kind==="frame-generation"?GENERATION[method]:kind==="temporal"?TEMPORAL[method]:null;
      const scene=kind==="temporal"||operation?.scene===true;
      const matrices=operation?.matrices===true,camera=operation?.camera===true;
      const sceneRequirements=scene?["depth","motion",...(matrices?["viewMatrix","projectionMatrix"]:camera?["camera"]:[]),...(operation?.requires||[])]:[];
      const pendingInputs=sceneRequirements.filter(key=>!sceneInputAvailable(key,graphicsInputs));
      const xess=kind==="frame-generation"?xessGenerationProvider:xessProvider;
      const hardwareReason = ["metalfx","metalfx-denoised"].includes(method) ? require("../reshade/hardware-support").operationReason(support.hardware,
        method==="metalfx-denoised"?"denoised":kind==="frame-generation"?"interpolation":kind==="temporal"?"temporal":"spatial") : null;
      const runtimeReason = hardwareReason || (!supported ? method.startsWith("metalfx") ? "The selected graphics processor does not include this MetalFX operation." : "This method is unavailable for the current graphics runtime." :
        method==="fsr4"&&!(support.temporalProfiles?.fsr4||["exact-fast"]).includes(settings.fsr4Profile)?"This FSR 4 profile is not included in the selected graphics processor.":null);
      const reason = runtimeReason || (method==="xess"&&xess?.available!==true?xess?.reason||"Install the Intel XeSS runtime and a compatible GPU compute host.":null) || (requiredModel && !model ? "Compatible Lossless Scaling models are required." : null);
      const category = method.startsWith("metalfx") ? "MetalFX" : method==="xess"?"Intel XeSS":/^fsr\d$/.test(method) ? "AMD FidelityFX" : ["ls1", "lsfg"].includes(method) ? "Lossless Scaling" : "Standard filters";
      rows.push({ id: kind + ":" + method, kind, label: method === "downsample" ? "Downsample" : support.spatialMethodLabels?.[method] || METHODS[method]?.label || (method.startsWith("libplacebo:") ? require("./presentation.mjs").libplaceboFilterLabel(method.slice(11)) : method),
        group: resize ? "Resize" : "Temporal", category,
        ...(["ls1","lsfg"].includes(method)?{traits:{neural:true}}:{}),
        ...(method==="fsr4"?{profiles:support.temporalProfiles?.fsr4||["exact-fast"]}:{}),
        ...(method==="xess"?{backends:xess?.backends||[],runtimeManagerId:"graphics-xess",availableWithoutRuntime:xess?.availableWithoutRuntime===true}:{}),
        ...(support.colorPipeline&&["ls1","lsfg"].includes(method)?{colorPolicy:method==="lsfg"&&support.lsfgHDR?Providers.SCRGB_COLOR_POLICY:Providers.SDR_COLOR_POLICY}:{}),
        inputContract:{domain:scene?"scene":kind==="frame-generation"?"image-pair":"image",color:"rgb",requires:[...sceneRequirements,...(kind==="frame-generation"?["opaque"]:[])],acceptsSynthetic:!scene},
        outputContract:{domain:kind==="frame-generation"?"timeline":"image",sizing:resize?"stage":kind==="temporal"?"scene-output":"preserve",...(resize?{direction:kind,extentEditable:true}:{}),...(kind==="frame-generation"?{phases:scene?"midpoint":"explicit",maximumMultiplier:scene?2:5,...(scene?{syntheticFrames:"passthrough"}:{})}:{})},
        template: { kind, enabled: true, method, settings: { ...stageSettings,
          [resize ? "spatialMethod" : kind === "temporal" ? "temporalMethod" : "frameGeneration"]: method,
          ...(resize ? { spatialMultiplier: null } : {}), ...(kind==="frame-generation"&&scene?{frameMultiplier:2}:{}), ...(model ? { modelVersion: model.version } : {}) },
          ...(kind === "downsample" ? {extent: {relativeTo: "input", factor: .5}} : {}) },
        available: !reason, ...(kind==="frame-generation"?{acceptsSynthetic:!scene}:{}), preservesCoordinates: resize && support.depthTransforms === true || kind === "temporal" && support.depthTransforms === true,
        coordinateTransform: resize || kind === "temporal" ? "scale" : "unknown", preservesSceneInputs:(resize||kind==="temporal")&&support.sceneGuideTransforms===true,
        ...(pendingInputs.length?{pendingInputs,availableWithoutInputs:!!supported&&!hardwareReason,inputReason:"This row waits for matching "+pendingInputs.map(sceneInputLabel).join(", ")+" inputs from the frame source."}:{}),
        ...(requiredModel ? {availableWithoutModel: !runtimeReason} : {}), ...(reason ? { reason } : {}), requirements });
    }
  }
  for (const [method, provider] of Object.entries(Providers.NEURAL)) {
    const source=modelSource(method);
    const providerAvailable = Boolean(neuralProvider && (neuralProvider.supportedMethods || neuralProvider.descriptor?.operations || ["mlx-dlss"]).includes(method));
    const model=modelForOperation(method),available=Boolean(providerAvailable&&(model||source)),scale=model?.intrinsicScale||provider.scale;
    const pendingInputs=provider.kind==="temporal"?["depth","motion"].filter(name=>!sceneInputAvailable(name,graphicsInputs)):[];
    rows.push({id: provider.kind + ":" + method, kind: provider.kind,
    label: provider.label, group: provider.kind === "upscale" ? "Resize" : ["temporal","frame-generation"].includes(provider.kind) ? "Temporal" : "Image filters", intrinsicScale: scale, runtimeManagerId:"graphics-neural-models", modelOperation:method,
    ...(source?{modelSource:source}:{}),...(provider.scales?{intrinsicScales:[...provider.scales]}:{}),
    ...(support.colorPipeline?{colorPolicy:Providers.SDR_COLOR_POLICY}:{}),
    inputContract:{domain:provider.kind==="temporal"?"scene":provider.kind==="frame-generation"?"image-pair":"image",color:"rgb",requires:provider.kind==="temporal"?["depth","motion","jitter","pre-exposure"]:[],acceptsSynthetic:provider.kind!=="temporal",history:provider.history},
    outputContract:{domain:provider.kind==="frame-generation"?"timeline":"image",sizing:scale!==1?"intrinsic":"preserve",scale,...(scale>1?{direction:"upscale"}:{}),...(provider.kind==="frame-generation"?{phases:"explicit",maximumMultiplier:5}:{})},
    preservesCoordinates: provider.kind !== "frame-generation" && (provider.scale === 1 || support.depthTransforms === true), coordinateTransform: provider.scale === 1 ? "identity" : "scale", preservesSceneInputs:provider.kind!=="frame-generation"&&(provider.scale===1||support.sceneGuideTransforms===true),
    template: {kind: provider.kind, enabled: true, method, settings: {...require("../reshade/neural").DEFAULTS,
      ...(provider.kind === "frame-generation" ? {frameMultiplier: 2, framePacing: "fixed", targetFps: 120, smoothCadence: false} : {})}},
    available,availableWithoutModel:providerAvailable, ...(pendingInputs.length?{pendingInputs,availableWithoutInputs:available,inputReason:"This row waits for matching depth and motion inputs from the frame source."}:{}), ...(provider.kind==="frame-generation"?{acceptsSynthetic:true}:{}), ...(!available ? {reason: !providerAvailable?neuralProvider ? "Requires an updated neural provider for this operation." : "Requires the Apple Silicon neural rendering provider and a compatible model.":"Import a compatible model in Runtimes."} : {}), requirements: ["neural-model",...(provider.kind==="temporal"?["temporal-inputs"]:[])]});
  }
  // A declared frame source lists every input it supplies. Other inputs are
  // absent rather than pending, except for methods the engine runs itself.
  const absent=row=>row.pendingInputs?.length&&typeof graphicsInputs?.source==="string"&&
    !(Array.isArray(graphicsInputs.methods)&&graphicsInputs.methods.includes(row.template.method));
  const ranked=rows.map(row=>({...row,transformType:require("./contracts.mjs").graphicsType(row.template,row),...recommendation(row,support),
    ...(absent(row)?{inputsAbsent:true,inputReason:"The frame source does not supply "+absentLabel(row.pendingInputs)+"."}:{})}));
  // Only suggested defaults move; menus order the other ranks.
  return ranked.sort((a,b)=>(a.recommendationRank!==0)-(b.recommendationRank!==0));
}
// Recommendations shared by every implementation menu. MetalFX is the
// suggested default on a GPU that supports the operation; descriptors mark the
// common choices. Installed collection files that their collection does not
// name are specialised variants.
const METALFX_OPERATION=Object.freeze({upscale:"spatial",temporal:"temporal","frame-generation":"interpolation"});
function absentLabel(inputs){
  const names=inputs.filter(name=>name!=="scene-frame").map(sceneInputLabel);
  return names.length>1?names.slice(0,-1).join(", ")+" or "+names.at(-1):names[0]||"scene inputs";
}
function recommendation(row,support){
  if(row.recommendationRank!==undefined)return {};
  const shader=row.template.kind==="shader",method=shader?row.template.shader.preset:row.template.method;
  const described=shader?require("../reshade/shader-settings").PRESETS.find(preset=>preset.id===method):METHODS[method];
  if((row.available||row.availableWithoutInputs)&&method==="metalfx"&&support.hardware?.state==="ready"&&
    support.hardware.metalfx?.[METALFX_OPERATION[row.kind]]?.supported===true)return {recommendationRank:0};
  if(shader?described?.recommended===true:described?.recommended?.includes(row.template.kind))return {recommendationRank:1};
  return typeof method==="string"&&method.startsWith("libplacebo:")&&described?.general!==true?{recommendationRank:3}:{};
}
module.exports = { MAX_NODES: Model.MAX_NODES, MAX_PARAMETERS: Model.MAX_PARAMETERS, DEFAULT_PROCESSING_HEIGHT: Model.DEFAULT_PROCESSING_HEIGHT, validate, normalize, inspect, salvage, fromLegacy, composeSimple, reconstructionPreset, catalog,
  PLAN_INVALID: Model.PLAN_INVALID, PLAN_NEWER: Model.PLAN_NEWER, HELPER_ROLES: Model.HELPER_ROLES, ownsHelpers: Model.ownsHelpers,
  isResize: Model.isResize, leading: Model.leading, migrate: value => validate(Model.migrate(value)), execution: value => Model.execution(validate(value)),
  orderSimple: (value, options) => Model.orderSimple(validate(value), options),
  validateOrdering: (value, capabilities) => Model.validateOrdering(validate(value), capabilities),
  orderingFailures: (value, capabilities) => Model.orderingFailures(validate(value), capabilities) };

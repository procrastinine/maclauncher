import {NEURAL,coordinateTransform,sceneInputNames} from "./operation-contracts.mjs";
import {graphicsType,shaderResizes} from "./contracts.mjs";
export const MAX_NODES = 32;
export const MAX_PARAMETERS = 4096;
export const DEFAULT_PROCESSING_HEIGHT = 540;
export const RENDER_DIVISORS = Object.freeze([1, 1.5, 2, 3, 4]);
export const validRenderDivisor = value => typeof value === "number" && Number.isFinite(value) && value >= 1;
const kinds = new Set(["shader", "spatial", "downsample", "upscale", "temporal", "neural", "frame-generation"]);
export const isResize = node => ["spatial", "downsample", "upscale"].includes(node?.kind);
// Sizing helpers are resize rows. Their owner is a row of a kind that can
// enlarge an image; the edit operations' classifier decides which owners
// derive helpers.
export const HELPER_ROLES = Object.freeze(["input", "fit"]);
export const ownsHelpers = node => ["shader", "spatial", "upscale", "neural"].includes(node?.kind);
const rowId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes("..");
function extent(value) {
  if (!object(value)) throw new Error("Choose an effect output size.");
  if(Object.hasOwn(value,"automatic")){
    // A legacy Automatic processing input is the fixed processing height. The
    // size fields saved beside it are superseded by that height and dropped.
    // New editors generate only image factors or pixel dimensions.
    if(value.automatic!==true||Object.keys(value).some(key=>!["automatic","relativeTo","factor","width","height"].includes(key)))
      throw new Error("Choose Automatic processing size or an explicit output size.");
    return {height: DEFAULT_PROCESSING_HEIGHT};
  }
  if (Object.hasOwn(value, "relativeTo")) {
    if (Object.keys(value).some(key => !["relativeTo", "factor"].includes(key)) ||
        !["input", "presentation"].includes(value.relativeTo) || typeof value.factor !== "number" ||
        !Number.isFinite(value.factor) || value.factor < 1 / 16 || value.factor > 16)
      throw new Error("Choose an input or output scale from 1/16 to 16.");
    return {relativeTo: value.relativeTo, factor: value.factor};
  }
  const keys = Object.keys(value);
  if (!keys.length || keys.some(key => !["width", "height"].includes(key)) ||
      keys.some(key => !Number.isInteger(value[key]) || value[key] < 1 || value[key] > 16384))
    throw new Error("Effect output dimensions must be whole pixels from 1 to 16384.");
  return {...value};
}
const object = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function copy(value, depth = 0) {
  if (depth > 12) throw new Error("Effect settings are too deeply nested.");
  if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 32768 && !value.includes("\0")) return value;
  if (Array.isArray(value) && value.length <= 128) return value.map(item => copy(item, depth + 1));
  if (object(value) && Object.keys(value).length <= 128) {
    if (Object.keys(value).some(key => ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("Invalid effect settings.");
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item, depth + 1)]));
  }
  throw new Error("Effect settings must contain finite JSON values.");
}
function shaderSettings(value) {
  const { parameters, ...settings } = value, result = copy(settings);
  if (parameters === null) result.parameters = null;
  else if (parameters !== undefined) {
    if (!object(parameters) || Object.keys(parameters).length > MAX_PARAMETERS) throw new Error("A shader can contain at most 4096 parameters.");
    result.parameters = Object.fromEntries(Object.entries(parameters).map(([name, values]) => {
      if (!name || new TextEncoder().encode(name).length > 4096 || /[\x00-\x1f\x7f]/.test(name) || ["__proto__", "constructor", "prototype"].includes(name) ||
          !Array.isArray(values) || values.length < 1 || values.length > 4 || values.some(value => typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))))
        throw new Error("Shader parameters need names and one to four finite numbers.");
      return [name, [...values]];
    }));
  }
  return result;
}
// ReShade's depth-input definitions for the game's .fx rows that read depth.
// Reversal defaults to standard depth; the other values are ReShade's.
export const DEPTH_INPUT_DEFAULTS = Object.freeze({reversed: false, logarithmic: false, farPlane: 1000, multiplier: 1});
export function depthInput(value) {
  if (value === undefined || value === null) return {...DEPTH_INPUT_DEFAULTS};
  if (!object(value) || Object.keys(value).some(key => !Object.hasOwn(DEPTH_INPUT_DEFAULTS, key))) throw new Error("Choose supported depth input settings.");
  const result = {...DEPTH_INPUT_DEFAULTS, ...value}, within = (number, minimum, maximum) => typeof number === "number" && Number.isFinite(number) && number >= minimum && number <= maximum;
  if (typeof result.reversed !== "boolean" || typeof result.logarithmic !== "boolean") throw new Error("Choose whether depth is reversed or logarithmic.");
  if (!within(result.farPlane, 1, 1e6)) throw new Error("Choose a far plane from 1 to 1000000.");
  if (!within(result.multiplier, .001, 1000)) throw new Error("Choose a depth multiplier from 0.001 to 1000.");
  return result;
}
// A stored plan keeps only the values that differ from the defaults.
function storedDepthInput(value) {
  const result = depthInput(value), changed = Object.entries(result).filter(([key, item]) => item !== DEPTH_INPUT_DEFAULTS[key]);
  return changed.length ? Object.fromEntries(changed) : undefined;
}
// Schema 2 helper ownership: {id, role} naming another row of the same plan.
function ownership(node) {
  const value = node.ownedBy;
  if (!isResize(node)) throw new Error("Only resize rows can be sizing helpers.");
  if (!object(value) || !rowId(value.id) || !HELPER_ROLES.includes(value.role))
    throw new Error("A sizing helper needs its owner's row ID and an input or fit role.");
  if (Object.keys(value).length !== 2) throw new Error("Effect row ownership contains unsupported fields.");
  return {id: value.id, role: value.role};
}
// An owner is an existing, unowned row that can own helpers, with at most one
// helper per role. Dangling or invalid ownership is reported, never repaired;
// the edit operations' migration retires such helpers before validation.
function owners(video) {
  const byId = new Map(video.map(node => [node.id, node])), claimed = new Set();
  for (const node of video) {
    if (!node.ownedBy) continue;
    const owner = byId.get(node.ownedBy.id), key = node.ownedBy.id + "\n" + node.ownedBy.role;
    if (!owner) throw new Error("A sizing helper names an effect row that is not in the plan.");
    if (owner === node || owner.ownedBy) throw new Error("A sizing helper cannot own itself or belong to another helper.");
    if (!ownsHelpers(owner)) throw new Error("Only shader, scaling and neural rows can own sizing helpers.");
    if (claimed.has(key)) throw new Error("An effect row has at most one input and one fit helper.");
    claimed.add(key);
  }
}
export function validate(value) {
  if (!object(value) || ![1, 2].includes(value.schema) || value.mode !== "advanced" || !Array.isArray(value.video) || value.video.length > MAX_NODES ||
      Object.keys(value).some(key => !["schema", "mode", "video", "renderResolution", ...(value.schema === 2 ? ["enabled", "output", "depthInput"] : [])].includes(key)) ||
      value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("Choose a valid ordered effects plan.");
  let renderResolution, output;
  const depth = storedDepthInput(value.depthInput);
  if(value.output !== undefined){
    if(!object(value.output)||Object.keys(value.output).some(key=>!["motionClarity","subframes","duty","brightness","framePacing","targetFps","smoothCadence","comparison","adaptiveQuality","toneMapping"].includes(key)))throw new Error("Choose supported output settings.");
    const motion=["motionClarity","subframes","duty","brightness"].some(key=>Object.hasOwn(value.output,key)), pacing=["framePacing","targetFps","smoothCadence"].some(key=>Object.hasOwn(value.output,key));
    output={...(motion?{motionClarity:"off",subframes:2,duty:.5,brightness:1}:{}),...(pacing?{framePacing:"fixed",targetFps:120,smoothCadence:false}:{}),...value.output};
    if(motion&&(!["off","bfi","beam"].includes(output.motionClarity)||!Number.isInteger(output.subframes)||output.subframes<2||output.subframes>8||
       !Number.isFinite(output.duty)||output.duty<.125||output.duty>1||!Number.isFinite(output.brightness)||output.brightness<1||output.brightness>8))throw new Error("Choose a supported subframe count, duty and brightness.");
    if(pacing&&(!["fixed","adaptive"].includes(output.framePacing)||!Number.isInteger(output.targetFps)||output.targetFps<30||output.targetFps>240||typeof output.smoothCadence!=="boolean"))throw new Error("Choose fixed or adaptive pacing and a target from 30 to 240 Hz.");
    if(value.output.toneMapping!==undefined&&!["auto","preserve","reinhard","pbr-neutral"].includes(value.output.toneMapping))throw new Error("Choose a supported output tone mapping method.");
    if(value.output.adaptiveQuality!==undefined){
      const selected=value.output.adaptiveQuality;
      if(!object(selected)||Object.keys(selected).some(key=>!["enabled","nodeId","budgetMs","minScale","maxScale"].includes(key)))throw new Error("Choose supported adaptive quality settings.");
      const policy={enabled:true,budgetMs:8,minScale:.5,maxScale:1,...selected};
      if(typeof policy.enabled!=="boolean"||typeof policy.nodeId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(policy.nodeId)||policy.nodeId.includes("..")||!Number.isFinite(policy.budgetMs)||policy.budgetMs<.25||policy.budgetMs>1000||!Number.isFinite(policy.minScale)||!Number.isFinite(policy.maxScale)||policy.minScale<1/16||policy.maxScale>1||policy.minScale>policy.maxScale)throw new Error("Adaptive quality needs a processing row, a GPU budget and scale bounds from 6.25% to 100%.");
      output.adaptiveQuality=policy;
    }
    if(value.output.comparison!==undefined){
      const selected=value.output.comparison;
      if(!object(selected)||Object.keys(selected).some(key=>!["mode","position","gain"].includes(key)))throw new Error("Choose supported comparison settings.");
      const comparison={mode:"off",position:.5,gain:1,...selected};
      if(!["off","before","wipe","difference"].includes(comparison.mode)||!Number.isFinite(comparison.position)||comparison.position<0||comparison.position>1||!Number.isFinite(comparison.gain)||comparison.gain<1||comparison.gain>16)throw new Error("Choose a comparison mode, position from 0 to 1 and difference gain from 1 to 16.");
      output.comparison=comparison;
    }
  }
  if (value.renderResolution != null) {
    const resolution = value.renderResolution;
    if (!object(resolution) || Object.keys(resolution).some(key => !["height", "multiplier", "maximum", "method", ...(value.schema === 2 ? ["managedBy"] : [])].includes(key)) ||
        (Object.hasOwn(resolution, "managedBy") && (typeof resolution.managedBy !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(resolution.managedBy) || resolution.managedBy.includes(".."))) ||
        (Object.hasOwn(resolution, "method") && (typeof resolution.method !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(resolution.method))) ||
        (Object.hasOwn(resolution, "maximum") && (resolution.maximum !== true || !Object.hasOwn(resolution, "height"))) ||
        (Object.hasOwn(resolution, "height") && Object.hasOwn(resolution, "multiplier")) ||
        !(Object.hasOwn(resolution, "height") && Number.isInteger(resolution.height) && resolution.height >= 1 && resolution.height <= 16384 ||
          Object.hasOwn(resolution, "multiplier") && validRenderDivisor(resolution.multiplier)))
      throw new Error("Choose a render height from 1 to 16384 pixels or a render percentage above 0 and up to 100%.");
    renderResolution = { ...resolution };
  }
  const ids = new Set();
  const video = value.video.map(node => {
    if (!object(node) || typeof node.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(node.id) ||
        node.id.includes("..") || ids.has(node.id) || !kinds.has(node.kind) || typeof node.enabled !== "boolean")
      throw new Error("Effect rows need unique IDs, a supported type and an enabled state.");
    ids.add(node.id);
    if (value.schema === 1 && ["downsample", "upscale"].includes(node.kind)) throw new Error("Explicit resize rows require effects schema 2.");
    const fields = [...(node.kind === "shader" ? ["id", "kind", "enabled", "shader",...(value.schema===2?["extent","settings"]:[])] : ["id", "kind", "enabled", "method", "settings", ...(isResize(node) ? ["outputSize", "presentationScale", ...(value.schema === 2 ? ["extent"] : [])] : [])]),
      ...(value.schema === 2 ? ["ownedBy"] : [])];
    if (Object.keys(node).some(key => !fields.includes(key))) throw new Error("Effect rows contain unsupported fields.");
    const common = { id: node.id, kind: node.kind, enabled: node.enabled }, owned = node.ownedBy !== undefined ? {ownedBy: ownership(node)} : {};
    if (node.kind === "shader") {
      if (!object(node.shader)) throw new Error("A shader row needs shader settings.");
      if(node.settings!==undefined&&(!object(node.settings)||Object.keys(node.settings).some(key=>key!=="modelPath")||
        node.settings.modelPath!==undefined&&node.settings.modelPath!==null&&(typeof node.settings.modelPath!=="string"||!node.settings.modelPath.startsWith("/")||node.settings.modelPath.length>32768||/[\0\r\n]/.test(node.settings.modelPath))))
        throw new Error("Choose a local model package for this filter input.");
      return { ...common, shader: shaderSettings(node.shader),...(node.settings!==undefined?{settings:{modelPath:node.settings.modelPath??null}}:{}),...(node.extent!==undefined?{extent:extent(node.extent)}:{}), ...owned };
    }
    if (typeof node.method !== "string" || !/^[a-z][a-z0-9:._-]{0,79}$/.test(node.method) || node.method === "off" ||
        node.kind === "frame-generation" && !["lsfg", "metalfx","fsr3","xess"].includes(node.method) && NEURAL[node.method]?.kind!=="frame-generation" || !object(node.settings))
      throw new Error("A graphics row needs a supported method and settings.");
    let outputSize;
    if (node.extent !== undefined && (node.outputSize !== undefined || node.presentationScale !== undefined)) throw new Error("Choose one effect output size.");
    const outputExtent = node.extent === undefined ? null : extent(node.extent);
    if(node.extent?.automatic&&node.kind!=="downsample")throw new Error("Legacy automatic processing input requires a Downsample row.");
    if (node.kind === "downsample" && outputExtent?.relativeTo === "input" && outputExtent.factor > 1 ||
        node.kind === "upscale" && outputExtent?.relativeTo === "input" && outputExtent.factor < 1)
      throw new Error("Downsample reduces its input; Upscale enlarges it.");
    if (node.presentationScale !== undefined && (node.outputSize !== undefined ||
        ![.25, 1 / 3, .5, 2 / 3, 1, 1.5, 2, 3, 4].includes(node.presentationScale) || node.method === "downsample" && node.presentationScale > 1))
      throw new Error("Choose one output size or a supported window scale.");
    if (node.outputSize !== undefined) {
      const keys = object(node.outputSize) ? Object.keys(node.outputSize) : [];
      if (!object(node.outputSize) || !keys.length || keys.some(key => !["width", "height"].includes(key)) ||
          !keys.every(key => Number.isInteger(node.outputSize[key]) && node.outputSize[key] >= 1 && node.outputSize[key] <= 16384))
        throw new Error("Effect output dimensions must be whole pixels from 1 to 16384.");
      outputSize = { ...node.outputSize };
    }
    return { ...common, method: node.method, settings: copy(node.settings), ...(outputSize ? { outputSize } : {}),
      ...(node.presentationScale !== undefined ? { presentationScale: node.presentationScale } : {}), ...(outputExtent ? {extent: outputExtent} : {}), ...owned };
  });
  owners(video);
  if (JSON.stringify(video).length > 4 * 1024 * 1024) throw new Error("The effects plan is too large.");
  return { schema: value.schema, mode: "advanced", ...(value.schema === 2 ? {enabled: value.enabled !== false} : {}), video, ...(renderResolution ? { renderResolution } : {}), ...(output ? {output} : {}),
    ...(depth ? {depthInput: depth} : {}) };
}
// Reading old records is lossless. Editors explicitly migrate on a real edit;
// legacy Auto remains a fit operation because its actual direction can change.
export function migrate(value) {
  const plan = validate(value);
  const legacy=plan.video.find(node=>node.enabled&&node.kind==="frame-generation")||plan.video.find(node=>node.kind==="frame-generation");
  const output=legacy&&plan.output?.framePacing===undefined?{...plan.output,framePacing:legacy.settings.framePacing||"fixed",targetFps:legacy.settings.targetFps??120,smoothCadence:legacy.settings.smoothCadence===true}:plan.output;
  return validate({...plan, schema: 2, enabled: plan.enabled !== false,...(output?{output}:{}), video: plan.video.map(node => {
    if(node.kind==="frame-generation"&&output?.framePacing!==undefined){const {framePacing,targetFps,smoothCadence,...settings}=node.settings;return {...node,settings};}
    if (node.kind !== "spatial") return node;
    const factor = node.settings.spatialMultiplier;
    const kind = node.method === "downsample" || typeof factor === "number" && factor < 1 ? "downsample" :
      typeof factor === "number" && factor > 1 ? "upscale" : "spatial";
    if (kind === "spatial") return node;
    const {outputSize, presentationScale, ...rest} = node;
    return {...rest, kind, method: node.method === "downsample" ? "bilinear" : node.method,
      extent: node.extent || (outputSize ? {...outputSize} : presentationScale !== undefined ? {relativeTo: "presentation", factor: presentationScale} :
        {relativeTo: "input", factor: typeof factor === "number" ? factor : .5})};
  })});
}
export function execution(value) {
  const plan = validate(value);
  return plan.enabled === false ? {...plan, video: plan.video.map(node => ({...node, enabled: false})), renderResolution: undefined, output: undefined} : plan;
}
// A saved plan that fails validation is reported, never replaced by another
// plan or by the legacy fields. A later schema is reported separately so a
// reader can explain why. `inspect` never throws: {plan: null} for an absent
// value, {plan} for a valid one and {error: {code, message}} otherwise.
// `normalize` returns the plan or null, and throws the error with its code.
export const PLAN_INVALID = "GRAPHICS_PLAN_INVALID", PLAN_NEWER = "GRAPHICS_PLAN_NEWER";
export function planError(value, error) {
  if (object(value) && typeof value.schema === "number" && value.schema > 2)
    return {code: PLAN_NEWER, message: "This effects plan uses a newer schema."};
  return {code: PLAN_INVALID, message: String(error?.message || "Choose a valid ordered effects plan.")};
}
export function inspect(value) {
  if (value == null) return {plan: null};
  try { return {plan: validate(value)}; } catch (error) { return {error: planError(value, error)}; }
}
export function normalize(value) {
  const {plan, error} = inspect(value);
  if (error) throw Object.assign(new Error(error.message), {code: error.code});
  return plan;
}
// Row-level salvage. Only the envelope (schema, mode, shape and master switch)
// must validate; a newer schema or a broken envelope is reported as `error`,
// as `inspect` does. Each row is then validated alone and its ownership
// against the rows that survive, as `leading` does. A helper whose owner is
// dropped is dropped too. An invalid source request, output setting or depth input is
// dropped on its own. `check` validates a complete plan; plan.js passes its
// settings and provider checks. Never throws: {plan: null, dropped: []} for an
// absent value, otherwise {plan, dropped: [{part, id, reason, label?}]} or {error}.
const OUTPUT_GROUPS = Object.freeze({motionClarity: ["motionClarity", "subframes", "duty", "brightness"],
  framePacing: ["framePacing", "targetFps", "smoothCadence"], toneMapping: ["toneMapping"], adaptiveQuality: ["adaptiveQuality"], comparison: ["comparison"]});
const reasonOf = error => String(error?.message || "Choose a valid ordered effects plan.").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 512);
function envelope(value) {
  let size;
  try { size = JSON.stringify(value).length; } catch { return false; }
  return object(value) && [1, 2].includes(value.schema) && value.mode === "advanced" && Array.isArray(value.video) && value.video.length <= MAX_NODES &&
    !Object.keys(value).some(key => !["schema", "mode", "video", "renderResolution", ...(value.schema === 2 ? ["enabled", "output", "depthInput"] : [])].includes(key)) &&
    (value.enabled === undefined || typeof value.enabled === "boolean") && size <= 4 * 1024 * 1024;
}
export function salvage(value, check = validate) {
  if (value == null) return {plan: null, dropped: []};
  let failure;
  try { return {plan: check(value), dropped: []}; } catch (error) { failure = error; }
  if (!envelope(value)) return {error: planError(value, failure)};
  const base = {schema: value.schema, mode: "advanced", ...(value.enabled !== undefined ? {enabled: value.enabled} : {})};
  const dropped = [], kept = [], ids = new Set(), removed = new Set();
  const passes = fields => { try { check({...base, video: [], ...fields});return null; } catch (error) { return reasonOf(error); } };
  value.video.forEach((row, index) => {
    const id = object(row) && rowId(row.id) ? row.id : null;
    const label = object(row) ? row.kind === "shader" ? row.shader?.preset : row.method : undefined;
    try {
      if (!id) throw new Error("Effect rows need unique IDs, a supported type and an enabled state.");
      if (ids.has(id)) throw new Error("Another effect row uses the same ID.");
      const {ownedBy, ...bare} = row;
      check({...base, video: [bare]});
      if (ownedBy !== undefined) {
        if (value.schema !== 2) throw new Error("Effect rows contain unsupported fields.");
        ownership(row);
      }
      ids.add(id);kept.push(row);
    } catch (error) {
      if (id && !ids.has(id)) removed.add(id);
      dropped.push({part: "row", id: id || `#${index + 1}`, reason: reasonOf(error), ...(typeof label === "string" && label ? {label: label.slice(0, 256)} : {})});
    }
  });
  const byId = new Map(kept.map(row => [row.id, row])), claimed = new Set();
  const video = kept.filter(row => {
    if (row.ownedBy === undefined) return true;
    const owner = byId.get(row.ownedBy.id), key = row.ownedBy.id + "\n" + row.ownedBy.role;
    const reason = !owner ? removed.has(row.ownedBy.id) ? "The effect this sizing step belongs to could not be read." : "A sizing helper names an effect row that is not in the plan." :
      owner === row || owner.ownedBy ? "A sizing helper cannot own itself or belong to another helper." :
      !ownsHelpers(owner) ? "Only shader, scaling and neural rows can own sizing helpers." :
      claimed.has(key) ? "An effect row has at most one input and one fit helper." : null;
    if (!reason) {claimed.add(key);return true;}
    removed.add(row.id);dropped.push({part: "row", id: row.id, reason, ...(row.method ? {label: String(row.method).slice(0, 256)} : {})});
    return false;
  });
  let renderResolution = value.renderResolution;
  if (renderResolution != null) {
    const reason = passes({renderResolution}) || (removed.has(renderResolution.managedBy) ? "The effect that manages this source size could not be read." : null);
    if (reason) {renderResolution = undefined;dropped.push({part: "renderResolution", id: "renderResolution", reason});}
  }
  let output = value.output;
  if (output !== undefined && passes({output})) {
    if (!object(output)) {dropped.push({part: "output", id: "output", reason: passes({output})});output = undefined;}
    else {
      const grouped = new Set(Object.values(OUTPUT_GROUPS).flat()), groups = {...OUTPUT_GROUPS};
      for (const key of Object.keys(output)) if (!grouped.has(key)) groups[key] = [key];
      const next = {};
      for (const [name, keys] of Object.entries(groups)) {
        const part = Object.fromEntries(keys.filter(key => Object.hasOwn(output, key)).map(key => [key, output[key]]));
        if (!Object.keys(part).length) continue;
        const reason = passes({output: part});
        if (reason) dropped.push({part: "output", id: "output." + name, reason});else Object.assign(next, part);
      }
      output = Object.keys(next).length ? next : undefined;
    }
  }
  if (output?.adaptiveQuality && removed.has(output.adaptiveQuality.nodeId)) {
    const {adaptiveQuality: _policy, ...rest} = output;output = Object.keys(rest).length ? rest : undefined;
    dropped.push({part: "output", id: "output.adaptiveQuality", reason: "The effect that adaptive quality adjusts could not be read."});
  }
  let depth = value.depthInput;
  if (depth !== undefined) {
    const reason = passes({depthInput: depth});
    if (reason) {depth = undefined;dropped.push({part: "depthInput", id: "depthInput", reason});}
  }
  try {
    return {plan: check({...base, video, ...(renderResolution != null ? {renderResolution} : {}), ...(output !== undefined ? {output} : {}),
      ...(depth !== undefined ? {depthInput: depth} : {})}), dropped};
  } catch (error) { return {error: planError(value, error)}; }
}
export function fromLegacy(entry = {}) {
  const advanced = normalize(entry.effects); if (advanced) return advanced;
  const graphics = object(entry.graphics) ? copy(entry.graphics) : {}, video = [];
  const spatialShader = graphics.spatialShader?.enabled === true ? graphics.spatialShader : null;
  // This selection becomes an ordinary shader row. Native stage settings must
  // not recursively carry another Simple spatial selection into the executor.
  delete graphics.spatialShader;
  const shader = entry.reshade?.enabled === true ? { id: "legacy-shader", kind: "shader", enabled: true, shader: shaderSettings(entry.reshade) } : null;
  for (const [kind, key] of [["temporal", "temporalMethod"], ["spatial", "spatialMethod"]]) {
    if (kind === "spatial" && shader && graphics.effectPlacement !== "after") video.push(shader);
    if (kind === "spatial" && graphics.neuralMethod === "mlx-dlss") {
      const height = graphics.neuralInputHeight ?? (graphics.neuralInputScale == null ? DEFAULT_PROCESSING_HEIGHT : null);
      if (height != null || graphics.neuralInputScale < 1) video.push({ id: "legacy-neural-input", kind: "spatial", enabled: true, method: "downsample",
        ...(height != null ? { outputSize: { height } } : { presentationScale: graphics.neuralInputScale }),
        settings: { ...graphics, spatialMethod: "bilinear", spatialMultiplier: null,
          temporalMethod: "off", frameGeneration: "off" } });
      video.push({ id: "legacy-neural", kind: "neural", enabled: true, method: "mlx-dlss", settings: {
        modelPath: graphics.neuralModelPath ?? null, temporal: graphics.neuralTemporal === true, intensity: graphics.neuralIntensity ?? 1 } });
    }
    if (kind === "spatial" && spatialShader) video.push({id: "legacy-spatial-shader", kind: "shader", enabled: true, shader: shaderSettings(spatialShader)});
    else if (typeof graphics[key] === "string" && graphics[key] !== "off") video.push({ id: "legacy-" + kind, kind, enabled: true, method: graphics[key], settings: copy(graphics) });
  }
  if (shader && graphics.effectPlacement === "after") video.push(shader);
  if (graphics.frameGeneration === "lsfg") video.push({ id: "legacy-frame-generation", kind: "frame-generation", enabled: true, method: "lsfg", settings: copy(graphics) });
  return validate({ schema: 1, mode: "advanced", video });
}
// Automatic placement follows input/geometry contracts. The legacy conversion
// remains a literal conversion of its saved before/after setting.
export function orderSimple(value, { shaderFacts = {} } = {}) {
  const plan = validate(value), source = [], reconstruction = [], spatial = [], display = [];
  for (const node of plan.video.filter(row => row.kind === "shader")) {
    if (node.id === "legacy-spatial-shader") {spatial.push(node);continue;}
    const facts = shaderFacts[node.id] || {}, traits = facts.traits || {}, requirements = facts.requirements || {};
    const implementation = {traits,...(facts.outputContract?{outputContract:facts.outputContract}:{})};
    const needsSource = sceneInputNames(requirements).length>0;
    if (needsSource) source.push(node);
    else if (shaderResizes(implementation) || ["downsample","upscale"].includes(graphicsType(node,implementation))) reconstruction.push(node);
    else display.push(node);
  }
  const processing = plan.video.filter(row => row.kind !== "shader"), fit = processing.findIndex(row => row.kind === "spatial" && row.method !== "downsample" || row.kind === "frame-generation");
  const split = fit < 0 ? processing.length : fit;
  return { ...plan, video: [...source, ...processing.slice(0, split), ...reconstruction, ...spatial, ...processing.slice(split), ...display] };
}
export function composeSimple(entry = {}, options = {}) {
  const advanced = normalize(entry.effects); if (advanced) return advanced;
  return orderSimple(fromLegacy(entry), options);
}
// A contextual editor preset carries the current model/settings, without
// introducing a machine-specific model path into a global preset catalog.
export function reconstructionPreset(entry = {}, { divisor, spatialMethod, frameMultiplier = 4, shaderFacts = {} } = {}) {
  if (divisor !== undefined && ![1, 1.5, 2, 4].includes(divisor)) throw new Error("Choose a supported reconstruction divisor.");
  const graphics = object(entry.graphics) ? copy(entry.graphics) : {};
  const current=normalize(entry.effects)?.video.filter(node=>node.kind==="neural"&&node.method==="mlx-dlss"),selected=current?.find(node=>node.enabled)||current?.[0];
  if(selected)Object.assign(graphics,{neuralModelPath:selected.settings.modelPath??null,neuralIntensity:selected.settings.intensity??1,neuralTemporal:selected.settings.temporal===true});
  const method = spatialMethod || (graphics.spatialMethod && graphics.spatialMethod !== "off" ? graphics.spatialMethod : "metalfx");
  const plan = migrate(composeSimple({ ...entry, effects: undefined, graphics: { ...graphics, neuralMethod: "mlx-dlss",
    neuralInputHeight: divisor === undefined ? DEFAULT_PROCESSING_HEIGHT : null,
    neuralInputScale: divisor === undefined ? null : 1 / divisor,
    spatialMethod: method, spatialMultiplier: null, frameGeneration: "lsfg", frameMultiplier } }, { shaderFacts }));
  return validate({...plan, video: plan.video.map(node => {
    if (node.id === "legacy-neural-input") return {...node, extent: divisor === undefined ? {height: DEFAULT_PROCESSING_HEIGHT} : {relativeTo: "input", factor: 1 / divisor}};
    if (node.kind === "spatial") return {...node, kind: "upscale", extent: {relativeTo: "presentation", factor: 1}};
    return node;
  })});
}
// The first rows of a validated plan, for incremental ordering checks. Input
// helpers precede their owners, so ownership past the slice is left out.
export function leading(value, count) {
  const video = value.video.slice(0, count), ids = new Set(video.map(node => node.id));
  return {...value, video: video.map(({ownedBy, ...node}) => ownedBy && ids.has(ownedBy.id) ? {...node, ownedBy} : node)};
}
// Ordering, row by row. A row that breaks it is reported and left out of the
// state the following rows are checked against, as if it were off, so each
// remaining row keeps its place. [{id, reason, unavailable?}] in plan order.
export function orderingFailures(value, capabilities = {}) {
  const plan = validate(value), failures = []; let barrier = false, resizedScene = false, sceneResizeSupported=true;
  for (const node of plan.video) {
    if (!node.enabled) continue;
    const facts = capabilities.nodes?.[node.id] || {}, requirements = facts.requirements || {};
    if (facts.available === false) {failures.push({id: node.id, reason: facts.reason || "An enabled effect is unavailable for this game.", unavailable: true});continue;}
    const scene=node.kind==="temporal"||sceneInputNames(requirements).length>0;
    const reason = barrier && scene ? "Scene effects require matching coordinates; place them before generated frames or effects with unknown coordinate changes." :
      scene && resizedScene && !sceneResizeSupported ? "This processor requires the original scene extent; put a processing resize after the scene effect." : null;
    if (reason) {failures.push({id: node.id, reason});continue;}
    if(facts.coordinateTransform === "scale" || isResize(node)){resizedScene=true;if(facts.preservesSceneInputs!==true)sceneResizeSupported=false;}
    // Coordinate continuity belongs to the operation contract, independently
    // of its implementation or the engine that supplied the image.
    if (facts.preservesCoordinates !== true && (facts.coordinateTransform || coordinateTransform(node)) !== "identity") barrier = true;
  }
  return failures;
}
export function validateOrdering(value, capabilities = {}) {
  const plan = validate(value), failure = orderingFailures(plan, capabilities)[0];
  if (failure) throw new Error(failure.reason);
  return plan;
}

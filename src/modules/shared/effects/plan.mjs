import {candidate as generationCandidate} from "./simple-generation.mjs";
export const MAX_NODES = 32;
export const MAX_PARAMETERS = 4096;
export const RENDER_DIVISORS = Object.freeze([1, 1.5, 2, 3, 4]);
const kinds = new Set(["shader", "spatial", "temporal", "neural", "frame-generation"]);
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
export function validate(value) {
  if (!object(value) || value.schema !== 1 || value.mode !== "advanced" || !Array.isArray(value.video) || value.video.length > MAX_NODES ||
      Object.keys(value).some(key => !["schema", "mode", "video", "renderResolution"].includes(key))) throw new Error("Choose a valid ordered effects plan.");
  let renderResolution;
  if (value.renderResolution != null) {
    const resolution = value.renderResolution;
    if (!object(resolution) || Object.keys(resolution).some(key => !["height", "multiplier", "maximum", "method"].includes(key)) ||
        (Object.hasOwn(resolution, "method") && (typeof resolution.method !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(resolution.method))) ||
        (Object.hasOwn(resolution, "maximum") && (resolution.maximum !== true || !Object.hasOwn(resolution, "height"))) ||
        (Object.hasOwn(resolution, "height") && Object.hasOwn(resolution, "multiplier")) ||
        !(Object.hasOwn(resolution, "height") && Number.isInteger(resolution.height) && resolution.height >= 1 && resolution.height <= 16384 ||
          Object.hasOwn(resolution, "multiplier") && RENDER_DIVISORS.includes(resolution.multiplier)))
      throw new Error("Choose a render height from 1 to 16384 pixels or a supported render multiplier.");
    renderResolution = { ...resolution };
  }
  const ids = new Set();
  const video = value.video.map(node => {
    if (!object(node) || typeof node.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(node.id) ||
        node.id.includes("..") || ids.has(node.id) || !kinds.has(node.kind) || typeof node.enabled !== "boolean")
      throw new Error("Effect rows need unique IDs, a supported type and an enabled state.");
    ids.add(node.id);
    const fields = node.kind === "shader" ? ["id", "kind", "enabled", "shader"] : ["id", "kind", "enabled", "method", "settings", ...(node.kind === "spatial" ? ["outputSize", "presentationScale"] : [])];
    if (Object.keys(node).some(key => !fields.includes(key))) throw new Error("Effect rows contain unsupported fields.");
    const common = { id: node.id, kind: node.kind, enabled: node.enabled };
    if (node.kind === "shader") {
      if (!object(node.shader)) throw new Error("A shader row needs shader settings.");
      return { ...common, shader: shaderSettings(node.shader) };
    }
    if (typeof node.method !== "string" || !/^[a-z][a-z0-9:._-]{0,79}$/.test(node.method) || node.method === "off" ||
        node.kind === "frame-generation" && node.method !== "lsfg" || !object(node.settings))
      throw new Error("A graphics row needs a supported method and settings.");
    let outputSize;
    if (node.presentationScale !== undefined && (node.outputSize !== undefined ||
        ![.25, 1 / 3, .5, 2 / 3, 1, 1.5, 2, 3, 4].includes(node.presentationScale) || node.method === "downsample" && node.presentationScale > 1))
      throw new Error("Choose one output size or a supported window scale.");
    if (node.outputSize !== undefined) {
      const keys = object(node.outputSize) ? Object.keys(node.outputSize) : [];
      if (!object(node.outputSize) || !keys.length || keys.some(key => !["width", "height"].includes(key)) ||
          (keys.length !== 2 && node.method !== "downsample") ||
          !keys.every(key => Number.isInteger(node.outputSize[key]) && node.outputSize[key] >= 1 && node.outputSize[key] <= 16384))
        throw new Error("Effect output dimensions must be whole pixels from 1 to 16384.");
      outputSize = { ...node.outputSize };
    }
    return { ...common, method: node.method, settings: copy(node.settings), ...(outputSize ? { outputSize } : {}),
      ...(node.presentationScale !== undefined ? { presentationScale: node.presentationScale } : {}) };
  });
  if (JSON.stringify(video).length > 4 * 1024 * 1024) throw new Error("The effects plan is too large.");
  return { schema: 1, mode: "advanced", video, ...(renderResolution ? { renderResolution } : {}) };
}
export function normalize(value) {
  try { return validate(value); } catch { return null; }
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
      // Converting Simple Auto to an editable Advanced plan materializes a
      // manual 2× baseline. Automatic drawable sizing is preparation metadata.
      if (graphics.neuralInputHeight != null || (graphics.neuralInputScale ?? .5) < 1) video.push({ id: "legacy-neural-input", kind: "spatial", enabled: true, method: "downsample",
        ...(graphics.neuralInputHeight != null ? { outputSize: { height: graphics.neuralInputHeight } } : { presentationScale: graphics.neuralInputScale ?? .5 }),
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
    const needsSource = Array.isArray(requirements) ? requirements.some(key => ["depth", "motion"].includes(key)) : requirements.depth || requirements.motion;
    if (needsSource) source.push(node);
    else if (traits.neural || traits.outputScale || traits.conditionalGeometry || traits.displayDependentGeometry || traits.unresolvedGeometry ||
        ["upscaling", "downscaling", "restoration"].includes(traits.category)) reconstruction.push(node);
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
export function simpleGenerationLayout(value) {
  return generationCandidate(validate(value).video);
}
// A contextual editor preset carries the current model/settings, without
// introducing a machine-specific model path into a global preset catalog.
export function reconstructionPreset(entry = {}, { divisor = 4, spatialMethod, frameMultiplier = 4, shaderFacts = {} } = {}) {
  if (![1, 1.5, 2, 4].includes(divisor)) throw new Error("Choose a supported reconstruction divisor.");
  const graphics = object(entry.graphics) ? copy(entry.graphics) : {};
  const method = spatialMethod || (graphics.spatialMethod && graphics.spatialMethod !== "off" ? graphics.spatialMethod : "metalfx");
  const plan = composeSimple({ ...entry, effects: undefined, graphics: { ...graphics, neuralMethod: "mlx-dlss", neuralInputHeight: null,
    neuralInputScale: .5, spatialMethod: method, frameGeneration: "lsfg", frameMultiplier } }, { shaderFacts });
  for (const node of plan.video) {
    if (node.id === "legacy-neural-input") { delete node.presentationScale;node.settings.spatialMultiplier = 1 / divisor; }
    else if (node.kind === "spatial") node.settings.spatialMultiplier = divisor;
  }
  return validate(plan);
}
export function validateOrdering(value, capabilities = {}) {
  const plan = validate(value); let barrier = false, generation = false;
  for (const node of plan.video) {
    if (!node.enabled) continue;
    const facts = capabilities.nodes?.[node.id] || {}, requirements = facts.requirements || {};
    if (facts.available === false) throw new Error(facts.reason || "An enabled effect is unavailable for this game.");
    if (barrier && (node.kind === "temporal" || requirements.depth || requirements.motion))
      throw new Error("Depth and motion effects must precede resizing, generated frames and effects that change or have unknown screen coordinates.");
    if (generation && node.kind === "neural" && node.settings.temporal === true)
      throw new Error("Temporal neural reconstruction must precede frame generation so its history follows real frames.");
    if (node.kind === "frame-generation") {
      if (generation) throw new Error("Only one frame-generation stage is supported.");
      generation = true;
    }
    if (node.kind !== "shader" || facts.preservesCoordinates !== true) barrier = true;
  }
  return plan;
}

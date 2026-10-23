const DIVISORS = Object.freeze([1, 1.5, 2, 3]);
// A valid request can exceed source allocation support and use completed-frame
// processing instead. Native capabilities remain limited to their existing ABI.
const {RENDER_DIVISORS: REQUEST_DIVISORS} = require("../effects/plan.mjs");

// Allocating a smaller drawable is safe only when its publisher also adjusts
// its render passes. Completed-frame processing never needs that assumption.
function candidates(host, inputs, producerDivisors = [], virtualWindow = false) {
  if (inputs?.nativeVideo === true || inputs?.sourceResolution === false) return [];
  if (host === "explicit") return [{heights: false, multipliers: DIVISORS.filter(value => producerDivisors.includes(value))}];
  const source = inputs?.sourceResolution;
  const result = [];
  if (["window", "catalyst"].includes(host) && source && ["engine", "drawable"].includes(source.control)) {
    const methods = Array.isArray(source.methods) ? [...new Set(source.methods.filter(value => typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value)))] : [];
    const methodLabels = Object.fromEntries(methods.filter(method => typeof source.methodLabels?.[method] === "string" &&
      source.methodLabels[method].length <= 128 && !/[\x00-\x1f\x7f]/.test(source.methodLabels[method])).map(method => [method, source.methodLabels[method]]));
    result.push({ heights: source.heights === true,
      multipliers: DIVISORS.filter(value => Array.isArray(source.multipliers) && source.multipliers.includes(value)), control: source.control,
      ...(source.automatic === true ? {automatic: true} : {}),
      ...(source.live === true ? {live: true} : {}),
      ...(methods.length ? {methods} : {}), ...(Object.keys(methodLabels).length ? {methodLabels} : {}) });
  }
  if (host === "window" && virtualWindow) result.push({heights: true, multipliers: [...DIVISORS], control: "virtual",
    ...(virtualWindow?.activationAPI === 1 ? {live: true, activationAPI: 1} : {}),
    ...(virtualWindow?.autoAPI === 1 ? {automatic: true} : {})});
  return result;
}
function capabilities(host, inputs, producerDivisors = [], virtualWindow = false) {
  return candidates(host, inputs, producerDivisors, virtualWindow)[0] || {heights: false, multipliers: []};
}
function normalizeRequest(source) {
  if (source == null) return null;
  // Adaptive source sizing is an internal Simple preparation contract. Saved
  // Advanced plans validate their own explicit height/divisor schema.
  if (source && typeof source === "object" && !Array.isArray(source) && Object.hasOwn(source, "automatic")) {
    if (source.automatic !== true || Object.keys(source).length !== 1) throw new Error("Automatic render sizing requires an automatic source request.");
    return {automatic: true};
  }
  if (!source || typeof source !== "object" || Array.isArray(source) ||
      Object.keys(source).some(key => !["height", "maximum", "multiplier", "method"].includes(key)) ||
      Object.hasOwn(source, "height") === Object.hasOwn(source, "multiplier")) throw new Error("Choose a render height or an available divisor.");
  const result = {};
  if (Object.hasOwn(source, "height")) {
    if (!Number.isSafeInteger(source.height) || source.height < 1 || source.height > 16384) throw new Error("Choose a render height from 1 to 16384.");
    result.height = source.height;
    if (Object.hasOwn(source, "maximum")) {
      if (typeof source.maximum !== "boolean") throw new Error("Choose an exact or maximum render height.");
      if (source.maximum) result.maximum = true;
    }
  } else {
    if (!REQUEST_DIVISORS.includes(source.multiplier) || Object.hasOwn(source, "maximum")) throw new Error("Choose a supported render divisor.");
    result.multiplier = source.multiplier;
  }
  if (Object.hasOwn(source, "method")) {
    if (typeof source.method !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(source.method)) throw new Error("Choose an available source filter.");
    result.method = source.method;
  }
  return result;
}
const size = value => value && [value.width, value.height].every(number => Number.isFinite(number) && number >= 1 && number <= 16384)
  ? {width: value.width, height: value.height} : null;
function automaticDivisor(output, source) {
  const bounds = size(output);
  if (!bounds) return 1;
  const aspect = size(source) || bounds;
  const fit = Math.min(bounds.width / aspect.width, bounds.height / aspect.height);
  const shortEdge = Math.min(bounds.width, aspect.width * fit, bounds.height, aspect.height * fit);
  return Math.max(1, Math.min(4, Math.round(shortEdge / 540)));
}
function targetSize(request, output, observed) {
  if (!request) return null;
  if (request.automatic) {
    if (!output) return null;
    const aspect = observed || output;
    const fit = Math.min(output.width / aspect.width, output.height / aspect.height);
    const width = aspect.width * fit, height = aspect.height * fit;
    const divisor = automaticDivisor(output, aspect);
    return {width: Math.max(1, Math.min(output.width, Math.ceil(width / divisor))),
      height: Math.max(1, Math.min(output.height, Math.ceil(height / divisor)))};
  }
  if (request.maximum) {
    if (!observed) return null;
    const bounds = output || observed;
    const scale = Math.min(1, request.height / observed.height, bounds.width / observed.width, bounds.height / observed.height);
    return {width: Math.max(1, Math.min(observed.width, bounds.width, Math.ceil(observed.width * scale))),
      height: Math.max(1, Math.min(observed.height, bounds.height, Math.ceil(observed.height * scale)))};
  }
  if (!output) return null;
  if (request.height !== undefined) {
    const height = Math.min(output.height, request.height);
    return {width: Math.max(1, Math.min(output.width, Math.ceil(output.width * height / output.height))), height};
  }
  return {width: Math.max(1, Math.ceil(output.width / request.multiplier)), height: Math.max(1, Math.ceil(output.height / request.multiplier))};
}
// Both editors use the same source decision. This describes a strategy, never
// proof that a native request applied. completedSource comes from the exact
// current source-controls acknowledgement, not a window-size observation.
function resolve(source, {host, inputs, producerDivisors = [], virtualWindow = false, processing = false,
  outputSize, completedSource, excludedControls = {}} = {}) {
  const requested = normalizeRequest(source), observed = completedSource?.verified === true ? size(completedSource.dimensions) : null;
  const output = size(outputSize) || (completedSource?.verified === true ? size(completedSource.outputSize) : null);
  const target = targetSize(requested, output, observed);
  const satisfied = !!(requested && target && observed && (requested.automatic
    ? observed.width <= target.width && observed.height <= target.height
    : Math.abs(target.width - observed.width) < 1 && Math.abs(target.height - observed.height) < 1));
  const base = {requested, target, observed, outputSize: output, satisfied, requiresSourceChange: false};
  if (!requested) return {...base, strategy: "original", control: null, source: null, processing: null, reason: "No source reduction is requested."};
  if (requested.multiplier === 1) return {...base, target: observed, satisfied: !!observed, requiresSourceChange: false,
    strategy: "original", control: null, source: null, processing: null, reason: "The original producer allocation is requested."};
  const available = candidates(host, inputs, producerDivisors, virtualWindow);
  const fallbackReasons = [];
  for (const support of available) {
    const control = support.control || "producer";
    const excluded = excludedControls[control];
    if (excluded || (requested.automatic ? support.automatic !== true : requested.height !== undefined ? !support.heights : !support.multipliers.includes(requested.multiplier))) {
      fallbackReasons.push({control, reason: typeof excluded === "string" ? excluded.slice(0, 512) : "This source API cannot apply the requested dimensions."});
      continue;
    }
    const effective = {...requested};
    if (effective.method && !support.methods?.includes(effective.method)) delete effective.method;
    let reason = satisfied ? "The completed producer already meets the requested dimensions; no source-window reduction is needed." :
      control === "virtual" ? "Using a virtual source window because no compatible renderer source API is available." : "Using the renderer source API.";
    if (requested.method && !effective.method) reason += " This source path preserves the renderer's filter.";
    return {...base, requiresSourceChange: !satisfied, strategy: control, control: support.control || null, support, source: effective, processing: null, reason, fallbackReasons};
  }
  if (satisfied) return {...base, strategy: "original", control: null, source: null, processing: null,
    reason: "The completed producer already meets the requested dimensions."};
  if (processing === true) {
    // Ratios remain relative to the physical output after a live resize. Fixed
    // heights leave width to the current frame's aspect ratio, never a snapshot.
    // The downsample executor clamps a height-only target to the current input,
    // so a maximum height needs no guessed source extent or fixed-width row.
    const descriptor = requested.automatic ? {method: "downsample", resolutionAuto: true} : requested.multiplier !== undefined ? {method: "downsample", presentationScale: 1 / requested.multiplier} :
      {method: "downsample", outputSize: {height: requested.height}};
    return {...base, strategy: "processing", control: null, source: null, processing: descriptor, fallbackReasons,
      reason: "Renderer source allocation is unavailable; downsampling completed frames preserves the requested processing size without reducing game rendering work."};
  }
  return {...base, strategy: "original", control: null, source: null, processing: null, fallbackReasons,
    reason: "No compatible source allocation or completed-frame downsampling path is available; the original source is retained."};
}

function environment(support) {
  return support.control ? { RESHADE_RENDER_SOURCE_CONTROL: support.control } : {};
}

module.exports = { DIVISORS, REQUEST_DIVISORS, capabilities, environment, normalizeRequest, automaticDivisor, resolve };

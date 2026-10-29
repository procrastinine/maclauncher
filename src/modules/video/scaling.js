const warn = require("../shared/graphics-warning");
const DEFAULT_METHOD = "libplacebo:ewa_lanczossharp";
const STANDARD = Object.freeze(["nearest", "bilinear", "bicubic"]);
function validFilters(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 256 && value.includes("bilinear") && value.every(name => typeof name === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(name));
}
function filtersFor(selection = {}) {
  const recorded = selection.install?.installationMetadata?.scaleFilters;
  if (validFilters(recorded)) return [...new Set(recorded)];
  const host=selection.install?.executablePath&&require("./runtime/render-host").read(selection.install.executablePath);
  if(host&&validFilters(host.value.scaleFilters))return [...new Set(host.value.scaleFilters)];
  return [...STANDARD];
}
// Saved graphics are an effects plan. A new video records no graphics; mpv
// scales it with DEFAULT_METHOD (argumentsFor) until a plan selects processing.
function mergeEntry(_existing, entry) { return entry; }
function filterName(method) { return STANDARD.includes(method) ? method : method?.startsWith("libplacebo:") ? method.slice(11) : null; }
function argumentsFor(entry, filters, logger, {decodedFrameProducer=false}={}) {
  // The decoded host renders at source dimensions; graph rows own resizing.
  // Keep conversion filters stable through master bypass and paused edits.
  if(decodedFrameProducer)return ["--scale=bilinear","--cscale=bilinear","--dscale=bilinear"];
  const method = entry.effects?.enabled === false ? "bilinear" : DEFAULT_METHOD;
  const requested = filterName(method), selected = requested && filters.includes(requested) ? requested : "bilinear";
  if (requested && requested !== selected) warn(logger, "The selected native video scaling filter is unavailable in this mpv version. Playback uses a supported filter.");
  return [`--scale=${selected}`, `--cscale=${selected}`, `--dscale=${selected}`];
}
// v0.4.0 applied an mpv filter selection as mpv's own scaler, never as a
// graph row. Video has no separate scaler setting, so the one-time upgrade
// drops that selection and mpv scales with DEFAULT_METHOD.
function legacyGraphics(graphics) {
  if (!filterName(graphics?.spatialMethod)) return graphics;
  return { ...graphics, spatialMethod: "off", ...(graphics.spatialShader ? {} : { spatialMultiplier: null }) };
}
function inputs(filters) {
  const names = [...new Set(filters)], methods = [...STANDARD.filter(name => names.includes(name)), ...names.filter(name => !STANDARD.includes(name)).map(name => "libplacebo:" + name)];
  return { source: "mpv-video", nativeVideo: true, presentationHold: true, shaderBindingsNextLaunch: false, spatialBindingsNextLaunch: false,
    sourceResolution: false, nativeSpatialMethods: methods, nativeSpatialMethodLabels: Object.fromEntries(methods.filter(method => method.startsWith("libplacebo:"))
      .map(method => [method, method === DEFAULT_METHOD ? "Lanczos · Sharp" : method.slice(11).replace(/_/g, " ")])), cameraProjection: false, methods: [] };
}
function parseHelp(text) {
  if (typeof text !== "string" || text.length > 128 * 1024) return [];
  const lines = text.split(/\r?\n/), start = lines.findIndex(line => /(?:available|valid).*(?:choices|filters|scalers)|(?:choices|filters|scalers).*(?:available|valid)/i.test(line));
  const names = [];
  for (const line of lines.slice(start < 0 ? 0 : start + 1)) {
    const match = /^\s+([a-z][a-z0-9_-]{0,63})(?:\s*(?:\([^)]*\)|\[[^\]]*\]))?\s*$/.exec(line);
    if (match && !names.includes(match[1])) names.push(match[1]);
  }
  return validFilters(names) && names.includes("bilinear") ? names : [];
}
module.exports = { DEFAULT_METHOD, STANDARD, validFilters, filtersFor, mergeEntry, argumentsFor, legacyGraphics, inputs, parseHelp };

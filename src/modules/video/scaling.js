const Catalog = require("./runtime/catalog"), PinnedRegistry = require("./runtime/scale-filters-0.41.0.json");
const warn = require("../shared/graphics-warning");
const DEFAULT_METHOD = "libplacebo:ewa_lanczossharp";
const STANDARD = Object.freeze(["nearest", "bilinear", "bicubic"]);
function validFilters(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 256 && value.includes("bilinear") && value.every(name => typeof name === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(name));
}
function filtersFor(selection = {}) {
  const recorded = selection.install?.installationMetadata?.scaleFilters;
  if (validFilters(recorded)) return [...new Set(recorded)];
  const pin = selection.install?.catalogEntry;
  const archiveSha256 = pin?.asset?.sha256 || (selection.version === Catalog.DEFAULT_ENTRY.version ? Catalog.DEFAULT_ENTRY.asset.sha256 : null);
  if (selection.version === PinnedRegistry.version && archiveSha256 === PinnedRegistry.archiveSha256) return [...PinnedRegistry.filters];
  return [...STANDARD];
}
function mergeEntry(existing, entry) {
  if (existing || entry.graphics && (Object.hasOwn(entry.graphics, "spatialMethod") || entry.graphics.spatialShader)) return entry;
  return { ...entry, graphics: { ...entry.graphics, spatialMethod: DEFAULT_METHOD, spatialMultiplier: null,
    neuralInputScale: entry.graphics?.neuralInputScale === undefined ? 1 : entry.graphics.neuralInputScale } };
}
function filterName(method) { return STANDARD.includes(method) ? method : method?.startsWith("libplacebo:") ? method.slice(11) : null; }
function nativeSimple(entry, filters) { return entry.effects?.mode !== "advanced" && !entry.graphics?.spatialShader && filters.includes(filterName(entry.graphics?.spatialMethod)); }
function argumentsFor(entry, filters, logger) {
  const method = entry.effects?.mode === "advanced" || entry.graphics?.spatialShader ? DEFAULT_METHOD : entry.graphics?.spatialMethod || DEFAULT_METHOD;
  const requested = filterName(method), selected = requested && filters.includes(requested) ? requested : "bilinear";
  if (requested && requested !== selected) warn(logger, "The selected native video scaling filter is unavailable in this mpv version. Playback uses a supported filter.");
  return [`--scale=${selected}`, `--cscale=${selected}`, `--dscale=${selected}`];
}
function sharedEntry(entry, filters) {
  if (!nativeSimple(entry, filters)) return entry;
  return { ...entry, graphics: { ...entry.graphics, spatialMethod: "off", spatialMultiplier: null } };
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
module.exports = { DEFAULT_METHOD, STANDARD, validFilters, filtersFor, mergeEntry, argumentsFor, sharedEntry, inputs, parseHelp };

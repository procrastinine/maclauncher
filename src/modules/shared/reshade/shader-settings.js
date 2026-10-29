const path = require("node:path");
const Chain = require("./effect-chain");
// A purpose heads the preset in implementation menus, as pack effects do.
// Descriptors declare a common choice (`recommended`) and an unchanged image
// mapping (`preservesCoordinates`), as other catalog entries declare them.
const PRESETS = Object.freeze([{ id: "crt", label: "CRT", purpose: "CRT and retro", recommended: true },
  { id: "grayscale", label: "Grayscale", purpose: "Colour and tone", preservesCoordinates: true },
  { id: "vibrance", label: "Colour", purpose: "Colour and tone", recommended: true, preservesCoordinates: true },
  { id: "sharpen", label: "Sharpen", purpose: "Sharpen", recommended: true, preservesCoordinates: true },
  { id: "cas", label: "CAS Sharpen", purpose: "Sharpen", recommended: true, preservesCoordinates: true },
  { id: "chain", label: "Combine effects…" }, { id: "custom", label: "Custom shader…" }]);
// A combination keeps the image mapping when every combined preset does.
function preservesCoordinates(shader) {
  const declared = id => PRESETS.some(preset => preset.id === id && preset.preservesCoordinates === true);
  return shader?.preset === "chain" ? shader.effects?.every(declared) === true : declared(shader?.preset);
}

function normalizePreset(value) {
  if (PRESETS.some(preset => preset.id === value)) return value;
  if (typeof value !== "string") return "crt";
  if (require("./filter-library").isFilterId(value) || require("./managed-shaders").isId(value)) return value;
  return require("./shader-packs").normalizeId(value) || "crt";
}
function normalizeSettings(value) {
  return { enabled: value?.enabled === true,
    preset: normalizePreset(value?.preset),
    effectPath: typeof value?.effectPath === "string" ? value.effectPath : null,
    ...(Chain.valid(value?.effects) ? { effects: [...value.effects] } : value?.preset === "chain" ? { effects: [...Chain.DEFAULT_EFFECTS] } : {}),
    ...(value?.parameters != null && require("./live-controls").validParameters(value.parameters) ? { parameters: structuredClone(value.parameters) } : {}) };
}
function updateSettings(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(key => !["enabled", "preset", "effectPath", "effects", "parameters"].includes(key)))
    throw new Error("Invalid ReShade settings.");
  if (Object.hasOwn(patch, "enabled") && typeof patch.enabled !== "boolean") throw new Error("ReShade enabled must be true or false.");
  if (Object.hasOwn(patch, "preset") && !PRESETS.some(item => item.id === patch.preset) && !require("./shader-packs").normalizeId(patch.preset) && !require("./filter-library").isFilterId(patch.preset) && !require("./managed-shaders").isId(patch.preset)) throw new Error("Choose a supported ReShade preset.");
  if (Object.hasOwn(patch, "effects") && patch.effects !== null && !Chain.valid(patch.effects)) throw new Error("Choose two to four included effects.");
  if (Object.hasOwn(patch, "effectPath") && patch.effectPath !== null &&
    (typeof patch.effectPath !== "string" || !path.isAbsolute(patch.effectPath) || !require("./shader-providers").sourceExtensions.includes(path.extname(patch.effectPath).toLowerCase()) || /[\x00-\x1f]/.test(patch.effectPath)))
    throw new Error("Choose a supported graphics filter file.");
  if (Object.hasOwn(patch, "parameters") && patch.parameters !== null && !require("./live-controls").validParameters(patch.parameters)) throw new Error("Choose valid shader parameter values.");
  const previous = normalizeSettings(current), next = normalizeSettings({ ...previous, ...patch });
  const Live = require("./live-controls");
  if (Live.effectKey(previous) !== Live.effectKey(next)) delete next.parameters;
  return normalizeSettings(next);
}
module.exports = { PRESETS, preservesCoordinates, normalizeSettings, updateSettings };

const path = require("node:path");
const Chain = require("./effect-chain");
const PRESETS = Object.freeze([{ id: "crt", label: "CRT" }, { id: "grayscale", label: "Grayscale" }, { id: "vibrance", label: "Colour" },
  { id: "sharpen", label: "Sharpen" }, { id: "cas", label: "CAS Sharpen" },
  { id: "chain", label: "Combine effects…" }, { id: "custom", label: "Custom shader…" }]);

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
  if (Object.hasOwn(patch, "preset") && !PRESETS.some(item => item.id === patch.preset) && !require("./shader-packs").lookup(patch.preset) && !require("./filter-library").isFilterId(patch.preset) && !require("./managed-shaders").isId(patch.preset)) throw new Error("Choose a supported ReShade preset.");
  if (Object.hasOwn(patch, "effects") && patch.effects !== null && !Chain.valid(patch.effects)) throw new Error("Choose two to four included effects.");
  if (Object.hasOwn(patch, "effectPath") && patch.effectPath !== null &&
    (typeof patch.effectPath !== "string" || !path.isAbsolute(patch.effectPath) || !/\.(fx|slangp|slang|glsl|hook)$/i.test(patch.effectPath) || /[\x00-\x1f]/.test(patch.effectPath)))
    throw new Error("Choose a ReShade, RetroArch Slang or libplacebo shader file.");
  if (Object.hasOwn(patch, "parameters") && patch.parameters !== null && !require("./live-controls").validParameters(patch.parameters)) throw new Error("Choose valid shader parameter values.");
  const previous = normalizeSettings(current), next = normalizeSettings({ ...previous, ...patch });
  const Live = require("./live-controls");
  if (Live.effectKey(previous) !== Live.effectKey(next)) delete next.parameters;
  return normalizeSettings(next);
}
module.exports = { PRESETS, normalizeSettings, updateSettings };

const path = require("node:path");
const Hardware = require("./graphics-hardware");

// DXVK splits DXVK_CONFIG on semicolons, then reads quoted option values.
// Read only the keys needed here; retain the user's complete original string.
function options(config) {
  const result = new Map();
  for (const line of config.split(";")) {
    const match = /^[ \t\r]*([A-Za-z0-9._]+)[ \t\r]*=([\s\S]*)$/.exec(line);
    if (!match) continue;
    let quoted = false, value = "";
    for (const character of match[2].replace(/^[ \t\r]*/, "")) {
      if (character === '"') quoted = !quoted;
      else if (!quoted && /[ \t\r]/.test(character)) break;
      else value += character;
    }
    result.set(match[1], value);
  }
  return result;
}
function presentsNvidia(config) {
  // DXVK_ENABLE_NVAPI unhides NVIDIA devices; it does not change Apple's vendor.
  return config.get("dxgi.customVendorId")?.toLowerCase() === "10de";
}
function environment(values, name) {
  const config = typeof values.DXVK_CONFIG === "string" ? values.DXVK_CONFIG : "", parsed = options(config);
  if (parsed.has("dxgi.customDeviceDesc") || !presentsNvidia(parsed) ||
      typeof name !== "string" || !name.trim() || /[";\x00-\x1f]/.test(name)) return {};
  return { DXVK_CONFIG: `dxgi.customDeviceDesc = "${name.trim()} (DXVK)"` + (config ? "; " + config : "") };
}
function usesDxvkDxgi(plan) {
  const placements = plan?.apiMode ? plan.placements || [] :
    [...Object.values(plan?.components || {}).map(row => row.used), ...(plan?.additional || [])].filter(Boolean)
      .flatMap(description => (description.files || []).map(file => ({ description, file })));
  return placements.some(({ description, file }) => ["dxvk", "vkd3d-proton"].includes(description.engine) &&
    path.basename(file.path).toLowerCase() === "dxgi.dll");
}
async function prepare(values, { translatorPlan, host, signal } = {}) {
  const parsed = options(typeof values.DXVK_CONFIG === "string" ? values.DXVK_CONFIG : "");
  if (!usesDxvkDxgi(translatorPlan) || parsed.has("dxgi.customDeviceDesc") || !presentsNvidia(parsed)) return {};
  const hardware = await Hardware.graphicsHardware(host, { signal, requireName: true });
  return environment(values, hardware.gpuName);
}
module.exports = { environment, prepare };

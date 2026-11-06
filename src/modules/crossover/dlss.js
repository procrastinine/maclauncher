const fs = require("node:fs");
const path = require("node:path");
const { versionAtLeast, systemVersionSync } = require("../shared/runtime/bundled-native");
const { inspectMachOExports } = require("../shared/runtime/macho-exports");
const { usedForApi } = require("../shared/runtime/translator-roles");

const DLLS = Object.freeze(["nvapi64", "nvngx"]);
const ENVIRONMENT = Object.freeze(["DXMT_ENABLE_NVEXT", "D3DM_ENABLE_METALFX"]);

function needsSceneInputs(effects) {
  const methods = require("../shared/effects/execution-requirements").analyze({effects}).methods;
  const contracts = require("../shared/effects/operation-contracts.mjs");
  return methods.temporal.length > 0 || methods.neural.some(method => contracts.NEURAL[method]?.history === "scene") ||
    methods.generation.some(method => contracts.GENERATION[method]?.scene === true);
}
function withTemporalSelection(settings, effects, translatorPlan) {
  const sources = translatorPlan ? [usedForApi(translatorPlan, "d3d11"), usedForApi(translatorPlan, "d3d12")].filter(Boolean) : [];
  const classicSource = sources.some(source => source.engine === "dxmt" || source.engine === "d3dmetal") ||
    !sources.length && ["auto", "dxmt", "d3dmetal"].includes(settings.graphicsBackend || "auto");
  // Preserve saved runtime integration, including its ability to expose the
  // game's temporal inputs before a shared replacement is selected live.
  return { ...settings, dlss: settings.dlss === true || classicSource && needsSceneInputs(effects) };
}

function hasLibraries(directory) {
  if (!path.isAbsolute(directory || "")) return false;
  return DLLS.every(name => {
    try {
      const file = path.join(directory, name + ".dll"), stat = fs.statSync(file);
      const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(file));
      return stat.isFile() && stat.size > 128 && !relative.startsWith("..") && !path.isAbsolute(relative);
    } catch { return false; }
  });
}

function checkSelection(settings, { backend, dxmt = false, d3dmetal = false,
  hardwareArch = require("../shared/runtime/host-capabilities").getHostCapabilities().hardwareArch, macOSVersion, executableArchitecture, translatorPlan } = {}) {
  if (settings.dlss !== true) return { enabled: false, dxmt: false, d3dmetal: false };
  if (hardwareArch !== "arm64") throw new Error("MetalFX Temporal requires Apple Silicon.");
  if (executableArchitecture && executableArchitecture !== "x86_64") throw new Error("MetalFX Temporal requires a 64-bit Windows executable.");
  const apiEngines = translatorPlan?.apiMode ? [usedForApi(translatorPlan, "d3d11")?.engine, usedForApi(translatorPlan, "d3d12")?.engine] : null;
  if (apiEngines) {
    dxmt = dxmt && apiEngines.includes("dxmt");
    d3dmetal = d3dmetal && apiEngines.includes("d3dmetal");
    backend = "auto"; // Global Wine redirection is transport, not the per-API renderer.
  }
  if (!["auto", "dxmt", "d3dmetal"].includes(backend)) throw new Error("MetalFX Temporal requires DXMT or D3DMetal. Change Graphics or disable MetalFX Temporal.");
  macOSVersion ||= systemVersionSync();
  const supportsDxmt = dxmt && versionAtLeast(macOSVersion, "14.0.0");
  const supportsD3DMetal = d3dmetal && versionAtLeast(macOSVersion, "26.0.0");
  if (backend === "dxmt" && !supportsDxmt || backend === "d3dmetal" && !supportsD3DMetal ||
      backend === "auto" && !supportsDxmt && !supportsD3DMetal) {
    throw new Error("MetalFX Temporal is unavailable with the selected graphics libraries and macOS version. Choose a compatible installed runtime or disable MetalFX Temporal.");
  }
  return { enabled: true, dxmt: supportsDxmt && backend !== "d3dmetal", d3dmetal: supportsD3DMetal && backend !== "dxmt" };
}

function environment(selection) {
  return { DXMT_ENABLE_NVEXT: selection.dxmt ? "1" : "0", D3DM_ENABLE_METALFX: selection.d3dmetal ? "1" : "0" };
}

function hasPlanLibraries(plan, engine) {
  return [usedForApi(plan, "d3d11"), usedForApi(plan, "d3d12")].filter(selected => selected?.engine === engine).some(selected => {
    const files = plan.apiMode && Array.isArray(plan.placements) ? plan.placements.filter(item => item.description.id === selected.id &&
      item.roles.some(role => role === "d3d11" || role === "d3d12")).map(item => item.file) : plan.compatibility?.[selected.id]?.files || selected.files;
    return DLLS.every(name => files.some(file => file.format === "pe" && file.machine === 0x8664 && path.basename(file.path).toLowerCase() === name + ".dll" && fs.existsSync(file.path) && fs.statSync(file.path).size > 128));
  });
}
async function hasD3DMetalPathBridge(engineRoot) {
  if (!path.isAbsolute(engineRoot || "")) return false;
  try {
    const layout = require("../shared/runtime/wine-layout").wineLayout({ wineRoot: engineRoot });
    const names = await inspectMachOExports(path.join(layout.unixRoot, "ntdll.so"), { arch: layout.architecture });
    return ["ntdll_get_unix_file_name", "ntdll_get_dos_file_name"].every(name => names.includes(name));
  } catch { return false; }
}

module.exports = { DLLS, ENVIRONMENT, needsSceneInputs, withTemporalSelection, hasLibraries, hasPlanLibraries, checkSelection, environment, hasD3DMetalPathBridge };

const fs = require("node:fs");
const path = require("node:path");
const { versionAtLeast, systemVersionSync } = require("../shared/runtime/bundled-native");
const { inspectMachOExports } = require("../shared/runtime/macho-exports");

const DLLS = Object.freeze(["nvapi64", "nvngx"]);
const ENVIRONMENT = Object.freeze(["DXMT_ENABLE_NVEXT", "D3DM_ENABLE_METALFX"]);

function withTemporalSelection(settings, graphics, effects) {
  const methods = require("../shared/effects/execution-requirements").analyze({graphics, effects}).methods.temporal;
  // Preserve saved runtime integration, including its ability to expose the
  // game's temporal inputs before a shared replacement is selected live.
  return { ...settings, dlss: settings.dlss === true || methods.length > 0 };
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
  arch = process.arch, macOSVersion, executableArchitecture } = {}) {
  if (settings.dlss !== true) return { enabled: false, dxmt: false, d3dmetal: false };
  if (arch !== "arm64") throw new Error("MetalFX Temporal requires Apple Silicon.");
  if (executableArchitecture && executableArchitecture !== "x86_64") throw new Error("MetalFX Temporal requires a 64-bit Windows executable.");
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

async function hasD3DMetalPathBridge(engineRoot) {
  if (!path.isAbsolute(engineRoot || "")) return false;
  try {
    const names = await inspectMachOExports(path.join(engineRoot, "lib", "wine", "x86_64-unix", "ntdll.so"), { arch: "x64" });
    return ["ntdll_get_unix_file_name", "ntdll_get_dos_file_name"].every(name => names.includes(name));
  } catch { return false; }
}

module.exports = { DLLS, ENVIRONMENT, withTemporalSelection, hasLibraries, checkSelection, environment, hasD3DMetalPathBridge };

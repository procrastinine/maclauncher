const fs = require("node:fs");
const path = require("node:path");
const Host = require("../../shared/runtime/host-capabilities");
const Requirements = require("../../shared/runtime/feature-requirements");
const { readMachOLoadCommands } = require("../../shared/runtime/macho-load-commands");

// Wine's own deployment target is independent of the selected renderer. Inspect
// renderer libraries without opening Wine or raising the floor of other paths.
function minimumMacOS(installation, backend) {
  let minimum = (Requirements.WINE_BACKENDS[backend] || Requirements.WINE_BACKENDS.dxmt).minimumMacOS;
  const root = installation?.crossoverRoot;
  if (!root) return minimum;
  const directory = backend === "dxmt" ? path.join(root, "lib/dxmt/x86_64-unix")
    : path.join(root, "lib64/apple_gptk/external/D3DMetal.framework");
  const pending = [{ directory, depth: 0 }], files = new Set();
  while (pending.length && files.size < 128) {
    const item = pending.pop();
    let entries; try { entries = fs.readdirSync(item.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(item.directory, entry.name);
      if (entry.isDirectory() && item.depth < 4) pending.push({ directory: file, depth: item.depth + 1 });
      else if (entry.isFile() && /(?:\.(?:dylib|so)$|^D3DMetal$)/.test(entry.name)) files.add(file);
      if (files.size >= 128) break;
    }
  }
  for (const file of files) {
    try {
      const image = readMachOLoadCommands(file, { architecture: "x86_64" }).slices[0];
      if (image.minimumMacOS && Host.versionAtLeast(image.minimumMacOS, minimum)) minimum = image.minimumMacOS;
    } catch {}
  }
  return minimum;
}

function reason(installation, backend, host = {}) {
  const required = Requirements.WINE_BACKENDS[backend];
  if (!required) return null;
  const actual = { ...Host.getHostCapabilities(), ...host };
  if (Requirements.requirementSupport({ hardwareArchitectures: required.hardwareArchitectures }, actual).supported === false)
    return "D3DMetal requires Apple Silicon.";
  const minimum = minimumMacOS(installation, backend);
  return Requirements.requirementSupport({ ...required, minimumMacOS: minimum }, actual).supported === false
    ? `${backend === "dxmt" ? "DXMT" : "D3DMetal"} requires macOS ${minimum} or later.` : null;
}

module.exports = { minimumMacOS, reason };

const Host = require("../../shared/runtime/host-capabilities");
const Requirements = require("../../shared/runtime/feature-requirements");
const Parent = require("../../../runtime-adapters/wine");
const Description = require("../../shared/runtime/translator-description");

// Wine's own deployment target is independent of the selected renderer. Inspect
// renderer libraries without opening Wine or raising the floor of other paths.
function minimumMacOS(installation, backend) {
  let minimum = (Requirements.WINE_BACKENDS[backend] || Requirements.WINE_BACKENDS.dxmt).minimumMacOS;
  if (!installation?.crossoverRoot) return minimum;
  const selected = Parent.embeddedComponent(installation,{sourceId:"crossover",engine:backend});
  if (!selected) return minimum;
  if (selected.minimumMacOS && Host.versionAtLeast(selected.minimumMacOS,minimum)) minimum=selected.minimumMacOS;
  try {
    const description=Description.describeTranslator(selected.root,{engine:backend,source:selected.source.id});
    // This compatibility seam belongs to the existing Intel CrossOver route.
    // Core passes measured admitted parts to the new route independently.
    for(const file of description.files)for(const image of file.slices||[])if(image.architecture==="x86_64"&&image.minimumMacOS&&Host.versionAtLeast(image.minimumMacOS,minimum))minimum=image.minimumMacOS;
  } catch {}
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

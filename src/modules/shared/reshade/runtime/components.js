const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../runtime/bundled-native");
const FSR = require("../temporal/fsr");
const FSRSource = require("../temporal/fsr/source.json");
const FSR4 = require("../temporal/fsr4");
const FSR4Source = require("../temporal/fsr4/source.json");

function getComponents({ root = require("../index").runtimeRoot(), platform = process.platform, macOSVersion,
  installed = [] } = {}) {
  const systemVersion = macOSVersion || (platform === "darwin" ? Native.systemVersionSync() : "0");
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(root, "runtime.json"), "utf8")); } catch { record = {}; }
  const hasProcessor = record.schema === 1 && typeof record.minimumMacOS === "string" &&
    fs.existsSync(path.join(root, "libreshade-macos.dylib"));
  const graphics = record.features?.graphics || {};
  const spatial = graphics.spatialMethods || [], temporal = graphics.temporalMethods || [];
  // Payload presence and host compatibility are separate: an older macOS can
  // still report an included provider and the OS version it requires.
  const fsr = FSR.resolve(root, { platform: "darwin", macOSVersion: "99.0" });
  const fsr4 = FSR4.resolve(root, { platform: "darwin", macOSVersion: "99.0" });
  const xess = require("../xess").resolve(root, {platform:"darwin"});
  const hostSupports = floor => platform === "darwin" && Native.versionAtLeast(systemVersion, floor);
  const nativeFloor = record.minimumMacOS || "13.0";
  const status = (included, floor) => !included ? "Not included" : !hostSupports(floor) ? `Requires macOS ${floor}` : "Included";
  const nativeAvailable = included => Boolean(included && hasProcessor && hostSupports(nativeFloor));
  const metalIncluded = hasProcessor && (spatial.includes("metalfx") || temporal.includes("metalfx"));
  const hardware = require("../hardware-support").snapshot(root, {platform});
  const metalNames = {spatial:"Spatial scaling",temporal:"Temporal scaling",denoised:"Denoised scaling",interpolation:"Frame interpolation"};
  const metalSupport = hardware.state === "ready" ? Object.entries(metalNames).map(([name,label]) =>
    `${label}: ${require("../hardware-support").operationReason(hardware,name,{macOSVersion:systemVersion}) ||
      (hardware.devices.some(row=>row.metalfx[name].supported)?"GPU supported":"GPU support unknown")}`).join(". ")+"." : "";
  const rows = [{
    id: "metalfx", label: "Apple MetalFX", version: platform === "darwin" ? [hardware.device?.name,`macOS ${systemVersion}`].filter(Boolean).join(" · ") : null,
    status: !hostSupports("13.0") ? "Requires macOS 13" : metalIncluded ? "Provided by macOS" : "Not included",
    available: nativeAvailable(metalIncluded),
    description: ["Spatial scaling uses the shared image. Temporal scaling and interpolation need scene inputs; denoised scaling also needs noisy color and material inputs.",metalSupport].filter(Boolean).join(" "),
    requirements: "Provided by macOS; no download. Spatial and temporal scaling require macOS 13 or later; denoised scaling and interpolation require macOS 26 or later. Available methods also depend on the included graphics processor and supplied inputs."
  }, {
    id: "fsr1", label: "AMD FSR 1", status: status(hasProcessor && spatial.includes("fsr1"), nativeFloor),
    available: nativeAvailable(spatial.includes("fsr1")),
    description: "Spatial EASU upscaling and RCAS sharpening use the current game image.",
    requirements: `Included with MacLauncher on macOS ${nativeFloor} or later. No models or separate download.`
  }];
  for (const method of ["fsr2", "fsr3"]) {
    const present = hasProcessor && temporal.includes(method) && fsr?.methods.includes(method);
    rows.push({ id: method, label: method === "fsr2" ? "AMD FSR 2.2" : "AMD FSR 3.1", version: present ? FSRSource[method].version : null,
      status: status(present, FSRSource.minimumMacOS), available: nativeAvailable(present) && hostSupports(FSRSource.minimumMacOS),
      description: "Native Metal temporal upscaling and RCAS sharpening.",
      requirements: `macOS ${FSRSource.minimumMacOS} or later. Requires renderer-provided depth, motion vectors, jitter and camera projection data. No model download.` });
  }
  // An accepted older payload keeps its own, higher macOS floor.
  const fsr4Present = hasProcessor && temporal.includes("fsr4") && fsr4, fsr4Floor = fsr4?.minimumMacOS || FSR4Source.minimumMacOS;
  rows.push({ id: "fsr4", label: "AMD FSR 4.1", version: fsr4Present ? fsr4.version : null,
    status: status(fsr4Present, fsr4Floor), available: nativeAvailable(fsr4Present) && hostSupports(fsr4Floor),
    description: "Native Metal neural temporal upscaling. The compatible model is included.",
    requirements: `macOS ${fsr4Floor} or later and an Apple Silicon GPU, for ARM and Intel game processes. Requires renderer-provided depth, motion vectors and camera jitter.`
  }, {
    id:"xess",label:"Intel XeSS",version:xess?record.version:null,
    status:status(Boolean(xess),xess?.descriptor.minimumMacOS||nativeFloor),
    available:nativeAvailable(Boolean(xess))&&hostSupports(xess?.descriptor.minimumMacOS||nativeFloor),
    description:"Included macOS GPU adapter for XeSS super resolution"+(xess?.generation?" and frame generation":"")+". Original Intel runtime files are managed separately.",
    requirements:"The adapter follows the MacLauncher graphics package version. Its declared Intel SDK dependency and a compatible GPU compute host are required.",
    ...(xess?{providerABI:xess.descriptor.providerABI,sdkRevision:xess.descriptor.sdk.commit,operations:["superresolution",...(xess.generation?["interpolate"]:[])]}:{})
  }, {
    id: "lossless", label: "Lossless Scaling", status: installed.length ? `${installed.length} ${installed.length === 1 ? "model file imported" : "model files imported"}` : "Models required",
    available: installed.length > 0,
    description: "Two model families with separate availability: LS1 spatial upscaling and LSFG frame generation. Both use compatible models from a purchased copy.",
    requirements: "Steam ownership is required. Download with Steam, find an existing installation or import a DLL below."
  });
  return rows;
}
module.exports = { getComponents };

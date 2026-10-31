// Stable platform/API requirements. A selected payload can declare a higher
// minimum; GPU device support is queried separately by the graphics owner.
const feature = (label, minimumMacOS, details = {}) => Object.freeze({label, platform: "darwin", minimumMacOS, ...details});
const METALFX = Object.freeze({
  spatial: feature("MetalFX spatial scaling", "13.0"),
  temporal: feature("MetalFX temporal scaling", "13.0"),
  denoised: feature("MetalFX denoised scaling", "26.0"),
  interpolation: feature("MetalFX frame interpolation", "26.0")
});
const METAL4 = feature("Metal 4", "26.0", {hardwareArchitectures: Object.freeze(["arm64"])});
// Runtimes built only for Apple Silicon, such as the Android and iOS app hosts.
const APPLE_SILICON = Object.freeze({label: "Apple Silicon", platform: "darwin", hardwareArchitectures: Object.freeze(["arm64"])});
const METALFX_EXTRA_INPUTS = feature("MetalFX distortion and previous-color inputs", "27.0");
// Frame-generation methods whose macOS floor exceeds the graphics package's,
// read from their generation contracts. deviceSupport names a support check
// that is not a Metal device query.
const {GENERATION} = require("../effects/operation-contracts.mjs");
const FRAME_GENERATION = Object.freeze({
  "metalfx-image": feature("MetalFX image interpolation", GENERATION["metalfx-image"].minimumMacOS),
  "vt-interpolation": feature("VideoToolbox low-latency interpolation", GENERATION["vt-interpolation"].minimumMacOS,
    {deviceSupport: "Support reported by VideoToolbox"})
});
const NEURAL = feature("MLX neural restoration and interpolation", require("../reshade/neural/source.json").minimumMacOS,
  {hardwareArchitectures: Object.freeze(["arm64"])});
const FSR4 = feature("FSR 4.1", require("../reshade/temporal/fsr4/source.json").minimumMacOS,
  {hardwareArchitectures: METAL4.hardwareArchitectures});
const WINE_BACKENDS = Object.freeze({
  dxmt: feature("DXMT", "14.0"),
  d3dmetal: feature("D3DMetal", "14.0", {hardwareArchitectures: Object.freeze(["arm64"])})
});
const TEMPLATE_RENDERERS = Object.freeze({
  dxmt: feature("Sikarugir DXMT", "14.0.0"),
  d3dmetal: feature("Sikarugir D3DMetal", "26.4.0", {hardwareArchitectures: Object.freeze(["arm64"])}),
  kosmickrisp: feature("KosmicKrisp", METAL4.minimumMacOS + ".0", {hardwareArchitectures: METAL4.hardwareArchitectures})
});
// The content picker reports the picked window and app from this release on.
const WINDOW_GRAPHICS = feature("Window graphics", "15.2");
const WINE_TEMPORAL = feature("Wine temporal scene bridge", WINE_BACKENDS.dxmt.minimumMacOS,
  {hardwareArchitectures: METAL4.hardwareArchitectures});
const WINE_MODERN_VULKAN = feature("Wine modern Vulkan renderers", METAL4.minimumMacOS,
  {hardwareArchitectures: METAL4.hardwareArchitectures});
// The one spelling map for CPU names: x86_64 and amd64 read as x64, aarch64 as arm64.
const normalizeArchitecture = value => ["x86_64", "amd64"].includes(value) ? "x64" : value === "aarch64" ? "arm64" : value;

// Leading numeric parts retain the existing runtime-version comparison.
function versionAtLeast(actual, minimum) {
  const parts = value => String(value ?? "").split(".").map(part => Number(/^\d+/.exec(part)?.[0] ?? NaN));
  const a = parts(actual), b = parts(minimum);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference) return difference > 0;
  }
  return true;
}

// null means that a required host fact has not been measured. It is not a
// negative hardware result and never supplies a reason to refuse a feature.
function requirementSupport(requirements = {}, host = {}) {
  if (requirements.platform && host.platform && requirements.platform !== host.platform)
    return {supported: false, reason: requirements.platform === "darwin" ? "Requires macOS." : "Requires " + requirements.platform + "."};
  if (requirements.hardwareArchitectures?.length && host.hardwareArch && !requirements.hardwareArchitectures.includes(host.hardwareArch))
    return {supported: false, reason: requirements.hardwareArchitectures.join() === "arm64" ? "Requires a Mac with Apple Silicon." : "Requires a supported processor."};
  if (requirements.executionArchitectures?.length && host.executionArch &&
      !requirements.executionArchitectures.some(arch => normalizeArchitecture(arch) === normalizeArchitecture(host.executionArch)))
    return {supported: false, reason: "Requires a matching process architecture."};
  if (requirements.minimumMacOS && host.macOSVersion && !versionAtLeast(host.macOSVersion, requirements.minimumMacOS))
    return {supported: false, reason: `Requires macOS ${requirements.minimumMacOS} or later.`};
  const known = (!requirements.platform || Boolean(host.platform)) &&
    (!requirements.hardwareArchitectures?.length || Boolean(host.hardwareArch)) &&
    (!requirements.executionArchitectures?.length || Boolean(host.executionArch)) &&
    (!requirements.minimumMacOS || Boolean(host.macOSVersion));
  return {supported: known ? true : null, reason: null};
}

module.exports = {APPLE_SILICON, METALFX, METAL4, METALFX_EXTRA_INPUTS, FRAME_GENERATION, NEURAL, FSR4, WINE_BACKENDS, TEMPLATE_RENDERERS,
  WINDOW_GRAPHICS, WINE_TEMPORAL, WINE_MODERN_VULKAN, requirementSupport, versionAtLeast, normalizeArchitecture};

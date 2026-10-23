const path = require("node:path");
const Native = require("../runtime/bundled-native");
const providers = [
  { format: "slangp", extensions: [".slangp", ".slang"], label: "RetroArch Slang", module: "./retroarch", rootEnvironment: "RESHADE_RETROARCH_ROOT" },
  { format: "libplacebo", extensions: [".glsl", ".hook"], label: "libplacebo", module: "./libplacebo", rootEnvironment: "RESHADE_LIBPLACEBO_ROOT" }
];
function packaged(file) {
  const extension = path.extname(file || "").toLowerCase(), provider = providers.find(row => row.extensions.includes(extension));
  return provider ? { ...provider, ...require(provider.module) } : null;
}
function availability(format, { features = {}, graphicsArchitecture = process.arch, macOSVersion } = {}) {
  if (format === "slang") format = "slangp";
  if (!format || format === "fx") return null;
  const provider = providers.find(row => row.format === format);
  if (!provider || !features.formats?.includes(format)) return `The ${provider?.label || format} provider is unavailable in this application build.`;
  const specification = features.providers?.[format], architecture = graphicsArchitecture === "x64" ? "x86_64" : graphicsArchitecture;
  if (specification?.architectures && !specification.architectures.includes(architecture)) return `The ${provider.label} provider requires ${specification.architectures.join(" or ")} game processes.`;
  if (specification?.minimumMacOS && !Native.versionAtLeast(macOSVersion || Native.systemVersionSync(), specification.minimumMacOS))
    return `The ${provider.label} provider requires macOS ${specification.minimumMacOS} or later.`;
  return null;
}
function requireAvailable(provider, options) {
  const reason = availability(provider.format, options);if (reason) throw new Error(reason);
  return provider;
}
module.exports = { packaged, availability, requireAvailable };

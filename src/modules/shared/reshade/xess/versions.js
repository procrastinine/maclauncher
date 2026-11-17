const fs = require("node:fs"), path = require("node:path");
const Upstream = require("../../runtime/upstream"), Files = require("../../runtime/bundled-native");
const Binary = require("../../../../core/binary-arch"), PE = require("../../runtime/pe-exports");
const { createPinnedNativeManager } = require("../../runtime/pinned-native-manager");
const { hashFile } = require("../../runtime/pinned-native-manager");
const Source = require("./source.json");

// These are the entry points consumed by the compiled GPU hosts.
const APIs = {
  d3d12: ["xessD3D12CreateContext", "xessD3D12BuildPipelines", "xessD3D12Init", "xessD3D12Execute", "xessDestroyContext", "xessGetProperties"],
  vulkan: ["xessVKGetRequiredInstanceExtensions", "xessVKGetRequiredDeviceExtensions", "xessVKGetRequiredDeviceFeatures", "xessVKCreateContext", "xessVKBuildPipelines", "xessVKInit", "xessVKExecute", "xessDestroyContext", "xessGetProperties"],
  frameGeneration: ["xefgSwapChainD3D12CreateContext", "xefgSwapChainD3D12BuildPipelines", "xefgSwapChainD3D12GetProperties", "xefgSwapChainD3D12InitFromSwapChainDesc", "xefgSwapChainD3D12GetSwapChainPtr", "xefgSwapChainSetLatencyReduction", "xefgSwapChainSetEnabled", "xefgSwapChainTagFrameConstants", "xefgSwapChainD3D12TagFrameResource", "xefgSwapChainSetPresentId", "xefgSwapChainGetLastPresentStatus", "xefgSwapChainDestroy"],
  latency: ["xellD3D12CreateContext", "xellSetSleepMode", "xellAddMarkerData", "xellDestroyContext"]
};
function inspectFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024) throw Error("Choose a regular Intel XeSS DLL.");
  const facts = Binary.inspectBinary(file), pe = PE.readPeExports(file);
  if (facts.format !== "pe" || facts.machine !== "x86_64" || !pe?.isDll) throw Error("The XeSS GPU host requires an x86_64 Windows DLL.");
  return { file, sha256: hashFile(file), supports: Object.keys(APIs).filter(key => APIs[key].every(name => pe.exports.get(name)?.executable)) };
}
function inspect(input) {
  const files = [], names = new Set(["libxess.dll", "libxess_fg.dll", "libxell.dll"]);
  function walk(directory, depth) {
    if (depth > 12 || files.length > 20000) throw Error("The XeSS SDK directory exceeds its inspection limit.");
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) walk(file, depth + 1);
      else if (item.isFile()) files.push(file);
      else if (names.has(item.name.toLowerCase())) throw Error("XeSS runtime files must be regular files.");
    }
  }
  if (fs.statSync(input).isDirectory()) walk(input, 0);
  else {
    if (!names.has(path.basename(input).toLowerCase())) throw Error("Choose a XeSS SDK folder or original runtime DLL.");
    for (const name of names) { const file = path.join(path.dirname(input), name); if (fs.existsSync(file)) files.push(file); }
  }
  const libraries = {}, hashes = {}, backends = [];
  for (const file of files.filter(file => names.has(path.basename(file).toLowerCase()))) {
    const value = inspectFile(file), name = path.basename(file).toLowerCase();
    if (hashes[name] && hashes[name] !== value.sha256) throw Error("The selected SDK contains different copies of the same XeSS DLL.");
    hashes[name] = value.sha256;
    if (name === "libxess.dll" && value.supports.some(key => ["d3d12", "vulkan"].includes(key))) {
      libraries.superresolution = file; backends.push(...value.supports.filter(key => ["d3d12", "vulkan"].includes(key)));
    }
    if (name === "libxess_fg.dll" && value.supports.includes("frameGeneration")) libraries.frameGeneration = file;
    if (name === "libxell.dll" && value.supports.includes("latency")) libraries.latency = file;
  }
  if (!libraries.superresolution) throw Error("The SDK has no XeSS super-resolution DLL with the GPU host's required exports.");
  return { library: libraries.superresolution, libraries, hashes, backends: [...new Set(backends)],
    capabilities: ["superresolution", ...(libraries.frameGeneration && libraries.latency ? ["interpolate"] : [])] };
}
const upstream = Upstream.github({ repository: "intel/xess", allArchitectures: true,
  recognize: release => ({ version: release.tag_name.replace(/^v(?=\d)/, ""),
    assets: (release.assets || []).filter(asset => /(?:xess|sdk).*\.zip$/i.test(asset.name)), architecture: "universal" }) });
function createManager(dependencies = {}) {
  return createPinnedNativeManager({ id: Source.managerId, label: "XeSS", upstream, nativeLibrary: true, supportsDefault: true,
    sourceUrl: "https://github.com/intel/xess/releases",
    resolveExecutable: root => inspect(root).library,
    inspectRuntime(options) {
      const selected = inspect(options.runtimePath), sha256 = hashFile(selected.library);
      if (options.expectedSha256 && options.expectedSha256 !== sha256) throw Error("The XeSS runtime changed; register it again.");
      for (const [relative, digest] of Object.entries(options.runtimeInstallationMetadata?.files || {})) {
        Files.relativeFile(relative);
        if (!options.runtimeRoot || Files.readRegular(path.join(options.runtimeRoot, relative), Files.LIMITS.fileBytes, { digestOnly: true }).sha256 !== digest)
          throw Error("An installed XeSS SDK library changed.");
      }
      return { executablePath: selected.library, runtimeVersion: options.runtimeVersion, upstreamRevision: options.upstreamRevision,
        architectures: ["x86_64"], needsRosetta: false, sha256, ...selected };
    }, prepareInstall: async ({ unpacked }) => {
      const selected = inspect(unpacked);
      return { files: Object.fromEntries(Object.values(selected.libraries).map(file => [path.relative(unpacked, file), hashFile(file)])) };
    }, dependencies });
}
module.exports = { createManager, inspect, inspectFile, upstream };

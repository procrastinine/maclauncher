const fs = require("node:fs"), path = require("node:path");
const Bundled = require("../runtime/bundled-native");

const managerId = "vulkan-kosmickrisp-gles32";
const selectionId = "kosmickrisp:maclauncher-gles32";

function createProvider({ resourceRoot, platform = process.platform, arch = process.arch, dependencies = {} } = {}) {
  const bundle = Bundled.createBundledNativeRuntime({ managerId, resourceRoot, platform, arch, dependencies });
  function declared() {
    return (dependencies.declarations || (() => JSON.parse(fs.readFileSync(path.join(__dirname, "distribution-supplementals.json"), "utf8"))))()
      .find(item => item.id === managerId && item.arch === arch);
  }
  function selected(verification) {
    if (platform !== "darwin" || arch !== "arm64") return null;
    const declaration = declared();
    if (!declaration) return null;
    const runtime = bundle.resolveRuntime({ version: declaration.version, verification });
    if (!runtime) return null;
    if (runtime.bundledManifestSha256 !== declaration.manifestSha256) throw new Error("Included Vulkan library differs from its package.");
    const manifest = bundle.resolve({ version: declaration.version, verification: "status" }).manifest;
    return { id: selectionId, backend: "kosmickrisp", version: declaration.version, included: true,
      label: "KosmicKrisp · GLES 3.2 (included)", minimumMacOS: runtime.minimumMacOS,
      library: Bundled.resolveInstalledAsset(runtime, "loader"), driver: runtime.runtimePath,
      readable: manifest.files.filter(file => file.architectures).map(file => path.join(runtime.installDir, "files", file.path)) };
  }
  return {
    installed() { try { const item = selected("status"); return item ? [item] : []; } catch { return []; } },
    resolve(item) {
      if (item.id !== selectionId) throw new Error("The selected included Vulkan library is unavailable.");
      const resolved = selected("full");
      if (!resolved) throw new Error("The selected included Vulkan library is unavailable for this Mac.");
      return resolved;
    }
  };
}

module.exports = { ...createProvider(), createProvider };

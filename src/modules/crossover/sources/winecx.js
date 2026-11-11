const fs = require("node:fs");
const path = require("node:path");

// dappermint's winecx-gptk runtime: CodeWeavers' CrossOver Wine changes on a
// current Wine release, downloaded as one Libraries archive. DXVK and DXMT
// arrive with it; D3DMetal comes from a version installed in Runtimes.
module.exports = Object.freeze({
  id: "winecx", label: "WineCX", runtimeLabel: "WineCX", managerId: "winecx", invocation: "wine",
  order: 202, graphicsArchitecture: "x86_64",
  manager: () => require("../winecx/runtime/manager"),
  labels: Object.freeze({ source: "WineCX", automatic: "WineCX's automatic choice" }),
  environmentKind: null, prefixModel: "windowsVersion", downloads: true,
  // Included translators are placed by MacLauncher, as no CrossOver graphics
  // selector chooses among them.
  graphicsSelector: false,
  vulkanLibrarySelector: install => install?.capabilities?.vulkanLibrarySelector === true,
  includedTranslators(install, add, { requestedEngine, gstreamerVersion }) {
    const root = install.librariesRoot || path.dirname(install.wineRoot), lib = install.libraryRoot || path.join(install.wineRoot, "lib");
    const versions = install.componentVersions || {};
    for (const [folder, engine] of [["DXMT", "dxmt"], ["DXVK", "dxvk"]]) add(path.join(root, folder), engine, "d3d-renderer", versions[engine] ? { version: versions[engine] } : {});
    add(path.join(lib, "libMoltenVK.dylib"), "moltenvk", "vulkan-driver", { form: "dylib" });
    const core = path.join(lib, "libgstreamer-1.0.0.dylib");
    if (fs.existsSync(core) && (!requestedEngine || requestedEngine === "gstreamer")) add(path.join(lib, "gstreamer-1.0"), "gstreamer", "video", { form: "dylib", version: gstreamerVersion(core) });
  },
  // Its DXMT keeps the Whisky x64/x32 layout, which the camera adapter does
  // not use as a base; a DXMT version from Runtimes serves it.
  dxmtBase: () => null,
  // Its native closure uses loader-relative paths; the fallback root covers
  // libraries Wine opens by name.
  nativeLibraries(install) {
    const lib = install.libraryRoot || path.join(install.wineRoot, "lib"), plugins = path.join(lib, "gstreamer-1.0");
    return { libraries: [lib], frameworks: [], gstreamer: fs.existsSync(plugins) ? { lib, plugins } : null };
  },
  launchEnvironment: () => ({})
});

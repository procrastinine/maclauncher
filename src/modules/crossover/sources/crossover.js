const fs = require("node:fs");
const path = require("node:path");

// A CrossOver application installed on this Mac. CrossOver's own wrapper and
// bottle tool run its Wine, and its graphics selector chooses among the
// translators the application includes.
module.exports = Object.freeze({
  id: "crossover", label: "CrossOver", runtimeLabel: "CrossOver", managerId: "crossover", invocation: "crossover",
  order: 200,
  manager: () => require("../runtime/manager"),
  labels: Object.freeze({ source: "CrossOver", automatic: "CrossOver's automatic choice", environment: "Bottle setting", environmentName: "CrossOver bottle" }),
  environmentKind: "crossover-bottle", prefixModel: "bottleTemplate", downloads: false,
  // Components from a CrossOver application stay with CrossOver launches.
  ownComponents: true,
  graphicsSelector: true,
  vulkanLibrarySelector: () => true,
  includedTranslators(install, add, { layout, requestedEngine, gstreamerVersion }) {
    for (const engine of ["dxmt", "dxvk"]) add(path.join(layout.root, "lib", engine), engine, "d3d-renderer");
    add(path.join(layout.root, "lib64/apple_gptk"), "d3dmetal", "d3d-renderer");
    add(path.join(layout.root, "lib64/libMoltenVK.dylib"), "moltenvk", "vulkan-driver", { form: "dylib" });
    if (!requestedEngine || requestedEngine === "gstreamer")
      add(path.join(layout.root, "lib64/gstreamer-1.0"), "gstreamer", "video", { form: "dylib", version: gstreamerVersion(path.join(layout.root, "lib64/libgstreamer-1.0.0.dylib")) });
  },
  // CrossOver's automatic selector can choose another renderer, so its DXMT is
  // the camera adapter's base only for an explicit DXMT selection.
  dxmtBase(install, { translator, settings = {} } = {}) {
    if (!path.isAbsolute(install.crossoverRoot || "") || translator?.engine !== "dxmt" && settings.graphicsBackend !== "dxmt") return null;
    return fs.existsSync(path.join(install.crossoverRoot, "lib/wine/x86_64-unix/wine")) ? path.join(install.crossoverRoot, "lib/dxmt") : null;
  },
  // CrossOver names the versions of its translators in its changelog.
  includedVersion(engine, layout, Description) {
    try {
      const name = Description.label({ engine }).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return fs.readFileSync(path.join(layout.root, "changelog.html"), "utf8").match(new RegExp(`Update to ${name}\\s+v?(\\d+(?:\\.\\d+)+(?:[a-z]\\d*)?)`, "i"))?.[1] || "";
    } catch { return ""; }
  }
});

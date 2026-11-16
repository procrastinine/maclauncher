const fs = require("node:fs");
const path = require("node:path");

// A CrossOver application installed on this Mac. CrossOver's own wrapper and
// bottle tool run its Wine, and its graphics selector chooses among the
// translators the application includes.
const Adapter = require("../../../runtime-adapters/wine");
module.exports = Adapter.descriptor("crossover", {
  manager: () => require("../runtime/manager"),
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

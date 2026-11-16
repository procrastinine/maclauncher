const fs = require("node:fs");
const path = require("node:path");

// A Sikarugir Wine engine with the Template of support libraries published
// for it. The Template supplies the engine's translators and native libraries.
const Adapter = require("../../../runtime-adapters/wine");
module.exports = Adapter.descriptor("sikarugir", {
  manager: () => require("../sikarugir/runtime/manager"),
  // The Template's DXMT, for a Wine tree with the modern WoW64 layout.
  dxmtBase(install) {
    const engine = install.engineRoot || install.wineRoot || (install.executablePath && path.dirname(path.dirname(install.executablePath)));
    if (!engine || !fs.existsSync(path.join(engine, "lib/wine/x86_64-unix/ntdll.so")) || fs.existsSync(path.join(engine, "lib/wine/x86_32on64-unix/ntdll.so"))) return null;
    return path.join(Adapter.embeddedComponent(install, {sourceId: "sikarugir", engine: "dxmt"}).root, "wine");
  },
  // The publisher's Wine 11 loader requires this initialization marker before
  // loading Windows libraries, including wineboot in a fresh prefix.
  launchEnvironment: (install, { existingEnvironment } = {}) => existingEnvironment || /^11(?:[._]|$)/.test(install.engineVersion || "") ? { SikarugirAppWine11: "1" } : {}
});

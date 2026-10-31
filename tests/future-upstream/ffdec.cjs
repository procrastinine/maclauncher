const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");
const { writeZipArchive } = require("../helpers/zip-fixture");

// The portable archive sits beside installers, a disk image and the library.
const repository = "jindrapetrik/jpexs-decompiler";
const releases = ["24.1.0", "24.0.1"].map(version => githubRelease(repository, `version${version}`,
  [`ffdec_${version}.zip`, `ffdec_${version}_setup.exe`, `ffdec_${version}_macosx.dmg`, `ffdec_lib_${version}.zip`, `ffdec_${version}.deb`]));
const scenarios = githubScenarios(repository, releases, { rename: name => name.replace(/^ffdec_(\d[\d.]*)\.zip$/, "ffdec-$1-portable.zip") });
scenarios.renamedAsset.usable = true;
const jar = (file, main) => { fs.mkdirSync(path.dirname(file), { recursive: true });
  writeZipArchive(file, [{ name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\r\n" + (main ? "Main-Class: com.jpexs.decompiler.flash.gui.Main\r\n" : "") }]); };
module.exports = { managers: ["ffdec"], current: githubRoutes(repository, releases), scenarios,
  layout: { write: root => { jar(path.join(root, "ffdec.jar"), true); jar(path.join(root, "lib", "ffdec_lib.jar"), false); return "ffdec.jar"; },
    resolve: root => require("../../src/modules/flash/runtime/ffdec-manager").core.locateJar(root, "24.1.0") } };

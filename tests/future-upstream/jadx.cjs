const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");
const { writeZipArchive } = require("../helpers/zip-fixture");

// The portable CLI archive sits beside graphical builds with bundled runtimes.
const repository = "skylot/jadx";
const releases = ["1.5.7", "1.5.6"].map(version => githubRelease(repository, `v${version}`,
  [`jadx-${version}.zip`, `jadx-gui-${version}-with-jre-win.zip`, `jadx-gui-${version}-no-jre-win.exe`]));
const scenarios = githubScenarios(repository, releases, { rename: name => name.replace(/^jadx-(\d[\d.]*)\.zip$/, "jadx-cli-$1-bin.zip") });
scenarios.renamedAsset.usable = true;
const jar = file => { fs.mkdirSync(path.dirname(file), { recursive: true });
  writeZipArchive(file, [{ name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\r\nMain-Class: jadx.cli.JadxCLI\r\n" }, { name: "jadx/cli/JadxCLI.class", data: "class" }]); };
module.exports = { managers: ["jadx"], current: githubRoutes(repository, releases), scenarios,
  // The application JAR is found when the archive moves it into a folder.
  layout: { write: root => { jar(path.join(root, "lib", "jadx-1.5.7-all.jar")); return "lib/jadx-1.5.7-all.jar"; },
    resolve: root => require("../../src/modules/android/tools/jadx-manager").core.locateJar(root, "1.5.7") },
  checks: { "JADX finds a renamed application JAR by its entry point"(t) {
    const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "future-jadx-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    jar(path.join(root, "jadx-2.0.0", "lib", "jadx-cli-2.0.0.jar"));
    fs.mkdirSync(path.join(root, "jadx-2.0.0", "bin")); fs.writeFileSync(path.join(root, "jadx-2.0.0", "bin", "jadx"), "#!/bin/sh\n");
    require("node:assert/strict").equal(require("../../src/modules/android/tools/jadx-manager").core.locateJar(root, "2.0.0"), "jadx-2.0.0/lib/jadx-cli-2.0.0.jar");
  } } };

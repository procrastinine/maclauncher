const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// One disk image per Mac CPU beside Windows, Linux and source downloads.
const repository = "rizinorg/cutter";
const releases = ["2.4.1", "2.4.0"].map(version => githubRelease(repository, `v${version}`, [`Cutter-v${version}-macOS-arm64.dmg`,
  `Cutter-v${version}-macOS-x86_64.dmg`, `Cutter-v${version}-Linux-x86_64.AppImage`, `Cutter-v${version}-Windows-x86_64.zip`, `Cutter-v${version}-src.tar.gz`]));
const scenarios = githubScenarios(repository, releases);
scenarios.renamedAsset.usable = true;
module.exports = { managers: ["native-inspector"], current: githubRoutes(repository, releases), scenarios,
  // The command-line tools are found when the app moves into a folder.
  layout: { write: root => { fs.mkdirSync(path.join(root, "Cutter.app", "Contents", "Resources", "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "Cutter.app", "Contents", "Resources", "bin", "rizin"), "binary"); return "Cutter.app/Contents/Resources"; },
  resolve: root => require("../../src/modules/shared/decompilation/runtime/native-manager").__test.appResources(root) } };

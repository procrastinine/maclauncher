const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

const repository = "krkrsdl2/krkrsdl2";
const releases = ["v1.1.0", "v1.0.0"].map(tag => githubRelease(repository, tag, ["krkrsdl2-macos.zip", "krkrsdl2-win32.zip", "krkrsdl2-emscripten.zip"]));
const scenarios = githubScenarios(repository, releases);
scenarios.renamedAsset.usable = true;
module.exports = { managers: ["krkrsdl2"], current: githubRoutes(repository, releases), scenarios,
  layout: {
    write(root) { fs.writeFileSync(path.join(root, "krkrsdl2"), "engine"); return "krkrsdl2"; },
    resolve: root => require("../../src/modules/kirikiri/catalog").releaseExecutable(root)
  } };

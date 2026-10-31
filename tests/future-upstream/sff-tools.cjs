const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

const repository = "openkakutou/sff";
const releases = ["1.2.0", "1.1.0"].map(version => githubRelease(repository, `v${version}`, ["sff.wasm", "wasm_exec.js"]));
// The module and its Go glue are renamed rather than repackaged.
const scenarios = githubScenarios(repository, releases, { rename: name => name.replace(/\.wasm$/, "-wasip1.wasm").replace(/\.js$/, "-go1.26.js") });
scenarios.renamedAsset.usable = true;
module.exports = { managers: ["sff-tools"], current: githubRoutes(repository, releases), scenarios };

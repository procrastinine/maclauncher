const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

const repository = "Sinflower/WolfTL";
const releases = ["1.2.0", "1.1.0"].map(version => githubRelease(repository, `v${version}`, ["WolfTL.exe"]));
module.exports = { managers: ["wolftl"], current: githubRoutes(repository, releases),
  scenarios: githubScenarios(repository, releases, { rename: name => name.replace(/\.exe$/, "_x64.zip") }) };
module.exports.scenarios.renamedAsset.usable = true;

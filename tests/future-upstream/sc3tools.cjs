const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

const repository = "CommitteeOfZero/sc3tools";
const releases = ["1.4.0", "1.3.0"].map(version => githubRelease(repository, `v${version}`, ["sc3tools.exe"]));
module.exports = { managers: ["sc3tools"], current: githubRoutes(repository, releases),
  scenarios: githubScenarios(repository, releases, { rename: name => name.replace(/\.exe$/, "-win-x64.zip") }) };
module.exports.scenarios.renamedAsset.usable = true;

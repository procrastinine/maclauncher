const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// The command-line build is published beside the graphical one.
const repository = "Sinflower/UberWolf";
const releases = ["0.5.0", "0.4.2"].map(version => githubRelease(repository, `v${version}`, ["UberWolf.exe", "UberWolfCli.exe"]));
module.exports = { managers: ["uberwolf"], current: githubRoutes(repository, releases),
  scenarios: githubScenarios(repository, releases, { rename: name => name.replace(/\.exe$/, "-x64.zip") }) };
module.exports.scenarios.renamedAsset.usable = true;

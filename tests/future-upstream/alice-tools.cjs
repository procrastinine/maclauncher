const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// Windows tools: a later release may add a CPU word or ship a different archive.
const repository = "nunuhara/alice-tools";
const releases = ["0.13.0", "0.12.1"].map(version => githubRelease(repository, version, [`alice-tools-${version}.zip`]));
module.exports = { managers: ["alice-tools"], current: githubRoutes(repository, releases),
  scenarios: { ...githubScenarios(repository, releases, { rename: name => name.replace(/\.zip$/, "-win64.7z") }) } };
module.exports.scenarios.renamedAsset.usable = true;

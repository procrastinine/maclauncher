const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// A standalone JAR; a later major version stays listed.
const repository = "iBotPeaches/Apktool";
const releases = ["3.0.3", "3.0.2"].map(version => githubRelease(repository, `v${version}`, [`apktool_${version}.jar`]));
const scenarios = githubScenarios(repository, releases, { rename: name => name.replace(/^apktool_/, "apktool-cli-") });
scenarios.renamedAsset.usable = true;
module.exports = { managers: ["apktool"], current: githubRoutes(repository, releases), scenarios };

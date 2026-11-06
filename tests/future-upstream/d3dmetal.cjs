const { githubRoutes, githubRelease, githubScenarios, publisherScenarios } = require("../helpers/future-upstream.cjs");

// D3DMetal downloads come from the d3dmetal folder of Sikarugir Template
// releases; Apple's Game Porting Toolkit is registered from local files.
const repository = "Sikarugir-App/Template";
const releases = ["1.0.24", "1.0.21"].map(version => githubRelease(repository, `v${version}`, [`Template-${version}.tar.xz`]));
const { current, scenarios } = publisherScenarios([{ name: "Template", current: githubRoutes(repository, releases),
  scenarios: githubScenarios(repository, releases), listed: version => `template-Template-${version}` }]);

module.exports = { managers: ["translator-d3dmetal"], current, scenarios };

const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// vkd3d-proton publishes one zstd archive per release.
const repository = "HansKristian-Work/vkd3d-proton";
const releases = ["2.14.1", "2.14"].map(version => githubRelease(repository, `v${version}`, [`vkd3d-proton-${version}.tar.zst`]));
const derived = githubScenarios(repository, releases), listed = version => `upstream-vkd3d-proton-${version}.tar.zst`;
const scenarios = Object.fromEntries(Object.entries(derived).map(([name, scenario]) => [name, scenario && { ...scenario,
  ...(scenario.version === undefined ? {} : { version: listed(scenario.version) }), ...(scenario.deleted === undefined ? {} : { deleted: listed(scenario.deleted) }) }]));

module.exports = { managers: ["translator-vkd3d-proton"], current: githubRoutes(repository, releases), scenarios };

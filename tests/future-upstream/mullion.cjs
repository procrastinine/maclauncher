const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// Mullion publishes one gzip archive per release, tagged as prereleases.
const repository = "dttdrv/mullion";
const releases = ["0.5-alpha.3", "0.5-alpha.2"].map(version => githubRelease(repository, `v${version}`, [`mullion-v${version}.tar.gz`], { prerelease: true }));
const derived = githubScenarios(repository, releases, { version: tag => tag.replace(/^v/, ""), bump: version => version.replace(/^\d+/, major => String(Number(major) + 1)) });
const listed = version => `upstream-mullion-v${version}`;
const scenarios = Object.fromEntries(Object.entries(derived).map(([name, scenario]) => [name, scenario && { ...scenario,
  ...(scenario.version === undefined ? {} : { version: listed(scenario.version) }), ...(scenario.deleted === undefined ? {} : { deleted: listed(scenario.deleted) }) }]));

module.exports = { managers: ["translator-mullion"], current: githubRoutes(repository, releases), scenarios };

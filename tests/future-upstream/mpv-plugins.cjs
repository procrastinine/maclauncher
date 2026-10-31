const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// uosc publishes its scripts as uosc.zip with a default uosc.conf; thumbfast
// publishes no releases, so its newest commit is the version.
const repository = "tomasklaen/uosc";
const releases = ["5.12.0", "5.11.0"].map(version => githubRelease(repository, version, ["uosc.zip", "uosc.conf"]));
const thumbfast = sha => ({ "https://api.github.com/repos/po5/thumbfast/commits": [{ sha, html_url: `https://github.com/po5/thumbfast/commit/${sha}`,
  commit: { message: "Update", committer: { name: "po5", date: "2026-09-01T12:00:00Z" } } }] });
// The managed install and an added uosc URL both read uosc's ZIP, so a renamed
// release keeps that format.
const scenarios = githubScenarios(repository, releases, { rename: name => name.replace(/^uosc\.(zip|conf)$/, "uosc-macos.$1") });
scenarios.renamedAsset.usable = true;
for (const scenario of Object.values(scenarios)) if (scenario) Object.assign(scenario.routes, thumbfast("a".repeat(40)));
scenarios.newCommit = { routes: { ...githubRoutes(repository, releases), ...thumbfast("b".repeat(40)) }, version: "b".repeat(40), usable: true,
  deleted: "a".repeat(40) };
module.exports = { managers: ["mpv-plugins"], current: { ...githubRoutes(repository, releases), ...thumbfast("a".repeat(40)) }, scenarios,
  savedDefault: false };

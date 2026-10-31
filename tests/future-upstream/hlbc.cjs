const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// The CLI is published as a bare Windows executable next to a Linux build.
const repository = "Gui-Yom/hlbc";
const releases = ["0.7.0", "0.6.1"].map(version => githubRelease(repository, `cli-v${version}`, ["hlbc.exe", "hlbc"]));
module.exports = { managers: ["hlbc"], current: githubRoutes(repository, releases),
  scenarios: githubScenarios(repository, releases, { rename: name => name.replace(/\.exe$/, "-x86_64-pc-windows-msvc.zip").replace(/^hlbc$/, "hlbc-x86_64-unknown-linux-gnu.tar.gz") }) };
module.exports.scenarios.renamedAsset.usable = true;

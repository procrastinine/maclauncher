const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// mpv names each Mac build by its macOS floor and CPU; a listed version
// carries the floor and CPU of the build this Mac uses.
const repository = "mpv-player/mpv";
const releases = ["0.41.0", "0.40.0"].map(version => githubRelease(repository, `v${version}`, [`mpv-v${version}-macos-14-arm.zip`,
  `mpv-v${version}-macos-15-intel.zip`, `mpv-v${version}-x86_64-pc-windows-msvc.zip`, `mpv-v${version}-aarch64-pc-windows-msvc.zip`]));
const cpu = process.arch === "x64" ? "x64" : "arm64", floor = cpu === "x64" ? 15 : 14;
const scenarios = githubScenarios(repository, releases);
// Each release is listed once per CPU.
for (const scenario of Object.values(scenarios)) if (scenario) {
  scenario.version &&= `${scenario.version}-macos-${floor}-${cpu}`;
  scenario.deleted &&= [`${scenario.deleted}-macos-14-arm64`, `${scenario.deleted}-macos-15-x64`];
}
// A renamed universal tar.xz build carries no floor in its name.
scenarios.renamedAsset.version = `1.0.0-${cpu}`;
scenarios.renamedAsset.usable = true;
module.exports = { managers: ["mpv"], current: githubRoutes(repository, releases), scenarios };

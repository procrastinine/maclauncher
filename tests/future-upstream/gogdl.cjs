const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// Heroic publishes self-contained GOGdl executables for each platform in every
// v<version> release; the macOS ones are listed once per CPU.
const repository = "Heroic-Games-Launcher/heroic-gogdl";
const assets = ["gogdl_macos_arm64", "gogdl_macos_x86_64", "gogdl_linux_x86_64", "gogdl_windows_x86_64.exe"];
const releases = [githubRelease(repository, "v1.3.1", assets), githubRelease(repository, "v1.2.0", assets)];
module.exports = { managers: ["gogdl"], current: githubRoutes(repository, releases), scenarios: githubScenarios(repository, releases) };

const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// Apex publishes one macOS kit archive in some ANR releases, beside Windows and
// Linux kits. The release tag is the version. The declared B15 kit keeps its
// declared identity, so these releases are the ones around it.
const repository = "apex-compute/ANR";
const releases = [
  githubRelease(repository, "FG-V.B14", ["anr-fg-V.B14-kit-macos.tar.gz", "anr-fg-V.B14-kit-windows.zip", "SHA256SUMS.txt"]),
  githubRelease(repository, "FG-V.B13", ["anr-fg-V.B13-kit-macos.tar.gz", "anr-fg-V.B13-kit-linux.tar.gz"])];
module.exports = { managers: ["anr"], current: githubRoutes(repository, releases),
  scenarios: githubScenarios(repository, releases, { version: tag => tag, bump: version => version.replace(/\d+$/, number => String(Number(number) + 76)) }) };

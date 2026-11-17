const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// The FSR 4 macOS port publishes one fsr4-mac-v<version>-crossover.zip model
// archive in each crossover-v<version> release, beside other platform builds.
const repository = "UzenUPoZiTiV4ik/fsr4-native-macos";
const releases = [
  githubRelease(repository, "crossover-v3.2", ["fsr4-mac-v3.2-crossover.zip", "fsr4-win-v3.2.zip"]),
  githubRelease(repository, "crossover-v3.1", ["fsr4-mac-v3.1-crossover.zip"])];
module.exports = { managers: ["graphics-fsr4-models"], current: githubRoutes(repository, releases),
  scenarios: githubScenarios(repository, releases, { version: tag => tag.replace(/^crossover-v/, "") }) };

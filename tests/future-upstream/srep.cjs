const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// mac-game-porter publishes one MacGamePorter.zip app archive per release, with
// GitHub's SHA-256 digest; SREP is read from inside that archive. The tag is the
// version.
const repository = "KarmSakha/mac-game-porter";
const releases = [
  githubRelease(repository, "v1.4.2", ["MacGamePorter.zip", "MacGamePorter.zip.sha256"]),
  githubRelease(repository, "v1.4.1", ["MacGamePorter.zip"])];
module.exports = { managers: ["srep"], current: githubRoutes(repository, releases), scenarios: githubScenarios(repository, releases) };

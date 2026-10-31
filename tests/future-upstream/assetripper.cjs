const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// AssetRipper publishes one archive per platform and CPU.
const repository = "AssetRipper/AssetRipper";
const releases = ["1.3.10", "1.3.9"].map(version => githubRelease(repository, version,
  ["mac_arm64", "mac_x64", "linux_x64", "win_x64", "win_arm64"].map(target => `AssetRipper_${target}.zip`)));
const scenarios = githubScenarios(repository, releases);
scenarios.renamedAsset.usable = true;
module.exports = { managers: ["assetripper"], current: githubRoutes(repository, releases), scenarios };

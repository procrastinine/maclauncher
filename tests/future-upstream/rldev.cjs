const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// The release tag names no version; the archive name does.
const repository = "yoremi-trad-fr/rldev2026-go-edition";
const releases = [githubRelease(repository, "rldev2026-go-1.41", ["V1.41-Windows.7z", "V1.41-Linux.tar.gz"]),
  githubRelease(repository, "rldev2026-go", ["V1.40-Windows.7z"])];
const scenarios = githubScenarios(repository, releases, { version: tag => /\d+\.\d+/.exec(tag)?.[0] || "1.40",
  rename: name => name.replace(/\.7z$/, "-x64.zip") });
scenarios.renamedAsset.usable = true;
module.exports = { managers: ["rldev"], current: githubRoutes(repository, releases), scenarios };

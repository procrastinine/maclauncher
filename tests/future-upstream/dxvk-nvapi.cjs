const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// DXVK-NVAPI publishes one tar.gz archive with its x64 and x86 libraries per release.
const repository = "jp7677/dxvk-nvapi";
const releases = ["0.9.3", "0.9.2"].map(version => githubRelease(repository, `v${version}`, [`dxvk-nvapi-v${version}.tar.gz`]));
module.exports = { managers: ["dxvk-nvapi"], current: githubRoutes(repository, releases), scenarios: githubScenarios(repository, releases) };

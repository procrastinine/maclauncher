const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// LÖVE publishes one Mac archive next to Windows, Linux, iOS and Android files.
const repository = "love2d/love";
const releases = ["11.5", "11.4"].map(version => githubRelease(repository, version, [`love-${version}-macos.zip`, `love-${version}-win64.zip`,
  `love-${version}-x86_64.AppImage`, `love-${version}-ios.zip`, `love-${version}-apple-libraries.zip`, `love-${version}-android.apk`]));
const scenarios = githubScenarios(repository, releases);
scenarios.renamedAsset.usable = true;
module.exports = { managers: ["love"], current: githubRoutes(repository, releases), scenarios };

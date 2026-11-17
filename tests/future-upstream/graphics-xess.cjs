const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// Intel publishes the XeSS SDK as one XeSS_SDK_<version>.zip in each v<version>
// release.
const repository = "intel/xess";
const releases = [
  githubRelease(repository, "v2.1.0", ["XeSS_SDK_2.1.0.zip"]),
  githubRelease(repository, "v2.0.1", ["XeSS_SDK_2.0.1.zip"])];
module.exports = { managers: ["graphics-xess"], current: githubRoutes(repository, releases), scenarios: githubScenarios(repository, releases) };

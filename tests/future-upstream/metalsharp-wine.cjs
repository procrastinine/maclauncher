const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// Each release holds the signed arm64 and Intel application archives, a
// plain arm64 archive and one SHA256SUMS file. The signed arm64 archive is
// the runtime.
const repository = "metalsharp/MetalSharp-Wine";
const releases = ["7.0", "6.2"].map(version => githubRelease(repository, `v${version}`,
  [`MetalSharp-Wine-${version}-arm64.zip`, `MetalSharp-Wine-${version}-x86_64.zip`, `metalsharp-wine-${version}-arm64.tar.xz`, "SHA256SUMS"]));
module.exports = { managers: ["metalsharp-wine"], current: githubRoutes(repository, releases), scenarios: githubScenarios(repository, releases),
  layout: {
    write(root) {
      const contents = path.join(root, "MetalSharp Wine.app", "Contents");
      fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true }); fs.writeFileSync(path.join(contents, "MacOS", "wine"), "wine");
      fs.mkdirSync(path.join(contents, "lib", "wine"), { recursive: true });
      return "MetalSharp Wine.app/Contents/MacOS/wine";
    },
    resolve: root => path.join(root, require("../../src/runtime-adapters/wine-release").findWine(root).entry)
  } };

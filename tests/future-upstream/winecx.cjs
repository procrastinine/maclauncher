const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// Each release holds one Libraries archive, the checksum file named after it
// and the runtime's version plist. Versions come from the release tags.
const repository = "dappermint/winecx-gptk";
const releases = ["4.8.1", "4.7.4"].map(version => githubRelease(repository, `runtime-v${version}`,
  ["Libraries.tar.gz", "Libraries.tar.gz.sha256", "WhiskyWineVersion.plist"]));
module.exports = { managers: ["winecx"], current: githubRoutes(repository, releases), scenarios: githubScenarios(repository, releases),
  layout: {
    write(root) {
      const wine = path.join(root, "Libraries", "Wine");
      for (const name of ["wine", "wineserver"]) { fs.mkdirSync(path.join(wine, "bin"), { recursive: true }); fs.writeFileSync(path.join(wine, "bin", name), name); }
      fs.mkdirSync(path.join(wine, "lib", "wine"), { recursive: true });
      return "Libraries/Wine/bin/wine";
    },
    resolve: root => path.join(require("../../src/modules/crossover/winecx/runtime/payload").findRoot(root), "Wine", "bin", "wine")
  } };

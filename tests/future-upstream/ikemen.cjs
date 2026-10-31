const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

const repository = "ikemen-engine/Ikemen-GO";
const releases = ["1.0.0", "0.99.0"].map(version => githubRelease(repository, `v${version}`,
  ["macos", "windows", "linux"].map(platform => `Ikemen_GO-v${version}-${platform}.zip`)));
const scenarios = githubScenarios(repository, releases);
scenarios.renamedAsset.usable = true;
module.exports = { managers: ["ikemen"], current: githubRoutes(repository, releases), scenarios,
  layout: {
    write(root) {
      const executable = path.join(root, "I.K.E.M.E.N-Go.app", "Contents", "MacOS", "Ikemen_GO_MacOSARM");
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, "engine");
      fs.mkdirSync(path.join(root, "data"));
      return "I.K.E.M.E.N-Go.app/Contents/MacOS/Ikemen_GO_MacOSARM";
    },
    resolve: root => require("../../src/modules/ikemen/runtime/manager").resolveExecutable(root)
  } };

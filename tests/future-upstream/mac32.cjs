const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

const repository = "Shagulka/mac32";
const releases = ["0.2", "0.1"].map(version => githubRelease(repository, `v${version}`, [`mac32-${version}-macos.zip`]));
const scenarios = githubScenarios(repository, releases);
scenarios.renamedAsset.usable = true;
module.exports = { managers: ["mac32"], current: githubRoutes(repository, releases), scenarios,
  layout: {
    write(root) {
      const app = path.join(root, "mac32-0.2", "Mac32.app", "Contents", "MacOS");
      fs.mkdirSync(path.join(app, "guest"), { recursive: true });
      fs.writeFileSync(path.join(app, "mac32"), "host");
      fs.writeFileSync(path.join(root, "mac32-0.2", "COPYING"), "license");
      return "mac32-0.2/Mac32.app/Contents/MacOS/mac32";
    },
    resolve: root => require("../../src/modules/mac32/runtime/payload").packageFiles(root)[0]
  } };

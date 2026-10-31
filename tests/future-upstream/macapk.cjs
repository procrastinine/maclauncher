const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

const repository = "kksimp/Mac.apk";
const releases = ["8.1.0", "8.0.2"].map(version => githubRelease(repository, `v${version}`, ["macapk.dmg"]));
const scenarios = githubScenarios(repository, releases);
scenarios.renamedAsset.usable = true;
module.exports = { managers: ["macapk"], current: githubRoutes(repository, releases), scenarios,
  layout: {
    write(root) {
      const resources = path.join(root, "Mac.apk.app", "Contents", "Resources");
      fs.mkdirSync(resources, { recursive: true });
      fs.writeFileSync(path.join(resources, "macapk-runtime"), "runtime");
      return "Mac.apk.app/Contents/Resources/macapk-runtime";
    },
    resolve: root => require("../../src/modules/android/providers/macapk/manager").resolveExecutable(root)
  } };

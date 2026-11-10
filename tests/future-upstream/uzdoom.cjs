const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");
const repository = "UZDoom/UZDoom";
// The publisher's current asset names carry no version.
const releases = ["5.0.3", "5.0.2"].map(version => githubRelease(repository, version, ["MacOS-UZDoom-Release-ARM64.dmg",
  "Windows-UZDoom-Release-x86_64.zip", "Linux-UZDoom-Release-x86_64.AppImage", "_release.json"]));
module.exports = { managers: ["uzdoom"], current: githubRoutes(repository, releases), scenarios: githubScenarios(repository, releases),
  layout: {
    write(root) {
      const executable = path.join(root, "UZDoom.app", "Contents", "MacOS", "uzdoom");
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, "");
      fs.writeFileSync(path.join(path.dirname(path.dirname(executable)), "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${path.basename(executable)}</string></dict></plist>`);
      return path.join("UZDoom.app", "Contents", "MacOS", "uzdoom");
    },
    resolve: root => require("../../src/modules/uzdoom/runtime/manager").resolveExecutable(root)
  } };

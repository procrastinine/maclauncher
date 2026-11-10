const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");
const repository = "ZDoom/Raze";
const releases = ["1.11.0", "1.10.2"].map(version => githubRelease(repository, version,
  [`raze-macos-${version}.zip`, `raze-${version}-windows.zip`, `raze-${version}-windows-pdb.7z`]));
module.exports = { managers: ["raze"], current: githubRoutes(repository, releases), scenarios: githubScenarios(repository, releases),
  layout: {
    write(root) {
      const executable = path.join(root, "Raze.app", "Contents", "MacOS", "raze");
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, "");
      fs.writeFileSync(path.join(path.dirname(path.dirname(executable)), "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${path.basename(executable)}</string></dict></plist>`);
      return path.join("Raze.app", "Contents", "MacOS", "raze");
    },
    resolve: root => require("../../src/modules/raze/runtime/manager").resolveExecutable(root)
  } };

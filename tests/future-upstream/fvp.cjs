const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

const repository = "xmoezzz/rfvp", API = `https://api.github.com/repos/${repository}/releases`;
const releases = ["0.7.0", "0.6.0"].map(version => githubRelease(repository, `v${version}`, ["RFVP.dmg", "RFVP-x86_64-pc-windows-msvc.zip"]));
// RFVP versions name the tag, its commit and the download's digest, so a file
// replaced behind the same tag is a new version and the replaced one leaves the list.
const snapshot = release => `${release.tag_name.replace(/^v/, "")}-${crypto.createHash("sha1").update(release.tag_name).digest("hex")}-${release.assets[0].digest.slice(7)}`;
const scenarios = githubScenarios(repository, releases);
for (const scenario of Object.values(scenarios)) if (scenario) scenario.version = snapshot(scenario.routes[API][0]);
scenarios.deletedRelease.deleted = snapshot(releases.at(-1));
scenarios.replacedFile.deleted = snapshot(releases[0]);
scenarios.renamedAsset.usable = true;
module.exports = { managers: ["rfvp"], current: githubRoutes(repository, releases), scenarios,
  layout: {
    write(root) { fs.mkdirSync(path.join(root, "RFVP.app", "Contents", "MacOS"), { recursive: true }); return "RFVP.app"; },
    resolve: root => require("../../src/modules/fvp/runtime/payload").appPath(root)
  } };

const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");
const { writeZipArchive } = require("../helpers/zip-fixture");

// Versions combine the release number and its build date.
const repository = "Argent77/NearInfinity";
const releases = [["2.4", "20240616"], ["2.4", "20231201"]].map(([version, date]) => githubRelease(repository, `v${version}-${date}`,
  [`NearInfinity-${date}.zip`, `NearInfinity-${date}-win64-setup.exe`, `NearInfinity-${date}-macos.dmg`]));
const scenarios = githubScenarios(repository, releases, { version: tag => tag.slice(1), bump: () => "2.5-20261030",
  rename: name => name.replace(/^NearInfinity-(\d+)\.zip$/, "NearInfinity-v2.5-$1.zip") });
scenarios.renamedAsset.usable = true;
const jar = file => { fs.mkdirSync(path.dirname(file), { recursive: true });
  writeZipArchive(file, [{ name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\r\nMain-Class: org.infinity.NearInfinity\r\n" }]); };
module.exports = { managers: ["near-infinity"], current: githubRoutes(repository, releases), scenarios,
  layout: { write: root => { jar(path.join(root, "NearInfinity.jar")); return "NearInfinity.jar"; },
    resolve: root => require("../../src/modules/gemrb/runtime/near-infinity-manager").core.locateJar(root, "2.4-20240616") } };

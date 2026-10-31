const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");
const Umt = require("../../src/modules/gamemaker/runtime/undertale-mod-tool");

// UTMT releases carry CLI builds for macOS (Apple Silicon), macOS x86 (Intel),
// Windows and Linux next to the GUI. Versions name the CPU build.
const repository = "UnderminersTeam/UndertaleModTool";
const releases = [
  githubRelease(repository, "0.8.3.0", ["UTMT_CLI_v0.8.3.0-macOS.zip", "UTMT_CLI_v0.8.3.0-macOS-x86.zip", "UTMT_CLI_v0.8.3.0-Windows.zip",
    "UTMT_CLI_v0.8.3.0-Linux.zip", "UndertaleModTool_v0.8.3.0-Windows.zip"]),
  githubRelease(repository, "0.8.2.0", ["UTMT_CLI_v0.8.2.0-macOS.zip", "UndertaleModTool_v0.8.2.0-Windows.zip"])
];
const scenarios = Object.fromEntries(Object.entries(githubScenarios(repository, releases)).map(([name, scenario]) => [name, scenario && {
  ...scenario, version: `${scenario.version}-native-macos`, usable: true, ...(scenario.deleted ? { deleted: `${scenario.deleted}-native-macos` } : {}) }]));
module.exports = {
  managers: ["undertale-mod-cli"], current: githubRoutes(repository, releases), scenarios,
  layout: { write: root => { fs.writeFileSync(path.join(root, "UndertaleModCli"), "cli"); return "UndertaleModCli"; }, resolve: root => Umt.resolveExecutable(root) }
};

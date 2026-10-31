const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// One archive per Mac CPU beside Windows and Linux builds.
const repository = "lifegpc/msg-tool";
const releases = ["0.4.2", "0.4.1"].map(version => githubRelease(repository, `v${version}`, ["aarch64-apple-darwin", "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"].map(target => `msg_tool-v${version}-${target}.zip`)));
const scenarios = githubScenarios(repository, releases, { rename: name => name.replace(/\.zip$/, ".tar.xz") });
scenarios.renamedAsset.usable = true;
module.exports = { managers: ["msg-tool"], current: githubRoutes(repository, releases), scenarios,
  layout: { write: root => { fs.writeFileSync(path.join(root, "msg_tool"), "binary"); return "msg_tool"; },
    resolve: root => require("../../src/modules/shared/runtime/msg-tool").resolveExecutable(root) } };

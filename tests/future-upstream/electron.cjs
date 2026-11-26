// Electron lists every release in one index with its Chromium and Node
// versions. The macOS downloads are named by version and CPU on GitHub.
const RELEASES = "https://releases.electronjs.org/releases.json";
const release = (version, extra = {}) => ({ version, date: "2026-11-24", chrome: "142.0.7444.59", node: "22.20.0", npm: "10.9.3",
  files: ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"], ...extra });
const index = releases => ({ [RELEASES]: releases });
const current = [release("45.5.0"), release("44.2.1"), release("46.0.0-beta.3")];
module.exports = { managers: ["electron"], current: index(current), scenarios: {
  newVersion: { routes: index([release("46.0.0"), ...current]), version: "46.0.0", usable: true },
  // Download names come from the version and CPU, so the index itself names no files to rename.
  renamedAsset: null,
  // An optional field is missing.
  missingField: { routes: index([(({ chrome, node, date, ...rest }) => rest)(release("46.0.0")), ...current]), version: "46.0.0", usable: true },
  deletedRelease: { routes: index(current.filter(row => row.version !== "44.2.1")), version: "45.5.0", usable: true, deleted: "44.2.1" }
},
checks: {
  "Electron installs a download only with the SHA-256 its release's checksum list names": async t => {
    const assert = require("node:assert/strict"), { network } = require("../helpers/future-upstream.cjs");
    const Manager = require("../../src/modules/shared/web/runtime/electron-manager");
    t.after(() => { network.routes = null; });
    const folder = "https://github.com/electron/electron/releases/download/v46.0.0/", sha = "d".repeat(64);
    const pin = { version: "46.0.0", asset: { filename: "electron-v46.0.0-darwin-arm64.zip" } };
    network.routes = { [folder + "SHASUMS256.txt"]: `${"a".repeat(64)} *electron-v46.0.0-darwin-x64.zip\n${sha} *electron-v46.0.0-darwin-arm64.zip\n` };
    assert.equal((await Manager.verifyArtifact({ archiveSha256: sha, pin })).verified, true);
    await assert.rejects(Manager.verifyArtifact({ archiveSha256: "e".repeat(64), pin }), /does not match Electron's published checksum/);
    // A release without the list keeps the checksum of its download.
    network.routes = {};
    assert.equal(await Manager.verifyArtifact({ archiveSha256: sha, pin }), null);
  }
} };

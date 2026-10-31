// NW.js lists every release in one version index with the platforms and
// flavors it publishes.
const release = (version, files = ["win-x64", "win-ia32", "linux-x64", "linux-ia32", "osx-x64", "osx-arm64"], extra = {}) =>
  ({ version: `v${version}`, date: "2026/10/01", files, flavors: ["normal", "sdk"], components: { node: "24.10.0", chromium: "141.0.7390.54" }, ...extra });
const index = versions => ({ "https://nwjs.io/versions.json": { latest: versions[0].version, stable: versions[0].version, lts: "v0.14.7", versions } });
const current = [release("0.104.0"), release("0.103.1")];
module.exports = { managers: ["nwjs"], current: index(current), scenarios: {
  newVersion: { routes: index([release("0.105.0"), ...current]), version: "0.105.0", usable: true },
  // A universal Mac build replaces the per-CPU builds.
  renamedAsset: { routes: index([release("0.105.0", ["win-x64", "linux-x64", "osx-universal"]), ...current]), version: "0.105.0", usable: true },
  // An optional field is missing.
  missingField: { routes: index([(({ flavors, components, ...rest }) => rest)(release("0.105.0")), ...current]), version: "0.105.0", usable: true },
  deletedRelease: { routes: index(current.slice(0, 1)), version: "0.104.0", usable: true, deleted: "0.103.1" },
  // The official index moved; the download index answers instead.
  movedIndex: { routes: { "https://dl.nwjs.io/index.json": index([release("0.105.0"), ...current])["https://nwjs.io/versions.json"] }, version: "0.105.0", usable: true }
},
checks: {
  "NW.js downloads the archive its checksum list names with the publisher's SHA-256": async t => {
    const assert = require("node:assert/strict"), { network } = require("../helpers/future-upstream.cjs");
    const { publishedFile } = require("../../src/modules/shared/web/runtime/nwjs-runtime-manager").__test;
    t.after(() => { network.routes = null; });
    const sha = "d".repeat(64), folder = "https://dl.nwjs.io/v0.105.0/";
    const listed = { name: "nwjs-sdk-v0.105.0-osx-arm64.zip", url: folder + "nwjs-sdk-v0.105.0-osx-arm64.zip", architecture: "arm64" };
    network.routes = { [folder + "SHASUMS256.txt"]: `${"a".repeat(64)}  nwjs-v0.105.0-win-x64.zip\n${"b".repeat(64)}  nwjs-sdk-v0.105.0-osx-x64.zip\n${sha} *nwjs-sdk-v0.105.0-osx-arm64.tar.gz\n` };
    const file = await publishedFile(listed, { version: "0.105.0", key: "osx-arm64" });
    assert.equal(file.url, folder + "nwjs-sdk-v0.105.0-osx-arm64.tar.gz");
    assert.deepEqual(file.digest, { algorithm: "sha256", value: sha });
    // Without a checksum list the listed archive installs and its hash is recorded.
    network.routes = {};
    assert.equal(await publishedFile(listed, { version: "0.105.0", key: "osx-arm64" }), listed);
  }
} };

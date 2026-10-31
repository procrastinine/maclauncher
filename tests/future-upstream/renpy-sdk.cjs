// Ren'Py lists SDK versions as folders under /dl/ and names the latest stable
// release on latest.html; each folder holds the SDK files. Refresh needs a
// major line, so the checks call the catalog directly.
const DL = "https://www.renpy.org/dl/";
const listing = versions => `<html><body><h1>Index of /dl</h1>${versions.map(version => `<a href="${version}">${version}</a>`).join("\n")}<a href="../">Parent</a></body></html>`;
const latest = version => `<html><body><a href="https://www.renpy.org/dl/${version}/renpy-${version}-sdk.dmg">Download Ren'Py ${version}</a></body></html>`;
const routes = (versions, newest) => ({ [DL]: listing(versions), "https://renpy.org/latest.html": latest(newest) });
const current = ["8.3.7/", "8.4.0/", "8.4.1/", "8.5.0/"];
async function versions(routes) {
  const { network } = require("../helpers/future-upstream.cjs"), Core = require("../../src/modules/renpy/runtime/sdk-manager");
  network.routes = routes;
  try { return (await Core.fetchAvailableVersions({ major: 8 })).versions; } finally { network.routes = null; }
}
module.exports = { managers: [], checks: {
  "Ren'Py SDK versions follow new, absolute and removed folder links": async () => {
    const assert = require("node:assert/strict");
    assert.deepEqual(await versions(routes(current, "8.4.1")), ["8.4.1", "8.4.0", "8.3.7"], "a version after the latest stable release is a prerelease");
    assert.deepEqual(await versions(routes([...current, "8.5.1/"], "8.5.1")), ["8.5.1", "8.5.0", "8.4.1", "8.4.0", "8.3.7"]);
    // Absolute links, a removed folder and unrelated links.
    assert.deepEqual(await versions(routes([DL + "8.4.1/", "/dl/8.4.0/", "nightly/", "8.x/", "README.txt"], "8.4.1")), ["8.4.1", "8.4.0"]);
    // Without the latest page the folder list stands on its own.
    assert.deepEqual(await versions({ [DL]: listing(current) }), ["8.5.0", "8.4.1", "8.4.0", "8.3.7"]);
    await assert.rejects(versions({ [DL]: listing(["nightly/"]) }), /No Ren'Py 8 SDK versions/);
    // A later major release joins the Python 3 group.
    assert.deepEqual(await versions(routes([...current, "9.0.0/"], "9.0.0")), ["9.0.0", "8.5.0", "8.4.1", "8.4.0", "8.3.7"]);
  },
  "Ren'Py SDK installs read the version folder when the disk image name changes": async t => {
    const assert = require("node:assert/strict"), { network } = require("../helpers/future-upstream.cjs");
    const { findListedDownload } = require("../../src/modules/renpy/runtime/sdk-manager").__test;
    t.after(() => { network.routes = null; });
    const sha = "a".repeat(64);
    network.routes = { [DL + "8.6.0/"]: ["renpy-8.6.0-sdkarm.tar.bz2", "renpy-8.6.0-sdk.tar.bz2", "renpy-8.6.0-sdk-universal.dmg", "renpy-8.6.0-sdk.zip",
      "renpy-8.6.0-web.zip", "checksums.txt"].map(name => `<a href="${name}">${name}</a>`).join(""),
      [DL + "8.6.0/checksums.txt"]: `${"b".repeat(32)} renpy-8.6.0-sdk.zip\n${sha} renpy-8.6.0-sdk.zip\n` };
    assert.equal((await findListedDownload("8.6.0")).url, DL + "8.6.0/renpy-8.6.0-sdk-universal.dmg");
    // The SHA-256 checksums.txt lists is the publisher's digest.
    assert.deepEqual((await findListedDownload("8.6.0", { formats: [".zip"] })).digest, { algorithm: "sha256", value: sha });
    network.routes = { [DL + "8.6.0/"]: `<a href="renpy-8.6.0-sdkarm.tar.bz2">arm</a><a href="renpy-8.6.0-sdk.tar.bz2">sdk</a>` };
    assert.equal((await findListedDownload("8.6.0")).url, DL + "8.6.0/renpy-8.6.0-sdk.tar.bz2");
    network.routes = {};
    assert.equal(await findListedDownload("8.6.0"), null);
  },
  "Ren'Py SDK installs find an SDK moved deeper in the download": async t => {
    const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
    const { findSdkRoot } = require("../../src/modules/renpy/runtime/sdk-manager").__test;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "renpy-sdk-layout-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sdk = path.join(root, "Ren'Py 8.6", "renpy-8.6.0-sdk");
    fs.mkdirSync(path.join(root, "__MACOSX", "renpy-8.6.0-sdk"), { recursive: true }); fs.writeFileSync(path.join(root, "__MACOSX", "renpy-8.6.0-sdk", "renpy.sh"), "");
    fs.mkdirSync(sdk, { recursive: true }); fs.writeFileSync(path.join(sdk, "renpy.sh"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(root, "README.txt"), "notes");
    assert.equal(findSdkRoot(root, "8.6.0"), sdk);
  }
} };

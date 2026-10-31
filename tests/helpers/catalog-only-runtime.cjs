const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// A download stub that records the chosen URL and stops before any file exists.
function stoppedDownloads() {
  const urls = [];
  return { urls, downloadToFile: async url => { urls.push(url); throw new Error("download stopped"); } };
}

// Catalog-only managers list nothing offline. Consented installation with an
// empty cache discovers the catalog once and downloads its newest release.
async function assertConsentedDiscovery({ manager, userDataDir, discoveries, downloads, newestUrl }) {
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []);
  const selection = manager.resolveSelection({}, {}, userDataDir);
  assert.equal(selection.version, null);
  assert.equal(selection.discoveryRequired, true);
  assert.equal(discoveries(), 0, "Status and selection stay offline");
  await assert.rejects(manager.installRuntime({ userDataDir }), /download stopped/);
  assert.equal(discoveries(), 1);
  assert.deepEqual(downloads.urls, [newestUrl]);
}

// An installation's receipt keeps its version known offline, including a saved
// default, after the version left the catalog.
function assertReceiptOffline({ manager, userDataDir, pin }) {
  const directory = manager.core.getInstallDir({ userDataDir, version: pin.version });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "runtime.json"), JSON.stringify({ version: pin.version, upstreamRevision: pin.upstreamRevision,
    catalogEntry: pin, source: "download", binarySha256: "c".repeat(64), executableRelative: "runtime", archiveSha256: pin.asset.sha256 }));
  assert.ok(manager.getState({ userDataDir }).catalog.versionRequirements[pin.version], "The receipt's version stays known");
  const saved = { runtimes: { [manager.id]: { defaultVersion: pin.version } } };
  assert.equal(manager.resolveSelection({}, saved, userDataDir).version, pin.version);
}

module.exports = { stoppedDownloads, assertConsentedDiscovery, assertReceiptOffline };

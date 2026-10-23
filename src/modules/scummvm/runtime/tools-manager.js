const fs = require("node:fs");
const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createDiscovery } = require("./catalog");
const { extractDmg } = require("./dmg");

const SOURCE_URL = "https://downloads.scummvm.org/frs/scummvm-tools/";
const DEFAULT_ENTRY = { version: "2.9.0", upstreamRevision: "516246735618120eb9439cb9673a32430c18d604",
  upstreamTag: "v2.9.0", minimumMacOS: "10.9", localBuild: false,
  sourceUrl: "https://github.com/scummvm/scummvm-tools/tree/v2.9.0",
  asset: { filename: "scummvm-tools-2.9.0-macosx.dmg", url: `${SOURCE_URL}2.9.0/scummvm-tools-2.9.0-macosx.dmg`,
    sha256: "fa7f4962203f6c52702429adf7a7f2bc6b64edcfb045948dab990c5e380220f4" } };

async function extractTools(archive, destination, signal) {
  return extractDmg(archive, destination, signal, { payloadName: "scummvm-tools-cli", copy: (source, target) => {
    fs.copyFileSync(source, target); fs.chmodSync(target, fs.statSync(source).mode);
    const mount = path.dirname(source);
    for (const file of fs.readdirSync(mount).filter(name => /^(?:License|ScummVM ReadMe|News)/i.test(name))) {
      const candidate = path.join(mount, file);
      if (fs.lstatSync(candidate).isFile()) fs.copyFileSync(candidate, path.join(destination, file));
    }
  } });
}
function createManager({ discoverCatalog = createDiscovery({ sourceUrl: SOURCE_URL, repository: "scummvm-tools",
  project: "ScummVM Tools", prefix: "scummvm-tools", minimumMacOS: "10.9",
  unavailableReason: "A macOS download with a published SHA-256 is not available for this tools release." }), dependencies = {} } = {}) {
  return createPinnedNativeManager({ id: "scummvm-tools", label: "ScummVM Tools", supportsDefault: true, sourceUrl: SOURCE_URL,
    catalog: [DEFAULT_ENTRY], recommendedVersion: "2.9.0", discoverCatalog,
    resolveExecutable: root => path.join(root, "scummvm-tools-cli"), dependencies: { extractArchive: extractTools, ...dependencies } });
}

module.exports = createManager();
module.exports.createManager = createManager;
module.exports.DEFAULT_ENTRY = DEFAULT_ENTRY;

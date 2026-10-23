const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const Bundled = require("../../shared/runtime/bundled-native");
const Native = require("../../shared/runtime/local-native");
const Binary = require("./bundled-binary.json");

// Maintainer input for the shared offline stager. The catalog binds both the
// executable and complete publisher app before relocation or signing occurs.
function createStagingInput(appRoot) {
  if (typeof appRoot !== "string" || !appRoot || /[\x00-\x1f]/.test(appRoot)) {
    throw new Error("Choose an explicit MKXP-Z publisher app path.");
  }
  const root = path.resolve(appRoot);
  if (path.basename(root) !== Binary.appName) throw new Error(`Expected ${Binary.appName}.`);
  const artifact = path.dirname(root), notice = "LICENSE.txt";
  return {
    managerId: "mkxpz", version: Binary.version, appRoot: root,
    executable: path.join(artifact, Binary.executableRelative), executableMode: 0o755,
    expectedInputSha256: Binary.executableSha256,
    payloads: Binary.resources.map(relative => ({ source: path.join(artifact, relative), relative })),
    notices: [{ file: path.join(artifact, notice), name: "MKXP-Z and included upstream dependencies",
      license: "GPL-3.0 and included dependency notices", sourceUrl: Binary.sourceUrl }],
    appRootNoticeFiles: [],
    provenance: { sourceKind: "reviewed-binary", verifiedBuild: false,
      binaryOrigin: Binary.binaryOrigin, publisherSourceRevision: Binary.upstreamRevision,
      inputPublisherArtifactTreeSha256: Binary.artifactTreeSha256 }
  };
}

function publisherArtifactTree(root) {
  const files = Bundled.fileInventory(root).filter(relative => relative !== ".maclauncher-mkxpz.json").map(relative => {
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("MKXP-Z publisher resources must be regular files.");
    return { path: relative, size: stat.size, mode: stat.mode & 0o777, sha256: Native.hashFile(file) };
  });
  return crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

function validatePublisherArtifact(appRoot) {
  const input = createStagingInput(appRoot);
  if (publisherArtifactTree(path.dirname(input.appRoot)) !== Binary.artifactTreeSha256)
    throw new Error("MKXP-Z publisher files differ from the selected complete artifact.");
  return input;
}

module.exports = { createStagingInput, publisherArtifactTree, validatePublisherArtifact };

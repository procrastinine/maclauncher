const path = require("node:path");
const Binary = require("./bundled-binary.json");

// Maintainer input for the shared offline stager. The catalog binds both the
// executable and complete publisher app before relocation or signing occurs.
function createStagingInput(appRoot) {
  if (typeof appRoot !== "string" || !appRoot || /[\x00-\x1f]/.test(appRoot)) {
    throw new Error("Choose an explicit MKXP-Z publisher app path.");
  }
  const root = path.resolve(appRoot);
  if (path.basename(root) !== Binary.appName) throw new Error(`Expected ${Binary.appName}.`);
  const notice = "LICENSE.mkxp-z-with-https.txt";
  return {
    managerId: "mkxpz", version: Binary.version, appRoot: root,
    executable: path.join(root, "Contents", "MacOS", "Z-universal"),
    expectedInputSha256: Binary.executableSha256,
    notices: [{ file: path.join(root, notice), name: "MKXP-Z and included upstream dependencies",
      license: "GPL-3.0 and included dependency notices", sourceUrl: Binary.sourceUrl }],
    appRootNoticeFiles: [notice],
    provenance: { sourceKind: "reviewed-binary", verifiedBuild: false,
      binaryOrigin: Binary.binaryOrigin, publisherSourceRevision: Binary.upstreamRevision }
  };
}

module.exports = { createStagingInput };

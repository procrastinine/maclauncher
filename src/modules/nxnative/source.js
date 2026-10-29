const fs = require("node:fs");
const path = require("node:path");

const required = ["scripts/build_ipa_from_nsp.py", "dm/tools/nso2elf.py", "dm/host/front_mac.m", "LICENSE"];

// Managed snapshots are verified by the shared version manager. Custom source
// stays in place and uses the same folder fingerprint as game preparation.
async function resolveSource(install, context, fingerprint) {
  if (!path.isAbsolute(install?.filesRoot || "")) throw new Error("The selected nxnative source is unavailable.");
  const root = fs.realpathSync(install.filesRoot), artifact = install.artifact;
  if (artifact?.kind === "github-commit") {
    if (artifact.repository !== "seedds/nxnative" || !/^[a-f0-9]{40}$/.test(artifact.revision || ""))
      throw new Error("The nxnative source revision is invalid.");
    return { root, revision: artifact.revision, committedAt: artifact.committedAt || null, kind: "github-commit" };
  }
  return { root, revision: await fingerprint(root, context), committedAt: null, kind: "local-source" };
}

module.exports = { resolveSource, required };

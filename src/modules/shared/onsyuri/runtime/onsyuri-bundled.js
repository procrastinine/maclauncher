const fs = require("node:fs");
const path = require("node:path");
const B = require("../../runtime/bundled-native");
const Native = require("../../runtime/local-native");
const { isDeepStrictEqual } = require("node:util");
// Existing initial choice and its verified pre-rename installation identity.
const RECOMMENDED_VERSION = "0.7.7beta-MCLv1";
const PREVIOUS_DEFAULT_VERSION = "0.7.7beta-macos-v3";

function validateVersionProvenance(manifest, record) {
  if (manifest.upstreamRevision !== record.upstreamRevision ||
      record.minimumMacOS && manifest.minimumMacOS !== record.minimumMacOS ||
      record.buildProvenance && !isDeepStrictEqual(manifest.provenance, record.buildProvenance) ||
      record.provenanceVerified !== undefined && record.provenanceVerified !== (manifest.provenance?.verifiedBuild === true))
    throw new Error("Onsyuri Mac runtime source profile differs from its installed receipt.");
}

function createOnsyuriBundled({ resourceRoot, platform = process.platform, dependencies } = {}) {
  const providers = new Map();
  const failedChecks = new Map();
  function provider(variant) {
    if (!["arm64", "x64"].includes(variant)) throw new Error("Choose Apple Silicon or Intel for the Onsyuri runtime.");
    if (!providers.has(variant)) providers.set(variant, B.createBundledNativeRuntime({ managerId: "onsyuri", resourceRoot, platform, arch: variant, dependencies }));
    return providers.get(variant);
  }
  function installDirectory({ userDataDir, version, variant }) {
    if (!path.isAbsolute(userDataDir || "") || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version || "")) throw new Error("Choose an explicit Onsyuri version and absolute launcher data directory.");
    provider(variant);
    return path.join(userDataDir, "runtimes", "onsyuri", "mac", version, variant);
  }
  function resolve({ userDataDir, version, variant, verification = "full" }) {
    const installDir = installDirectory({ userDataDir, version, variant });
    if (verification === "status" && failedChecks.has(installDir)) throw new Error(failedChecks.get(installDir));
    if (!fs.existsSync(installDir)) return null;
    try {
      const record = JSON.parse(B.readRegular(path.join(installDir, "runtime.json"), B.LIMITS.manifestBytes).bytes);
      if (record.version !== version || !/^[a-f0-9]{40}$/.test(record.upstreamRevision || "")) throw new Error("Onsyuri installed source/version identity is invalid.");
      if (!provider(variant).verifyInstalled({ installDir, record, pin: record, verification })) throw new Error("Onsyuri runtime package changed or is incomplete.");
      const manifest = JSON.parse(B.readRegular(path.join(installDir, "bundle-manifest.json"), B.LIMITS.manifestBytes).bytes);
      validateVersionProvenance(manifest, record);
      if (manifest.arch !== variant) return null;
      const runtime = Native.resolveLocalRuntime({ runtimePath: path.join(installDir, B.relativeFile(record.executableRelative)),
        runtimeVersion: version, upstreamRevision: record.upstreamRevision, expectedSha256: record.binarySha256, platform, arch: variant });
      if (verification === "full") failedChecks.delete(installDir);
      return { ...record, ...runtime, version, variant, installDir };
    } catch (error) {
      if (verification === "full") failedChecks.set(installDir, error.message);
      return null;
    }
  }
  function isBundle(installDir) {
    // Damaged bundle metadata must not turn into an unverified legacy install.
    return fs.existsSync(path.join(installDir, "runtime.json")) || fs.existsSync(path.join(installDir, "bundle-manifest.json"));
  }
  return { resolve, isBundle,
    isResourcePath: value => provider("arm64").isResourcePath(value),
    clearCache: () => { failedChecks.clear(); for (const bundle of providers.values()) bundle.clearCache(); } };
}

module.exports = { RECOMMENDED_VERSION, PREVIOUS_DEFAULT_VERSION, validateVersionProvenance, createOnsyuriBundled };

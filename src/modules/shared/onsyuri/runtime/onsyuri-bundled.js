const fs = require("node:fs");
const path = require("node:path");
const B = require("../../runtime/bundled-native");
const Native = require("../../runtime/local-native");
const { isDeepStrictEqual } = require("node:util");
const CATALOG = Object.freeze(require("./portable-versions.json").map(pin => Object.freeze(pin)));
const RECOMMENDED_VERSION = CATALOG[0].version;

function validateVersionProvenance(manifest, pin) {
  if (!pin.sourceTreeSha256) return;
  const provenance = manifest.provenance;
  if (provenance?.verifiedBuild !== true || provenance.sourceTreeSha256 !== pin.sourceTreeSha256 ||
      provenance.overlaySha256 !== pin.overlaySha256 || !isDeepStrictEqual(provenance.sourceScope, pin.sourceScope) ||
      !isDeepStrictEqual(provenance.omittedSubmodules, pin.omittedSubmodules) || manifest.minimumMacOS !== pin.minimumMacOS ||
      !pin.hostArchitectures.includes(manifest.arch)) throw new Error("Onsyuri Mac runtime source profile differs from the selected version.");
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
    let pin = CATALOG.find(entry => entry.version === version);
    const installDir = installDirectory({ userDataDir, version, variant });
    if (verification === "status" && failedChecks.has(installDir)) throw new Error(failedChecks.get(installDir));
    if (!fs.existsSync(installDir)) return null;
    try {
      if (!pin) {
        const manifest = JSON.parse(B.readRegular(path.join(installDir, "bundle-manifest.json"), B.LIMITS.manifestBytes).bytes);
        const original = CATALOG.find(entry => entry.upstreamRevision === manifest.upstreamRevision && entry.sourceTreeSha256 &&
          entry.sourceTreeSha256 === manifest.provenance?.sourceTreeSha256 && entry.overlaySha256 === manifest.provenance?.overlaySha256);
        if (!original || manifest.version !== version) return null;
        pin = { ...original, version };
      }
      const record = JSON.parse(B.readRegular(path.join(installDir, "runtime.json"), B.LIMITS.manifestBytes).bytes);
      if (!provider(variant).verifyInstalled({ installDir, record, pin, verification })) throw new Error("Onsyuri runtime package changed or is incomplete.");
      const manifest = JSON.parse(B.readRegular(path.join(installDir, "bundle-manifest.json"), B.LIMITS.manifestBytes).bytes);
      validateVersionProvenance(manifest, pin);
      if (manifest.arch !== variant) return null;
      const runtime = Native.resolveLocalRuntime({ runtimePath: path.join(installDir, B.relativeFile(record.executableRelative)),
        runtimeVersion: version, upstreamRevision: pin.upstreamRevision, expectedSha256: record.binarySha256, platform, arch: variant });
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
  return { catalog: CATALOG, resolve, isBundle,
    isResourcePath: value => provider("arm64").isResourcePath(value),
    clearCache: () => { failedChecks.clear(); for (const bundle of providers.values()) bundle.clearCache(); } };
}

module.exports = { CATALOG, RECOMMENDED_VERSION, validateVersionProvenance, createOnsyuriBundled };

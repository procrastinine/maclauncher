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
    if (!["arm64", "x64"].includes(variant)) throw new Error("Choose Apple Silicon or Intel for the bundled Onsyuri runtime.");
    if (!providers.has(variant)) providers.set(variant, B.createBundledNativeRuntime({ managerId: "onsyuri", resourceRoot, platform, arch: variant, dependencies }));
    return providers.get(variant);
  }
  function installDirectory({ userDataDir, version, variant }) {
    if (!path.isAbsolute(userDataDir || "") || !CATALOG.some(pin => pin.version === version)) throw new Error("Choose an explicit bundled Onsyuri version and absolute launcher data directory.");
    provider(variant);
    return path.join(userDataDir, "runtimes", "onsyuri", "mac", version, variant);
  }
  function resolve({ userDataDir, version, variant, verification = "full" }) {
    const pin = CATALOG.find(entry => entry.version === version);
    if (!pin) return null;
    const installDir = installDirectory({ userDataDir, version, variant });
    if (verification === "status" && failedChecks.has(installDir)) throw new Error(failedChecks.get(installDir));
    if (!fs.existsSync(installDir)) {
      try {
        const packageInfo = provider(variant).resolve({ version, upstreamRevision: pin.upstreamRevision, verification });
        if (packageInfo) validateVersionProvenance(packageInfo.manifest, pin);
        const included = provider(variant).resolveRuntime({ version, upstreamRevision: pin.upstreamRevision, verification });
        if (verification === "full") failedChecks.delete(installDir);
        return included ? { ...included, variant } : null;
      } catch (error) {
        if (verification === "full") failedChecks.set(installDir, error.message);
        throw error;
      }
    }
    try {
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
  function available({ version, variant }) {
    const pin = CATALOG.find(entry => entry.version === version);
    if (!pin) return null;
    const bundle = provider(variant).resolve({ version, upstreamRevision: pin.upstreamRevision });
    if (bundle) validateVersionProvenance(bundle.manifest, pin);
    return bundle;
  }
  async function install({ userDataDir, version, variant, ...options }) {
    options.signal?.throwIfAborted();
    if (!CATALOG.some(pin => pin.version === version)) return null;
    const existing = resolve({ userDataDir, version, variant });
    if (existing) return existing;
    const bundle = provider(variant);
    const manager = { core: { catalog: CATALOG,
      getInstallDir: input => installDirectory({ ...input, variant }),
      resolveInstalled: input => resolve({ ...input, variant }) } };
    return bundle.install({ ...options, manager, userDataDir, version });
  }
  function isBundle(installDir) {
    // Damaged bundle metadata must not turn into an unverified legacy install.
    return fs.existsSync(path.join(installDir, "runtime.json")) || fs.existsSync(path.join(installDir, "bundle-manifest.json"));
  }
  return { catalog: CATALOG, available, install, resolve, isBundle,
    isResourcePath: value => provider("arm64").isResourcePath(value),
    clearCache: () => { failedChecks.clear(); for (const bundle of providers.values()) bundle.clearCache(); } };
}

module.exports = { CATALOG, RECOMMENDED_VERSION, validateVersionProvenance, createOnsyuriBundled };

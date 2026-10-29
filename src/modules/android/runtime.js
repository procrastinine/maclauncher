const fs = require("node:fs");
const path = require("node:path");
const Bundled = require("../shared/runtime/bundled-native");
const declarationFile = path.join(__dirname, "managed-packages.json");
const platformHashes = new Map();
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function platformHash(manifest, manifestSha256) {
  // Older manifests did not describe the common payload separately. Keep
  // their original owner identity rather than infer a partial inventory.
  if (!Array.isArray(manifest.files) || !manifest.files.length) return undefined;
  // Original system APKs may come from the supplied Android image. Older ART
  // manifests have no complete image identity and keep their previous owner key.
  if (manifest.profile.artExecutionVersion != null &&
      (manifest.platformSupplier?.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(manifest.platformSupplier.image?.sha256 || ""))) return undefined;
  if (platformHashes.has(manifestSha256)) return platformHashes.get(manifestSha256);
  const { artExecutionVersion, ...profile } = manifest.profile;
  const value = require("node:crypto").createHash("sha256").update(JSON.stringify(canonical({
    schemaVersion: manifest.schemaVersion, minimumMacOS: manifest.minimumMacOS,
    architectures: manifest.architectures, profile, platformSupplier: manifest.platformSupplier,
    files: [...manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  }))).digest("hex");
  platformHashes.set(manifestSha256, value);
  if (platformHashes.size > 4) platformHashes.delete(platformHashes.keys().next().value);
  return value;
}
// Staging publishes this small declaration atomically. A retained backend must
// observe its next version without reloading modules or restarting Electron.
function readDeclaration({ optional = false } = {}) {
  let records;
  try { records = JSON.parse(fs.readFileSync(declarationFile, "utf8")); }
  catch (error) { if (optional && error.code === "ENOENT") return null; throw error; }
  const declaration = records.find(item => item.id === "android");
  if (!declaration && optional) return null;
  if (!declaration) throw new Error("The managed Android runtime metadata is missing. Install Android in Runtimes.");
  return declaration;
}

// Development staging only. Ordinary launches resolve a managed installation.
function runtimeRoot(declaration) {
  if (require("../shared/runtime/included-helpers").isPackaged(__filename))
    throw new Error("Select an installed Android runtime in Runtimes.");
  if (declaration === undefined) declaration = readDeclaration();
  return path.resolve(__dirname, "../../../build/managed-runtimes", Bundled.relativeFile(declaration.directoryRelative));
}

// Metadata resolution is used by status/UI. Only resolveForLaunch authorizes
// execution after verifying the complete payload outside the calling thread.
function resolve({ root, platform = process.platform, arch = process.arch,
  macOSVersion } = {}, declaration = readDeclaration()) {
  if (platform !== "darwin" || arch !== "arm64") throw new Error("MacLauncher Android requires Apple Silicon macOS.");
  if (!path.isAbsolute(root || "")) throw new Error("Select an installed Android runtime in Runtimes.");
  const stored = Bundled.readRegular(path.join(root, "runtime.json"), Bundled.LIMITS.manifestBytes);
  if (stored.sha256 !== declaration.manifestSha256) throw new Error("The Android runtime metadata has changed. Reinstall this version in Runtimes.");
  const manifest = JSON.parse(stored.bytes);
  if (manifest.schemaVersion !== 1 || manifest.version !== declaration.version ||
      manifest.profile?.javaMajor !== 21 || !manifest.profile.id ||
      manifest.profile.nativeLoadTarget !== "maclauncher.android.bridge.GuestNativeLoader")
    throw new Error("The Android runtime profile is invalid.");
  if (!Bundled.versionAtLeast(macOSVersion || Bundled.systemVersionSync(), declaration.minimumMacOS))
    throw new Error(`This Android runtime requires macOS ${declaration.minimumMacOS} or later.`);
  // Child services keep the identity selected by this launch. Publishing a new
  // managed version must not make an in-flight account owner validate its old
  // root against the new version. The full inventory stays with the verifier;
  // descendants only need the small, trusted manifest identity.
  const commonPlatformHash = platformHash(manifest, stored.sha256);
  const runtimeIdentity = { version: declaration.version, minimumMacOS: declaration.minimumMacOS,
    manifestSha256: declaration.manifestSha256,
    ...(commonPlatformHash ? { platformHash: commonPlatformHash } : {}),
    ...(manifest.sourceHash?{sourceHash:manifest.sourceHash}:{}),
    ...(manifest.inputHash?{inputHash:manifest.inputHash}:{}) };
  return { ...require("./conversion").payload(root, manifest.profile), version: manifest.version,
    runtimeIdentity, runtimeDeclaration: declaration };
}

async function resolveForLaunch(options = {}, declaration = readDeclaration()) {
  options.signal?.throwIfAborted();
  const payload = resolve(options, declaration);
  await require("./runtime-verifier").verifyPayload(payload.root, declaration, { signal: options.signal });
  options.signal?.throwIfAborted();
  // Re-read the small declaration after the worker completes so a replaced
  // runtime.json cannot supply unchecked launch metadata.
  return resolve({ ...options, root: payload.root }, declaration);
}

function status(options = {}) {
  try {
    const payload = resolve(options);
    return { ready: true, managed: true, version: payload.version, label: "MacLauncher Android" };
  } catch (error) { return { ready: false, managed: true, reason: error.message }; }
}

function resolveSelected(entry, context = {}) {
  const selected = require("./runtime-manager").resolveSelection(entry, context.settings, context.userDataDir, { verification: "status" });
  return selected.ready ? resolve({ root: selected.install.root }, selected.install.declaration) : null;
}

async function resolveSelectedForLaunch(entry, context = {}) {
  const selected = require("./runtime-manager").resolveSelection(entry, context.settings, context.userDataDir);
  if (!selected.ready) throw new Error(selected.reason || "Install MacLauncher Android in Runtimes.");
  return module.exports.resolveForLaunch({ root: selected.install.root, signal: context.signal }, selected.install.declaration);
}

module.exports = { runtimeRoot, resolve, resolveForLaunch, resolveSelected, resolveSelectedForLaunch, status, readDeclaration };

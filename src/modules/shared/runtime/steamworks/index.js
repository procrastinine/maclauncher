const fs = require("node:fs");
const path = require("node:path");
const Bundle = require("../bundled-native");
const Native = require("../local-native");
const Environment = require("./environment");
const Source = require("./source-identity");

function verifiedLibrary(libraryPath, { sha256, architecture }) {
  if (!/^[a-f0-9]{64}$/.test(sha256 || "") || !["arm64", "x86_64"].includes(architecture)) throw new Error("An exact native Steam API checksum and architecture are required.");
  const file = Bundle.readRegular(libraryPath, 64 * 1024 * 1024);
  if (file.sha256 !== sha256) throw new Error("The native Steam API library changed.");
  const architectures = Native.readMachOArchitectures(libraryPath, { allowLibrary: true });
  if (!architectures.includes(architecture)) throw new Error(`The native Steam API library cannot run as ${architecture}.`);
  return { libraryPath, sha256, architectures };
}

/** Pure backend lookup; missing payloads never trigger a download or build. */
function resolveBundledLibrary({ resourcesRoot, architecture, interfaces, catalog } = {}) {
  if (!Array.isArray(catalog) || !catalog.length) return { ready: false, reason: "This app does not include an offline Steam API library." };
  if (!["arm64", "x86_64"].includes(architecture) || !Array.isArray(interfaces) || interfaces.some(value => !Environment.INTERFACE.test(value))) {
    return { ready: false, reason: "The requested Steam API architecture or interface versions are unknown." };
  }
  const pin = catalog.find(value => Source.sourceIdentity(value) &&
    value.architectures?.includes(architecture) && value.qualifiedInterfaces && interfaces.every(item => value.qualifiedInterfaces.includes(item)));
  if (!pin) return { ready: false, reason: "No included Steam API library supports the requested interfaces." };
  if (pin.defaultInterfaces !== undefined && (!Array.isArray(pin.defaultInterfaces) ||
      pin.defaultInterfaces.length < 1 || pin.defaultInterfaces.length > 128 ||
      new Set(pin.defaultInterfaces).size !== pin.defaultInterfaces.length ||
      pin.defaultInterfaces.some(value => typeof value !== "string" || !Environment.INTERFACE.test(value) || !pin.qualifiedInterfaces.includes(value)) ||
      pin.defaultInterfaces.filter(value => /^SteamClient\d{3}$/.test(value)).length !== 1)) {
    return { ready: false, reason: "The included Steam API default interface versions are invalid." };
  }
  const packageVersion = pin.packageVersion ?? pin.version;
  if (typeof packageVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(packageVersion)) {
    return { ready: false, reason: "The bundled Steam API package version is invalid." };
  }
  const roots = resourcesRoot ? [resourcesRoot] : [process.resourcesPath, path.resolve(__dirname, "../../../../resources")];
  for (const root of roots.filter(value => typeof value === "string" && path.isAbsolute(value))) {
    const directory = path.join(root, "native-runtimes/steam-api-helper", packageVersion, "universal");
    if (!fs.existsSync(directory)) continue;
    try {
      const content = Bundle.readRegular(path.join(directory, "helper.json"), 1024 * 1024);
      if (content.sha256 !== pin.manifestSha256) throw new Error("The bundled Steam API manifest changed.");
      const manifest = JSON.parse(content.bytes);
      if (manifest.schemaVersion !== 1 || manifest.id !== "steam-api-helper" || manifest.version !== pin.version ||
          (manifest.packageVersion ?? manifest.version) !== packageVersion ||
          (pin.sourcePackageVersion != null && manifest.sourcePackageVersion !== pin.sourcePackageVersion) ||
          !Source.sameSourceIdentity(manifest, pin) || manifest.librarySha256 !== pin.librarySha256 ||
          JSON.stringify(manifest.qualifiedInterfaces) !== JSON.stringify(pin.qualifiedInterfaces) ||
          JSON.stringify(manifest.defaultInterfaces) !== JSON.stringify(pin.defaultInterfaces)) throw new Error("The bundled Steam API source/version identity changed.");
      // The trusted catalog seals the manifest itself, avoiding a self-hash.
      Bundle.verifyPayload(directory, { ...manifest, files: [...manifest.files,
        { path: "helper.json", size: content.size, sha256: pin.manifestSha256, mode: 0o644 }] });
      const library = verifiedLibrary(path.join(directory, "libsteam_api.dylib"), { sha256: pin.librarySha256, architecture });
      return { ready: true, version: pin.version, packageVersion, ...Source.sourceFields(pin), ...library, directory, mode: "offline", interfaces };
    } catch (error) { return { ready: false, present: true, reason: error.message }; }
  }
  return { ready: false, present: false, reason: "The included offline Steam API library is missing." };
}

function prepareOfflineLaunch({ library, ownedDirectory, appId, interfaces, language, baseEnvironment }) {
  if (!library?.ready || library.mode !== "offline") throw new Error(library?.reason || "An offline Steam API library is required.");
  const prepared = Environment.prepareEnvironment({ libraryPath: library.libraryPath, ownedDirectory, appId, interfaces, language, baseEnvironment });
  return { ...prepared, version: library.version, sourceRevision: library.sourceRevision,
    ...(library.sourceKind === "owned" ? { sourceKind: library.sourceKind, sourceSha256: library.sourceSha256 } : {}),
    sha256: library.sha256, architectures: library.architectures };
}

module.exports = { verifiedLibrary, resolveBundledLibrary, prepareOfflineLaunch };

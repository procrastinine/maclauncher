const fs = require("node:fs");
const path = require("node:path");
const Bundle = require("../bundled-native");
const Native = require("../local-native");
const Source = require("./source-identity");

const ID = "steam-ticket-loader";
const FILENAME = "libsdkencryptedappticket.dylib";

/** Included loader for unavailable encrypted-ticket operations; never a decryptor. */
function resolveBundledTicket({ resourcesRoot, architecture, version, catalog } = {}) {
  const pins = catalog || require("./ticket-versions.json");
  if (!Array.isArray(pins) || !pins.length) return { ready: false, reason: "This app does not include an encrypted-ticket loader." };
  if (!["arm64", "x86_64"].includes(architecture)) return { ready: false, reason: "The encrypted-ticket loader CPU is unknown." };
  const pin = pins.find(value => value.id === ID && value.schemaVersion === 1 &&
    (!version || value.version === version) && value.policy === "unavailable" &&
    Source.sourceIdentity(value)?.kind === "owned" && value.architectures?.includes(architecture));
  if (!pin) return { ready: false, reason: "No included encrypted-ticket loader supports this version or CPU." };
  const packageVersion = pin.packageVersion ?? pin.version;
  if (typeof packageVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(packageVersion)) {
    return { ready: false, reason: "The encrypted-ticket loader package version is invalid." };
  }
  const roots = resourcesRoot ? [resourcesRoot] : [process.resourcesPath, path.resolve(__dirname, "../../../../resources")];
  for (const root of roots.filter(value => typeof value === "string" && path.isAbsolute(value))) {
    const directory = path.join(root, "native-runtimes", ID, packageVersion, "universal");
    if (!fs.existsSync(directory)) continue;
    try {
      const content = Bundle.readRegular(path.join(directory, "helper.json"), 1024 * 1024);
      if (content.sha256 !== pin.manifestSha256) throw new Error("The included encrypted-ticket loader manifest changed.");
      const manifest = JSON.parse(content.bytes);
      if (manifest.schemaVersion !== 1 || manifest.id !== ID || manifest.version !== pin.version ||
          (manifest.packageVersion ?? manifest.version) !== packageVersion || manifest.policy !== "unavailable" ||
          !Source.sameSourceIdentity(manifest, pin) || manifest.librarySha256 !== pin.librarySha256 ||
          JSON.stringify(manifest.architectures) !== JSON.stringify(pin.architectures) ||
          manifest.minimumMacOS !== pin.minimumMacOS) {
        throw new Error("The included encrypted-ticket loader source or version changed.");
      }
      Bundle.verifyPayload(directory, { ...manifest, files: [...manifest.files,
        { path: "helper.json", size: content.size, sha256: content.sha256, mode: 0o644 }] });
      const libraryPath = path.join(directory, FILENAME), library = Bundle.readRegular(libraryPath, 4 * 1024 * 1024);
      if (!/^[a-f0-9]{64}$/.test(pin.librarySha256 || "") || library.sha256 !== pin.librarySha256 ||
          !Native.readMachOArchitectures(libraryPath, { allowLibrary: true }).includes(architecture)) {
        throw new Error("The included encrypted-ticket loader library changed or has an incompatible CPU.");
      }
      return { ready: true, version: pin.version, packageVersion, policy: "unavailable", source: "bundled",
        ...Source.sourceFields(pin), directory, libraryPath, sha256: library.sha256,
        architectures: [...pin.architectures], minimumMacOS: pin.minimumMacOS, readOnly: true };
    } catch (error) { return { ready: false, present: true, reason: error.message }; }
  }
  return { ready: false, present: false, reason: "The included encrypted-ticket loader is missing." };
}

module.exports = { ID, FILENAME, resolveBundledTicket };

const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { readAppBundleVersion } = require("../../shared/runtime/app-bundle");
const { extractDmg } = require("../../shared/runtime/dmg");
const Native = require("../../shared/runtime/local-native");
const Catalog = require("./catalog");

const APP_NAME = "DOSBox Staging.app";
const executablePath = root => path.join(root, APP_NAME, "Contents", "MacOS", "dosbox");

function prepareInstall({ unpacked, pin }) {
  const appVersion = readAppBundleVersion(path.join(unpacked, APP_NAME));
  const prefix = pin.version.replaceAll(".", "\\.");
  if (typeof appVersion !== "string" || !new RegExp(`^${prefix}(?:-[a-f0-9]{5,40})?$`, "i").test(appVersion))
    throw new Error("The DOSBox Staging app version differs from the selected release.");
  const architectures = Native.readMachOArchitectures(executablePath(unpacked));
  if (!architectures.includes("arm64")) throw new Error("The selected DOSBox Staging release does not support Apple Silicon.");
  return { appVersion, architectures };
}

function createManager(dependencies = {}) {
  return createPinnedNativeManager({ id: "dosbox-staging", label: "DOSBox Staging", sourceUrl: Catalog.SOURCE_URL,
    catalog: [Catalog.PIN], supportsDefault: true,
    discoverCatalog: Catalog.createDiscovery(dependencies), resolveExecutable: executablePath, prepareInstall,
    dependencies: { extractArchive: (archive, destination, signal) => extractDmg(archive, destination, signal,
      { payloadName: APP_NAME, project: "DOSBox Staging" }), ...dependencies } });
}

module.exports = createManager();
module.exports.createManager = createManager;
module.exports.DEFAULT_VERSION = Catalog.DEFAULT_VERSION;
module.exports.PIN = Catalog.PIN;
module.exports.executablePath = executablePath;
module.exports.prepareInstall = prepareInstall;

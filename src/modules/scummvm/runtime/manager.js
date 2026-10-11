const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { readAppBundleVersion } = require("../../shared/runtime/app-bundle");
const Native = require("../../shared/runtime/local-native");
const { DEFAULT_ENTRY, DEFAULT_VERSION, SOURCE_URL, createDiscovery } = require("./catalog");
const { extractDmg } = require("./dmg");

function createManager({ discoverCatalog = createDiscovery(), dependencies = {} } = {}) {
  return createPinnedNativeManager({ id: "scummvm", label: "ScummVM",
    sourceUrl: SOURCE_URL, catalog: [DEFAULT_ENTRY], recommendedVersion: DEFAULT_VERSION,
    discoverCatalog, resolveExecutable: root => path.join(root, "ScummVM.app"),
    prepareInstall: ({ unpacked, pin }) => {
      const app = path.join(unpacked, "ScummVM.app");
      if (readAppBundleVersion(app) !== pin.version) throw new Error("ScummVM app version does not match the selected release.");
      const architectures = Native.readMachOArchitectures(path.join(app, "Contents", "MacOS", "scummvm"));
      if (!architectures.includes("arm64")) throw new Error("The selected ScummVM release does not support Apple Silicon.");
      return { appVersion: pin.version, architectures };
    }, dependencies: { extractArchive: extractDmg, ...dependencies } });
}

module.exports = createManager();
module.exports.createManager = createManager;

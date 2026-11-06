const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { resolveAppBundleExecutablePath } = require("../../shared/runtime/app-bundle");
const { locatePackaged } = require("../../shared/runtime/release-files");
const Native = require("../../shared/runtime/local-native");
const Catalog = require("./catalog");

// The app keeps its name in current releases; another app bundle is found too.
const executablePath = root => resolveAppBundleExecutablePath(locatePackaged(root, ["DOSBox Staging.app", /^DOSBox.*\.app$/i, /\.app$/i]));

function prepareInstall({ unpacked }, { arch = require("../../shared/runtime/architecture").selectedArchitecture() } = {}) {
  const executable = executablePath(unpacked);
  if (!executable) throw new Error("The DOSBox Staging download contains no app.");
  const architectures = Native.readMachOArchitectures(executable);
  const nativeArch = arch === "x64" ? "x86_64" : arch;
  if (!architectures.includes(nativeArch)) throw new Error(`The selected DOSBox Staging release does not support this Mac's ${arch} CPU.`);
  return { architectures };
}

function createManager(dependencies = {}) {
  return createPinnedNativeManager({ id: "dosbox-staging",
    versionCompatibility: () => true, // DOS executables target the emulated DOS machine, not a DOSBox release ABI.
     label: "DOSBox Staging", sourceUrl: Catalog.SOURCE_URL,
    supportsDefault: true, upstream: Catalog.source, resolveExecutable: executablePath, prepareInstall, dependencies });
}

module.exports = createManager();
module.exports.createManager = createManager;
module.exports.executablePath = executablePath;
module.exports.prepareInstall = prepareInstall;

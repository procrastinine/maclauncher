const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { locatePackaged } = require("../../shared/runtime/release-files");
const Architecture = require("../../shared/runtime/architecture");
const Native = require("../../shared/runtime/local-native");
const Catalog = require("./catalog");

// The archive holds the `xash3d` launcher beside the engine libraries; a later
// layout may place them in a folder.
const resolveExecutable = root => locatePackaged(root, ["xash3d"], { files: true });

// A build lists its CPU; one without serves the CPU it is installed for.
function prepareInstall({ unpacked, pin }, { arch = Architecture.targetArchitecture(Architecture.recordArchitecture(pin)) || Architecture.selectedArchitecture() } = {}) {
  const executable = resolveExecutable(unpacked);
  if (!executable) throw new Error("The Xash3D FWGS download contains no engine executable.");
  const architectures = Native.readMachOArchitectures(executable);
  if (!architectures.includes(arch === "x64" ? "x86_64" : arch)) throw new Error(`The selected Xash3D FWGS build does not support this Mac's ${arch} CPU.`);
  return { architectures };
}

function createManager(dependencies = {}) {
  return createPinnedNativeManager({ id: "xash3d-fwgs", label: "Xash3D FWGS", sourceUrl: Catalog.SOURCE_URL,
    upstream: Catalog.source, resolveExecutable, prepareInstall, dependencies });
}

module.exports = createManager();
module.exports.createManager = createManager;
module.exports.resolveExecutable = resolveExecutable;
module.exports.prepareInstall = prepareInstall;

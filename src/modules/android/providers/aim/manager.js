const fs = require("node:fs"), path = require("node:path");
const Bundled = require("../../../shared/runtime/bundled-native");
const { createProjectBuildManager } = require("../../../shared/runtime/project-build-manager");

function includedRoot(record, options, optional = false) {
  if (record.id !== "android-aim" || record.arch !== "arm64" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.version || "") ||
      record.directoryRelative !== `android-aim/${record.version}/${record.arch}` ||
      record.manifestRelative !== "manifest.json" || record.sourceRelative !== "files/source.tar.gz" ||
      !/^[a-f0-9]{64}$/.test(record.manifestSha256 || "") || !/^[a-f0-9]{64}$/.test(record.sourceSha256 || ""))
    throw new Error("The included AIM runtime identity is invalid. Reinstall MacLauncher.");
  const roots = options.nativeResourceRoot ? [options.nativeResourceRoot] :
    [process.resourcesPath && path.join(process.resourcesPath, "native-runtimes"), path.resolve(__dirname, "../../../../resources/native-runtimes")].filter(Boolean);
  const root = roots.map(directory => path.join(directory, record.directoryRelative)).find(directory => fs.existsSync(optional ? directory : path.join(directory, "manifest.json")));
  return root ? { root, record } : optional ? null : { root: path.join(roots[0], record.directoryRelative), record };
}

function createManager(dependencies = {}) {
  return createProjectBuildManager({ projectId: "android-aim", runtimeId: "aim", label: "AIM", repository: "procrastinine/maclauncher-builds",
    manifestRelative: "manifest.json", sourceRelative: manifest => manifest.files.some(file => file.path === "source.tar.gz") ? "files/source.tar.gz" : null,
    executableRelative: "bin/aimctl", filesPrefix: "files/",
    included: options => {
      const record = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../distribution-supplementals.json"))).find(row => row.id === "android-aim");
      if (!record) throw new Error("The included AIM runtime metadata is missing. Reinstall MacLauncher.");
      return includedRoot(record, options);
    },
    retainedIncluded: options => {
      const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, "retained-versions.json")));
      if (metadata.schemaVersion !== 1 || !Array.isArray(metadata.packages)) throw new Error("The retained AIM runtime metadata is invalid. Reinstall MacLauncher.");
      return metadata.packages.map(record => includedRoot(record, options, true)).filter(Boolean);
    },
    validateManifest: (manifest, record) => {
      if (record.arch !== "arm64") throw new Error("The selected AIM runtime requires Apple Silicon.");
      return Bundled.validateManifest(manifest, { managerId: "android-aim", version: record.version, arch: record.arch });
    },
    verifyPayload: selected => Bundled.verifyPayload(selected.root, selected.declaration), dependencies });
}
module.exports = createManager();
module.exports.createManager = createManager;

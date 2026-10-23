const fs = require("node:fs"), path = require("node:path");
const Runtime = require("./runtime");
const { createProjectBuildManager } = require("../shared/runtime/project-build-manager");

function includedRoot(record, options, optional = false) {
  if (record.id !== "android" || record.arch !== "arm64" || typeof record.version !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.version || "") ||
      record.directoryRelative !== `android/${record.version}/arm64` ||
      record.manifestRelative !== "runtime.json" || record.sourceRelative !== "source.tar.gz" ||
      !/^[a-f0-9]{64}$/.test(record.manifestSha256 || "") || !/^[a-f0-9]{64}$/.test(record.sourceSha256 || ""))
    throw new Error("The included Android runtime identity is invalid. Reinstall MacLauncher.");
  const roots = options.nativeResourceRoot ? [options.nativeResourceRoot] :
    [process.resourcesPath && path.join(process.resourcesPath, "native-runtimes"), path.resolve(__dirname, "../../resources/native-runtimes")].filter(Boolean);
  const root = roots.map(directory => path.join(directory, record.directoryRelative)).find(directory => fs.existsSync(optional ? directory : path.join(directory, "runtime.json")));
  return root ? { root, record } : optional ? null : { root: path.join(roots[0], record.directoryRelative), record };
}

function createManager(dependencies = {}) {
  return createProjectBuildManager({ projectId: "android", runtimeId: "klepton", label: "MacLauncher Android", repository: "procrastinine/maclauncher-builds",
    manifestRelative: "runtime.json", sourceRelative: manifest => manifest.files.some(file => file.path === "source.tar.gz") ? "source.tar.gz" : null,
    executableRelative: "native/libklepton-jvm.dylib", nativeLibrary: true,
    included: options => {
      const record = Runtime.readDeclaration({ optional: true });
      return record ? includedRoot(record, options) : null;
    },
    retainedIncluded: options => {
      const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, "retained-versions.json")));
      if (metadata.schemaVersion !== 1 || !Array.isArray(metadata.packages)) throw new Error("The retained Android runtime metadata is invalid. Reinstall MacLauncher.");
      return metadata.packages.map(record => includedRoot(record, options, true)).filter(Boolean);
    },
    validateManifest: (manifest, record) => {
      if (record.arch !== "arm64" || !manifest.architectures?.includes("arm64") || manifest.profile?.javaMajor !== 21 ||
          !manifest.profile.id || manifest.profile.nativeLoadTarget !== "maclauncher.android.bridge.GuestNativeLoader")
        throw new Error("The selected Android runtime profile is unsupported.");
    },
    verifyPayload: (selected, options) => require("./runtime-verifier").verifyPayload(selected.root, selected.declaration, options), dependencies });
}
module.exports = createManager();
module.exports.createManager = createManager;

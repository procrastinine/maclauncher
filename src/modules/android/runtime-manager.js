const Bundled = require("../shared/runtime/bundled-native");
const { createProjectBuildManager } = require("../shared/runtime/project-build-manager");

function createManager(dependencies = {}) {
  return createProjectBuildManager({
    // Framework, VM and native adaptation form one selected Android API/profile snapshot.
    versionCompatibility: "exact",
     projectId: "android", runtimeId: "klepton", label: "MacLauncher Android", repository: "procrastinine/maclauncher-builds", upstreamUrl: "https://github.com/procrastinine/maclauncher-android",
    manifestRelative: "runtime.json", sourceRelative: manifest => manifest.files.some(file => file.path === "source.tar.gz") ? "source.tar.gz" : null,
    executableRelative: "native/libklepton-jvm.dylib", nativeLibrary: true,
    validateManifest: (manifest, record) => {
      if (Bundled.isManagedDeclaration(manifest)) return;
      if (record.arch !== "arm64" || !manifest.architectures?.includes("arm64") || manifest.profile?.javaMajor !== 21 ||
          !manifest.profile.id || manifest.profile.nativeLoadTarget !== "maclauncher.android.bridge.GuestNativeLoader")
        throw new Error("The selected Android runtime profile is unsupported.");
    },
    verifyPayload: (selected, options) => require("./runtime-verifier").verifyPayload(selected.root, selected.declaration, { ...options, resolveDependency: selected.resolveDependency }), dependencies });
}
module.exports = createManager();
module.exports.createManager = createManager;

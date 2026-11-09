const fs = require("node:fs"), path = require("node:path");
const execute = require("node:util").promisify(require("node:child_process").execFile);
const Bundled = require("../../shared/runtime/bundled-native");
const { createProjectBuildManager } = require("../../shared/runtime/project-build-manager");
// An owned source adaptation is built from source; its package record names that source.
const owned = manifest => manifest?.provenance?.sourceKind === "owned-source-adaptation";

function createManager(dependencies = {}) {
  return createProjectBuildManager({ projectId: "mkxpz", runtimeId: "mkxpz", label: "MKXP-Z",
    repository: "procrastinine/maclauncher-builds",
    manifestRelative: "manifest.json",
    sourceRelative: manifest => owned(manifest) ? null : "manifest.json",
    filesPrefix: "files/",
    executableRelative: manifest => manifest.executableRelative,
    validateManifest(manifest, record) {
      if (Bundled.isManagedDeclaration(manifest)) return;
      if (manifest.arch !== record.arch || record.arch === "universal" &&
          manifest.files.some(file => file.architectures && !["arm64", "x86_64"].every(arch => file.architectures.includes(arch))))
        throw new Error("The MKXP-Z package CPU coverage differs from its catalog.");
      // Universal package validation defaults to the launcher CPU; its native slices were checked above.
      Bundled.validateManifest(record.arch === "universal" ? { ...manifest, arch: process.arch } : manifest,
        { managerId: "mkxpz", version: record.version });
      const provenance = manifest.provenance;
      if (owned(manifest)) return;
      if (!/^[^/]+\.app\/Contents\/MacOS\/[^/]+$/.test(manifest.executableRelative || "") ||
          !["reviewed-binary", "publisher-binary"].includes(provenance.sourceKind) || provenance.verifiedBuild !== false)
        throw new Error("The MKXP-Z package does not identify its original publisher binary.");
      if (!/^[a-f0-9]{64}$/.test(provenance.inputExecutableSha256 || "") ||
          !/^[a-f0-9]{64}$/.test(provenance.inputArtifactTreeSha256 || ""))
        throw new Error("The MKXP-Z package does not identify its original publisher bytes.");
    },
    async verifyPayload(selected, { signal } = {}) {
      signal?.throwIfAborted();
      Bundled.verifyPayload(selected.root, selected.declaration, selected.resolveDependency);
      await Bundled.verifySignatures(selected.root,selected.declaration,{signal});
    }, dependencies });
}

function runtimeFromInstall(install) {
  const appName = install.manifest.executableRelative.split("/")[0];
  return { ...install, appPath: path.join(install.payloadRoot, appName), resourceRoot: install.payloadRoot,
    source: "MacLauncher Builds", projectPackage: true };
}

// The shared registration owns this nested payload. A damaged exact selection
// must never become an unverified legacy app.
function resolveOwned({ userDataDir, version, architecture, verification = "full" }, manager = module.exports.manager) {
  if (!path.isAbsolute(userDataDir || "") || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version || "") || version === "..")
    throw new Error("The selected MKXP-Z installation identity is invalid.");
  const key = JSON.stringify([userDataDir, version, architecture ?? null, verification]);
  return require("../../../core/coordinated-runtime-managers").memoizeRuntimeResolution(manager, key, () => {
    const directory = manager.core.getInstallDir({ userDataDir, version, architecture });
    if (!fs.existsSync(path.join(directory, "runtime.json"))) return null;
    const selected = manager.resolveSelection(null, {}, userDataDir, { version, architecture, verification });
    if (!selected.ready || !selected.install)
      throw new Error("The selected MKXP-Z installation is damaged. Remove it and install this version again.");
    if (verification === "full") {
      Bundled.verifyPayload(selected.install.root, selected.install.declaration);
    }
    return runtimeFromInstall(selected.install);
  });
}

module.exports = { createManager, manager: createManager(), runtimeFromInstall, resolveOwned };

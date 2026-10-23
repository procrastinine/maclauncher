const fs = require("node:fs"), path = require("node:path");
const execute = require("node:util").promisify(require("node:child_process").execFile);
const Binary = require("./bundled-binary.json");
const Bundled = require("../../shared/runtime/bundled-native");
const Owned = require("./mkxpz-owned-builds");
const { createProjectBuildManager } = require("../../shared/runtime/project-build-manager");

function createManager(dependencies = {}) {
  return createProjectBuildManager({ projectId: "mkxpz", runtimeId: "mkxpz", label: "MKXP-Z",
    repository: "procrastinine/maclauncher-builds", included: () => null,
    manifestRelative: "manifest.json",
    sourceRelative: (_manifest, record) => Owned.pin(record.version) ? null : "source.tar.gz",
    filesPrefix: (_manifest, record) => Owned.pin(record.version) ? "files/" : "",
    executableRelative: manifest => manifest.executableRelative,
    validateManifest(manifest, record) {
      if (manifest.arch !== record.arch || record.arch === "universal" &&
          manifest.files.some(file => file.architectures && !["arm64", "x86_64"].every(arch => file.architectures.includes(arch))))
        throw new Error("The MKXP-Z package CPU coverage differs from its catalog.");
      Bundled.validateManifest(record.arch === "universal" ? { ...manifest, arch: process.arch } : manifest,
        { managerId: "mkxpz", version: record.version });
      const provenance = manifest.provenance;
      const owned = Owned.pin(record.version);
      if (owned) {
        if (record.sourceSha256 !== owned.sourceArtifact.sha256)
          throw new Error("The MKXP-Z corresponding source differs from its selected build identity.");
        Owned.validate(manifest);
        return;
      }
      if (!/^[^/]+\.app\/Contents\/MacOS\/[^/]+$/.test(manifest.executableRelative || "") ||
          !["reviewed-binary", "publisher-binary"].includes(provenance.sourceKind) || provenance.verifiedBuild !== false)
        throw new Error("The MKXP-Z package does not identify its original publisher binary.");
      const pin = [Binary, ...(Binary.retained || [])].find(item => item.version === record.version);
      if (pin && (manifest.upstreamRevision !== pin.upstreamRevision ||
          manifest.executableRelative !== (pin.executableRelative || pin.appName + "/Contents/MacOS/Z-universal") ||
          provenance.inputExecutableSha256 !== pin.executableSha256 || provenance.inputArtifactTreeSha256 !== pin.treeSha256))
        throw new Error("The MKXP-Z baseline differs from its reviewed publisher identity.");
    },
    async verifyPayload(selected, { signal } = {}) {
      signal?.throwIfAborted();
      Bundled.verifyPayload(selected.root, selected.declaration);
      for (const file of selected.declaration.files.filter(item => item.architectures))
        await execute("/usr/bin/codesign", ["--verify", "--strict", path.join(selected.root, file.path)],
          { signal, timeout: 30000, maxBuffer: 1024 * 1024 });
    }, dependencies });
}

function runtimeFromInstall(install) {
  const appName = install.manifest.executableRelative.split("/")[0];
  return { ...install, appPath: path.join(install.payloadRoot, appName), resourceRoot: install.payloadRoot,
    source: "MacLauncher Builds", projectPackage: true };
}

// The shared registration owns this nested payload. A damaged exact selection
// must never become an unverified legacy app or the included fallback.
function resolveOwned({ userDataDir, version, verification = "full" }, manager = module.exports.manager) {
  if (!path.isAbsolute(userDataDir || "") || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version || "") || version === "..")
    throw new Error("The selected MKXP-Z installation identity is invalid.");
  const directory = path.join(userDataDir, "runtimes/mkxpz", version);
  if (!fs.existsSync(path.join(directory, "runtime.json"))) return null;
  const selected = manager.resolveSelection(null, {}, userDataDir, { version, verification });
  if (!selected.ready || !selected.install)
    throw new Error("The selected MKXP-Z installation is damaged. Remove it and install this version again.");
  if (verification === "full") {
    Bundled.verifyPayload(selected.install.root, selected.install.declaration);
  }
  return runtimeFromInstall(selected.install);
}

module.exports = { createManager, manager: createManager(), runtimeFromInstall, resolveOwned };

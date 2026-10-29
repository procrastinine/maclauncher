const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Bundled = require("../../shared/runtime/bundled-native");
const MachO = require("../../shared/runtime/macho-load-commands");
const { createProjectBuildManager } = require("../../shared/runtime/project-build-manager");
const SHA = /^[a-f0-9]{64}$/;

function validateManifest(manifest) {
  if (manifest.managerId !== "gamemaker-opengl-helper" || manifest.helperABI !== 1 || manifest.arch !== "universal" ||
      !SHA.test(manifest.source?.sourceSha256 || "") || !manifest.files.some(file => file.path === "helper.json") ||
      !manifest.runnerChecksums || typeof manifest.runnerChecksums !== "object" || Array.isArray(manifest.runnerChecksums) ||
      !Object.keys(manifest.runnerChecksums).length || Object.entries(manifest.runnerChecksums).some(([version, hash]) => !/^\d+(?:\.\d+){2,3}$/.test(version) || !SHA.test(hash)) ||
      !Array.isArray(manifest.legacyLogicalRunnerVersions) || manifest.legacyLogicalRunnerVersions.some(version => !Object.hasOwn(manifest.runnerChecksums, version)))
    throw new Error("The GameMaker graphics helper uses an unsupported integration profile.");
}
function verifyInstall(install) {
  Bundled.verifyPayload(install.root, install.declaration);
  validateManifest(install.manifest);
  const record = JSON.parse(Bundled.readRegular(path.join(install.payloadRoot, "helper.json"), Bundled.LIMITS.manifestBytes).bytes);
  const file = path.join(install.payloadRoot, "software-opengl.dylib");
  const primary = install.manifest.files.find(item => item.path === "software-opengl.dylib");
  if (record.sourceSha256 !== install.manifest.source.sourceSha256 || record.binarySha256 !== primary?.sha256 || record.architecture !== "universal" ||
      !Array.isArray(record.supportedRunnerVersions) || record.supportedRunnerVersions.length !== Object.keys(install.manifest.runnerChecksums).length ||
      record.supportedRunnerVersions.some(version => !Object.hasOwn(install.manifest.runnerChecksums, version)))
    throw new Error("The GameMaker graphics helper record differs from its managed package.");
  const image = MachO.assertSystemLibraryClosure(MachO.readMachOLoadCommands(file), {
    fileType: 6, installName: "@rpath/software-opengl.dylib", maximumMacOS: install.declaration.minimumMacOS });
  if (!["arm64", "x86_64"].every(arch => image.architectures.includes(arch))) throw new Error("The GameMaker graphics helper requires both Mac CPU architectures.");
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", file], { timeout: 30000, stdio: "pipe" });
  return { ...record, version: install.version || install.manifest.version, profileVersion: record.version,
    runnerChecksums: install.manifest.runnerChecksums, legacyLogicalRunnerVersions: install.manifest.legacyLogicalRunnerVersions,
    ready: true, dylibPath: file, installDir: install.installDir || install.root, reason: null };
}
function createManager(dependencies = {}) {
  const manager = createProjectBuildManager({ projectId: "gamemaker-opengl-helper", label: "GameMaker graphics helper", repository: "procrastinine/maclauncher-builds",
    manifestRelative: "manifest.json", sourceRelative: null, executableRelative: "software-opengl.dylib", nativeLibrary: true,
    validateManifest, verifyPayload: verifyInstall, dependencies });
  manager.ui = { groupId: "gamemaker", tabLabel: "GameMaker", sectionLabel: "Graphics helper", order: 90, memberOrder: 5, management: "managed" };
  return manager;
}
module.exports = Object.assign(createManager(), { createManager, verifyInstall });

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createPinnedNativeManager, hashFile } = require("../../shared/runtime/pinned-native-manager");
const MachO = require("../../shared/runtime/macho-load-commands");
const { locatePackaged } = require("../../shared/runtime/release-files");
const Catalog = require("./rlvm-catalog");
const ADAPTER = require("./adapter-profile.json");
const adapterManager = require("./rlvm-adapter-manager");
const APP = "rlvm.app/Contents/MacOS/rlvm";
// A release may move the app into a folder or use another archive format.
const executable = root => locatePackaged(root, APP) || path.join(root, APP);

function verifyLibraries(executablePath, requestedArchitecture) {
  const Binary = require("../../shared/runtime/binary-compatibility");
  const root = MachO.readMachOLoadCommands(executablePath), executable = fs.realpathSync(executablePath);
  const requested = requestedArchitecture || require("../../shared/runtime/architecture").selectedArchitecture();
  const preferred = requested === "x64" ? "x86_64" : requested;
  const architecture = root.architectures.includes(preferred) ? preferred : root.architectures[0];
  const pending = [{ file: executablePath, runPaths: [] }], visited = new Set();
  while (pending.length) {
    const { file, runPaths: inherited } = pending.shift(), canonical = fs.realpathSync(file);
    if (visited.has(canonical)) continue;
    if (visited.size >= 256) throw new Error("RLVM native library dependencies exceed the inspection limit.");
    visited.add(canonical);
    const image = MachO.readMachOLoadCommands(file, { architecture }).slices[0];
    if (canonical !== executable && image.fileType !== 6) throw new Error("RLVM requires a Mach-O dynamic library for " + file + ".");
    const runPaths = Binary.nativeRunPaths(file, image, executablePath, inherited);
    for (const dependency of image.dependencies) {
      if (/^\/(?:usr\/lib|System\/Library)\//.test(dependency.path)) continue;
      const target = Binary.resolveNativeDependency(file, image, dependency.path, { executablePath, runPaths });
      if (!target && dependency.kind === "weak") continue;
      if (!target) throw new Error(`RLVM requires ${dependency.path}. Select the complete application with its libraries.`);
      pending.push({ file: target, runPaths });
    }
  }
  return root;
}
function inspectRuntime(options) {
  const runtime = require("../../shared/runtime/local-native").resolveLocalRuntime(options);
  verifyLibraries(runtime.executablePath, options.arch || options.requiredArchitecture);
  return runtime;
}
function prepareInstall({ unpacked }) {
  const image = verifyLibraries(executable(unpacked));
  if (!image.architectures.some(arch => ["arm64", "x86_64"].includes(arch))) throw new Error("This RLVM app requires an unsupported CPU.");
}
// Retain exact adapter copies already owned by earlier installations.
function resolveAdapter(install) {
  const root = path.dirname(path.dirname(path.dirname(path.dirname(install.executablePath))));
  const file = path.join(root, "rlvm-adapter.dylib"), stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || hashFile(file) !== ADAPTER.sha256)
    throw new Error("The installed RLVM adapter has changed. Reinstall the adapter in Runtimes.");
  MachO.assertSystemLibraryClosure(MachO.readMachOLoadCommands(file), { fileType: 6, installName: "@rpath/rlvm-adapter.dylib", maximumMacOS: ADAPTER.minimumMacOS });
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", file], { timeout: 30000, stdio: "pipe" });
  return { ...install, adapterPath: file };
}
function adapterSelection(install, entry, context) {
  const override = entry?.runtimeData?.[adapterManager.id]?.version;
  const requested = override && override !== "auto" ? override : context.settings?.runtimes?.[adapterManager.id]?.defaultVersion;
  if (install && (!requested || requested === "auto")) {
    const retained = resolveAdapter(install);
    if (retained) return { ready: true, install: retained, version: ADAPTER.version, legacy: true };
  }
  return adapterManager.resolveSelection(entry, context.settings, context.userDataDir);
}
function resolveForLaunch(install, entry, context) {
  const selected = adapterSelection(install, entry, context);
  if (!selected.ready) throw new Error(selected.reason);
  const adapterPath = selected.legacy ? selected.install.adapterPath : adapterManager.verifyInstall(selected.install);
  if (!selected.legacy) context.recordRuntimeUse?.({ managerId: adapterManager.id, version: selected.version, sourcePath: selected.install.installDir });
  return { ...install, adapterPath };
}
function createManager({ dependencies = {} } = {}) {
  return createPinnedNativeManager({
    // RealLive script data does not link against the RLVM package version.
    versionCompatibility: () => true,
     id: "rlvm", label: "RLVM", sourceUrl: Catalog.RELEASES,
    upstream: Catalog.source, projectBuilds: Catalog.projectBuilds, inspectRuntime, resolveExecutable: executable, prepareInstall, dependencies });
}
module.exports = Object.assign(createManager(), { createManager, executable, prepareInstall, resolveAdapter, adapterSelection, resolveForLaunch, adapterManager });

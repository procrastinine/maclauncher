const fs = require("node:fs");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const { createPinnedNativeManager, hashFile } = require("../../shared/runtime/pinned-native-manager");
const MachO = require("../../shared/runtime/macho-load-commands");
const Catalog = require("./rlvm-catalog");
const ADAPTER = require("./adapter-profile.json");
const adapterManager = require("./rlvm-adapter-manager");
const run = promisify(execFile);
const executable = root => path.join(root, "rlvm.app", "Contents", "MacOS", "rlvm");

async function extractDiskImage(archive, destination, signal, execute = run) {
  const mount = fs.mkdtempSync(path.join(path.dirname(destination), ".mount-"));
  let attached = false;
  try {
    await execute("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, archive], { signal, timeout: 60000 });
    attached = true;
    signal?.throwIfAborted();
    const app = path.join(mount, "rlvm.app");
    if (!fs.lstatSync(app).isDirectory() || fs.lstatSync(app).isSymbolicLink()) throw new Error("The RLVM download does not contain a macOS app.");
    fs.cpSync(app, path.join(destination, "rlvm.app"), { recursive: true });
  } finally {
    if (attached) await execute("/usr/bin/hdiutil", ["detach", mount, "-force"], { timeout: 60000 });
    fs.rmdirSync(mount);
  }
}
function prepareInstall({ unpacked }) {
  const image = MachO.assertSystemLibraryClosure(MachO.readMachOLoadCommands(executable(unpacked)), { fileType: 2, maximumMacOS: "13.0" });
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
  return createPinnedNativeManager({ id: "rlvm", label: "RLVM", catalog: [Catalog.reviewedEntry()], sourceUrl: Catalog.RELEASES,
    discoverCatalog: Catalog.createDiscovery({ dependencies: dependencies.github }), resolveExecutable: executable, prepareInstall,
    dependencies: { extractArchive: extractDiskImage, ...dependencies } });
}
module.exports = Object.assign(createManager(), { createManager, extractDiskImage, prepareInstall, resolveAdapter, adapterSelection, resolveForLaunch, adapterManager });

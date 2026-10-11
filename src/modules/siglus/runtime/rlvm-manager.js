const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createPinnedNativeManager, hashFile } = require("../../shared/runtime/pinned-native-manager");
const MachO = require("../../shared/runtime/macho-load-commands");
const Catalog = require("./rlvm-catalog");
const ADAPTER = require("../resources/rlvm-adapter/manifest.json");
const run = promisify(execFile);
const executable = root => path.join(root, "rlvm.app", "Contents", "MacOS", "rlvm");
const adapter = root => path.join(root, "rlvm-adapter.dylib");

function adapterResource() {
  const root = path.resolve(__dirname, "../resources/rlvm-adapter"), file = path.join(root, ADAPTER.path);
  if (!file.startsWith(root + path.sep) || hashFile(file) !== ADAPTER.sha256 ||
      hashFile(path.join(root, "adapter.m")) !== ADAPTER.sourceSha256) throw new Error("The included RLVM adapter failed its integrity check.");
  return file;
}
async function extractDiskImage(archive, destination, signal, execute = run) {
  const mount = fs.mkdtempSync(path.join(path.dirname(destination), ".mount-"));
  let attached = false;
  try {
    await execute("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, archive], { signal, timeout: 60000 });
    attached = true;
    if (signal?.aborted) signal.throwIfAborted();
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
  fs.copyFileSync(adapterResource(), adapter(unpacked));
  return { adapterVersion: ADAPTER.version, adapterSha256: ADAPTER.sha256 };
}
function resolveAdapter(install) {
  const root = path.dirname(path.dirname(path.dirname(path.dirname(install.executablePath))));
  const file = adapter(root);
  if (hashFile(file) !== ADAPTER.sha256) throw new Error("The installed RLVM adapter has changed. Reinstall this version.");
  return { ...install, adapterPath: file };
}
function createManager({ dependencies = {} } = {}) {
  const manager = createPinnedNativeManager({ id: "rlvm", label: "RLVM", recommendedVersion: Catalog.VERSION,
    catalog: [Catalog.reviewedEntry()], sourceUrl: Catalog.RELEASES,
    discoverCatalog: Catalog.createDiscovery({ dependencies: dependencies.github }),
    resolveExecutable: executable, prepareInstall,
    dependencies: { extractArchive: extractDiskImage, ...dependencies } });
  const selection = manager.resolveSelection.bind(manager), state = manager.getState.bind(manager);
  manager.resolveSelection = (entry, settings, userDataDir, options) => {
    const result = selection(entry, settings, userDataDir, options);
    if (!result.ready) return result;
    try { return { ...result, install: resolveAdapter(result.install) }; }
    catch (error) { return { ...result, ready: false, install: null, reason: error.message }; }
  };
  manager.getState = options => {
    const result = state(options), installed = result.installed.map(row => {
      if (!row.ready) return row;
      try { resolveAdapter(row); return row; }
      catch (error) { return { ...row, ready: false, status: "damaged", error: error.message }; }
    });
    return { ...result, installed, sections: result.sections.map(section => ({ ...section, installed })) };
  };
  return manager;
}
module.exports = Object.assign(createManager(), { createManager, adapterResource, extractDiskImage, prepareInstall, resolveAdapter });

const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");
const MachO = require("../../shared/runtime/macho-load-commands");
const { inspectMachOExports } = require("../../shared/runtime/macho-exports");
const Host = require("../../shared/runtime/bundled-native");
const { throwIfAborted } = require("../../shared/runtime/download-utils");

const LIBRARY_RELATIVE = "RFVP.app/Contents/Frameworks/librfvp.dylib";
const REQUIRED_EXPORTS = Object.freeze(["rfvp_run_entry", "rfvp_set_text_hidpi_enabled"]);

function libraryPath(root) {
  if (!path.isAbsolute(root) || fs.lstatSync(root).isSymbolicLink())
    throw new Error("RFVP requires its managed installation folder.");
  const target = path.join(root, LIBRARY_RELATIVE);
  // The selected payload must remain inside its managed installation, including
  // the directories between its root and the actual shared library.
  let current = root;
  for (const segment of LIBRARY_RELATIVE.split("/")) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("RFVP library files cannot be symbolic links.");
  }
  if (!fs.lstatSync(target).isFile()) throw new Error("The RFVP shared library is missing.");
  return target;
}

function inspectLibrary(target, { signal, maximumMacOS } = {}) {
  const info = MachO.readMachOLoadCommands(target, { signal });
  MachO.assertSystemLibraryClosure(info, { fileType: 6, installName: "@rpath/librfvp.dylib", maximumMacOS });
  if (!info.architectures.includes("arm64") || !info.architectures.includes("x86_64"))
    throw new Error("RFVP requires a universal Apple Silicon and Intel shared library.");
  const minimumMacOS = info.slices.map(slice => slice.minimumMacOS)
    .sort((a, b) => Host.versionAtLeast(a, b) ? -1 : 1)[0];
  return { architectures: info.architectures, minimumMacOS };
}

async function preparePayload({ unpacked, signal }, { inspectExports = inspectMachOExports, systemVersionSync = Host.systemVersionSync } = {}) {
  throwIfAborted(signal);
  const target = libraryPath(unpacked), info = inspectLibrary(target, { signal, maximumMacOS: systemVersionSync() });
  for (const arch of info.architectures) {
    throwIfAborted(signal);
    const exports = await inspectExports(target, { arch });
    if (!REQUIRED_EXPORTS.every(name => exports.includes(name)))
      throw new Error("This RFVP download does not support the required game launch interface.");
  }
  throwIfAborted(signal);
  const stat = fs.statSync(target);
  return { schemaVersion: 1, hostInterface: "rfvp-run-entry-v1", library: {
    relativePath: LIBRARY_RELATIVE, bytes: stat.size, sha256: Native.hashFile(target),
    ...info, requiredExports: [...REQUIRED_EXPORTS]
  } };
}

function createPayloadResolver({ systemVersionSync = Host.systemVersionSync } = {}) {
  const cache = new Map();
  return function resolvePayload(install, { verification = "full" } = {}) {
    if (!install) return { install: null, reason: "RFVP is not installed." };
    let key;
    try {
      const evidence = install.installationMetadata;
      const library = evidence?.library;
      if (evidence?.schemaVersion !== 1 || evidence.hostInterface !== "rfvp-run-entry-v1" ||
        library?.relativePath !== LIBRARY_RELATIVE || !/^[a-f0-9]{64}$/.test(library.sha256 || "") ||
        !Number.isSafeInteger(library.bytes) || library.bytes < 32 ||
        JSON.stringify(library.requiredExports) !== JSON.stringify(REQUIRED_EXPORTS))
        throw new Error("RFVP library registration is incomplete. Remove and install this version again.");
      const target = libraryPath(install.installDir), stat = fs.statSync(target);
      if (stat.size !== library.bytes) throw new Error("RFVP library files changed. Remove and install this version again.");
      key = JSON.stringify([target, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs,
        library.sha256, library.minimumMacOS]);
      const cached = verification === "status" ? cache.get(key) : null;
      if (cached?.error) throw new Error(cached.error);
      let info = cached?.info;
      if (!info) {
        info = inspectLibrary(target);
        if (info.minimumMacOS !== library.minimumMacOS || JSON.stringify(info.architectures) !== JSON.stringify(library.architectures))
          throw new Error("RFVP library registration does not match the installed files.");
        if (verification !== "status" && Native.hashFile(target) !== library.sha256)
          throw new Error("RFVP library files changed. Remove and install this version again.");
        if (cache.size >= 128) cache.delete(cache.keys().next().value);
        cache.set(key, { info });
      }
      if (!Host.versionAtLeast(systemVersionSync(), info.minimumMacOS))
        return { install: null, minimumMacOS: info.minimumMacOS, reason: `This RFVP build requires macOS ${info.minimumMacOS}.` };
      return { install: { ...install, dylibPath: target, appPath: path.join(install.installDir, "RFVP.app"),
        minimumMacOS: info.minimumMacOS, librarySha256: library.sha256 }, reason: null, minimumMacOS: info.minimumMacOS };
    } catch (error) {
      if (key) {
        if (cache.size >= 128) cache.delete(cache.keys().next().value);
        cache.set(key, { error: error.message });
      }
      return { install: null, reason: error.message };
    }
  };
}

module.exports = { LIBRARY_RELATIVE, REQUIRED_EXPORTS, libraryPath, inspectLibrary, preparePayload, createPayloadResolver };

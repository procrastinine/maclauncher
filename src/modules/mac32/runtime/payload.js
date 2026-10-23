const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");
const MachO = require("../../shared/runtime/macho-load-commands");
const Host = require("../../shared/runtime/bundled-native");

const GUEST_LIBRARIES = Object.freeze(["libmac32rt.dylib", "libmac32cxx.dylib", "libmac32cxx2.dylib", "libmac32ios.dylib"]);
const executableRelative = version => `mac32-${version}/Mac32.app/Contents/MacOS/mac32`;
const requiredFiles = version => [executableRelative(version),
  ...GUEST_LIBRARIES.map(name => `mac32-${version}/Mac32.app/Contents/MacOS/guest/${name}`),
  `mac32-${version}/COPYING`, `mac32-${version}/NOTICE`];

function payloadPath(root, relative) {
  if (!path.isAbsolute(root || "") || path.isAbsolute(relative) || relative.split("/").includes(".."))
    throw new Error("mac32 requires its managed installation folder.");
  let current = root;
  for (const part of ["", ...relative.split("/")]) {
    if (part) current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("mac32 runtime files cannot be symbolic links.");
  }
  if (!fs.lstatSync(current).isFile()) throw new Error("A required mac32 runtime file is missing.");
  return current;
}

function inspectPayload(root, version, { signal } = {}) {
  const executable = payloadPath(root, executableRelative(version));
  const host = MachO.readMachOLoadCommands(executable, { signal });
  MachO.assertSystemLibraryClosure(host, { fileType: 2 });
  if (!host.architectures.includes("x86_64")) throw new Error("mac32 requires its 64-bit Intel Mac executable.");
  const minimumMacOS = host.slices.map(slice => slice.minimumMacOS).sort((a, b) => Host.versionAtLeast(a, b) ? -1 : 1)[0];
  for (const name of GUEST_LIBRARIES) {
    const file = payloadPath(root, `mac32-${version}/Mac32.app/Contents/MacOS/guest/${name}`);
    const guest = MachO.readMachOLoadCommands(file, { signal, architecture: "i386" });
    if (guest.slices.some(slice => slice.wordSize !== 32 || slice.fileType !== 6))
      throw new Error("mac32 requires its matching 32-bit guest libraries.");
  }
  return { minimumMacOS, architectures: host.architectures };
}

function preparePayload({ unpacked, pin, signal }, { systemVersionSync = Host.systemVersionSync } = {}) {
  const info = inspectPayload(unpacked, pin.version, { signal });
  if (!Host.versionAtLeast(systemVersionSync(), info.minimumMacOS)) throw new Error(`mac32 ${pin.version} requires macOS ${info.minimumMacOS}.`);
  const files = requiredFiles(pin.version).map(relativePath => {
    signal?.throwIfAborted();
    const target = payloadPath(unpacked, relativePath), stat = fs.statSync(target);
    return { relativePath, bytes: stat.size, sha256: Native.hashFile(target) };
  });
  return { schemaVersion: 1, interface: "mac32-app-v1", ...info, files };
}

function createPayloadResolver({ systemVersionSync = Host.systemVersionSync } = {}) {
  const cache = new Map();
  return function resolvePayload(install, { verification = "full" } = {}) {
    if (!install) return { install: null, reason: "mac32 is not installed." };
    let key;
    try {
      const metadata = install.installationMetadata, required = requiredFiles(install.version);
      if (metadata?.schemaVersion !== 1 || metadata.interface !== "mac32-app-v1" || !Array.isArray(metadata.files) ||
        JSON.stringify(metadata.files.map(file => file.relativePath)) !== JSON.stringify(required) ||
        metadata.files.some(file => !/^[a-f0-9]{64}$/.test(file.sha256 || "") || !Number.isSafeInteger(file.bytes) || file.bytes < 1))
        throw new Error("mac32 runtime registration is incomplete. Remove and install this version again.");
      const files = metadata.files.map(file => {
        const target = payloadPath(install.installDir, file.relativePath), stat = fs.statSync(target, { bigint: true });
        if (stat.size !== BigInt(file.bytes)) throw new Error("mac32 runtime files changed. Remove and install this version again.");
        return { ...file, target, identity: [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":") };
      });
      key = JSON.stringify([install.installDir, metadata, files.map(file => file.identity)]);
      let info = verification === "status" ? cache.get(key) : null;
      if (info?.error) throw new Error(info.error);
      if (!info) {
        info = inspectPayload(install.installDir, install.version);
        if (info.minimumMacOS !== metadata.minimumMacOS || JSON.stringify(info.architectures) !== JSON.stringify(metadata.architectures))
          throw new Error("mac32 runtime metadata no longer matches the installed files.");
        for (const file of files) if (Native.hashFile(file.target) !== file.sha256)
          throw new Error("mac32 runtime files changed. Remove and install this version again.");
        if (cache.size >= 64) cache.delete(cache.keys().next().value);
        cache.set(key, info);
      }
      if (!Host.versionAtLeast(systemVersionSync(), info.minimumMacOS))
        return { install: null, reason: `mac32 ${install.version} requires macOS ${info.minimumMacOS}.` };
      return { install: { ...install, minimumMacOS: info.minimumMacOS,
        guestDirectory: path.join(path.dirname(install.executablePath), "guest") }, reason: null };
    } catch (error) {
      if (key) { if (cache.size >= 64) cache.delete(cache.keys().next().value); cache.set(key, { error: error.message }); }
      return { install: null, reason: error.message };
    }
  };
}

module.exports = { GUEST_LIBRARIES, executableRelative, requiredFiles, payloadPath, inspectPayload, preparePayload, createPayloadResolver };

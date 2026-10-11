const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const Native = require("./local-native");
const run = promisify(execFile);

const LIMITS = Object.freeze({ manifestBytes: 8 * 1024 * 1024, files: 20000, fileBytes: 256 * 1024 * 1024, bytes: 1024 * 1024 * 1024 });
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const SHA = /^[a-f0-9]{64}$/;
// Display refreshes share parsed manifests, not payload verification results.
// Full install/launch verification always rereads every payload byte.
const manifestCache = new Map();
const MANIFEST_CACHE_LIMIT = 128;
let hostSystemVersion;

function fileIdentity(file, { maximum = LIMITS.fileBytes } = {}) {
  if (!realDirectory(path.dirname(file))) throw new Error("Bundled runtime directory is missing.");
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.size > BigInt(maximum)) throw new Error("Bundled runtime file is not regular or exceeds its limit.");
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(":");
}

function clearManifestCache(directory) {
  const root = directory && path.resolve(directory);
  for (const file of manifestCache.keys()) {
    if (!root || file === root || file.startsWith(root + path.sep)) manifestCache.delete(file);
  }
}

function readManifest(file, expected, { cached = false } = {}) {
  const absolute = path.resolve(file);
  const identity = cached ? fileIdentity(absolute, { maximum: LIMITS.manifestBytes }) : null;
  let stored = cached && manifestCache.get(absolute);
  if (!stored || stored.identity !== identity) {
    const content = readRegular(absolute, LIMITS.manifestBytes);
    const manifest = validateManifest(JSON.parse(content.bytes));
    stored = { identity, manifest, sha256: content.sha256 };
    if (cached) {
      // A write during the initial read must not populate a stale display entry.
      if (fileIdentity(absolute, { maximum: LIMITS.manifestBytes }) !== identity) throw new Error("Bundled runtime manifest changed while being read.");
      manifestCache.delete(absolute);
      if (manifestCache.size >= MANIFEST_CACHE_LIMIT) manifestCache.delete(manifestCache.keys().next().value);
      manifestCache.set(absolute, stored);
    }
  }
  const manifest = stored.manifest;
  if (expected?.managerId && manifest.managerId !== expected.managerId || expected?.version && manifest.version !== expected.version ||
      expected?.upstreamRevision && manifest.upstreamRevision !== expected.upstreamRevision || expected?.arch && manifest.arch !== expected.arch) {
    throw new Error("Bundled runtime version, source pin or architecture differs from the selected catalog entry.");
  }
  return stored;
}

function relativeFile(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || /[\x00-\x1f]/.test(value) ||
      path.posix.isAbsolute(value) || value.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe bundled runtime file path.");
  return value;
}

function realDirectory(directory, { create = false } = {}) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return false;
      fs.mkdirSync(current, { mode: 0o700 });
      stat = fs.lstatSync(current);
    }
    // macOS presents its system temporary directories through these aliases.
    if (process.platform === "darwin" && ["/tmp", "/var"].includes(current) && stat.isSymbolicLink()) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Bundled runtime directories cannot use symlinks.");
  }
  return true;
}

function readRegular(file, maximum) {
  if (!realDirectory(path.dirname(file))) throw new Error("Bundled runtime directory is missing.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error("Bundled runtime file is not regular or exceeds its limit.");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("Bundled runtime changed while being read.");
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error("Bundled runtime changed while being read.");
    return { bytes, size: bytes.length, sha256: digest(bytes), mode: stat.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}

function validateManifest(manifest, { managerId, version, upstreamRevision, arch } = {}) {
  if (manifest?.schemaVersion !== 1 || !/^[a-z0-9-]+$/.test(manifest.managerId || "") ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.version || "") || !/^[a-f0-9]{40}$/.test(manifest.upstreamRevision || "") ||
      manifest.platform !== "darwin" || !["arm64", "x64"].includes(manifest.arch) ||
      !/^\d+\.\d+(?:\.\d+)?$/.test(manifest.minimumMacOS || "") ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > LIMITS.files ||
      !Array.isArray(manifest.notices) || !manifest.notices.length ||
      manifest.provenance?.sourceRevision !== manifest.upstreamRevision || !Array.isArray(manifest.dependencies)) throw new Error("Invalid bundled runtime manifest.");
  if (managerId && manifest.managerId !== managerId || version && manifest.version !== version ||
      upstreamRevision && manifest.upstreamRevision !== upstreamRevision || arch && manifest.arch !== arch) throw new Error("Bundled runtime version, source pin or architecture differs from the selected catalog entry.");
  relativeFile(manifest.executableRelative);
  const names = new Set(), filesByPath = new Map(), directories = new Set();
  let total = 0;
  for (const file of manifest.files) {
    relativeFile(file.path);
    const key = file.path.normalize("NFC").toLowerCase();
    if (names.has(key) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > LIMITS.fileBytes ||
        !SHA.test(file.sha256 || "") || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777 ||
        file.architectures && (!Array.isArray(file.architectures) || !file.architectures.length || file.architectures.some(value => !["arm64", "x86_64"].includes(value)))) throw new Error("Invalid bundled runtime file record.");
    names.add(key);
    filesByPath.set(file.path, file);
    for (let directory = path.posix.dirname(file.path); directory !== "."; directory = path.posix.dirname(directory)) directories.add(directory);
    total += file.size;
    if (total > LIMITS.bytes) throw new Error("Bundled runtime exceeds its size limit.");
  }
  const executable = filesByPath.get(manifest.executableRelative);
  if (!executable || !(executable.mode & 0o111) || !executable.architectures?.includes(manifest.arch === "x64" ? "x86_64" : "arm64")) throw new Error("Bundled runtime has no matching executable.");
  for (const notice of manifest.notices) {
    if (!notice || typeof notice.name !== "string" || !notice.name || typeof notice.license !== "string" || !notice.license ||
        !/^https:\/\//.test(notice.sourceUrl || "") || !filesByPath.has(relativeFile(notice.path))) throw new Error("Bundled runtime license notice is missing.");
  }
  for (const dependency of manifest.dependencies) {
    if (!dependency || !filesByPath.has(relativeFile(dependency.file)) ||
        !Array.isArray(dependency.links) || dependency.links.some(link => typeof link !== "string" || !(
          link.startsWith("/usr/lib/") || link.startsWith("/System/Library/") || link.startsWith("@loader_path/")))) throw new Error("Bundled runtime dependency closure is invalid.");
    for (const link of dependency.links.filter(link => link.startsWith("@loader_path/"))) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(dependency.file), link.slice("@loader_path/".length)));
      relativeFile(resolved);
      if (!filesByPath.has(resolved)) throw new Error("Bundled runtime dependency is missing from its package.");
    }
  }
  for (const [key, value] of Object.entries(manifest.environmentRelative || {})) {
    if (!["PYTHONHOME", "PYTHONPATH"].includes(key) || !directories.has(relativeFile(value))) throw new Error("Bundled runtime environment directory is invalid.");
  }
  for (const [key, value] of Object.entries(manifest.runtimeFiles || {})) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,50}$/.test(key) || !filesByPath.has(relativeFile(value))) throw new Error("Bundled runtime asset file is invalid.");
  }
  return manifest;
}

function fileInventory(root) {
  const files = [];
  function walk(relative, depth) {
    if (depth > 32) throw new Error("Bundled runtime directory nesting exceeds its limit.");
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = relativeFile(path.posix.join(relative, entry.name));
      if (entry.isSymbolicLink()) throw new Error("Bundled runtime packages cannot contain symlinks.");
      if (entry.isDirectory()) walk(name, depth + 1);
      else if (entry.isFile()) files.push(name);
      else throw new Error("Bundled runtimes may contain only regular files and directories.");
      if (files.length > LIMITS.files) throw new Error("Bundled runtime has too many files.");
    }
  }
  if (!realDirectory(root)) throw new Error("Bundled runtime payload is missing.");
  walk("", 0);
  return files.sort();
}

function verifyPayload(root, manifest) {
  const expected = manifest.files.map(file => file.path).sort();
  if (JSON.stringify(fileInventory(root)) !== JSON.stringify(expected)) throw new Error("Bundled runtime file inventory differs from its manifest.");
  for (const file of manifest.files) {
    const full = path.join(root, file.path);
    const actual = readRegular(full, file.size);
    if (actual.size !== file.size || actual.sha256 !== file.sha256 || actual.mode !== file.mode) throw new Error(`Bundled runtime checksum or permissions changed: ${file.path}`);
    if (file.architectures && JSON.stringify(Native.readMachOArchitectures(full, { allowLibrary: true }).sort()) !== JSON.stringify([...file.architectures].sort())) throw new Error(`Bundled runtime Mach-O architecture changed: ${file.path}`);
  }
  return true;
}

function bundledManifestPath(install) {
  if (typeof install?.installDir !== "string" || !path.isAbsolute(install.installDir)) throw new Error("Invalid bundled runtime root.");
  return path.join(install.installDir, install.bundledExecution === "direct" ? "manifest.json" : "bundle-manifest.json");
}

function verifyInstalled({ installDir, record, pin, managerId, verification = "full" }) {
  try {
    if (!["full", "status"].includes(verification)) return false;
    const stored = readManifest(bundledManifestPath({ ...record, installDir }),
      { managerId, version: record.version, upstreamRevision: pin.upstreamRevision }, { cached: verification === "status" });
    if (!SHA.test(record.bundledManifestSha256 || "") || stored.sha256 !== record.bundledManifestSha256) return false;
    const manifest = stored.manifest;
    if (record.source !== "bundled" || record.version !== manifest.version ||
        record.bundledExecution === "direct" && (record.readOnly !== true || record.removable !== false) ||
        record.executableRelative !== `files/${manifest.executableRelative}` ||
        record.binarySha256 !== manifest.files.find(file => file.path === manifest.executableRelative).sha256) return false;
    const expectedEnvironment = Object.fromEntries(Object.entries(manifest.environmentRelative || {}).map(([key, value]) => [key, `files/${value}`]));
    if (JSON.stringify(record.environmentRelative || {}) !== JSON.stringify(expectedEnvironment)) return false;
    const expectedFiles = Object.fromEntries(Object.entries(manifest.runtimeFiles || {}).map(([key, value]) => [key, `files/${value}`]));
    if (JSON.stringify(record.runtimeFiles || {}) !== JSON.stringify(expectedFiles)) return false;
    if (verification === "full") return verifyPayload(path.join(installDir, "files"), manifest);
    // getState is a display operation. Verify the sealed record and primary
    // executable metadata here; launches and explicit refresh check the closure.
    const executable = manifest.files.find(file => file.path === manifest.executableRelative);
    const file = path.join(installDir, "files", executable.path);
    fileIdentity(file, { maximum: executable.size });
    const stat = fs.lstatSync(file);
    return stat.size === executable.size && (stat.mode & 0o777) === executable.mode;
  } catch { return false; }
}

function versionAtLeast(actual, required) {
  const left = String(actual).split(".").map(Number), right = String(required).split(".").map(Number);
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0);
  }
  return true;
}

async function verifySignatures(root, manifest, { signal } = {}) {
  for (const file of manifest.files.filter(file => file.architectures)) {
    await run("/usr/bin/codesign", ["--verify", "--strict", path.join(root, file.path)], { ...(signal ? { signal } : {}), timeout: 30000, maxBuffer: 1024 * 1024 });
  }
}

function verifySignaturesSync(root, manifest) {
  for (const file of manifest.files.filter(file => file.architectures)) {
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", path.join(root, file.path)], { timeout: 30000, stdio: "pipe", maxBuffer: 1024 * 1024 });
  }
}

function systemVersionSync() {
  if (!hostSystemVersion) hostSystemVersion = execFileSync("/usr/bin/sw_vers", ["-productVersion"], { timeout: 10000, encoding: "utf8" }).trim();
  return hostSystemVersion;
}

function createBundledNativeRuntime({ managerId, resourceRoot, platform = process.platform, arch = process.arch, dependencies = {} } = {}) {
  if (!/^[a-z0-9-]+$/.test(managerId || "")) throw new Error("Bundled runtime needs a safe manager id.");
  const roots = resourceRoot ? [path.resolve(resourceRoot)] : [process.resourcesPath && path.join(process.resourcesPath, "native-runtimes"),
    path.resolve(__dirname, "../../../resources/native-runtimes")].filter(Boolean);
  const signatureCache = new Map();
  function resolve({ version, upstreamRevision, arch: selectedArch = arch, verification = "status" } = {}) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version || "") || !["arm64", "x64"].includes(selectedArch)) throw new Error("Choose a safe explicit bundled runtime version and architecture.");
    for (const root of roots) {
      // Versioned resources coexist; older app builds retain manager/arch.
      for (const directory of [path.join(root, managerId, version, selectedArch), path.join(root, managerId, selectedArch)]) {
        let stored;
        try { stored = readManifest(path.join(directory, "manifest.json"), undefined, { cached: verification === "status" }); }
        catch (error) { if (!fs.existsSync(directory)) continue; throw new Error(`Bundled ${managerId} manifest is missing or unreadable: ${error.message}`); }
        const manifest = stored.manifest;
        if (manifest.version !== version) {
          if (directory === path.join(root, managerId, version, selectedArch)) throw new Error("Bundled runtime directory contains a different version.");
          continue;
        }
        if (manifest.managerId !== managerId || upstreamRevision && manifest.upstreamRevision !== upstreamRevision || manifest.arch !== selectedArch) throw new Error("Bundled runtime version, source pin or architecture differs from the selected catalog entry.");
        return { directory, manifest, manifestSha256: stored.sha256, version, source: "bundled", minimumMacOS: manifest.minimumMacOS };
      }
    }
    return null;
  }
  // Opt-in callers use these sealed resources in place. No registration or
  // writable runtime directory is created; game state belongs to userData.
  function resolveRuntime({ version, upstreamRevision, verification = "full" } = {}) {
    if (platform !== "darwin") return null;
    if (!["full", "status"].includes(verification)) throw new Error("Choose status or full bundled runtime verification.");
    const bundle = resolve({ version, upstreamRevision, verification });
    if (!bundle) return null;
    const manifest = bundle.manifest, payload = path.join(bundle.directory, "files");
    const hostVersion = (dependencies.systemVersionSync || systemVersionSync)();
    if (!versionAtLeast(hostVersion, manifest.minimumMacOS)) throw new Error(`${managerId} ${version} requires macOS ${manifest.minimumMacOS}; this Mac uses ${hostVersion}.`);
    const executable = manifest.files.find(file => file.path === manifest.executableRelative);
    const runtimePath = path.join(payload, executable.path), nativeArch = (dependencies.hostArch || process.arch) === "x64" ? "x86_64" : dependencies.hostArch || process.arch;
    const architectures = executable.architectures;
    const needsRosetta = nativeArch === "arm64" && !architectures.includes("arm64") && architectures.includes("x86_64");
    if (!architectures.includes(nativeArch) && !needsRosetta) throw new Error(`Runtime does not support this Mac's ${nativeArch} CPU.`);
    if (verification === "full") {
      verifyPayload(payload, manifest);
      // Full bytes are still checked before each execution. A successful
      // signature check can be reused only for those identical native files.
      const signatureKey = JSON.stringify([bundle.manifestSha256,
        manifest.files.filter(file => file.architectures).map(file => fileIdentity(path.join(payload, file.path)))]);
      if (signatureCache.get(payload) !== signatureKey) {
        (dependencies.verifySignaturesSync || verifySignaturesSync)(payload, manifest);
        if (signatureCache.size >= MANIFEST_CACHE_LIMIT) signatureCache.delete(signatureCache.keys().next().value);
        signatureCache.set(payload, signatureKey);
      }
      if (readRegular(path.join(bundle.directory, "manifest.json"), LIMITS.manifestBytes).sha256 !== bundle.manifestSha256)
        throw new Error("Bundled runtime manifest changed during verification.");
    } else {
      fileIdentity(runtimePath, { maximum: executable.size });
      const stat = fs.lstatSync(runtimePath);
      if (stat.size !== executable.size || (stat.mode & 0o777) !== executable.mode) throw new Error("Bundled runtime executable metadata changed.");
    }
    return Object.freeze({ version, runtimeVersion: version, upstreamRevision: manifest.upstreamRevision,
      runtimePath, executablePath: runtimePath, executableRelative: `files/${executable.path}`, installDir: bundle.directory,
      binarySha256: executable.sha256, sha256: executable.sha256, bundledManifestSha256: bundle.manifestSha256,
      source: "bundled", bundledExecution: "direct", readOnly: true, removable: false,
      architectures: Object.freeze([...architectures]), needsRosetta, minimumMacOS: manifest.minimumMacOS,
      provenanceVerified: manifest.provenance.verifiedBuild === true, buildProvenance: structuredClone(manifest.provenance),
      environmentRelative: Object.freeze(Object.fromEntries(Object.entries(manifest.environmentRelative || {}).map(([key, value]) => [key, `files/${value}`]))),
      runtimeFiles: Object.freeze(Object.fromEntries(Object.entries(manifest.runtimeFiles || {}).map(([key, value]) => [key, `files/${value}`]))) });
  }
  async function install({ manager, userDataDir, version, signal, onProgress, logger } = {}) {
    if (platform !== "darwin") throw new Error("Bundled native runtimes require macOS.");
    const pin = manager.core.catalog.find(entry => entry.version === version);
    if (!pin) throw new Error("Choose an explicit pinned runtime version.");
    const bundle = resolve({ version, upstreamRevision: pin.upstreamRevision, verification: "full" });
    if (!bundle) return null;
    signal?.throwIfAborted();
    const hostVersion = dependencies.systemVersion ? await dependencies.systemVersion() : (await run("/usr/bin/sw_vers", ["-productVersion"], { ...(signal ? { signal } : {}), timeout: 10000 })).stdout.trim();
    if (!versionAtLeast(hostVersion, bundle.manifest.minimumMacOS)) throw new Error(`${managerId} ${version} requires macOS ${bundle.manifest.minimumMacOS}; this Mac uses ${hostVersion}.`);
    verifyPayload(path.join(bundle.directory, "files"), bundle.manifest);
    const destination = manager.core.getInstallDir({ userDataDir, version });
    const parent = path.dirname(destination);
    realDirectory(parent, { create: true });
    if (fs.existsSync(destination)) throw new Error(`Remove the incomplete ${managerId} ${version} installation before reinstalling.`);
    const staging = fs.mkdtempSync(path.join(parent, ".bundle-install-"));
    try {
      for (const [index, file] of bundle.manifest.files.entries()) {
        signal?.throwIfAborted();
        const source = path.join(bundle.directory, "files", file.path);
        const target = path.join(staging, "files", file.path);
        realDirectory(path.dirname(target), { create: true });
        const content = readRegular(source, file.size);
        if (content.sha256 !== file.sha256 || content.size !== file.size) throw new Error("Bundled runtime changed during installation.");
        fs.writeFileSync(target, content.bytes, { flag: "wx", mode: file.mode });
        fs.chmodSync(target, file.mode);
        onProgress?.({ phase: "copy", percent: Math.floor((index + 1) / bundle.manifest.files.length * 90) });
      }
      const serialized = readRegular(path.join(bundle.directory, "manifest.json"), LIMITS.manifestBytes);
      if (serialized.sha256 !== bundle.manifestSha256) throw new Error("Bundled runtime manifest changed during installation.");
      fs.writeFileSync(path.join(staging, "bundle-manifest.json"), serialized.bytes, { flag: "wx", mode: 0o600 });
      verifyPayload(path.join(staging, "files"), bundle.manifest);
      await (dependencies.verifySignatures || verifySignatures)(path.join(staging, "files"), bundle.manifest, { signal });
      const executable = bundle.manifest.files.find(file => file.path === bundle.manifest.executableRelative);
      fs.writeFileSync(path.join(staging, "runtime.json"), JSON.stringify({ version, upstreamRevision: pin.upstreamRevision,
        executableRelative: `files/${bundle.manifest.executableRelative}`, binarySha256: executable.sha256,
        source: "bundled", bundledManifestSha256: bundle.manifestSha256,
        provenanceVerified: bundle.manifest.provenance.verifiedBuild === true,
        environmentRelative: Object.fromEntries(Object.entries(bundle.manifest.environmentRelative || {}).map(([key, value]) => [key, `files/${value}`])),
        runtimeFiles: Object.fromEntries(Object.entries(bundle.manifest.runtimeFiles || {}).map(([key, value]) => [key, `files/${value}`])),
        buildProvenance: bundle.manifest.provenance, minimumMacOS: bundle.manifest.minimumMacOS,
        installedAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      signal?.throwIfAborted();
      // Recheck the owned parent before publishing the fully verified tree.
      realDirectory(parent);
      if (fs.existsSync(destination)) throw new Error("A runtime installation appeared during bundle copy. Retry after removing it.");
      fs.renameSync(staging, destination);
      const installed = manager.core.resolveInstalled({ userDataDir, version });
      if (!installed) { fs.rmSync(destination, { recursive: true, force: true }); throw new Error("Copied bundled runtime failed its installed integrity check."); }
      logger?.info?.(`[runtime] installed bundled ${managerId} ${version}`);
      onProgress?.({ phase: "ready", percent: 100 });
      return installed;
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  const isResourcePath = value => typeof value === "string" && roots.some(root => {
    const directory = path.join(root, managerId), file = path.resolve(value);
    return file === directory || file.startsWith(directory + path.sep) || directory.startsWith(file + path.sep);
  });
  return { resolve, resolveRuntime, install, isResourcePath, clearCache: directory => {
    clearManifestCache(directory);
    for (const root of signatureCache.keys()) if (!directory || root.startsWith(path.resolve(directory) + path.sep)) signatureCache.delete(root);
  }, verifyInstalled: options => {
    if (options.record?.bundledExecution === "direct") {
      try {
        const bundle = resolve({ version: options.record.version, upstreamRevision: options.pin.upstreamRevision, verification: options.verification });
        if (!bundle || path.resolve(options.installDir) !== bundle.directory) return false;
      } catch { return false; }
    }
    return verifyInstalled({ ...options, managerId });
  } };
}

function resolveInstalledEnvironment(install) {
  const result = {};
  for (const [key, value] of Object.entries(install?.environmentRelative || {})) {
    if (!["PYTHONHOME", "PYTHONPATH"].includes(key) || typeof install?.installDir !== "string" || !path.isAbsolute(install.installDir)) throw new Error("Invalid installed runtime environment.");
    const directory = path.join(install.installDir, relativeFile(value));
    if (!directory.startsWith(path.resolve(install.installDir) + path.sep) || !realDirectory(directory)) throw new Error("Installed runtime environment directory is missing or unsafe.");
    result[key] = directory;
  }
  return result;
}

function resolveInstalledAsset(install, name) {
  const value = install?.runtimeFiles?.[name];
  if (value === undefined) return null;
  if (typeof install?.installDir !== "string" || !path.isAbsolute(install.installDir)) throw new Error("Invalid installed runtime asset root.");
  const file = path.join(install.installDir, relativeFile(value));
  if (!realDirectory(path.dirname(file)) || !fs.lstatSync(file).isFile()) throw new Error("Installed runtime asset is missing or unsafe.");
  return file;
}

module.exports = { LIMITS, digest, relativeFile, realDirectory, readRegular, fileIdentity, clearManifestCache, validateManifest, verifyPayload,
  fileInventory, verifyInstalled, bundledManifestPath, versionAtLeast, systemVersionSync, createBundledNativeRuntime, resolveInstalledEnvironment, resolveInstalledAsset };

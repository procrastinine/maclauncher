const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");
const Bundled = require("../../shared/runtime/bundled-native");
const Catalog = require("../../shared/runtime/maclauncher-builds");

function requiredFiles(dotnetVersion) {
  return ["FNA.dll", "MacLauncherFnaHost.dll", "MacLauncherFnaHost.runtimeconfig.json",
  "native/lib/libSDL3.0.dylib", "native/lib/libFNA3D.0.dylib", "native/lib/libFAudio.0.dylib",
  `host/fxr/${dotnetVersion}/libhostfxr.dylib`, `shared/Microsoft.NETCore.App/${dotnetVersion}/libhostpolicy.dylib`,
  `shared/Microsoft.NETCore.App/${dotnetVersion}/libcoreclr.dylib`, `shared/Microsoft.NETCore.App/${dotnetVersion}/System.Private.CoreLib.dll`];
}

function verifyRuntime(install) {
  if (!install?.executablePath) throw new Error("FNA runtime is not installed.");
  const root = path.dirname(install.executablePath);
  const profilePath=install.runtimeFiles?.fnaProfile || install.runtimeFiles?.profile;
  const record = JSON.parse(Bundled.readRegular(profilePath ? path.join(install.installDir,Bundled.relativeFile(profilePath)) : path.join(root, "fna-runtime.json"),1024*1024).bytes);
  const project = install.source === "download" && install.catalogEntry?.projectPackage;
  if (install.source === "download") {
    if (Object.keys(record.files || {}).length > 128) throw new Error("FNA runtime profile exceeds its file limit.");
    for (const relative of Object.keys(record.files || {})) Bundled.relativeFile(relative);
    const host=install.runtimeFiles?.managedHost;
    return {root,...record,...(host?{hostPath:path.join(install.installDir,Bundled.relativeFile(host))}:{}),
      sourceIdentity:Catalog.sourceIdentity(project,{manifest:install.manifest || record,receiptRevision:install.upstreamRevision})};
  }
  if (typeof record.profile !== "string" || !record.profile ||
      !/^\d+\.\d+\.\d+$/.test(record.dotnetVersion || "") || !/^\d+(?:\.\d+){1,3}$/.test(record.frameworkVersion || "") ||
      !["arm64", "x64"].includes(record.architecture) ||
      !record.files || Array.isArray(record.files) || Object.keys(record.files).length > 128) throw new Error("FNA runtime profile metadata is invalid.");
  let sealedManifest, sealedPayload;
  if (install.source === "custom" && install.manifest) {
    sealedManifest = Bundled.validateRuntimeManifest(install.manifest, { managerId: "fna", arch: record.architecture });
    sealedPayload = install.payloadRoot;
    Bundled.verifyPayload(sealedPayload, sealedManifest);
  } else if (install.source === "bundled") {
    // Distribution relocation and signing change native bytes. The sealed
    // whole-payload manifest binds those final bytes, the original profile
    // metadata and its source identity; do not trust stale pre-relocation hashes.
    if (!Bundled.verifyInstalled({ installDir: install.installDir, record: install,
      pin: { upstreamRevision: record.upstreamRevision }, managerId: "fna" })) throw new Error("FNA bundled runtime inventory failed its integrity check.");
    sealedManifest = JSON.parse(fs.readFileSync(Bundled.bundledManifestPath(install), "utf8"));
    sealedPayload = path.join(install.installDir, "files");
  }
  if (sealedManifest) {
    const prefix = path.relative(sealedPayload, root).split(path.sep).join("/");
    if (path.isAbsolute(prefix) || prefix === ".." || prefix.startsWith("../")) throw new Error("FNA runtime escaped its package.");
    const finalFiles = new Map(sealedManifest.files.map(file => [file.path, file.sha256]));
    record.files = Object.fromEntries(Object.keys(record.files).map(relative => [relative, finalFiles.get((prefix ? prefix + "/" : "") + relative)]));
  }
  for (const required of requiredFiles(record.dotnetVersion)) {
    if (!record.files[required]) throw new Error("FNA runtime is incomplete.");
  }
  for (const [relative, checksum] of Object.entries(record.files)) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..") || !/^[a-f0-9]{64}$/.test(checksum) ||
      Native.hashFile(path.join(root, relative)) !== checksum) throw new Error("FNA runtime file integrity check failed.");
  }
  return { root, ...record, sourceIdentity: Catalog.sourceIdentity(project, {manifest: sealedManifest, receiptRevision: install.upstreamRevision}) };
}


function requireOriginalGamePaths(profile) {
  if (profile?.capabilities?.originalGamePaths !== true) {
    const error = new Error("An updated FNA runtime is required to run from the original game directory.");
    error.code = "FNA_RUNTIME_UPDATE_REQUIRED";
    throw error;
  }
  return profile;
}

module.exports = { verifyRuntime, requiredFiles, requireOriginalGamePaths };

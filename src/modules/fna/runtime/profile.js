const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");
const Bundled = require("../../shared/runtime/bundled-native");

function requiredFiles(dotnetVersion) {
  return ["FNA.dll", "MacLauncherFnaHost.dll", "MacLauncherFnaHost.runtimeconfig.json",
  "native/lib/libSDL3.0.dylib", "native/lib/libFNA3D.0.dylib", "native/lib/libFAudio.0.dylib",
  `host/fxr/${dotnetVersion}/libhostfxr.dylib`, `shared/Microsoft.NETCore.App/${dotnetVersion}/libhostpolicy.dylib`,
  `shared/Microsoft.NETCore.App/${dotnetVersion}/libcoreclr.dylib`, `shared/Microsoft.NETCore.App/${dotnetVersion}/System.Private.CoreLib.dll`];
}

function verifyRuntime(install) {
  if (!install?.executablePath) throw new Error("FNA runtime is not installed.");
  const root = path.dirname(install.executablePath);
  const record = JSON.parse(fs.readFileSync(path.join(root, "fna-runtime.json"), "utf8"));
  if (typeof record.profile !== "string" || !record.profile || !/^[a-f0-9]{40}$/.test(record.upstreamRevision || "") ||
      !/^\d+\.\d+\.\d+$/.test(record.dotnetVersion || "") || !/^\d+(?:\.\d+){1,3}$/.test(record.frameworkVersion || "") ||
      record.architecture !== "arm64" || record.upstreamRevision !== install.upstreamRevision ||
      !record.files || Array.isArray(record.files) || Object.keys(record.files).length > 128) throw new Error("FNA runtime profile metadata is invalid.");
  let sealedManifest, sealedPayload;
  if (install.source === "custom" && install.manifest) {
    sealedManifest = Bundled.validateManifest(install.manifest, { managerId: "fna", upstreamRevision: record.upstreamRevision, arch: "arm64" });
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
  } else if (install.source === "download" && install.catalogEntry?.projectPackage) {
    const selected = install.catalogEntry.projectPackage;
    if (selected.id !== "fna" || selected.version !== install.version || selected.source?.revision && selected.source.revision !== record.upstreamRevision || selected.manifestRelative !== "manifest.json")
      throw new Error("FNA runtime package identity is invalid.");
    const directory = path.join(install.installDir, "project-payload");
    const sealed = Bundled.readRegular(path.join(directory, selected.manifestRelative), Bundled.LIMITS.manifestBytes);
    const manifest = Bundled.validateManifest(JSON.parse(sealed.bytes), {
      managerId: "fna", version: selected.version, upstreamRevision: record.upstreamRevision, arch: "arm64"
    });
    if (sealed.sha256 !== selected.manifestSha256) throw new Error("FNA runtime package manifest changed.");
    sealedPayload = path.join(directory, "files");
    Bundled.verifyPayload(sealedPayload, manifest);
    sealedManifest = manifest;
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
  return { root, ...record };
}


module.exports = { verifyRuntime, requiredFiles };

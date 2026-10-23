const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Archive = require("./archive");
const MachO = require("./macho");
function plist(bytes) {
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], { input: bytes, timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("IPA Info.plist is invalid.");
  const value = JSON.parse(result.stdout.toString());
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("IPA Info.plist is not a dictionary.");
  return value;
}
function inspectArchive(archive) {
  const apps = archive.entries.filter(e => /^Payload\/[^/]+\.app\/Info\.plist$/.test(e.name));
  if (apps.length !== 1) throw new Error("An IPA must contain exactly one application in Payload.");
  const appPrefix = apps[0].name.slice(0, -"Info.plist".length), info = plist(archive.read(apps[0].name));
  const executable = info.CFBundleExecutable, bundleId = info.CFBundleIdentifier;
  if (typeof executable !== "string" || !executable || executable.length > 255 || /[\/\\:\x00-\x1f]/.test(executable) || [".", ".."].includes(executable)) throw new Error("IPA executable name is invalid.");
  if (typeof bundleId !== "string" || bundleId.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(bundleId)) throw new Error("IPA application identifier is invalid.");
  const binary = MachO.inspect(archive.read(appPrefix + executable, 512 * 1024 * 1024));
  if (binary.fileType !== 2) throw new Error("IPA main binary is not an executable.");
  return { info, appPrefix, executable, bundleId, label: info.CFBundleDisplayName || info.CFBundleName || bundleId,
    version: String(info.CFBundleShortVersionString || info.CFBundleVersion || ""), encrypted: binary.encrypted,
    minimumIOS: String(info.MinimumOSVersion || ""), architecture: "arm64",
    compatibility: binary.encrypted ? "Encrypted executable; an unencrypted IPA is required." : "Unencrypted ARM64; app compatibility varies." };
}
function inspectIpa(file) { const archive = Archive.open(file); try { return inspectArchive(archive); } finally { archive.close(); } }
function detectGame(context) {
  const file = context?.inputPath;
  if (typeof file !== "string" || !path.isAbsolute(file) || !/\.ipa$/i.test(file)) return null;
  try {
    const info = inspectIpa(file);
    return { gameType: "scripted", engine: "ios", gamePath: file, contentRootDir: path.dirname(file), name: info.label,
      moduleData: { bundleId: info.bundleId, detectedVersion: info.version, architecture: info.architecture, encrypted: info.encrypted, compatibility: info.compatibility },
      detectionEvidence: [{ type: "ios-package", path: file }, { type: "selected-artifact", path: file }] };
  } catch { return null; }
}
module.exports = { plist, inspectArchive, inspectIpa, detectGame };

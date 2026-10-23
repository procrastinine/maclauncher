const path = require("node:path");
const fs = require("node:fs");
const { inspectApk } = require("./apk");
const Package = require("./package-set");
const Abi = require("./provider-native-abi");

function result(file, metadata, packageSet = false) {
  return { gameType: "scripted", engine: "android", gamePath: file,
    contentRootDir: fs.statSync(file).isDirectory() ? file : path.dirname(file),
    name: metadata.label || path.basename(file, path.extname(file)),
    moduleData: { packageName: metadata.packageName, detectedName: metadata.label || path.basename(file, path.extname(file)), detectedVersion: metadata.versionName || String(metadata.versionCode || ""),
      architectures: metadata.architectures, launcherActivity: metadata.launchers[0]?.activity || null,
      limitations: metadata.limitations, ...(packageSet ? { packageSet: true } : {}) },
    detectionEvidence: [{ type: "android-package", path: file, packageName: metadata.packageName },
      { type: "selected-artifact", path: file }] };
}

function detectGame(context) {
  const file = context?.inputPath;
  if (typeof file !== "string" || !path.isAbsolute(file)) return null;
  try {
    const profile = Abi.installedProfile();
    if (fs.lstatSync(file).isDirectory()) {
      const selected = Package.inspectFiles(Package.directFiles(file), { profile });
      return result(selected.base.file, selected.metadata, true);
    }
    if (!/\.apk$/i.test(file)) return null;
    const metadata = inspectApk(file, { nativeArchitectures: Abi.supported(profile) });
    const files = Package.directFiles(file);
    if (files.length > 1 || metadata.split || metadata.requiresSplitInstallation || metadata.requiredSplits.length) {
      const selected = Package.inspectFiles(files, { profile });
      return result(selected.base.file, selected.metadata, true);
    }
    return result(file, metadata);
  } catch { return null; }
}

async function detectGameAsync(context) {
  const file = context?.inputPath;
  if (typeof file !== "string" || !path.isAbsolute(file) || !Package.ARCHIVES.test(file)) return detectGame(context);
  try { return result(file, (await Package.inspectInput(file, { profile: Abi.installedProfile() })).metadata, true); } catch { return null; }
}

module.exports = { detectGame, detectGameAsync };

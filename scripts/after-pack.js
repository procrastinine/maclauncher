const fs = require("node:fs");
const path = require("node:path");

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function removeIfExists(p) {
  if (!exists(p)) return false;
  fs.rmSync(p, { recursive: true, force: true });
  return true;
}

function moveRootFileIntoResources(appPath, name) {
  const src = path.join(appPath, name);
  if (!exists(src)) return false;

  const dest = path.join(appPath, "Contents", "Resources", name);
  ensureDir(path.dirname(dest));
  if (exists(dest)) {
    fs.rmSync(src, { force: true });
    return true;
  }
  fs.renameSync(src, dest);
  return true;
}

function listDirectories(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

function listAppBundles(root) {
  return listDirectories(root)
    .filter(name => name.toLowerCase().endsWith(".app"))
    .map(name => path.join(root, name));
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const resourcesPath = path.join(appPath, "Contents", "Resources");

  // Drop the redundant Z-universal.app copy from extraResources.
  removeIfExists(path.join(resourcesPath, "Z-universal.app"));

  const mkxpzRoot = path.join(
    resourcesPath,
    "app.asar.unpacked",
    "src",
    "modules",
    "rgss",
    "resources",
    "mkxpz"
  );

  const licenseName = "LICENSE.mkxp-z-with-https.txt";
  for (const versionName of listDirectories(mkxpzRoot)) {
    const versionDir = path.join(mkxpzRoot, versionName);
    for (const appBundle of listAppBundles(versionDir)) {
      // Keep bundle roots sealed to avoid codesign failures.
      moveRootFileIntoResources(appBundle, licenseName);
    }
  }
};

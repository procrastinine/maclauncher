const fs = require("node:fs"), path = require("node:path");
const Packages = require("./packages");
const { assertOwnDirectory } = require("../../shared/writable-input");

function keepReleases(directory, context) {
  assertOwnDirectory(context.userDataDir, directory, { create: false });
  const catalogFile = path.join(context.userDataDir, "android/services/catalog.json");
  const services = context.readJson(catalogFile, 4 * 1024 * 1024);
  // Never salvage or mutate account/app metadata during upkeep.
  if (fs.existsSync(catalogFile) && (services?.schemaVersion !== 1 || !Array.isArray(services.packages))) return () => true;
  let selected;
  try { selected = Packages.resolvePackages(context.userDataDir, { verification: "status" }); }
  catch { return () => true; }
  if (!selected) return () => true;
  const releases = new Map(Packages.installedReleases(context.userDataDir).map(row => [row.version, row]));
  const kept = new Set([selected.version]);
  for (const [version, row] of releases) {
    if (!Array.isArray(row.packages) || row.packages.length !== Packages.catalog.packages.length
        || Packages.catalog.packages.some(pin => row.packages.filter(item => item.packageName === pin.packageName).length !== 1)) { kept.add(version);continue; }
    for (const installed of services?.packages || []) {
      const component = row.packages.find(item => item.packageName === installed.packageName);
      if (!component) continue;
      // Installed service records identify their exact APK, independently of
      // release numbering. Account snapshots carry no release or APK pin.
      if (!/^[a-f0-9]{64}$/.test(installed.apkSha256 || "") || installed.apkSha256 === component.sha256) kept.add(version);
    }
  }
  return version => {
    const row = releases.get(version);
    if (!row || kept.has(version)) return true;
    try {
      assertOwnDirectory(context.userDataDir, row.root, { create: false });
      const record = path.join(row.root, "release.json");
      if (fs.existsSync(record)) {
        const stat = fs.lstatSync(record);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) return true;
      }
      const names = new Set(["release.json", ...row.packages.map(item => item.filename)]);
      if (row.packages.some(item => !/^[a-f0-9]{64}$/.test(item.sha256 || "") || !Number.isSafeInteger(item.bytes) || item.bytes <= 0
          || typeof item.filename !== "string" || path.basename(item.filename) !== item.filename)
          || fs.readdirSync(row.root).some(name => !names.has(name))) return true;
      for (const component of row.packages) {
        const stat = fs.lstatSync(path.join(row.root, component.filename));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== component.bytes) return true;
      }
      // No APK hashing or traversal of private Android app data.
      // Shared upkeep owns quiet-state and filesystem guards after this
      // metadata-only retention decision.
      return false;
    } catch { return true; }
  };
}

module.exports = { keepReleases };

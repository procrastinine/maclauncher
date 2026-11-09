const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");
const Bundled = require("../../shared/runtime/bundled-native");
const Catalog = require("../../shared/runtime/maclauncher-builds");
const { imageRequiresRosetta } = require("../../shared/runtime/architecture");
const { architectureSupport } = require("../../shared/runtime/host-capabilities");
const PROFILE = "siglus-rs-published-library-direct-host-v1";
const hash = Native.hashFile;

const verified = new Map();
function resolveProfile(install, { verification = "full" } = {}) {
  const project = install.catalogEntry?.projectPackage;
  const root = install.payloadRoot || path.dirname(path.dirname(install.executablePath));
  const declaredFile=(key,fallback)=>install.runtimeFiles?.[key]
    ? path.join(install.installDir,Bundled.relativeFile(install.runtimeFiles[key]))
    : path.join(root,Bundled.relativeFile(install.manifest?.runtimeFiles?.[key] || fallback));
  if (install.source==='download') {
    const library=declaredFile('siglusLibrary','lib/libsiglus.dylib');
    const file=declaredFile('siglusProfile','siglus-profile.json');
    const profile=fs.existsSync(file) ? JSON.parse(Bundled.readRegular(file,65536).bytes) : install.manifest?.profile || {};
    const manifestFile=path.join(install.root || path.join(install.installDir,'project-payload'),Bundled.relativeFile(project?.manifestRelative || 'manifest.json'));
    const manifest=install.manifest || (fs.existsSync(manifestFile) ? JSON.parse(Bundled.readRegular(manifestFile,Bundled.LIMITS.manifestBytes).bytes) : profile);
    const libraryArchitectures=Native.readMachOArchitectures(library,{allowLibrary:true});
    if (!libraryArchitectures.some(cpu=>architectureSupport(cpu).supported)) throw new Error("The Siglus library does not support this Mac's CPU.");
    return {...install,needsRosetta:imageRequiresRosetta(libraryArchitectures),libraryArchitectures,libraryPath:library,profile,
      sourceIdentity:Catalog.sourceIdentity(project,{manifest,receiptRevision:install.upstreamRevision})};
  }
  const profilePath=declaredFile('siglusProfile','siglus-profile.json');
  const identity = file => { const stat = fs.lstatSync(file, { bigint: true }); if (!stat.isFile()) throw new Error("Siglus native payload is missing."); return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"); };
  const library = path.join(root, "lib", "libsiglus.dylib"), key = [install.version, install.upstreamRevision, install.bundledManifestSha256,
    identity(profilePath), identity(library), identity(install.executablePath), identity(path.join(root, "LICENSE-siglus_rs.txt"))].join(";");
  if (verification === "status" && verified.get(root)?.key === key) return verified.get(root).value;
  if (fs.statSync(profilePath).size > 65536) throw new Error("Siglus profile exceeds its metadata limit.");
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  if (profile.schema !== 1 || profile.profile !== PROFILE || profile.version !== install.version) throw new Error("The installed Siglus profile has changed.");
  const files = Object.keys(profile.files || {});
  if (files.length !== 3 || !["bin/siglus-host", "lib/libsiglus.dylib", "LICENSE-siglus_rs.txt"].every(file => files.includes(file))) throw new Error("The installed Siglus payload is incomplete.");
  // A bundled runtime keeps one exact record, its sealed manifest.
  if (install.source === "bundled" && !Bundled.verifyInstalled({ installDir: install.installDir, record: install,
    pin: { upstreamRevision: install.upstreamRevision }, managerId: "siglus" })) throw new Error("The bundled Siglus inventory failed its integrity check.");
  for (const relative of files)
    if (!fs.realpathSync(path.join(root, relative)).startsWith(fs.realpathSync(root) + path.sep)) throw new Error("The installed Siglus payload has changed. Reinstall this version.");
  const libraryArchitectures = Native.readMachOArchitectures(library, { allowLibrary: true });
  const needsRosetta = imageRequiresRosetta(libraryArchitectures);
  if (!libraryArchitectures.some(cpu => architectureSupport(cpu).supported)) throw new Error("The Siglus library does not support this Mac's CPU. Reinstall this version.");
  const value = { ...install, needsRosetta, libraryArchitectures, libraryPath: library, profile, profileSha256: hash(profilePath),
    sourceIdentity: Catalog.sourceIdentity(project, {manifest: profile, receiptRevision: install.upstreamRevision}) };
  if (verified.size >= 32) verified.delete(verified.keys().next().value);
  verified.set(root, { key, value });
  return value;
}
module.exports = { resolveProfile, PROFILE };

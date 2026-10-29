const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");
const Bundled = require("../../shared/runtime/bundled-native");
const HOST = require("./host-profile.json");
const PROFILE = "siglus-rs-published-library-direct-host-v1";
const hash = Native.hashFile;

const verified = new Map();
function resolveProfile(install, { verification = "full" } = {}) {
  const root = path.dirname(path.dirname(install.executablePath)), profilePath = path.join(root, "siglus-profile.json");
  const project = install.catalogEntry?.projectPackage;
  const manifestPath = project && path.join(install.installDir, "project-payload", Bundled.relativeFile(project.manifestRelative));
  const nativeApi = project?.capabilities?.nativeApi ?? install.catalogEntry?.nativeApi;
  const identity = file => { const stat = fs.lstatSync(file, { bigint: true }); if (!stat.isFile()) throw new Error("Siglus native payload is missing."); return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"); };
  const library = path.join(root, "lib", "libsiglus.dylib"), key = [install.version, install.upstreamRevision, install.binarySha256, install.bundledManifestSha256,
    project && [project.manifestSha256, nativeApi, identity(manifestPath)].join(":"),
    identity(profilePath), identity(library), identity(install.executablePath), identity(path.join(root, "LICENSE-siglus_rs.txt"))].join(";");
  if (verification === "status" && verified.get(root)?.key === key) return verified.get(root).value;
  if (fs.statSync(profilePath).size > 65536) throw new Error("Siglus profile exceeds its metadata limit.");
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  const installation = install.installationMetadata || install.record?.installationMetadata;
  const hostIdentity = [HOST, ...(HOST.compatibleHosts || [])].find(host =>
    host.sourceSha256 === profile.hostSourceSha256 && host.sha256 === profile.files?.["bin/siglus-host"]);
  if (profile.schema !== 1 || profile.profile !== PROFILE || profile.version !== install.version || profile.upstreamRevision !== install.upstreamRevision ||
    (install.source === "download" && !project && profile.archiveSha256 !== install.archiveSha256) ||
    (project ? !/^[a-f0-9]{64}$/.test(profile.hostSourceSha256 || "") : !hostIdentity) ||
    (installation?.profileSha256 && hash(profilePath) !== installation.profileSha256)) throw new Error("The installed Siglus profile has changed.");
  let files = Object.entries(profile.files || {});
  if (files.length !== 3 || !["bin/siglus-host", "lib/libsiglus.dylib", "LICENSE-siglus_rs.txt"].every(file => Object.hasOwn(profile.files, file))) throw new Error("The installed Siglus payload is incomplete.");
  if (project) {
    // The selected Builds record binds this host revision and its profile.
    // Launcher host hashes identify only the retained nonmanaged route.
    if (project.id !== "siglus" || nativeApi !== "game_run_entry-v1") throw new Error("The Siglus package uses an unsupported native API.");
    const stored = Bundled.readRegular(manifestPath, Bundled.LIMITS.manifestBytes);
    if (stored.sha256 !== project.manifestSha256 || stored.mode !== 0o644) throw new Error("The installed Siglus package manifest has changed.");
    const manifest = Bundled.validateManifest(JSON.parse(stored.bytes), {
      managerId: "siglus", version: install.version, upstreamRevision: install.upstreamRevision, arch: project.arch
    });
    if (root !== path.join(install.installDir, "project-payload/files") || manifest.executableRelative !== "bin/siglus-host" ||
        manifest.runtimeFiles?.siglusProfile !== "siglus-profile.json" || manifest.runtimeFiles?.siglusLibrary !== "lib/libsiglus.dylib")
      throw new Error("The Siglus package uses an unsupported native layout.");
    const inventory = new Map(manifest.files.map(file => [file.path, file]));
    const profileFile = inventory.get("siglus-profile.json"), profileBytes = Bundled.readRegular(profilePath, 65536);
    if (!profileFile || profileFile.sha256 !== profileBytes.sha256 || profileFile.size !== profileBytes.size || profileFile.mode !== profileBytes.mode ||
        files.some(([relative, expected]) => inventory.get(relative)?.sha256 !== expected))
      throw new Error("The installed Siglus profile differs from its sealed package.");
  }
  if (install.source === "bundled") {
    // Distribution signing changes native bytes. The shared sealed manifest
    // binds final relocated bytes and the original profile/source evidence.
    if (!Bundled.verifyInstalled({ installDir: install.installDir, record: install,
      pin: { upstreamRevision: install.upstreamRevision }, managerId: "siglus" })) throw new Error("The bundled Siglus inventory failed its integrity check.");
    const sealed = JSON.parse(fs.readFileSync(Bundled.bundledManifestPath(install), "utf8"));
    const prefix = path.relative(path.join(install.installDir, "files"), root).split(path.sep).join("/");
    const hashes = new Map(sealed.files.map(file => [file.path, file.sha256]));
    files = files.map(([relative]) => [relative, hashes.get(prefix + "/" + relative)]);
  }
  for (const [relative, expected] of files) {
    const file = path.join(root, relative);
    if (!fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep) || !/^[a-f0-9]{64}$/.test(expected) || hash(file) !== expected) throw new Error("The installed Siglus payload has changed. Reinstall this version.");
  }
  const architecture = process.arch === "x64" ? "x86_64" : process.arch;
  const libraryArchitectures = Native.readMachOArchitectures(library, { allowLibrary: true });
  const needsRosetta = architecture === "arm64" && !libraryArchitectures.includes("arm64") && libraryArchitectures.includes("x86_64");
  if (!libraryArchitectures.includes(architecture) && !needsRosetta) throw new Error("The Siglus library does not support this Mac's CPU. Reinstall this version.");
  const value = { ...install, needsRosetta, libraryArchitectures, libraryPath: library, profile, profileSha256: hash(profilePath) };
  if (verified.size >= 32) verified.delete(verified.keys().next().value);
  verified.set(root, { key, value });
  return value;
}
module.exports = { resolveProfile, PROFILE, HOST };

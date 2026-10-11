const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Native = require("../../shared/runtime/local-native");
const Bundled = require("../../shared/runtime/bundled-native");
const MachO = require("../../shared/runtime/macho-load-commands");
const { inspectMachOExports } = require("../../shared/runtime/macho-exports");
const execFileAsync = promisify(execFile);
const HOST_ROOT = path.resolve(__dirname, "../resources/native-host");
const HOST = require("../resources/native-host/manifest.json");
const PROFILE = "siglus-rs-published-library-direct-host-v1";
const hash = Native.hashFile;

function hostResource() {
  const file = path.resolve(HOST_ROOT, HOST.path);
  if (!file.startsWith(HOST_ROOT + path.sep) || hash(file) !== HOST.sha256 || hash(path.join(HOST_ROOT, "host.m")) !== HOST.sourceSha256) throw new Error("The bundled Siglus host failed its integrity check.");
  return file;
}
async function prepareInstall({ unpacked, pin, signal }, dependencies = {}) {
  const run = dependencies.execFile || execFileAsync, app = pin.hostArchitectures?.includes("arm64") ? "Siglus-arm64.app" : "Siglus-x86_64.app";
  const original = path.join(unpacked, app, "Contents", "Frameworks", "libsiglus.dylib");
  const arch = pin.hostArchitectures?.includes("arm64") ? "arm64" : "x86_64";
  const realRoot = fs.realpathSync(unpacked), actual = fs.realpathSync(original);
  if (!actual.startsWith(realRoot + path.sep) || !Native.readMachOArchitectures(original, { allowLibrary: true }).includes(arch)) throw new Error("The Siglus archive does not contain the selected native library.");
  await run("/usr/bin/codesign", ["--verify", "--strict", original], { ...(signal ? { signal } : {}), timeout: 30000 });
  const image = MachO.assertSystemLibraryClosure(MachO.readMachOLoadCommands(original, { architecture: arch, signal }),
    { fileType: 6, installName: "@rpath/libsiglus.dylib" });
  const symbols = new Set(await inspectMachOExports(original, { arch }));
  if (!["game_run_entry", "game_probe_json", "game_string_free"].every(name => symbols.has(name))) throw new Error("This Siglus native library does not expose the direct host API.");
  if (signal?.aborted) { const error = new Error("Siglus installation cancelled."); error.name = "AbortError"; error.code = "ABORT_ERR"; throw error; }
  const dependencyPaths = [image.slices[0].installName.path, ...image.slices[0].dependencies.map(item => item.path)];
  const library = path.join(unpacked, "lib", "libsiglus.dylib"), host = path.join(unpacked, "bin", "siglus-host");
  fs.mkdirSync(path.dirname(library)); fs.mkdirSync(path.dirname(host));
  fs.renameSync(original, library); fs.copyFileSync(hostResource(), host); fs.chmodSync(host, 0o755);
  await run("/usr/bin/codesign", ["--verify", "--strict", host], { ...(signal ? { signal } : {}), timeout: 30000 });
  fs.rmSync(path.join(unpacked, app), { recursive: true, force: true });
  const licenseSource = path.resolve(__dirname, "../resources/LICENSE-siglus_rs.txt");
  fs.copyFileSync(licenseSource, path.join(unpacked, "LICENSE-siglus_rs.txt"));
  const record = { schema: 1, profile: PROFILE, version: pin.version, upstreamRevision: pin.upstreamRevision,
    archiveSha256: pin.asset.sha256, hostVersion: HOST.version, hostSourceSha256: HOST.sourceSha256,
    files: { "bin/siglus-host": hash(host), "lib/libsiglus.dylib": hash(library), "LICENSE-siglus_rs.txt": hash(path.join(unpacked, "LICENSE-siglus_rs.txt")) },
    architectures: Native.readMachOArchitectures(library, { allowLibrary: true }), dependencies: dependencyPaths, signature: "verified-upstream-ad-hoc" };
  const profilePath = path.join(unpacked, "siglus-profile.json");
  fs.writeFileSync(profilePath, JSON.stringify(record, null, 2) + "\n");
  return { profile: PROFILE, profileSha256: hash(profilePath), librarySha256: record.files["lib/libsiglus.dylib"], hostSourceSha256: HOST.sourceSha256 };
}

const verified = new Map();
function resolveProfile(install, { verification = "full" } = {}) {
  const root = path.dirname(path.dirname(install.executablePath)), profilePath = path.join(root, "siglus-profile.json");
  const identity = file => { const stat = fs.statSync(file, { bigint: true }); if (!stat.isFile()) throw new Error("Siglus native payload is missing."); return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"); };
  const library = path.join(root, "lib", "libsiglus.dylib"), key = [install.version, install.upstreamRevision, install.binarySha256, install.bundledManifestSha256,
    identity(profilePath), identity(library), identity(install.executablePath), identity(path.join(root, "LICENSE-siglus_rs.txt"))].join(";");
  if (verification === "status" && verified.get(root)?.key === key) return verified.get(root).value;
  if (fs.statSync(profilePath).size > 65536) throw new Error("Siglus profile exceeds its metadata limit.");
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  const installation = install.installationMetadata || install.record?.installationMetadata;
  if (profile.schema !== 1 || profile.profile !== PROFILE || profile.version !== install.version || profile.upstreamRevision !== install.upstreamRevision ||
    (install.source === "download" && profile.archiveSha256 !== install.archiveSha256) ||
    profile.hostSourceSha256 !== HOST.sourceSha256 || profile.files?.["bin/siglus-host"] !== HOST.sha256 ||
    (installation?.profileSha256 && hash(profilePath) !== installation.profileSha256)) throw new Error("The installed Siglus profile has changed.");
  let files = Object.entries(profile.files || {});
  if (files.length !== 3 || !["bin/siglus-host", "lib/libsiglus.dylib", "LICENSE-siglus_rs.txt"].every(file => Object.hasOwn(profile.files, file))) throw new Error("The installed Siglus payload is incomplete.");
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
module.exports = { prepareInstall, resolveProfile, hostResource, PROFILE, HOST };

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const execute = promisify(require("node:child_process").execFile);
const { createPinnedNativeManager } = require("../../../shared/runtime/pinned-native-manager");
const Catalog = require("./catalog");
const { readZipEntryBuffer } = require("../../../shared/runtime/zip");

const POLICY_VERSION = 1;
function materializePolicy(userDataDir) {
  const Writable = require("../../../shared/writable-input");
  const bytes = fs.readFileSync(require("../../included-files").file("providers/macapk/resources/privacy.jar")), digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const directory = path.join(userDataDir, "runtimes/macapk/policy");
  Writable.assertOwnDirectory(userDataDir, directory);
  const file = path.join(directory, digest + ".jar");
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !fs.readFileSync(file).equals(bytes)) throw new Error("The Android privacy adapter changed on disk.");
  } else Writable.atomicWrite(file, bytes, { root: directory });
  return file;
}
function bundleRoot(install) { return path.dirname(path.dirname(install.executablePath)); }
function runtimePaths(install) {
  const contents = bundleRoot(install);
  return { contents, app: path.dirname(contents), executable: install.executablePath,
    java: path.join(contents, "Resources/jre/bin/java"), framework: path.join(contents, "lib/android-framework.jar"),
    loader: path.join(contents, "lib/macapk-loader.jar") };
}
// Releases may move the application into a folder; the known path wins.
const RUNTIME = "Mac.apk.app/Contents/Resources/macapk-runtime";
function resolveExecutable(root) {
  const executable = require("../../../shared/runtime/release-files").locatePackaged(root, RUNTIME);
  if (!executable) throw new Error("The Mac.apk download does not contain its application bundle.");
  return executable;
}
// The application's own minimum system version is its macOS requirement.
function applicationRequirement(app) {
  const value = String(require("../../../shared/runtime/app-bundle").readInfoPlist(app)?.LSMinimumSystemVersion || "");
  return /^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(value) ? (value.includes(".") ? value : value + ".0") : undefined;
}
async function verifyPolicy(contents, { signal, run = execute } = {}) {
  const java = path.join(contents, "Resources/jre/bin/java"), lib = path.join(contents, "lib");
  // The provider must supply its actual framework and loader. Pure Java tools
  // intentionally skip Android adaptation, so they cannot validate an install.
  for (const [jar, entry] of [["android-framework.jar", "android/os/Build.class"], ["macapk-loader.jar", "com/macapk/loader/SharedStorage.class"]]) {
    const bytes = readZipEntryBuffer(path.join(lib, jar), entry);
    if (!bytes || bytes.length < 8 || bytes.readUInt32BE(0) !== 0xcafebabe)
      throw new Error("The Mac.apk download is missing its Android framework or loader.");
  }
  const privateHome = fs.mkdtempSync(path.join(os.tmpdir(), "macapk-policy-"));
  const executablePolicy = path.join(privateHome, "privacy.jar");
  fs.writeFileSync(executablePolicy, fs.readFileSync(require("../../included-files").file("providers/macapk/resources/privacy.jar")), { mode: 0o600 });
  const args = ["-Duser.home=" + privateHome, "-Djava.io.tmpdir=" + privateHome,
    "--add-exports=java.base/jdk.internal.org.objectweb.asm=ALL-UNNAMED", "-javaagent:" + executablePolicy,
    "-cp", [executablePolicy, path.join(lib, "android-framework.jar"), path.join(lib, "macapk-loader.jar")].join(path.delimiter),
    "-version"];
  try {
    await run(java, args, { signal, timeout: 30000, maxBuffer: 64 * 1024,
      env: { PATH: "/usr/bin:/bin", HOME: privateHome, TMPDIR: privateHome,
        MACAPK_CLIPBOARD_HOST: "0", MACAPK_LOCATION_HOST: "0", MACAPK_OFFLINE: "1",
        MACAPK_ANDROID_ROOT: path.join(privateHome, "android"), MACAPK_SHARED_SDCARD: "0",
        MACAPK_SHARED_SDCARD_MIGRATE: "0", MACAPK_STORAGE_ONE_PATH: "0", MACAPK_USER_FOLDERS: "0",
        MACAPK_NOW_PLAYING: "0", MACAPK_APP_LINKS: "0" } });
    return { privacyVersion: POLICY_VERSION };
  } finally { fs.rmSync(privateHome, { recursive: true, force: true }); }
}
function createManager({ dependencies = {} } = {}) {
  return createPinnedNativeManager({
    // APKs do not link a Mac.apk release; the ready package supplies its complete native environment.
    versionCompatibility: () => true,
     id: "macapk", label: "Mac.apk",
    sourceUrl: Catalog.SOURCE_URL, upstream: Catalog.source,
    resolveExecutable, dependencies,
    prepareInstall: async ({ unpacked, signal }) => {
      const contents = path.dirname(path.dirname(resolveExecutable(unpacked)));
      const minimumMacOS = applicationRequirement(path.dirname(contents));
      return { ...await verifyPolicy(contents, { signal, run: dependencies.execute || execute }), ...(minimumMacOS ? { minimumMacOS } : {}) };
    } });
}
module.exports = createManager();
Object.assign(module.exports, { createManager, runtimePaths, bundleRoot, verifyPolicy, materializePolicy, POLICY_VERSION, resolveExecutable });
Object.defineProperty(module.exports, "policyJar", { get: () => require("../../included-files").file("providers/macapk/resources/privacy.jar") });

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const execute = promisify(require("node:child_process").execFile);
const { createPinnedNativeManager } = require("../../../shared/runtime/pinned-native-manager");
const { catalog, SOURCE_URL, createCatalogDiscovery } = require("./catalog");

const POLICY_VERSION = 1;
const policyJar = path.join(__dirname, "resources/privacy.jar");
function materializePolicy(userDataDir) {
  const Writable = require("../../../shared/writable-input");
  const bytes = fs.readFileSync(policyJar), digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const directory = path.join(userDataDir, "runtimes/macapk/policy");
  Writable.assertOwnDirectory(userDataDir, directory);
  const file = path.join(directory, digest + ".jar");
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !fs.readFileSync(file).equals(bytes)) throw new Error("The Android privacy adapter changed on disk.");
  } else Writable.atomicWrite(file, bytes, { root: directory });
  return file;
}
const resources = root => path.join(root, "Mac.apk.app/Contents/Resources");
function bundleRoot(install) { return path.dirname(path.dirname(install.executablePath)); }
function runtimePaths(install) {
  const contents = bundleRoot(install);
  return { contents, app: path.dirname(contents), executable: install.executablePath,
    java: path.join(contents, "Resources/jre/bin/java"), framework: path.join(contents, "lib/android-framework.jar"),
    loader: path.join(contents, "lib/macapk-loader.jar") };
}
async function extractArchive(file, destination, signal) {
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-macapk-")); let mounted = false;
  try {
    await execute("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, file], { signal, timeout: 60000, maxBuffer: 1024 * 1024 });
    mounted = true;
    const app = path.join(mount, "Mac.apk.app");
    if (!fs.statSync(app).isDirectory()) throw new Error("The Mac.apk download does not contain its application bundle.");
    await execute("/usr/bin/ditto", [app, path.join(destination, "Mac.apk.app")], { signal, timeout: 120000 });
  } finally {
    if (mounted) await execute("/usr/bin/hdiutil", ["detach", mount], { timeout: 30000 });
    fs.rmSync(mount, { recursive: true, force: true });
  }
}
async function verifyPolicy(contents, { signal, run = execute } = {}) {
  const java = path.join(contents, "Resources/jre/bin/java"), lib = path.join(contents, "lib");
  const privateHome = fs.mkdtempSync(path.join(os.tmpdir(), "macapk-policy-"));
  const executablePolicy = path.join(privateHome, "privacy.jar");
  fs.writeFileSync(executablePolicy, fs.readFileSync(policyJar), { mode: 0o600 });
  const args = ["-Duser.home=" + privateHome, "-Djava.io.tmpdir=" + privateHome,
    "--add-exports=java.base/jdk.internal.org.objectweb.asm=ALL-UNNAMED", "-javaagent:" + executablePolicy,
    "-cp", [executablePolicy, path.join(lib, "android-framework.jar"), path.join(lib, "macapk-loader.jar")].join(path.delimiter),
    "com.maclauncher.android.macapk.PrivacyProbe"];
  try {
    const result = await run(java, args, { signal, timeout: 30000, maxBuffer: 64 * 1024,
      env: { PATH: "/usr/bin:/bin", HOME: privateHome, TMPDIR: privateHome,
        MACAPK_CLIPBOARD_HOST: "0", MACAPK_LOCATION_HOST: "0", MACAPK_OFFLINE: "1",
        MACAPK_ANDROID_ROOT: path.join(privateHome, "android"), MACAPK_SHARED_SDCARD: "0",
        MACAPK_SHARED_SDCARD_MIGRATE: "0", MACAPK_STORAGE_ONE_PATH: "0", MACAPK_USER_FOLDERS: "0",
        MACAPK_NOW_PLAYING: "0", MACAPK_APP_LINKS: "0" } });
    if (result.stdout.trim() !== "macapk-policy-1") throw new Error("This Mac.apk version cannot apply the selected privacy policy.");
    return { privacyVersion: POLICY_VERSION };
  } finally { fs.rmSync(privateHome, { recursive: true, force: true }); }
}
function createManager({ dependencies = {}, catalogDependencies = {} } = {}) {
  return createPinnedNativeManager({ id: "macapk", label: "Mac.apk",
    catalog, sourceUrl: SOURCE_URL, discoverCatalog: createCatalogDiscovery(catalogDependencies),
    resolveExecutable: root => path.join(resources(root), "macapk-runtime"),
    dependencies: { extractArchive, ...dependencies },
    prepareInstall: async ({ unpacked, signal }) => verifyPolicy(path.join(unpacked, "Mac.apk.app/Contents"), { signal, run: dependencies.execute || execute }) });
}
module.exports = createManager();
Object.assign(module.exports, { createManager, runtimePaths, bundleRoot, verifyPolicy, policyJar, materializePolicy, POLICY_VERSION, extractArchive });

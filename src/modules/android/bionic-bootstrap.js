const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFile, execFileSync } = require("node:child_process");
const execute = require("node:util").promisify(execFile);
const { pathToFileURL } = require("node:url");
const Writable = require("../shared/writable-input");
const { canonical } = require("../shared/runtime/macos-sandbox");
const NativeAbi = require("./native-abi");
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
async function generateLinkerConfiguration({ runner, systemRoot, pathMap, state, signal }) {
  const { nativeServiceIdentity } = await import(pathToFileURL(require.resolve("./art/composition.mjs")).href);
  signal?.throwIfAborted();
  // Original init runs this image's complete generator after its APEX view is
  // ready. Use linux-run's original Android environment, with no inherited
  // guest or Darwin preload, and retain its status rather than invent paths.
  await execute(runner, ["--root", systemRoot, "--path-map", pathMap,
    "--cache", path.join(state, "linkerconfig-cache"), "--identity-text",
    nativeServiceIdentity("linkerconfig", "init", 0, "0"),
    "/apex/com.android.runtime/bin/linkerconfig", "--target", "/linkerconfig"],
  { env: { PATH: "/usr/bin:/bin" }, signal, timeout: 10000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
  signal?.throwIfAborted();
}
async function prepare({ config, dataRoot, userDataDir, jdk, signal }) {
  // Metadata and JVM tools have no installed application native-code owner.
  if (typeof config.nativeRoot !== "string" || !config.nativeRoot) return null;
  // The existing preparation owner selects the ABI. No ELF magic or game list
  // selects a native provider, and original ARM32 remains on its existing path.
  if (NativeAbi.fromDirectory(config.nativeRoot) !== NativeAbi.ARM64) return null;
  const runtime = await canonical(config.runtimeRoot, "directory");
  const file = path.join(runtime, "native/bionic/profile.json");
  let stat;try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.size > 16384) throw new Error("The Android native profile is invalid.");
  const profile = JSON.parse(fs.readFileSync(file, "utf8"));
  if (profile.schemaVersion !== 1 || profile.nativeAbi !== NativeAbi.ARM64) throw new Error("The Android native profile version is unsupported.");
  if (profile.aaudioVersion != null && profile.aaudioVersion !== 1) throw new Error("The Android native audio profile version is unsupported.");
  if (profile.choreographerVersion != null && profile.choreographerVersion !== 1) throw new Error("The Android native display profile version is unsupported.");
  if (profile.libandroidFacadeVersion != null && profile.libandroidFacadeVersion !== 1) throw new Error("The Android native library profile version is unsupported.");
  if (typeof profile.inodeBootstrap !== "string" || !profile.inodeBootstrap.startsWith("native/bionic/") || profile.inodeBootstrap.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error("The Android native storage helper path is invalid.");
  const bootstrap = await canonical(path.join(runtime, profile.inodeBootstrap), "file");
  if (!bootstrap.startsWith(runtime + path.sep)) throw new Error("The Android native storage helper is outside its runtime.");
  if (!/^[a-f0-9]{64}$/.test(profile.inodeBootstrapSha256 || "") || hash(bootstrap) !== profile.inodeBootstrapSha256)
    throw new Error("The Android native storage helper is invalid.");
  if (typeof profile.linkerConfigRunner !== "string" || !profile.linkerConfigRunner.startsWith("native/bionic/") || profile.linkerConfigRunner.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error("The Android native configuration helper path is invalid.");
  const runner = await canonical(path.join(runtime, profile.linkerConfigRunner), "file");
  if (!runner.startsWith(runtime + path.sep) || !/^[a-f0-9]{64}$/.test(profile.linkerConfigRunnerSha256 || "") || hash(runner) !== profile.linkerConfigRunnerSha256)
    throw new Error("The Android native configuration helper is invalid.");
  const bridge = await canonical(path.join(runtime, "native/bionic/jsig-bridge.dylib"), "file");
  const jsig = await canonical(path.join(jdk, "lib/libjsig.dylib"), "file");
  const state = path.join(config.cacheRoot, "bionic");Writable.assertOwnDirectory(dataRoot, state);
  const image = await require("./system-image").prepare({ context: { userDataDir, signal }, image: profile.systemImage.acquisition,
    expected: profile.systemImage.content, existingOnly: true });
  if (!image) throw new Error("The Android system image is not installed.");
  const systemRoot = await canonical(image.root, "directory");
  Writable.atomicWrite(path.join(state, "bootstrap.json"), JSON.stringify({ schemaVersion: 1, imageSha256: image.archiveSha256, systemRoot }) + "\n", { root: state });
  const { applicationLayout, prepareMountParents, publishPathMap } = await import(pathToFileURL(require.resolve("./art/layout.mjs")).href);
  signal?.throwIfAborted();
  const properties = path.join(state, "properties");
  if (!fs.existsSync(properties)) execFileSync(bootstrap, [systemRoot, properties], { encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  let text = execFileSync(bootstrap, ["layout", systemRoot, state], { encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  const imageLayout = text;
  const sources = (config.sourceApks || [path.basename(config.sourceApk)]).map(name => path.isAbsolute(name) ? name : path.join(path.dirname(config.sourceApk), name));
  text += applicationLayout({ packageName: config.packageName, dataRoot, sourceApks: sources, nativeRoot: config.nativeRoot, nativeAbi: NativeAbi.ARM64 });
  const guest = await canonical(path.join(runtime, "native/bionic/guest"), "directory");
  // This distinct runtime directory carries original read-only code defaults;
  // the initializer never rewrites its shared ELF children's inode metadata.
  // applicationLayout also mounts these exact installed-code directories.
  // Declare their guest ownership before an app traverses its Android path;
  // host-private directory permissions remain unchanged.
  const codeDirectories = [...new Set(await Promise.all([...sources.map(file => path.dirname(file)), path.dirname(config.nativeRoot)]
    .map(directory => canonical(directory, "directory"))))];
  const code = [...codeDirectories, ...sources, config.nativeRoot];
  execFileSync(bootstrap, ["initialize-package", ...code, guest], { encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const guestExecutables = await Promise.all(["bootstrap.so", "linker64", "libmaclauncher-ndk-host.so", "libmaclauncher-graphics-ndk.so", "libmaclauncher-looper.so", "libmaclauncher-egl.so", "libGLESv2.so", "libGLESv3.so", ...(profile.aaudioVersion === 1 ? ["libmaclauncher-aaudio.so"] : []), ...(profile.choreographerVersion === 1 ? ["libmaclauncher-choreographer.so"] : []), ...(profile.libandroidFacadeVersion === 1 ? ["libandroid.so"] : [])]
    .map(name => canonical(path.join(guest, name), "file")));
  if (guestExecutables.some(file => !file.startsWith(guest + path.sep))) throw new Error("Android native execution inputs are outside their runtime.");
  const record = (guest, host) => {
    if ([guest, host].some(value => typeof value !== "string" || /[\0\r\n\t]/.test(value))) throw new Error("Invalid Android native mapping.");
    return "ro\t" + guest + "\t" + host + "\n";
  };
  // Init prepares platform namespaces before an application acquires its own
  // storage mounts. App import defaults must not change init's file ownership.
  const generatorMap = publishPathMap(state, "linker-configuration", prepareMountParents(
    imageLayout + record("/dev/__properties__", properties) +
    record("/apex/com.android.runtime/bin/linker64", path.join(guest, "linker64")),
    path.join(state, "linkerconfig-mounts")));
  await generateLinkerConfiguration({ runner, systemRoot, pathMap: generatorMap, state, signal });
  text += record("/dev/__properties__", properties);
  text += record("/apex/com.android.runtime/bin/linker64", path.join(guest, "linker64"));
  text += record("/data/local/tmp/maclauncher-bionic", guest);
  // GLES2/3 retain distinct original SONAMEs and complete export sets while
  // forwarding to the same native context/resource owner. Original EGL and
  // versioned GLES1 keep their complete private platform interfaces.
  for (const name of ["libGLESv2.so", "libGLESv3.so"])
    text += record("/system/lib64/" + name, path.join(guest, name));
  if (profile.aaudioVersion === 1) text += record("/system/lib64/libaaudio.so", path.join(guest, "libmaclauncher-aaudio.so"));
  if (profile.libandroidFacadeVersion === 1) {
    const original = await canonical(path.join(systemRoot, "system/lib64/libandroid.so"), "file");
    if (!original.startsWith(systemRoot + path.sep)) throw new Error("The Android platform library is outside its system image.");
    // The public DSO keeps the full original export/version surface. Typed
    // families share their existing owners; all other exports retain this
    // exact original image implementation, through a read-only code alias.
    text += record("/system/lib64/libandroid-platform.so", original);
    text += record("/system/lib64/libandroid.so", path.join(guest, "libandroid.so"));
  }
  text += record(config.nativeRoot, config.nativeRoot);
  for (const source of sources) text += record(source, source);
  // JNI and Java retain physical installation paths. They name only the same
  // read-only code inputs in the guest namespace, never a peer's writable data.
  text = prepareMountParents(text, path.join(state, "mounts"));
  const pathMap = publishPathMap(state, "namespace", text);
  return { readDirectories: [systemRoot], readFiles: [bootstrap], readXattrs: codeDirectories, executables: [bootstrap, ...guestExecutables],
    preloads: [bridge, jsig], environment: { KLJ_BIONIC_JSIG_LIBRARY: jsig } };
}
module.exports = { prepare, generateLinkerConfiguration };

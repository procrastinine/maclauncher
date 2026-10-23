const fs = require("node:fs");
const path = require("node:path");
const manager = require("./manager");
const { environment } = require("../../../shared/runtime/macos-sandbox");

function ensureRuntime(entry, context) {
  const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
  return selection.ready ? null : { managerId: manager.id, version: selection.version, installOptions: {} };
}
async function packageInput(packageSet, entry, storage, signal) {
  signal?.throwIfAborted();
  const files = packageSet?.apks || packageSet?.selected?.map(item => item.file) || [];
  const base = packageSet?.base?.file || files[0];
  if (files.length < 2) return base || packageSet?.input || packageSet?.archive || entry.gamePath;
  const root = fs.realpathSync(packageSet.root || path.dirname(base));
  if (path.basename(base) !== "base.apk") throw new Error("The Android package set requires an installed base APK.");
  for (const file of files) {
    if (path.dirname(fs.realpathSync(file)) !== root || file !== base && !/^split_[^/]+\.apk$/.test(path.basename(file)))
      throw new Error("The Android split package paths are invalid.");
  }
  // The publisher installs a plain base.apk together with its split_*.apk
  // siblings, cloning unchanged members. No second full archive is needed.
  return base;
}
async function prepareLaunch({ entry, context, storage, packageSet, policy }) {
  const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
  if (!selection.ready) throw new Error(selection.reason);
  if (policy?.clipboard !== "explicit" || policy?.location != null || policy?.audioInput || policy?.cameraInput)
    throw new Error("The selected Mac.apk device capabilities are unavailable.");
  const runtime = manager.runtimePaths(selection.install);
  for (const directory of [storage.androidRoot, storage.home, storage.temporary, storage.cacheRoot, storage.runtimeRoot])
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const input = await packageInput(packageSet, entry, storage, context.signal);
  if (!path.isAbsolute(input || "") || !fs.statSync(input).isFile()) throw new Error("Select an Android package file.");
  const classpath = [runtime.framework, runtime.loader];
  const executablePolicy = manager.materializePolicy(context.userDataDir);
  const google = policy?.google;
  if (google?.enabled && (!path.isAbsolute(google.socket || "") || !/^[a-f0-9]{64}$/.test(google.capability || "")))
    throw new Error("The shared Google account service is unavailable.");
  const optionPath = value => '"' + value.replaceAll('"', '\\"') + '"';
  const ArgumentTransport = require("../../launch-arguments");
  const argumentAgent = ArgumentTransport.prepareAgent(context);
  const toolOptions = ["--add-exports=java.base/jdk.internal.org.objectweb.asm=ALL-UNNAMED",
    "-Duser.home=" + optionPath(storage.home), "-Djava.io.tmpdir=" + optionPath(storage.temporary),
    '-javaagent:"' + executablePolicy.replaceAll('"', '\\"') + '"',
    ...(argumentAgent ? ['-javaagent:"' + argumentAgent.replaceAll('"', '\\"') + '"=macapk'] : [])].join(" ");
  const env = { ...ArgumentTransport.environment(context, environment()), HOME: storage.home, CFFIXED_USER_HOME: storage.home,
    TMPDIR: storage.temporary + path.sep, JAVA_TOOL_OPTIONS: toolOptions,
    MACAPK_ANDROID_ROOT: storage.androidRoot, MACAPK_APP_CACHE_DIR: path.join(storage.cacheRoot, "applications"),
    MACAPK_AOT_CACHE: "0", MACAPK_CLIPBOARD_HOST: "0", MACAPK_LOCATION_HOST: "0", MACAPK_DISPLAY_DENSITY: "320",
    MACAPK_GUEST_TOTALRAM: String(8 * 1024 ** 3), MACAPK_SELF_CAPTURE: "0",
    MACAPK_SHARED_SDCARD: "0", MACAPK_SHARED_SDCARD_MIGRATE: "0", MACAPK_STORAGE_ONE_PATH: "0",
    MACAPK_USER_FOLDERS: "0", MACAPK_NOW_PLAYING: "0",
    MACAPK_APP_LINKS: policy?.networkAllowed === true ? "1" : "0",
    MACAPK_GMS_PRESENT: google?.enabled ? "1" : "0", MACAPK_GMS_FCM: "0",
    ...(!google?.enabled ? { MACAPK_GMS_HONEST_MISSING: "1" } : {}),
    MACAPK_GMS_DIR: path.join(storage.cacheRoot, "google"),
    MACAPK_OFFLINE: policy?.networkAllowed === true ? "0" : "1",
    MACAPK_CANONICAL_APP: runtime.app,
    ...(["metal", "vulkan"].includes(context.runtimeSettings?.angleBackend) ? { MACAPK_ANGLE_BACKEND: context.runtimeSettings.angleBackend } : {}),
    ...(google?.enabled ? { MACLAUNCHER_GOOGLE_SOCKET: google.socket, MACLAUNCHER_GOOGLE_CAPABILITY: google.capability } : {}),
    ...(policy?.clipboardSocket ? { MACLAUNCHER_CLIPBOARD_SOCKET: policy.clipboardSocket } : {}) };
  // Upstream package preparation and its background compression use these
  // system archive tools. They retain the same file/network sandbox.
  const executableFiles = [runtime.executable, runtime.java, path.join(path.dirname(runtime.java), "../lib/jspawnhelper"),
    path.join(runtime.contents, "bin/macapk-translator"), path.join(runtime.contents, "bin/macapk-elfexec"),
    "/bin/sh", "/bin/bash", "/usr/sbin/taskpolicy", "/usr/bin/nice", "/usr/bin/unzip", "/usr/bin/tar", "/usr/bin/ditto", "/usr/bin/codesign", "/bin/mkdir", "/bin/rm", "/bin/mv"];
  const descriptor = { command: runtime.executable, args: ["--apk", input, "--android-root", storage.androidRoot,
    "--width", String(policy.width || 1280), "--height", String(policy.height || 800), "--orientation", "landscape"], env, cwd: storage.androidRoot,
    readDirectories: [runtime.app, ...(fs.existsSync("/private/var/select") ? ["/private/var/select"] : [])],
    readFiles: [input, executablePolicy, ...(argumentAgent ? [argumentAgent] : []), ...classpath], executables: executableFiles,
    machServices: ["com.apple.WebKit.WebContent", "com.apple.WebKit.Networking", "com.apple.WebKit.GPU", "com.apple.nsurlsessiond"],
    runtime: { managerId: manager.id, version: selection.version, sourcePath: selection.install.installDir },
    device: { model: "Pixel Tablet", width: 2560, height: 1600, densityDpi: 320 } };
  const identity = await require("./identity").prepareIdentity({ entry, context, storage, packageSet, runtime, descriptor, policy, policyJar: executablePolicy });
  descriptor.command = identity.command;
  descriptor.env.MACAPK_APP_LABEL = identity.label;
  if (identity.icon) descriptor.env.MACAPK_APP_ICON = identity.icon;
  descriptor.readDirectories.push(identity.app);
  descriptor.machRegistrations = [identity.identifier];
  descriptor.application = identity;
  const packageName = packageSet?.metadata?.packageName || packageSet?.base?.metadata?.packageName;
  if (typeof packageName === "string" && /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(packageName))
    descriptor.expansionDirectory = path.join(storage.androidRoot, "sdcard/Android/obb", packageName);
  return descriptor;
}
module.exports = { manager, ensureRuntime, prepareLaunch, packageInput, resolveIcon: require("./identity").resolveIcon };

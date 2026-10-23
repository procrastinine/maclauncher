const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const Bundled = require("../../../shared/runtime/bundled-native");
const manager = require("./manager");
const { confirmToolInstall } = require("../../../shared/runtime/tool-install");
const { downloadToFile } = require("../../../shared/runtime/download-utils");
const { runDownloadTask } = require("../../../shared/runtime/download-manager");
const { environment } = require("../../../shared/runtime/macos-sandbox");
const pin = require("./source.json");
const preparations = new Map();
const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";

function resolveRuntime(context = {}, verification = "full", entry) {
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir, { nativeResourceRoot: context.nativeResourceRoot, verification });
  if (!selected.ready) throw new Error(selected.reason);
  const install = selected.install;
  if (verification === "full") Bundled.verifyPayload(install.root, install.declaration);
  const root = install.payloadRoot;
  return { ...install, root, bin: path.join(root, "bin"), version: selected.version };
}

function ensureRuntime(entry, context) {
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir, { nativeResourceRoot: context.nativeResourceRoot, verification: "status" });
  return selected.ready ? null : { managerId: manager.id, version: selected.version, installOptions: {} };
}

function resolveLaunchMode() { return "android-services"; }

async function hashFile(file, signal) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) { signal?.throwIfAborted(); hash.update(chunk); }
  return hash.digest("hex");
}

async function capture(command, args, { env, cwd, signal, input, timeout = 120000, maximum = 4 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  const child = spawn(command, args, { env: { ...environment(), PATH: systemPath, ...env }, cwd, stdio: ["pipe", "pipe", "pipe"] });
  const output = [], errors = []; let size = 0, failure, killer;
  const stop = error => { failure ||= error; child.kill("SIGTERM"); killer ||= setTimeout(() => child.kill("SIGKILL"), 2000); };
  const collect = (target, bytes) => { size += bytes.length; if (size > maximum) stop(new Error("Android command output exceeded its limit.")); else target.push(bytes); };
  child.stdout.on("data", bytes => collect(output, bytes)); child.stderr.on("data", bytes => collect(errors, bytes));
  child.stdin.on("error", () => {}); child.stdin.end(input || undefined);
  const abort = () => stop(signal?.reason || new Error("Android command canceled."));
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop(new Error("Android command timed out.")), timeout);
  child.once("spawn", () => { if (signal?.aborted) abort(); });
  try {
    const [code, reason] = await once(child, "close");
    if (failure) throw failure;
    if (code !== 0) throw new Error(Buffer.concat(errors).toString("utf8").trim() || `Android command failed (${reason || code}).`);
    return Buffer.concat(output).toString("utf8");
  } finally { clearTimeout(timer); clearTimeout(killer); signal?.removeEventListener("abort", abort); }
}

async function prepareSystem({ context, storage, policy, runtime = resolveRuntime(context) }, dependencies = {}) {
  if (!path.isAbsolute(context.userDataDir || "")) throw new Error("Android data storage is unavailable.");
  const imageSource = dependencies.image || pin.androidImage;
  const directory = require("./image-cache").directoryForImage(context.userDataDir, runtime, imageSource);
  const identity = runtime.root;
  const existing = preparations.get(directory);
  if (existing?.identity === identity) return existing.operation;
  const operation = (async () => {
    // Runtime versions share image storage; serialize writes across versions.
    if (existing) await existing.operation.catch(() => {});
    require("../../../shared/writable-input").assertOwnDirectory(context.userDataDir, directory);
    const archive = path.join(directory, "system.zip");
    if (!fs.existsSync(path.join(directory, "system.dmg"))) await require("../../system-image").adoptBase({
      context, image: imageSource, destination: path.join(directory, "system.dmg") });
    const prepare = async signal => {
      await (dependencies.capture || capture)(path.join(runtime.bin, "android-runtime-prepare"), [archive, runtime.root, directory], {
        signal, timeout: 20 * 60 * 1000, env: { MACLAUNCHER_AIM_ROOT: runtime.root }, maximum: 16 * 1024 * 1024 });
      const image = path.join(directory, "derived", "root");
      if (!fs.existsSync(path.join(image, ".identity"))) throw new Error("Android system image preparation did not complete.");
      fs.rmSync(archive, { force: true });
      fs.mkdirSync(path.join(directory, "userdata"), { recursive: true, mode: 0o700 });
      return { runtime, image, directory, userdata: path.join(directory, "userdata") };
    };
    if (!fs.existsSync(path.join(directory, "system.dmg"))) {
      await confirmToolInstall(context, { managerId: "android-aim-image", version: imageSource.version,
        label: "Android system image", requiresDownload: true,
        detail: "Download the Android 16 system image (1.95 GB) under the Android SDK license: " + imageSource.licenseUrl });
      return runDownloadTask(context.downloads || context.downloadManager, { label: "Android system image", managerId: "android-aim-image", sectionId: "default", version: imageSource.version,
        kind: "runtime", dedupeKey: "android-aim-image:" + directory }, async ({ signal: taskSignal, onProgress }) => {
        const signal = context.signal && taskSignal ? AbortSignal.any([context.signal, taskSignal]) : context.signal || taskSignal;
        try {
          await (dependencies.downloadToFile || downloadToFile)(imageSource.url, archive, { signal, onProgress });
          onProgress?.({ detail: "Verifying…" });
          if (await hashFile(archive, signal) !== imageSource.sha256) throw new Error("The Android system image checksum did not match.");
          signal?.throwIfAborted();
          onProgress?.({ detail: "Preparing…" });
          return await prepare(signal);
        } finally { fs.rmSync(archive, { force: true }); }
      }, { onProgress: context.onProgress });
    }
    return prepare(context.signal);
  })();
  preparations.set(directory, { identity, operation });
  try { return await operation; } finally { if (preparations.get(directory)?.operation === operation) preparations.delete(directory); }
}

function runtimeEnvironment({ runtime, storage, policy }) {
  const hash = crypto.createHash("sha256").update(storage.root).digest("hex").slice(0, 24);
  return { ...environment(), PATH: systemPath, HOME: storage.home, CFFIXED_USER_HOME: storage.home, TMPDIR: storage.temporary + path.sep,
    MACLAUNCHER_AIM_ROOT: runtime.root, MACLAUNCHER_AIM_NETWORK: policy?.networkAllowed === true ? "allow" : "deny",
    MACLAUNCHER_AIM_IPC_PREFIX: "org.maclauncher.android.aim." + hash + ".", MACLAUNCHER_AIM_NO_SHIMS: "1", MACLAUNCHER_AIM_MOUNTED_DATA: "1",
    ...(policy?.clipboardSocket ? { MACLAUNCHER_CLIPBOARD_SOCKET: policy.clipboardSocket } : {}) };
}

function controlDescriptor({ runtime, storage, policy, prepared, args }) {
  const env = runtimeEnvironment({ runtime, storage, policy }), prefix = env.MACLAUNCHER_AIM_IPC_PREFIX;
  return { command: path.join(runtime.bin, "aimctl"), args: ["--data", storage.androidRoot, ...args], env, cwd: storage.root,
    readDirectories: [runtime.root, ...(prepared ? [prepared.directory] : [])],
    executables: ["/bin/ps"],
    executableDirectories: [runtime.bin, storage.androidRoot, ...(prepared ? [prepared.image] : [])], machServicePrefixes: [prefix], machRegistrationPrefixes: [prefix],
    machServices: [],
    runtime: { managerId: manager.id, version: runtime.version, sourcePath: runtime.root } };
}

async function stopRuntime({ child, pid = child?.pid, isCurrent = () => true }) {
  if (!isCurrent() || child?.pid !== pid) return false;
  // The retained controller signals its original resident child inside the
  // inherited sandbox and waits for the resident's checked worker/DATA drain.
  // A separately sandboxed aimctl sibling cannot signal that resident.
  if (child.exitCode == null && child.signalCode == null) {
    await new Promise((resolve, reject) => {
      const clean = () => {clearTimeout(timer);child.removeListener("exit", finish);child.removeListener("error", fail);};
      const finish = () => {clean();resolve();};
      const fail = error => {clean();reject(error);};
      // The keeper preserves AIM's complete worker and DATA retirement
      // budget. Allow its final status delivery without group termination.
      const timer = setTimeout(() => fail(new Error("Android controller did not complete its runtime shutdown.")), 270000);
      child.once("exit", finish);child.once("error", fail);
      if (child.exitCode != null || child.signalCode != null) finish();
      else {
        try { if (!child.kill("SIGTERM")) fail(new Error("Android controller could not receive its shutdown request.")); }
        catch (error) {fail(error);}
      }
    });
  }
  if (child.signalCode || child.exitCode !== 0) throw new Error(`Android controller shutdown failed (${child.signalCode || child.exitCode}).`);
  return true;
}

async function prepareLaunch({ entry, context, storage, packageSet, policy }) {
  if (policy?.networkAllowed === true) throw new Error("AIM currently supports offline applications. Disable network access to use AIM.");
  if (context.runtimeSettings?.googleIntegration === true) throw new Error("Google integration is unavailable in AIM. Select Android or Mac.apk for Google services.");
  if (policy?.clipboard !== "explicit" || policy?.location != null || policy?.audioInput || policy?.cameraInput) throw new Error("The selected AIM device capabilities are unavailable.");
  const runtime = resolveRuntime(context, "full", entry);
  const launchMode = resolveLaunchMode();
  if (context.useRuntime) await context.useRuntime({ managerId: manager.id, version: runtime.version, sourcePath: runtime.installDir });
  const prepared = await prepareSystem({ context, storage, policy, runtime });
  const helper = path.join(runtime.bin, "android-runtime-prepare");
  await capture(helper, ["--data-attach", storage.androidRoot], { signal: context.signal, timeout: 180000, env: { MACLAUNCHER_AIM_ROOT: runtime.root } });
  const cleanup = () => capture(helper, ["--data-detach", storage.androidRoot], { timeout: 60000, env: { MACLAUNCHER_AIM_ROOT: runtime.root } });
  try {
  const descriptor = controlDescriptor({ runtime, storage, policy, prepared, args: [] });
  const application = await require("./identity").prepareIdentity({ entry, context, storage, packageSet, runtime, prepared, descriptor, policy });
  descriptor.readDirectories.push(application.app);
  descriptor.executables.push(application.executablePath);
  descriptor.machRegistrations = [application.identifier];
  descriptor.application = application;
  descriptor.env.MACLAUNCHER_AIM_DISPLAY = application.executablePath;
  const configuration = path.join(storage.runtimeRoot, "aim-launch.json");
  require("../../../shared/writable-input").atomicWrite(configuration, JSON.stringify({ schemaVersion: 1, runtime: runtime.root,
    image: prepared.image, originalImage: prepared.image, launchMode,
    userdata: prepared.userdata, data: storage.androidRoot, root: storage.root,
    packageName: packageSet.metadata.packageName, activity: packageSet.metadata.launchers[0]?.name || packageSet.metadata.launchers[0]?.activity || "",
    key: packageSet.key, apks: packageSet.apks, title: entry.name || "Android game",
    ...(context.gameArguments?.length ? { gameArguments: require("../../launch-arguments").serialized(context) } : {}) }) + "\n", { root: storage.root });
  const controller = path.join(__dirname, "resources/maclauncher-aim").replace(/([\\/])app\.asar(?=[\\/])/, "$1app.asar.unpacked");
  return { ...descriptor, command: controller, args: [configuration], readFiles: [configuration],
    executables: [...descriptor.executables, controller],
    expansionDirectory: path.join(storage.androidRoot, "media", "0", "Android", "obb", packageSet.metadata.packageName),
    cleanup, stop: stopRuntime,
    device: { model: "Pixel Tablet", width: 2560, height: 1600, densityDpi: 320 } };
  } catch (error) { await cleanup().catch(failure => context.logger?.warn?.(failure.message)); throw error; }
}

module.exports = { id: "aim", pin, manager, ensureRuntime, resolveRuntime, resolveLaunchMode, prepareSystem, controlDescriptor, stopRuntime, prepareLaunch, capture,
  resolveIcon: require("./identity").resolveIcon };

const fs = require("node:fs"), path = require("node:path");
const Sandbox = require("../shared/runtime/macos-sandbox");
const Writable = require("../shared/writable-input");
const reference = require("./provider-device-profile.json");
const device = Object.freeze({ ...reference, ...reference.display, orientation: reference.display.naturalOrientation });

function resolvePolicy(settings = {}) {
  const dimension = (value, fallback) => Number.isInteger(value) && value >= 64 && value <= 8192 ? value : fallback;
  return { networkAllowed: settings.networkIsolation === false, clipboard: "explicit", location: null,
    audioInput: "", cameraInput: "", device,
    width: dimension(settings.width, 1280), height: dimension(settings.height, 800) };
}

async function prepareIsolation(descriptor, storage, policy, { graphics = {}, signal } = {}) {
  signal?.throwIfAborted();
  if (process.platform !== "darwin") throw new Error("Android runtimes require macOS on Apple Silicon.");
  await fs.promises.access("/usr/bin/sandbox-exec", fs.constants.X_OK);
  if (!descriptor || !path.isAbsolute(descriptor.command || "") || !Array.isArray(descriptor.args) || descriptor.args.some(item => typeof item !== "string" || item.includes("\0")))
    throw new Error("The Android runtime launch is invalid.");
  if (["open", "osascript", "launchctl"].includes(path.basename(descriptor.command)))
    throw new Error("Android privacy controls require launching the runtime directly.");
  const root = await Sandbox.canonical(storage.root, "directory"), command = await Sandbox.canonical(descriptor.command, "file");
  Writable.assertOwnDirectory(storage.root, path.join(storage.cacheRoot, "graphics"));
  const scoped = await Sandbox.isolateGraphics(graphics, storage.runtimeRoot, path.join(storage.cacheRoot, "graphics"), signal);
  const readDirectories = [...new Set([storage.packagesRoot, storage.runtimeRoot, ...(descriptor.readDirectories || [])])];
  const executablePaths = [...new Set([command, "/usr/bin/env", ...(descriptor.executables || [])])];
  // Graphics grants are already validated and can name exact owned stores
  // which a later live import creates. Required runtime inputs must exist now.
  const canonicalDirectories = [...await Promise.all(readDirectories.map(file => Sandbox.canonical(file, "directory"))), ...scoped.readableDirectories];
  const canonicalFiles = [...await Promise.all((descriptor.readFiles || []).map(file => Sandbox.canonical(file, "file"))), ...scoped.readable];
  const executables = await Promise.all(executablePaths.map(file => Sandbox.canonical(file, "file")));
  const machServices = (descriptor.machServices || []).filter(name => policy.networkAllowed || !/nsurlsession|WebKit\.Networking/.test(name));
  let fileExtensions;
  if (descriptor.application?.app) {
    const app = await Sandbox.canonical(descriptor.application.app, "directory");
    if (!Sandbox.within(root, app)) throw new Error("The Android application bundle is outside its private storage.");
    fileExtensions = { read: [app] };
  }
  let profile = Sandbox.profile({ readDirectories: canonicalDirectories, readFiles: canonicalFiles,
    writeDirectories: [root], executables, blockNetwork: !policy.networkAllowed, machServices, fileExtensions });
  // Private runtime IPC remains available when Internet and LAN access are off.
  const quote = value => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
  profile += `\n(allow network-bind network-inbound (local unix-socket (subpath ${quote(root)})))\n`;
  profile += `(allow network-outbound (remote unix-socket (subpath ${quote(root)})))\n`;
  if (policy.clipboardSocket) {
    if (!/^\/private\/tmp\/maclauncher-clipboard-[a-f0-9]{32}\.sock$/.test(policy.clipboardSocket) || !(await fs.promises.lstat(policy.clipboardSocket)).isSocket())
      throw new Error("The Android clipboard endpoint is invalid.");
    profile += `(allow file-read-metadata (literal ${quote(policy.clipboardSocket)}))\n`;
    profile += `(allow network-outbound (remote unix-socket (literal ${quote(policy.clipboardSocket)})))\n`;
  }
  if (policy.googleSocket) {
    if (!/^\/private\/tmp\/maclauncher-google-[a-f0-9]{32}\.sock$/.test(policy.googleSocket) || !(await fs.promises.lstat(policy.googleSocket)).isSocket())
      throw new Error("The Android account endpoint is invalid.");
    profile += `(allow file-read-metadata (literal ${quote(policy.googleSocket)}))\n`;
    profile += `(allow network-outbound (remote unix-socket (literal ${quote(policy.googleSocket)})))\n`;
  }
  for (const [operation, prefixes] of [["mach-lookup", descriptor.machServicePrefixes], ["mach-register", descriptor.machRegistrationPrefixes]]) {
    for (const prefix of prefixes || []) {
      if (!/^org\.maclauncher\.android\.aim\.[a-f0-9]{12,64}\.$/.test(prefix)) throw new Error("The Android service namespace is invalid.");
      const expression = "^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      profile += `(allow ${operation} (global-name-regex ${quote(expression)}))\n`;
    }
  }
  for (const name of descriptor.machRegistrations || []) {
    if (!/^(?:org|com)\.maclauncher\.android\.[A-Za-z0-9._-]+$/.test(name)) throw new Error("The Android service identity is invalid.");
    profile += `(allow mach-register (global-name ${quote(name)}))\n`;
  }
  for (const directory of descriptor.executableDirectories || []) {
    const actual = await Sandbox.canonical(directory, "directory");
    if (![root, ...canonicalDirectories].some(allowed => Sandbox.within(allowed, actual))) throw new Error("Android executable code is outside its runtime.");
    profile += `(allow process-exec (subpath ${quote(actual)}))\n`;
  }
  const file = path.join(storage.runtimeRoot, "sandbox.sb");
  Writable.atomicWrite(file, profile, { root: storage.root });
  const environment = { ...Sandbox.environment(), ...(descriptor.env || {}), ...scoped.graphics,
    HOME: storage.home, CFFIXED_USER_HOME: storage.home, TMPDIR: storage.temporary + path.sep };
  const afterSandbox = Object.entries(environment).filter(([key]) => /^DYLD_[A-Z0-9_]+$/.test(key)).map(([key, value]) => key + "=" + value);
  // The invoking path can identify a private per-game .app. Authority follows
  // the validated real executable; retain that bundle identity at exec time.
  return { command: "/usr/bin/sandbox-exec", args: ["-f", file, "/usr/bin/env", ...afterSandbox, descriptor.command, ...descriptor.args],
    environment, graphics: scoped.graphics, profile };
}

module.exports = { device, resolvePolicy, prepareIsolation };

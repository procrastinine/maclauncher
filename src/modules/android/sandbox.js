const fs = require("node:fs"), path = require("node:path");
const Writable = require("../shared/writable-input");
const Namespace = require("./storage-namespace");
const NativeStartup = require("./native-startup");
const { profile, environment, canonical, within, isolateGraphics } = require("../shared/runtime/macos-sandbox");

function captureCapabilities(config) {
  let text = "";
  // Only explicit per-game selections grant access. The physical owner still
  // verifies current macOS authorization before opening a capture device.
  if (config.audioInputUid) text += '\n(allow device-microphone)\n(allow mach-lookup (global-name "com.apple.tccd") (global-name "com.apple.cmio.registerassistantservice.system-extensions"))\n';
  if (config.cameraInputUid) text += '\n(allow device-camera)\n(allow mach-lookup (global-name "com.apple.tccd") (global-name "com.apple.cmio.registerassistantservice") (global-name "com.apple.cmio.registerassistantservice.system-extensions"))\n';
  return text;
}

async function prepareSandbox({ javaPath, config, configFile, dataRoot, userDataDir, processIdentityVersion = 0, graphics = {}, signal, blockNetwork = false,
  installedPackages = [], localSockets = {}, accountCodeRoot = null, installedCodeRoot = null, vulkan = null, angleBackend = "metal", argumentAgent = null }, dependencies = {}) {
  if (!["metal", "vulkan"].includes(angleBackend)) throw new Error("Select Metal or Vulkan for the Android OpenGL ES backend.");
  if (angleBackend === "vulkan" && !vulkan) throw new Error("No Vulkan implementation is installed. Install MoltenVK or KosmicKrisp in Runtimes → Graphics.");
  if (config.webLinksAllowed != null && (config.webLinksAllowed !== 0 && config.webLinksAllowed !== 1 || blockNetwork && config.webLinksAllowed === 1))
    throw new Error("Android web links cannot bypass network isolation.");
  if (process.platform !== "darwin") throw new Error("Android file isolation requires macOS.");
  await fs.promises.access("/usr/bin/sandbox-exec", fs.constants.X_OK);
  const executable = await canonical(javaPath, "file"), jdk = await canonical(path.resolve(path.dirname(executable), ".."), "directory");
  const helper = await canonical(path.join(jdk, "lib/jspawnhelper"), "file");
  const data = await canonical(dataRoot, "directory"), runtime = await canonical(config.runtimeRoot, "directory");
  const iconHelper = path.join(runtime, "native/android-application-icon");
  const application = typeof config.title === "string" && config.nativeInputFd == null ? await (dependencies.prepareApplication || require("./application").prepare)({
    executablePath: executable, links: Object.fromEntries(["lib", "conf", "release"].map(name => [name, path.join(jdk, name)])),
    directory: path.join(path.dirname(configFile), "application"), title: config.title,
    iconFile: config.iconFile, iconHelper: fs.existsSync(iconHelper) ? iconHelper : null, signal
  }) : null;
  const applicationExecutable = application ? await canonical(application.executablePath, "file") : executable;
  const directories = {};
  for (const key of ["filesRoot", "cacheRoot"]) {
    directories[key] = await canonical(config[key], "directory");
    if (!within(data, directories[key])) throw new Error("Android files must remain inside the app's private storage.");
  }
  const bionic = await require("./bionic-bootstrap").prepare({ config, dataRoot: data, userDataDir, jdk, signal });
  const androidEnvironment = Namespace.environment({ dataRoot: data, ...directories, partitionsRoot: path.join(runtime, "android-root") });
  const home = path.join(data, "home"), temporary = path.join(data, "cache", "tmp"), graphicsOutput = path.join(data, "cache", "graphics");
  for (const directory of [home, temporary, graphicsOutput]) Writable.assertOwnDirectory(data, directory);
  const systemEnvironment = environment();
  const javaArguments = ["-Djava.home=" + jdk, "-Duser.home=" + home, "-Djava.io.tmpdir=" + temporary, "-XX:-UsePerfData"];
  javaArguments.push(...require("./jvm-options").cryptoJvmOptions({ javaHome: jdk, runtimeRoot: runtime, cacheRoot: directories.cacheRoot, javaArguments }));
  const nativeStartupEnvironment = NativeStartup.environment({ androidEnvironment, systemEnvironment, home, temporary: temporary + path.sep });
  const applicationAccess = application ? await require("./application").isolation(application) : {};
  const graphicsDirectory = path.join(path.dirname(configFile), "graphics");
  Writable.assertOwnDirectory(path.dirname(configFile), graphicsDirectory);
  const scoped = await isolateGraphics(graphics, graphicsDirectory, graphicsOutput, signal);
  const storageLibrary = path.join(runtime, "native", "libandroid-storage.dylib");
  const privateStorage = fs.existsSync(storageLibrary) ? await canonical(storageLibrary, "file") : null;
  const processLibrary = path.join(runtime, "native", "libandroid-jvm-process.dylib");
  const jvmProcess = fs.existsSync(processLibrary) ? await canonical(processLibrary, "file") : null;
  const selectedJvm = jvmProcess ? await canonical(path.join(jdk, "lib/server/libjvm.dylib"), "file") : null;
  const identities = await require("./process-channel").processNamespace(userDataDir, processIdentityVersion);
  const readDirectories = [...(bionic?.readDirectories || []), jdk, runtime, await canonical(graphicsDirectory, "directory"), ...scoped.readableDirectories];
  const nativeDirectories = config.nativeRoot ? [config.nativeRoot] : [];
  if (application) readDirectories.push(await canonical(application.app, "directory"));
  for (const key of ["nativeRoot", "assetsRoot", "resourcesRoot"])
    if (config[key]) readDirectories.push(await canonical(config[key], "directory"));
  const readFiles = [...(bionic?.readFiles || []), await canonical(configFile, "file"), ...scoped.readable];
  if (config.graphicsLibrary) readFiles.push(await canonical(config.graphicsLibrary, "file"));
  if (argumentAgent) readFiles.push(await canonical(argumentAgent, "file"));
  const vulkanEnvironment = require("../shared/vulkan").environment(vulkan, graphicsDirectory);
  for (const file of vulkan?.readable || []) readFiles.push(await canonical(file, "file"));
  for (const key of ["convertedJar", "sourceApk"]) if (config[key]) readFiles.push(await canonical(config[key], "file"));
  for (const name of config.sourceApks || []) {
    if (name !== path.basename(name)) throw new Error("Android split package paths must be filenames.");
    readFiles.push(await canonical(path.join(path.dirname(config.sourceApk), name), "file"));
  }
  // Package metadata and installed code are readable across Android packages;
  // another package's writable data is never included in these grants.
  for (const installed of installedPackages) {
    for (const apk of installed.sourceApks) readFiles.push(await canonical(apk, "file"));
    if (installed.convertedJar) readFiles.push(await canonical(installed.convertedJar, "file"));
    readDirectories.push(await canonical(installed.nativeRoot, "directory"));
    nativeDirectories.push(installed.nativeRoot);
  }
  const writeDirectories = [data, ...identities.writeDirectories, ...(applicationAccess.writeDirectories || [])];
  const nativeExecutables = await require("./native-executables").installedExecutables(nativeDirectories,
    [...writeDirectories, ...(applicationAccess.fileExtensions?.readWrite || [])], signal);
  let text = profile({ readDirectories, readFiles, writeDirectories, executables: [...(bionic?.executables || []), applicationExecutable, executable, helper, ...nativeExecutables, ...(privateStorage ? ["/usr/bin/env"] : [])], blockNetwork,
    machServices: [...webKitMachServices, ...(applicationAccess.machServices || [])],
    // LaunchServices receives the complete owned bundle when registering this
    // process. Delegating only its Resources directory prevents registration;
    // the bundle is already read-only in the game's sandbox.
    fileExtensions: applicationAccess.fileExtensions });
  if (accountCodeRoot || installedCodeRoot) {
    if(!(config.accountService===1&&config.packageName==="android")&&config.serviceRole!=="system")
      throw new Error("Installed-code access requires an Android system service.");
    const codeRoot = await canonical(installedCodeRoot || accountCodeRoot, "directory");
    const escape = value => value.replace(/[.*+?^{$}()|[\]\\]/g, "\\$&");
    const quote = value => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
    // SBPL #"..." is a regex literal: backslashes belong to the regular
    // expression, unlike an ordinary quoted path. Double-escaping them makes
    // a dotted profile path match a literal backslash instead of that path.
    const regex = value => '#"' + value.replaceAll('"', '\\"') + '"';
    // Android's system package catalog reads installed code, never the private
    // app data beside it. Enrollment can add another installed package later.
    text += '\n(allow file-read-metadata (literal ' + quote(codeRoot) + ') (regex ' + regex('^' + escape(codeRoot) + '/[^/]+$') + '))';
    text += '\n(allow file-read* (regex ' + regex('^' + escape(codeRoot) + '/[^/]+/prepared(/|$)') + '))';
  }
  // StrictJarFile duplicates an already-authorized APK descriptor through
  // Darwin's fd device. This cannot open a file the process does not hold.
  text += '\n(allow file-read-metadata (literal "/dev/fd"))\n(allow file-read-data file-read-metadata (regex #"^/dev/fd/[0-9]+$"))\n';
  // Host-owned local IPC remains available with internet access disabled.
  // Grant only each socket, never its directory or the service's private data.
  const quoteSocket = value => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
  // The guest VFS reads ownership declarations on the exact installed-code
  // directory mounts. Ancestor metadata permission does not include xattrs;
  // this grants neither directory contents nor sibling file data.
  const codeMetadata = bionic?.readXattrs || [];
  if (codeMetadata.length) text += '\n(allow file-read-xattr ' + codeMetadata.map(directory => '(literal ' + quoteSocket(directory) + ')').join(' ') + ')\n';
  const syncSocket=await require("./platform-services/paths").syncSocket(configFile);
  const deviceSockets={...localSockets,
    connect:[...(localSockets.connect||[])],
    listen:[...(localSockets.listen||[]),syncSocket]};
  for (const [operation, sockets] of Object.entries(deviceSockets)) {
    if (!["connect", "listen"].includes(operation) || !Array.isArray(sockets)) throw new Error("Invalid Android local service access.");
    for (const socket of sockets) {
      if (!path.isAbsolute(socket || "") || /[\x00-\x1f\x7f]/.test(socket)) throw new Error("Invalid Android local service path.");
      const parent = await canonical(path.dirname(socket), "directory");
      if (path.join(parent, path.basename(socket)) !== socket) throw new Error("Android local service path must be canonical.");
      for (let directory = parent; directory !== path.dirname(directory); directory = path.dirname(directory))
        text += '\n(allow file-read-metadata (literal ' + quoteSocket(directory) + '))';
      const literal = '(literal ' + quoteSocket(socket) + ')';
      text += '\n(allow file-read-metadata ' + literal + ')';
      if (operation === "connect") text += '\n(allow network-outbound (remote unix-socket ' + literal + '))';
      else text += '\n(allow file-write* ' + literal + ')\n(allow network-bind network-inbound (local unix-socket ' + literal + '))';
    }
  }
  text += require('./shared-memory-policy').capabilities([temporary]);
  text += captureCapabilities(config);
  const profileFile = path.join(path.dirname(configFile), "sandbox.sb");
  Writable.atomicWrite(profileFile, text, { root: path.dirname(configFile) });
  // sandbox-exec strips DYLD variables at its own protected entry. Set the
  // owned preload after entering the sandbox, before any JVM/framework code.
  const preloads = [...new Set([...(bionic?.preloads || []), privateStorage, selectedJvm, jvmProcess, scoped.graphics.DYLD_INSERT_LIBRARIES]
    .flatMap(value => (value || "").split(path.delimiter)).filter(Boolean))];
  const entry = preloads.length ? ["/usr/bin/env", "DYLD_INSERT_LIBRARIES=" +
    preloads.join(path.delimiter), applicationExecutable] : [applicationExecutable];
  return { command: "/usr/bin/sandbox-exec", prefix: ["-f", profileFile, ...entry], executablePath: applicationExecutable,
    javaArguments,
    environment: { ...systemEnvironment, ...androidEnvironment, ...vulkanEnvironment, ...identities.environment, ...bionic?.environment, KL_ANGLE_BACKEND: angleBackend, HOME: home, CFFIXED_USER_HOME: home, TMPDIR: temporary + path.sep, MACLAUNCHER_ANDROID_SYNC_SOCKET: syncSocket, MACLAUNCHER_ANDROID_NATIVE_ABI: require("./native-abi").fromDirectory(config.nativeRoot), ...nativeStartupEnvironment },
    graphics: scoped.graphics, profile: text };
}
// WebKit checks its local process services before loading even an inline page.
// Network requests retain the process sandbox and WebKit provider policy.
const webKitMachServices = Object.freeze([
  "com.apple.WebKit.WebContent", "com.apple.WebKit.Networking",
  "com.apple.WebKit.GPU", "com.apple.nsurlsessiond"
]);
module.exports = { prepareSandbox, environment, profile, captureCapabilities, webKitMachServices };

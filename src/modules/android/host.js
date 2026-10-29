const fs = require("node:fs");
const path = require("node:path");
const Java = require("../java/runtime/java-runtime-manager");
const Writable = require("../shared/writable-input");
const ReShade = require("../shared/reshade");
const { confirmToolInstall } = require("../shared/runtime/tool-install");
const { prepareApk, retainPrepared } = require("./prepare");
const Sandbox = require("./sandbox");
const Storage = require("./storage");
const ProcessHistory = require("./process-history");
const PackageMetadata = require("./package-metadata");
const { createLaunchTiming } = require("./launch-timing");
const { frameworkJvmOptions, applicationJvmOptions } = require("./jvm-options");
const conversionJvmOptions = payload => payload.profile?.demandDexVersion === 1 ? ["-Dmaclauncher.dex.demand=true"] : [];
const deviceProfile = require("./device-profile.json");
// Includes the trailing newline written to launch.json; mirrored by LaunchConfig.MAX_BYTES.
const MAX_LAUNCH_CONFIG_BYTES = 64 * 1024;

// The JNI bridge uses the Apple Silicon Java 21 ABI. Other installed Java
// lines and Rosetta hosts remain available to their own game runtimes.
async function ensureJava(context, dependencies = {}) {
  const manager = dependencies.manager || Java, core = manager.core.java;
  const config = manager.normalizeSettings(context.settings?.runtimes?.java);
  const resolve = version => core.resolveBestInstalled({ userDataDir: context.userDataDir,
    line: 21, version, variant: "arm64", strictVariant: true, hostArch: "arm64" });
  context.signal?.throwIfAborted();
  let host = resolve(config.lines[21].defaultVersion) || resolve(null);
  if (!host) {
    if (dependencies.installedOnly === true)
      throw new Error("Apple Silicon Java 21 is not installed. Install Java 21 in Runtimes.");
    let version = config.lines[21].defaultVersion;
    if (!version) {
      await manager.refreshCatalog({ sectionId: "21", force: false, latestOnly: false,
        logger: context.logger, signal: context.signal });
      context.onRuntimeStateChange?.();
      version = manager.getState({ userDataDir: context.userDataDir, settings: config }).sections
        .find(section => section.id === "21")?.catalog?.versions?.[0];
    }
    context.signal?.throwIfAborted();
    if (!version) throw new Error("No Apple Silicon Java 21 runtime is available. Refresh Temurin in Runtimes.");
    const installOptions = { sectionId: "21", line: 21, variant: "arm64", strictVariant: true };
    await (dependencies.confirm || confirmToolInstall)(context, { manager, version, installOptions,
      label: "Java 21 (Apple Silicon)", requiresDownload: true, detail: "Required to run Android games." });
    await manager.installRuntime({ ...context, ...installOptions, version });
    context.onRuntimeStateChange?.();
    host = resolve(version);
  }
  context.signal?.throwIfAborted();
  if (!host?.javaPath || host.line !== 21 || host.variant !== "arm64" || host.requiresRosetta)
    throw new Error("Android games require Apple Silicon Java 21.");
  await context.useRuntime?.({ managerId: manager.id, version: host.version, sectionId: "21",
    variant: "arm64", sourcePath: host.installDir || host.javaHome || host.javaPath });
  return host;
}

function viewport(settings = {}) {
  const dimension = (value, fallback) => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 64 || value > 8192)
      throw new Error("Android window dimensions must be between 64 and 8192 pixels.");
    return value;
  };
  // Mac window requests use points; a 2x backing initially matches the tablet
  // reference. The native session fits the window and owns its real pixels.
  const display = deviceProfile.display, logicalScale = display.densityDpi / 160;
  return { width: dimension(settings.width, Math.round(display.width / logicalScale)),
    height: dimension(settings.height, Math.round(display.height / logicalScale)) };
}

function launchConfig(entry, prepared, payload, settings, graphicsEnvironment = {}, serviceProcess = false) {
  const activity = prepared.metadata.launchers[0]?.activity;
  if (!activity && !serviceProcess) throw new Error("The APK has no enabled launcher activity.");
  const presentationVersion = payload.profile?.canvasPresentationVersion;
  if (presentationVersion != null && presentationVersion !== 1)
    throw new Error("The Android Canvas presentation profile is unsupported.");
  const config = { schemaVersion: 1, runtimeRoot: payload.root,
    packageName: prepared.metadata.packageName, versionName: prepared.metadata.versionName || "unknown",
    versionCode: Number(prepared.metadata.versionCode || 0), ...(!serviceProcess ? { activityClass: activity } : {}),
    convertedJar: prepared.convertedJar, nativeRoot: prepared.nativeRoot, assetsRoot: prepared.assetsRoot,
    resourcesRoot: prepared.resourcesRoot, sourceApk: prepared.sourceApk,
    filesRoot: prepared.filesRoot, cacheRoot: prepared.cacheRoot,
    title: entry.name || prepared.metadata.label || prepared.metadata.packageName, ...viewport(settings) };
  if (payload.profile?.webLinksVersion != null && payload.profile.webLinksVersion !== 1)
    throw new Error("The Android web-link profile is unsupported.");
  if (payload.profile?.webLinksVersion === 1) config.webLinksAllowed = settings?.networkIsolation === false ? 1 : 0;
  if (payload.profile?.webViewVersion != null && payload.profile.webViewVersion !== 1)
    throw new Error("The Android web-view profile is unsupported.");
  if (payload.profile?.webViewVersion === 1) config.networkAllowed = settings?.networkIsolation === false ? 1 : 0;
  if (payload.profile?.adPolicyVersion != null && payload.profile.adPolicyVersion !== 1)
    throw new Error("The Android advertising policy profile is unsupported.");
  if (payload.profile?.adPolicyVersion === 1) config.allowAds = settings?.allowAds === true ? 1 : 0;
  if (payload.profile?.manualSensorVersion === 1) config.manualTilt = ["keyboard", "controller"].includes(settings?.manualTilt) ? settings.manualTilt : "off";
  if (!serviceProcess && payload.profile?.keyboardTouchVersion === 1) {
    config.touchJoystick = ["off", "wasd", "arrows", "wasd-arrows"].includes(settings?.touchJoystick) ? settings.touchJoystick : "wasd";
    for (const [key, fallback, minimum, maximum] of [["touchJoystickX", 18, 0, 100], ["touchJoystickY", 75, 0, 100], ["touchJoystickRadius", 12, 0.01, 50]]) {
      const value = settings?.[key] ?? fallback;
      if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error("Android touch joystick position and radius must be within their percentage ranges.");
      config[key] = Math.round(value * 100);
    }
  }
  if (prepared.sourceApks) {
    if (payload.profile?.splitApksVersion !== 1 || prepared.sourceApks.length < 1 ||
        prepared.sourceApks[0] !== prepared.sourceApk || prepared.sourceApks.some(file => path.dirname(file) !== path.dirname(prepared.sourceApk)))
      throw new Error("The prepared Android package set is invalid.");
    config.sourceApks = prepared.sourceApks.map(file => path.basename(file));
  }
  // Original PackageParser reads complete application/component metadata from these APKs.
  // Only the shared preparation service may nominate the graphics library.
  // It also marks this process as an explicit host before the JVM starts.
  if (graphicsEnvironment.DYLD_INSERT_LIBRARIES) {
    const libraries = [...new Set(graphicsEnvironment.DYLD_INSERT_LIBRARIES.split(path.delimiter).filter(Boolean))];
    if (graphicsEnvironment.RESHADE_EXPLICIT_HOST !== "1" || !libraries.length || libraries.some(file => !path.isAbsolute(file)))
      throw new Error("Android graphics preparation did not select an explicit GPU host.");
    // The JNI presenter takes one callable processor; DYLD retains all selected
    // adapters. Resolve the included processor by file identity when additional
    // adapters are selected, independently of their ordering or symlink names.
    let library = libraries[0];
    if (libraries.length > 1) {
      const core = fs.realpathSync(path.join(ReShade.runtimeRoot(), "libreshade-macos.dylib"));
      if (!libraries.some(file => fs.realpathSync(file) === core))
        throw new Error("Android graphics preparation did not select the included GPU processor.");
      library = core;
    }
    config.graphicsLibrary = library;
  }
  if (Buffer.byteLength(JSON.stringify(config) + "\n") > MAX_LAUNCH_CONFIG_BYTES)
    throw new Error("The Android launch configuration exceeds the supported size.");
  if (Object.entries(config).some(([key,value]) => typeof value === "string" && value.length > (key==="applicationActivitiesJson"?49152:16384)))
    throw new Error("An Android launch value exceeds the supported size.");
  return config;
}

function hostEnvironment(base = process.env) {
  return Sandbox.environment(base);
}

const nativeFailureMarkers=["FORTIFY: ","[linux-abi] fatal ","JNI FatalError called:",
  "JNI DETECTED ERROR IN APPLICATION","libc: Fatal signal ",
  "[6/libc] Fatal signal ","[7/libc] Fatal signal ","FATAL EXCEPTION:"];

function failureSummary(report) {
  const lines = report.toString("utf8").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").split(/\r?\n/).map(line => line.trim());
  const first=lines.findIndex(line=>/^(?:[\w$]+\.)*[\w$]*(?:Exception|Error)(?::|$)/.test(line)||
    /^#\s+(?:SIG[A-Z]+|EXCEPTION_|Internal Error)/.test(line)||nativeFailureMarkers.some(marker=>line.includes(marker)));
  if(first>=0){
    const failure=lines[first];
    const cause=/^(?:[\w$]+\.)*[\w$]*(?:Exception|Error)(?::|$)/.test(failure)?
      lines.slice(first+1).find(line=>line.startsWith("Caused by: ")):null;
    return [failure.replace(/^#\s*/,""),cause].filter(Boolean).join("\n").slice(0,2048);
  }
  return lines.filter(line => line && !/^(?:at |\[android-host\]|\[android-frame\]|\[thread |\[\.\.\.)/.test(line))
    .slice(-4).join("\n").slice(-2048);
}

function captureStderr(child, file, directory, logger, { frameSource = child.stderr, stop } = {}) {
  if (Number.isSafeInteger(child.pid) && child.pid > 0) {
    // The backend owns this actual child and its stderr. Carry generic Stop
    // through its existing token/RPC path so intent reaches this owner before
    // signaling, rather than only marking the frontend's process proxy.
    require("../../core/process-lifecycle").bindProcessStop(child, ({ pid }) => {
      if (stop) return stop();
      if (child.exitCode != null || child.signalCode != null) return false;
      return require("../../core/process-stop").stopProcessTree(pid);
    });
  }
  const limit = 32768;
  // Keep this launch's inode, not a path that removal or another launch may
  // replace after exit. Never recreate the app container during finalization.
  let output;
  let frameHistory;
  try {
    Writable.assertOwnDirectory(directory, path.dirname(file), { create: false });
    output = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  } catch (error) { logger?.error?.("[android] Cannot open runtime details: " + error.message); }
  try { frameHistory = require("./frame-history").open(path.dirname(file)); }
  catch (error) { logger?.warn?.("[android] Cannot open frame timing history: " + error.message); }
  const frameFiles = frameHistory?.files;
  const flushFrames = () => {
    try { frameHistory?.flush(); }
    catch (error) {
      try { frameHistory?.close(); } catch {}
      frameHistory = undefined;
      logger?.warn?.("[android] Cannot save frame timing history: " + error.message);
    }
  };
  const failureMarkers = ["# A fatal error has been detected by the Java Runtime Environment:",
    "[android-host] Failure:", "[android-host] Secondary failure:",...nativeFailureMarkers]
    .map(value => Buffer.from(value));
  const markerBytes = Math.max(...failureMarkers.map(value => value.length));
  const truncation = Buffer.from("\n[... runtime diagnostics truncated ...]\n");
  let tail = Buffer.alloc(0), fatalHead = null, fatalBytes = 0, probe = Buffer.alloc(0), complete = false, drainTimer, liveTimer, liveFailed = false;
  const reportBytes = () => fatalHead === null ? tail : fatalBytes <= limit ? tail.subarray(tail.length - fatalBytes) :
    Buffer.concat([fatalHead, truncation, tail.subarray(tail.length - (limit - fatalHead.length - truncation.length))]);
  const writeReport = report => {
    if (output == null) return;
    for (let offset = 0; offset < report.length;) {
      const count = fs.writeSync(output, report, offset, report.length - offset, offset);
      if (!count) throw new Error("The runtime log could not be written.");
      offset += count;
    }
    fs.ftruncateSync(output, report.length);
  };
  const flushLive = () => {
    liveTimer = undefined;
    if (complete) return;
    try { writeReport(reportBytes()); }
    catch (error) { liveFailed = true; logger?.warn?.("[android] Cannot update runtime details: " + error.message); }
    flushFrames();
  };
  child.completionDiagnostics = { pending: true, ...(frameFiles ? {frameLogFiles: frameFiles} : {}) };
  const frameData = (bytes, source = child.stderr) => {
    frameHistory?.feed(bytes, source);
    if (frameHistory && !liveTimer) { liveTimer = setTimeout(flushLive, 1000); liveTimer.unref?.(); }
  };
  const presentationFrames = bytes => frameData(bytes, frameSource);
  if (frameSource !== child.stderr) frameSource?.on("data", presentationFrames);
  const data = chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    frameData(bytes);
    tail = bytes.length >= limit ? Buffer.from(bytes.subarray(bytes.length - limit)) :
      Buffer.concat([tail.subarray(Math.max(0, tail.length + bytes.length - limit)), bytes]);
    if (fatalHead !== null) {
      fatalBytes += bytes.length;
      if (fatalHead.length < limit / 2)
        fatalHead = Buffer.concat([fatalHead, bytes.subarray(0, limit / 2 - fatalHead.length)]);
    } else {
      const input = Buffer.concat([probe, bytes]);
      const matches = failureMarkers.map(marker => input.indexOf(marker)).filter(offset => offset !== -1);
      const start = matches.length ? Math.min(...matches) : -1;
      if (start !== -1) {
        fatalBytes = input.length - start;
        fatalHead = Buffer.from(input.subarray(start, start + limit / 2));
        probe = Buffer.alloc(0);
      } else probe = Buffer.from(input.subarray(Math.max(0, input.length - markerBytes + 1)));
    }
    // One bounded snapshot per second, on the backend worker. Idle games do
    // no log I/O; the retained inode also survives container removal safely.
    if ((output != null && !liveFailed || frameHistory) && !liveTimer) { liveTimer = setTimeout(flushLive, 1000); liveTimer.unref?.(); }
  };
  const streamError = error => data("\nRuntime stderr could not be read: " + error.message + "\n");
  const close = (code, signal) => {
    if (complete) return;
    complete = true; clearTimeout(drainTimer); clearTimeout(liveTimer);
    child.stderr?.removeListener("data", data); child.stderr?.removeListener("error", streamError);
    if (frameSource !== child.stderr) frameSource?.removeListener("data", presentationFrames);
    child.removeListener?.("exit", exited);
    child.removeListener?.("close", close);
    const report = reportBytes();
    const expectedStop = child.stopRequested === true &&
      (signal === "SIGTERM" && code == null || !signal && (code === 0 || code === 143));
    const failed = fatalHead !== null || !expectedStop && (code !== 0 || Boolean(signal));
    child.completionDiagnostics = { pending: false, logFile: file, ...(frameFiles ? {frameLogFiles: frameFiles} : {}),
      ...(failed && report.length ? { message: failureSummary(report) } : {}) };
    try {
      writeReport(report);
      // A guest teardown callback may call System.exit(0) after the host has
      // already reported a failure. Preserve that diagnostic independently
      // of the guest's chosen exit status.
      const detail = child.completionDiagnostics.message;
      if (fatalHead !== null) logger?.error?.(`[android] Runtime reported a failure (${signal || code}). ${detail || ""}\nDetails: ${file}`);
      else if (failed && tail.length) logger?.error?.(`[android] Runtime exited (${signal || code}). ${detail || ""}\nDetails: ${file}`);
    } catch (error) { logger?.error?.("[android] Cannot save runtime details: " + error.message); }
    finally {
      flushFrames(); try { frameHistory?.close(); } catch {}
      frameHistory = undefined;
      if (output != null) { try { fs.closeSync(output); } catch {} output = undefined; }
    }
    tail = probe = Buffer.alloc(0); fatalHead = null; fatalBytes = 0;
    child.stderr?.destroy?.();
    child.emit?.("diagnostics");
  };
  // Drain normal pipe closure immediately. A descendant retaining stderr must
  // not keep diagnostic listeners or the failure banner pending indefinitely.
  const exited = (code, signal) => { drainTimer = setTimeout(() => close(code, signal), 1000); drainTimer.unref?.(); };
  child.stderr?.on?.("data", data);
  child.stderr?.on?.("error", streamError);
  child.once?.("exit", exited);
  child.once?.("close", close);
  if (child.exitCode != null || child.signalCode != null) exited(child.exitCode, child.signalCode);
  child.stderr?.unref?.();
  return child;
}

function presentationEnvironment(payload, context, graphics = {}, dependencies = {}) {
  return payload.profile?.canvasPresentationVersion === 1 ? {
    DYLD_INSERT_LIBRARIES: graphics.DYLD_INSERT_LIBRARIES || (dependencies.resolvePresentationLibrary || ReShade.resolvePresentationLibrary)({ app: context.app }),
    RESHADE_EXPLICIT_HOST: "1"
  } : {};
}

function angleBackend(context, payload) {
  const selected = context.runtimeSettings?.angleBackend ?? "metal";
  if (!["metal", "vulkan"].includes(selected)) throw new Error("Select Metal or Vulkan for the Android OpenGL ES backend.");
  if (selected === "vulkan" && payload.profile?.angleVulkanVersion !== 1)
    throw new Error("The included Android runtime does not contain the ANGLE Vulkan backend.");
  return selected;
}

function serviceLauncher(context, payload, java, presentation, dependencies = {}, privateOutput = false) {
  const blockNetwork = require("./launch-policy").networkBlocked(context);
  const renderer = angleBackend(context, payload);
  const vulkan = (dependencies.resolveVulkan || require("../shared/vulkan").resolve)(context);
  const hostClasspath = [path.join(payload.root, "android-host.jar"), path.join(payload.root, "android-framework.jar")];
  return async (service, fields, stdio, sandboxOptions) => {
        const serviceConfig = { ...launchConfig({ name: service.record.packageName }, service.prepared, payload,
          { ...context.runtimeSettings, networkIsolation: blockNetwork }, presentation, true), webLinksAllowed: 0, ...fields };
        await PackageMetadata.applyLaunchIdentity(serviceConfig, {
          gameId: require("./service-packages").codeId(service.record.packageName), gamePath: service.prepared.sourceApk,
          name: service.record.packageName, moduleData: { packageName: service.record.packageName }
        }, service.prepared, payload, java, { ...context, metadataSourceIdentity: PackageMetadata.preparedSourceIdentity(service.prepared) });
        if (serviceConfig.networkAllowed != null) serviceConfig.networkAllowed = blockNetwork ? 0 : 1;
        if (Buffer.byteLength(JSON.stringify(serviceConfig) + "\n") > MAX_LAUNCH_CONFIG_BYTES)
          throw new Error("The Android service configuration exceeds the supported size.");
        Writable.atomicWrite(service.storage.launchFile, JSON.stringify(serviceConfig) + "\n", { root: service.storage.root });
        const isolated = await (dependencies.prepareSandbox || Sandbox.prepareSandbox)({ javaPath: java.javaPath,
          config: serviceConfig, configFile: service.storage.launchFile, dataRoot: service.storage.dataRoot,
          userDataDir: context.userDataDir, processIdentityVersion: payload.profile?.processIdentityVersion,
          signal: context.signal, blockNetwork, graphics: presentation, vulkan, angleBackend: renderer, ...sandboxOptions });
        context.signal?.throwIfAborted();
        const query=require("./process-channel").prepareProcessQuerySpawn(
          { cwd: service.prepared.filesRoot, env: { ...isolated.environment, ...isolated.graphics }, executablePath: isolated.executablePath || java.javaPath, networkIsolationApplied: true, stdio },
          path.join(payload.root,"native/android-supervisor-send"));
        const child = await (dependencies.spawnService || require("../../core/processes").spawnDetachedChecked)(isolated.command,
          [...isolated.prefix, ...isolated.javaArguments, ...frameworkJvmOptions, ...applicationJvmOptions(payload), ...conversionJvmOptions(payload), "-XstartOnFirstThread", ...PackageMetadata.dockArguments(serviceConfig), "-XX:+ErrorFileToStderr",
            "-cp", [require("./text-input").materialize(service.prepared.cacheRoot),...hostClasspath].join(path.delimiter), "maclauncher.android.ServiceHost", "--config", service.storage.launchFile],
          query.options, false,
          { onProcessSpawn: process => context.onToolProcessSpawn?.(process, { stopOnLauncherExit: true }) });
        query.attach(child);
        if (privateOutput) { if (typeof privateOutput === "function") child.stderr?.on("data", privateOutput); child.stderr?.on("error", () => {}); child.stderr?.resume(); return child; }
        return captureStderr(child, service.storage.logFile, service.storage.root, context.logger);
      };
}

async function launch(entry, context, payload, dependencies = {}) {
  const execution = require("./launch-policy").execution(context);
  if (execution === "art") return (await import("./art/launch.mjs")).launch(entry, context, payload, dependencies);
  const timing = createLaunchTiming(context.logger);
  viewport(context.runtimeSettings);
  let renderer = angleBackend(context, payload);
  const java = await timing.measure("java", () => ensureJava(context, dependencies));
  const platformPayload = await timing.measure("platform-runtime", () =>
    require("./launch-policy").resolvePlatformRuntime({ context, payload },
      { resolvePlatformRuntime: async () => payload, ...dependencies }));
  const profileReservation = await timing.measure("platform-owners", () =>
    require("./service-processes").reserveProfileOwners({
      ...require("./launch-policy").serviceOptions({context,payload,platformPayload,java}),signal:context.signal }));
  let prepared, release = () => {};
  const {retireAll, stopProcess, requireRetired} = await import("./art/process-retirement.mjs");
  let services, installedPreparation, installedRetirement, nativeComposition, child, history, config, retirement;
  const releaseInstalled = () => installedRetirement ??= Promise.resolve().then(async () => (await installedPreparation)?.release?.());
  const requireConsumersRetired = () => {
    requireRetired([child]); services?.requireRetired?.(); nativeComposition?.requireRetired?.();
  };
  const close = () => {
    retirement ??= Promise.resolve().then(() => retireAll([
      () => stopProcess(child),
      () => services ? services.close() : releaseInstalled(),
      () => nativeComposition?.close(),
      () => { requireConsumersRetired(); return profileReservation.close(); },
      () => { requireConsumersRetired(); return release(); }
    ]));
    if (child) child.runtimeRetirement = retirement;
    return retirement;
  };
  try {
  prepared = await timing.measure("package", () => (dependencies.prepare || prepareApk)(entry, { userDataDir: context.userDataDir,
    payload, java, signal: context.signal, onToolProcessSpawn: context.onToolProcessSpawn, retain: true }));
  release = prepared.root ? await retainPrepared(prepared) : () => {};
  if (prepared.nativeRoot) await timing.measure("runtime-image", () =>
    (dependencies.prepareRuntimeImage || require("./runtime-image").prepare)({ payload, context,
      nativeAbi: require("./native-abi").fromDirectory(prepared.nativeRoot) }));
  // Installed packages do not depend on the game's display metadata or effects.
  // Start that existing preparation once while those independent inputs resolve.
  installedPreparation = timing.measure("installed-packages", () =>
    (dependencies.prepareInstalledServices || require("./service-packages").prepareInstalled)(entry,
      prepared, context, payload, java));
  installedPreparation.catch(() => {});
  let graphics = await timing.measure("graphics", () => context.getGameEffectsEnvironment());
  if (graphics.RESHADE_RESOLUTION_MULTIPLIER != null && payload.profile?.producerResolutionVersion !== 1) {
    context.logger?.warn?.("[android] Render resolution control is unavailable; using Auto for this launch.");
    graphics = { ...graphics }; delete graphics.RESHADE_RESOLUTION_MULTIPLIER;
  }
  const presentation = presentationEnvironment(payload, context, graphics, dependencies);
  let vulkan = await timing.measure("vulkan", () => (dependencies.resolveVulkan || require("../shared/vulkan").resolve)(context));
  ({ renderer, vulkan } = await timing.measure("gles-provider", () => require("./graphics-selection").resolveGraphics(
    entry, context, payload, prepared.metadata, { renderer, vulkan }, dependencies)));
  if (payload.profile?.canvasPresentationVersion === 1 && !graphics.DYLD_INSERT_LIBRARIES) {
    graphics = { ...graphics, ...presentation };
  }
  config = launchConfig(entry, prepared, payload, context.runtimeSettings, graphics);
  await timing.measure("metadata", () => PackageMetadata.applyLaunchIdentity(config, entry, prepared, payload, java, context));
  if (payload.profile?.mediaInputsVersion === 1) {
    await timing.measure("media-inputs", () => require("./media-inputs").configureLaunch(config, entry, context, payload, dependencies.mediaSelection));
  }
  const browser = require("./web-links").prepareLaunch(config, context, dependencies);
  const blockNetwork = require("./launch-policy").networkBlocked(context);
  if (config.networkAllowed != null) config.networkAllowed = blockNetwork ? 0 : 1;
  const hostJar = path.join(payload.root, "android-host.jar");
  if (!fs.lstatSync(hostJar).isFile()) throw new Error("The included Android host is missing.");
  const hostClasspath = [require("./text-input").materialize(prepared.cacheRoot),hostJar];
  const ArgumentTransport = require("./launch-arguments");
  const argumentAgent = ArgumentTransport.prepareAgent(context);
  if (payload.profile?.frameworkBaseVersion === 1) hostClasspath.push(path.join(payload.root, "android-framework.jar"));
  let storage = Storage.storagePaths(context.userDataDir, entry.gameId);const directory = storage.root;
  Writable.assertOwnDirectory(context.userDataDir, directory);
  const installed = await installedPreparation;
  const compositionOptions=dependencies.nativeComposition===true?{}:dependencies.nativeComposition;
  if(compositionOptions){
    if(renderer!=="metal")throw new Error("Native Android composition requires the Metal OpenGL ES backend.");
    nativeComposition=await timing.measure("composition",async()=>
      (await import("./composition-session.mjs")).prepareCompositionSession({context,payload,prepared,storage,config,graphics,installed,dependencies:{...dependencies,...compositionOptions}}));
    Object.assign(config,nativeComposition.config);
  }
  if(payload.profile?.googleProviderCompatibilityVersion===1)config.googleProviderCompatibility=installed?.google?.enabled?1:0;
  if (installed) {
    services = await timing.measure("service-connections", () => (dependencies.prepareServiceConnections || require("./service-processes").prepareConnections)({
      userDataDir:context.userDataDir, installed: {...installed, release: releaseInstalled}, game: prepared, config, signal: context.signal, logger: context.logger,
      ...require("./launch-policy").serviceOptions({context, payload, platformPayload, java, installed}),
      profileReservation,
      ...(nativeComposition?{platformOwners:{composition:nativeComposition}}:{}),
      launchService: serviceLauncher(context, payload, java, presentation, dependencies)
    }));
  }
  if(payload.profile?.processExitHistoryVersion!=null&&payload.profile.processExitHistoryVersion!==1)
    throw new Error("The Android process history profile is unsupported.");
  history=payload.profile?.processExitHistoryVersion===1?ProcessHistory.open(directory,config.packageName):null;
  if(history)config.processExitHistoryJson=history.json;
  if(Buffer.byteLength(JSON.stringify(config)+"\n")>MAX_LAUNCH_CONFIG_BYTES)
    throw new Error("The Android launch configuration exceeds the supported size.");
  const file = path.join(directory, "launch.json");
  Writable.atomicWrite(file, JSON.stringify(config) + "\n", { root: directory });
  const log = path.join(directory, "runtime.log");
  Writable.atomicWrite(log, "", { root: directory });
  context.signal?.throwIfAborted();
  context.logger?.info?.("[android] Launching " + config.packageName + " with Java 21 and Klepton");
  context.logger?.info?.("[android] Java: " + java.javaPath + "; runtime: " + payload.root);
  const isolated = await timing.measure("sandbox", () => (dependencies.prepareSandbox || Sandbox.prepareSandbox)({ javaPath: java.javaPath,
    config, configFile: file, dataRoot: storage.dataRoot, graphics, vulkan, signal: context.signal,
    userDataDir: context.userDataDir, processIdentityVersion: payload.profile?.processIdentityVersion,
    blockNetwork, angleBackend: renderer, argumentAgent, ...services?.sandbox }));
  context.signal?.throwIfAborted();
  // The launch context adds effects immediately before spawning. Replace only
  // this launch's prepared environment with its private resources and outputs.
  const originalEffects = context.getGameEffectsEnvironment;
  const launchedAt = Date.now();
  try {
    context.getGameEffectsEnvironment = async () => isolated.graphics;
    let stdio=services ? services.stdio(["ignore", "ignore", "pipe", config.webLinksAllowed == null ? "ignore" : "pipe"]) :
        config.webLinksAllowed == null ? ["ignore", "ignore", "pipe"] : ["ignore", "ignore", "pipe", "pipe"];
    if(nativeComposition)stdio=nativeComposition.stdio(stdio);
    const query=require("./process-channel").prepareProcessQuerySpawn({ cwd: prepared.filesRoot, env: ArgumentTransport.environment(context, isolated.environment),
      executablePath: isolated.executablePath || java.javaPath, graphicsExecutable: isolated.executablePath || java.javaPath, networkIsolationApplied: true,
      stdio },
      path.join(payload.root,"native/android-supervisor-send"));
    child = await timing.measure("spawn", () => context.spawnDetachedChecked(isolated.command, [...isolated.prefix, ...isolated.javaArguments,
      ...frameworkJvmOptions, ...applicationJvmOptions(payload), ...ArgumentTransport.jvmOptions(argumentAgent), ...conversionJvmOptions(payload), "-XstartOnFirstThread", ...PackageMetadata.dockArguments(config), "-XX:+ErrorFileToStderr", "-cp", hostClasspath.join(path.delimiter),
      "maclauncher.android.Host", "--config", file], query.options));
    query.attach(child);
    if (services) {
      try { await timing.measure("connect", () => services.connect(child,nativeComposition?{presentation:nativeComposition.composition.presenter}:{})); }
      catch (error) { if (child.exitCode == null && child.signalCode == null) child.kill(); throw error; }
    }
  } finally { context.getGameEffectsEnvironment = originalEffects; }
  timing.finish();
  browser.attach(child, { executablePath: isolated.executablePath || java.javaPath, launchedAt });
  // The sandbox execs Java in place, preserving this PID. Activate that owned
  // Java window asynchronously once it appears, using the shared native policy.
  void Promise.resolve().then(() => (dependencies.focusOwnedNativeGame ||
    require("../shared/runtime/native-focus").focusOwnedNativeGame)(nativeComposition?.presentation.child||child,
      { executablePath: nativeComposition?.presentation.executablePath||isolated.executablePath||java.javaPath, launchedAt:nativeComposition?.presentation.launchedAt||launchedAt, logger: context.logger }))
    .catch(error => context.logger?.warn?.("[android] Window activation: " + error.message));
  const finished = (code=child.exitCode, signal=child.signalCode) => {
    child.removeListener?.("exit", finished); child.removeListener?.("close", finished);
    if(history)try{history.recordExit({pid:child.pid,processName:config.processName||config.packageName,
      uid:process.getuid(),code,signal});}catch(error){context.logger?.warn?.("[android] Cannot save process history: "+error.message);}
    void close().catch(error => context.logger?.warn?.("[android] JVM process retirement: " + error.message));
  };
  child.once?.("exit", finished); child.once?.("close", finished);
  if (child.exitCode != null || child.signalCode != null) finished();
  return captureStderr(child, log, directory, context.logger,{
    ...(nativeComposition?{frameSource:nativeComposition.composition.presenter.stderr}:{}),
    stop: async () => { await close(); return true; }
  });
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { context.logger?.warn?.("[android] JVM process retirement: " + cleanupError.message); }
    throw error;
  }
}

module.exports = { ensureJava, viewport, launchConfig, hostEnvironment, captureStderr, presentationEnvironment, angleBackend, serviceLauncher, launch };

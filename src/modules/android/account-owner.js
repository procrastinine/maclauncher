const fs = require("node:fs"), path = require("node:path");
const Java = require("../java/runtime/java-runtime-manager");
const Runtime = require("./runtime"), Host = require("./host");
const Catalog = require("./service-packages"), Storage = require("./storage"), Sandbox = require("./sandbox");
const Writable = require("../shared/writable-input"), Processes = require("../../core/processes");
const { frameworkJvmOptions } = require("./jvm-options");
const { createAccountControl } = require("./account-control");

const unavailable = (code = "ACCOUNT_OWNER_UNAVAILABLE") => Object.assign(new Error("The Android account service is unavailable."), { code });
const alive = child => child && child.exitCode == null && child.signalCode == null;
const ignoreError = () => {};

async function retire(owner) {
  if (owner.stopping) return owner.stopping;
  owner.closed = true; owner.controller.abort(); owner.control?.close();
  owner.child?.stdio?.[6]?.destroy(); owner.child?.stdio?.[5]?.end();
  return owner.stopping = (async () => {
    const child = owner.child;
    if (alive(child)) await new Promise(resolve => {
      const done = () => { clearTimeout(timer); child.removeListener("exit", done); child.removeListener("close", done); resolve(); };
      const timer = setTimeout(() => { if (alive(child)) { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } } }, 2000);
      timer.unref?.(); child.once("exit", done); child.once("close", done); if (!alive(child)) done();
    });
    for (const [target, event, listener] of owner.listeners) target.removeListener(event, listener);
    child?.stdio?.[5]?.destroy(); child?.stdio?.[6]?.destroy();
    await owner.diagnosticsDone;child?.stderr?.destroy();
    await owner.services?.close(); await Promise.allSettled(owner.releases.map(release => release()));
  })();
}

function installedJava(context) {
  const settings = Java.normalizeSettings(context.settings?.runtimes?.java);
  const resolve = version => Java.core.java.resolveBestInstalled({ userDataDir: context.userDataDir,
    line: 21, version, variant: "arm64", strictVariant: true, hostArch: "arm64" });
  const java = resolve(settings.lines[21].defaultVersion) || resolve(null);
  if (!java?.javaPath || java.line !== 21 || java.variant !== "arm64" || java.requiresRosetta)
    throw unavailable("ACCOUNT_JAVA_UNAVAILABLE");
  return java;
}

async function start(owner, context, request) {
  const { userDataDir, record, java, payload, blockNetwork, allowAds, dependencies, brokerStorage, lockFd } = request;
  const signal = owner.controller.signal;
  owner.stages = require("./account-stages").create();
  owner.startupStage = "prepare-account-runtime";
  const sharedFramework = payload.profile?.frameworkServicesVersion === 1;
  const framework = path.join(payload.root, "android-framework.jar");
  let sources=[framework],code=payload.root;
  if (!sharedFramework) {
    const source = await Catalog.retainSource(userDataDir, record.packageName, signal);
    code=source.root;sources=source.sources;owner.releases.push(source.release);
  }
  // Keep the original account database location. Its historical directory key
  // does not make an authenticator APK the owner of Android system services.
  const dataId = require("./account-storage").dataId(sharedFramework ? undefined : record.packageName);
  const entry = { gameId: dataId, name: "Android services",
    runtimeSettings: { klepton: { googleIntegration: true } },
    gamePath: sources.length === 1 ? sources[0] : code,
    ...(sources.length > 1 ? { moduleData: { packageSet: true } } : {}) };
  // Android's original account service is a system process. Authenticator APKs
  // are ordinary clients/providers, never the owner of system-server authority.
  owner.startupStage = "prepare-account-storage";
  const storage = await Storage.prepareStorage(entry, userDataDir, { signal, payloadRoot: payload.root });
  const prepared = { root: payload.root, sourceApk: framework, sourceApks: [framework],
    convertedJar: framework, nativeRoot: path.join(payload.root, "native"),
    assetsRoot: payload.root, resourcesRoot: payload.root,
    filesRoot: storage.filesRoot, cacheRoot: storage.cacheRoot,
    metadata: { packageName: "android", applicationProcessName: "android.accounts",
      versionName: "16", versionCode: 1, launchers: [] } };
  signal.throwIfAborted();
  const processName = prepared.metadata.applicationProcessName;
  owner.startupStage = "prepare-account-configuration";
  const presentation = Host.presentationEnvironment(payload, context);
  const config = { ...Host.launchConfig(entry, prepared, payload, { networkIsolation: blockNetwork, allowAds }, presentation, true),
    serviceProcess: 1, accountService: 1, ...(record ? { accountProviderPackage: record.packageName } : {}), processName, authorityFd: 5, accountControlFd: 6,
    title: "Android accounts", ...(brokerStorage ? { accountSocketPath: brokerStorage.platformSocket } : {}),
    webLinksAllowed: 0 };
  if (config.networkAllowed != null) config.networkAllowed = blockNetwork ? 0 : 1;
  if(payload.profile?.googleProviderCompatibilityVersion===1)config.googleProviderCompatibility=1;
  const processContext = { ...context, userDataDir, signal, networkAllowed: !blockNetwork,
    runtimeSettings: { networkIsolation: blockNetwork, allowAds } };
  owner.startupStage = "prepare-installed-packages";
  const installed = await Catalog.prepareInstalled(entry, prepared, processContext, payload, java, { uid: 1000 });
  owner.startupStage = "prepare-connections";
  owner.services = await require("./service-processes").prepareConnections({ userDataDir, installed, game: prepared, config, signal,
    processIdentityVersion: payload.profile?.processIdentityVersion,
    lazyProfileServicesVersion: payload.profile?.lazyProfileServicesVersion,
    serviceOwners: { account: { packageName: "android", processName } },
    descriptorSender: path.join(payload.root, "native/android-supervisor-send"),
    platformOptions: payload.profile?.platformServicesVersion === 1 ? {
      userDataDir, runtimeRoot: payload.root, runtimeIdentity: payload.runtimeIdentity, javaPath: java.javaPath, moduleRoot: __dirname,
      systemServices: payload.profile?.systemServicesVersion === 1
    } : undefined,
    launchService: (() => {
      const launch = Host.serviceLauncher(processContext, payload, java, presentation, dependencies, bytes => owner.stages.write(bytes));
      return (service, fields, stdio, sandbox) => {
        const inherited = [...stdio]; if (lockFd != null) inherited[4] = lockFd;
        return launch(service, fields, inherited, sandbox);
      };
    })() });
  const json = JSON.stringify(config) + "\n";
  if (Buffer.byteLength(json) > 64 * 1024) throw unavailable();
  owner.startupStage = "prepare-account-sandbox";
  Writable.atomicWrite(storage.launchFile, json, { root: storage.root });
  const isolated = await Sandbox.prepareSandbox({ javaPath: java.javaPath, config, configFile: storage.launchFile,
    userDataDir, processIdentityVersion: payload.profile?.processIdentityVersion,
    dataRoot: storage.dataRoot, signal, blockNetwork, graphics: presentation, ...owner.services.sandbox,
    ...(brokerStorage ? { accountCodeRoot: path.join(userDataDir, "android", "apps"), localSockets: { ...owner.services.sandbox.localSockets, listen: [brokerStorage.platformSocket] } } : {}) });
  signal.throwIfAborted();
  const controlOverlay = await require("./store/custom-account-token").materializeControl(context, payload, java, storage.cacheRoot);
  const classpath = [controlOverlay, require("./text-input").materialize(storage.cacheRoot), path.join(payload.root, "android-host.jar"), path.join(payload.root, "android-framework.jar")];
  owner.startupStage = "spawn-account-owner";
  const query=require("./process-channel").prepareProcessQuerySpawn(
    { cwd: prepared.filesRoot, env: { ...isolated.environment, ...isolated.graphics }, executablePath: isolated.executablePath || java.javaPath, networkIsolationApplied: true,
      stdio: owner.services.stdio(["ignore", "ignore", "pipe", "ignore", lockFd ?? "ignore", "pipe", "pipe"]) },
    path.join(payload.root,"native/android-supervisor-send"));
  const child = await (dependencies.spawn || Processes.spawnDetachedChecked)(isolated.command,
    [...isolated.prefix, ...isolated.javaArguments, ...frameworkJvmOptions, "-XstartOnFirstThread", ...require("./package-metadata").dockArguments(config), "-XX:+ErrorFileToStderr",
      "-cp", classpath.join(path.delimiter), "maclauncher.android.Host", "--config", storage.launchFile],
    query.options, false,
    { onProcessSpawn: child => {
      owner.child = child;
      owner.diagnosticsDone=new Promise(resolve=>{
        if(!child.stderr||child.stderr.readableEnded||child.stderr.destroyed)return resolve();
        child.stderr.once("end",resolve);child.stderr.once("close",resolve);child.once("close",resolve);
      });
      // Guest stderr can contain credentials. Drain it without persistence/logging.
      child.stderr?.on("data", bytes => owner.stages.write(bytes));
      child.stderr?.on("error", ignoreError); child.stderr?.resume();
      child.stdio?.[5]?.on("error", ignoreError); child.stdio?.[6]?.on("error", ignoreError);
      return context.onToolProcessSpawn?.(child, { stopOnLauncherExit: true });
    } });
  query.attach(child);
  owner.child = child;
  signal.throwIfAborted();
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || !alive(child)) throw unavailable();
  owner.control = createAccountControl({ child, control: child.stdio[6] });
  const ended = () => { void retire(owner); };
  for (const [target, event] of [[child, "exit"], [child, "close"], [child, "error"],
    [child.stdio[5], "error"], [child.stdio[5], "end"], [child.stdio[5], "close"],
    [child.stdio[6], "error"], [child.stdio[6], "end"], [child.stdio[6], "finish"], [child.stdio[6], "close"]]) {
    target.on(event, ended); owner.listeners.push([target, event, ended]);
  }
  owner.startupStage = "connect-platform";
  owner.identity=await owner.services.connect(child);
  signal.throwIfAborted();
  return owner.control;
}


/** One runtime adapter under the shared profile broker; no process-local database registry. */
async function startProfileService(config, storage, lockFd, dependencies = {}) {
  const owner = { controller: new AbortController(), releases: [], listeners: [], closed: false,
    startupStage: "resolve-profile-storage" };
  try {
    const userDataDir = fs.realpathSync(config.userDataDir);
    owner.startupStage = "read-provider-catalog";
    const record = Catalog.read(userDataDir).packages.find(item => item.enabled && item.packageName === "com.google.android.gms");
    owner.startupStage = "resolve-account-runtime";
    const payload = dependencies.payload || Runtime.resolve({ root: config.runtimeRoot }, config.runtimeIdentity);
    if (!record && payload.profile?.frameworkServicesVersion !== 1) throw unavailable("ACCOUNT_PROVIDER_MISSING");
    const java = { javaPath: config.javaPath, line: 21, variant: "arm64", requiresRosetta: false };
    await start(owner, { userDataDir, signal: owner.controller.signal }, { userDataDir, record, java, payload,
      // This original system service owns local account state only. Authenticator
      // children receive request policy independently through their service owner.
      blockNetwork: false, allowAds: false, dependencies, brokerStorage: storage, lockFd });
    const child = owner.child;
    const identity = { packageName: "android", processName: "android.accounts", pid: owner.identity.pid, hostPid:owner.identity.hostPid, uid: 1000,
      hostUid: process.getuid(), securityContext: "u:r:system_server:s0",
      ...(payload.profile?.frameworkServicesVersion === 1 ? {frameworkServicesVersion:1} : {}) };
    const ready = (async()=>{
      if(payload.profile?.frameworkServicesVersion === 1){
        owner.startupStage = "retain-applications";
        const applications=await Catalog.retainApplications(userDataDir,owner.controller.signal);
        owner.releases.push(applications.release);
        if(applications.unavailablePackages?.length)console.warn("Android application APKs unavailable: "+applications.unavailablePackages.slice(0,16).join(", ")+(applications.unavailablePackages.length>16?" ("+applications.unavailablePackages.length+" total)":""));
        owner.startupStage = "initialize-services";
        await owner.control.request("initializeServices",{packages:applications.packages});
      }
      owner.startupStage = "read-accounts";
      const result = await owner.control.request("accounts");owner.startupStage = "ready";return result;
    })().catch(async error=>{
      // Cleanup deliberately closes the service process. Preserve the actual
      // structured startup rejection before that close can report exit zero.
      owner.startupError=error;
      if(error.providerFailureType)error.message="The Android account service stopped ("+error.providerFailureType+(error.providerFailureSite?" at "+error.providerFailureSite:"")+").";
      // A failed bootstrap retires its exact child before observing stderr's
      // final exception sites. Provider messages and account values stay private.
      await retire(owner);
      const failure=owner.stages.snapshot().failure;
      if(failure){
        error.message="The Android account service stopped ("+require("./account-stages").describeFailure(failure)+").";
        error.providerFailureType=failure.type;error.accountFailure=failure;
      }
      throw error;
    });ready.catch(ignoreError);
    return { child, identity, ready,
      enroll: (peer, authorization) => owner.control.request("enroll", { peer, authorization }),
      retire: peer => owner.control.request("retire", { peer }),
      accountStages: () => owner.stages.snapshot(),
      startupFailure:()=>owner.startupError||null,
      startupStage:()=>owner.startupStage,
      failureDiagnostics:()=>owner.stages.snapshot().failure||null,
      request: async (command, value, context = {}) => {
        const done = owner.stages.begin(command);
        try { const result = await owner.control.request(command, value, context); done(true); return result; }
        catch (error) { done(false); throw error; }
      },
      close: () => retire(owner) };
  } catch (error) {
    // The broker cannot inspect an adapter which has not returned. Preserve
    // this actual phase before cleanup, including failures before spawning a
    // JVM; the original exception and private provider output stay unchanged.
    try { Object.defineProperty(error, "platformStartupStage", { value: owner.startupStage, configurable: true }); } catch {}
    await retire(owner); throw error;
  }
}

async function acquire(context, { blockNetwork = true, access = blockNetwork ? "read" : "manage" } = {}, dependencies = {}) {
  context.signal?.throwIfAborted();
  const userDataDir = fs.realpathSync(context.userDataDir);
  const payload = dependencies.resolveRuntime ? await dependencies.resolveRuntime({ signal: context.signal }) :
    await require("./account-runtime").resolveForAccounts(context, { install: !blockNetwork });
  if (payload.profile?.accountControlVersion !== 1 || payload.profile?.accountActivityVersion !== 1)
    throw unavailable("ACCOUNT_RUNTIME_UNAVAILABLE");
  const java = dependencies.java || (blockNetwork ? installedJava({ ...context, userDataDir }) : await Host.ensureJava(context, dependencies));
  const lease = await (dependencies.acquireBroker || require("./platform-services/client").acquire)({
    userDataDir, runtimeRoot: payload.root, runtimeIdentity: payload.runtimeIdentity, javaPath: java.javaPath, moduleRoot: __dirname,
    signal: context.signal, role: "accounts", access });
  let released = false;
  const release = () => { if (!released) { released = true; context.signal?.removeEventListener("abort", release); lease.close(); } };
  context.signal?.addEventListener("abort", release, { once: true });
  if (context.signal?.aborted) { release(); context.signal.throwIfAborted(); }
  return { ...lease, request(command, value = null, options = {}) {
    if (released) return Promise.reject(unavailable("ACCOUNT_LEASE_RELEASED"));
    const signal = options.signal || context.signal;
    signal?.throwIfAborted();
    const abort = () => release(); signal?.addEventListener("abort", abort, { once: true });
    return lease.request(command, value, { networkAllowed: options.networkAllowed ?? !blockNetwork })
      .finally(() => signal?.removeEventListener("abort", abort));
  }, release, close: release };
}
/** Explicit uninstall reaches the same original grant owner before data is
 * deleted. Older live account owners have never owned URI grants. */
async function removePackages(context, packages, dependencies = {}) {
  if(!packages.length)return;
  const payload=await (dependencies.resolveForAccounts||require("./account-runtime").resolveForAccounts)(context,{install:false});
  if(payload.profile?.frameworkServicesVersion!==1)return;
  const owner=await (dependencies.acquire||acquire)(context,{blockNetwork:true,access:"manage"},{resolveRuntime:async()=>payload});
  try{if(owner.identity.frameworkServicesVersion===1)await owner.request("removePackages",{packages});}
  finally{owner.release();}
}
module.exports = { acquire, startProfileService, removePackages };

const path = require("node:path"), { spawn } = require("node:child_process");
const { receive, send, processIdentity } = require("../process-channel");
const { privateDirectory, writePrivate } = require("./paths");
const Stages = require("../account-stages");

/** The inherited descriptor authenticates one physical JVM. Java validates the
 * same PID before admitting its platform identity or reading later commands. */
async function connectAuthority(child, role = "keystore", bootCount, processIdentityVersion = 0) {
  if (!["system", "keystore", "composition"].includes(role)) throw Error("Unknown Android platform service.");
  const ids = await processIdentity(child, { version: processIdentityVersion }), system = role === "system", composition = role === "composition";
  const identity = { packageName: system || composition ? "android" : "android.keystore",
    processName: composition ? "android.composition" : system ? "android.system" : "android.keystore", ...ids,
    uid: system || composition ? 1000 : 1017, hostUid: process.getuid(),
    securityContext: system || composition ? "u:r:system_server:s0" : "u:r:keystore:s0" };
  if (system && bootCount !== undefined) identity.bootCount = bootCount;
  const authority = child.stdio[5], pending = new Map();
  let serial = 0, stopped = false, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const fail = error => {
    if (stopped) return; stopped = true; rejectReady(error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  child.once("error", fail);
  child.once("exit", () => fail(Error("Android platform service stopped.")));
  receive(authority, value => {
    if (value.op === "ready") {
      if (system && value.processStateVersion === 1) identity.processStateVersion = 1;
      if (system && value.packageSourceLifetimeVersion === 1) identity.packageSourceLifetimeVersion = 1;
      resolveReady(); return;
    }
    const request = pending.get(value.requestId);
    if (!request || !["enrolled", "retired", "state-updated", "failed"].includes(value.op)) return;
    pending.delete(value.requestId); clearTimeout(request.timer);
    if (value.op === "failed") request.reject(Object.assign(Error(value.error || "Android platform request was rejected."), { failureType: value.failureType }));
    else request.resolve(value);
  }, fail);
  authority.once("end", () => fail(Error("Android platform authority closed.")));
  void send(authority, { schemaVersion: 2, self: identity }).catch(fail);
  if (child.exitCode != null || child.signalCode != null) fail(Error("Android platform service stopped during startup."));
  function command(op, peer, fields = {}) {
    if (stopped || !authority.writable) return Promise.reject(Error("Android platform service stopped."));
    const requestId = String(++serial);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(Error("Android platform request did not complete.")); }, 15000);
      pending.set(requestId, { resolve, reject, timer });
      void send(authority, { op, peer, requestId, ...fields }).catch(fail);
    });
  }
  return { child, identity, ready,
    enroll: (peer, authorization) => command("enroll", peer, system && authorization ? { authorization } : {}), retire: peer => command("retire", peer),
    processState: (peer, state) => command("process-state", peer, { state }),
    close() { fail(Error("Android platform service stopped.")); authority.end(); } };
}

async function startProfileService(config, storage, lockFd) {
  if (config.role !== "system" && config.role !== "keystore") throw Error("Unknown Android platform service.");
  const payload = require("../runtime").resolve({ root: config.runtimeRoot }, config.runtimeIdentity);
  const bootCount = config.role === "system" ? await require("./boot-state").bootCount(storage) : undefined;
  const dataRoot = await privateDirectory(path.join(storage.root, "data"));
  const filesRoot = await privateDirectory(path.join(dataRoot, "files")), cacheRoot = await privateDirectory(path.join(dataRoot, "cache"));
  const launch = { runtimeRoot: config.runtimeRoot, dataRoot, filesRoot, cacheRoot, runRoot: storage.runRoot,
    authorityFd: 5, ownershipFd: 4, platformSocketPath: storage.platformSocket, serviceRole: config.role };
  const launchFile = path.join(storage.root, "launch.json"); await writePrivate(launchFile, launch);
  const installedCodeRoot = config.role === "system" ? path.join(config.userDataDir, "android", "apps") : null;
  if (installedCodeRoot) await require("node:fs/promises").mkdir(installedCodeRoot, { recursive: true, mode: 0o700 });
  const isolated = await require(path.join(config.moduleRoot, "sandbox.js")).prepareSandbox({
    javaPath: config.javaPath, config: launch, configFile: launchFile, dataRoot, blockNetwork: true,
    userDataDir: config.userDataDir, processIdentityVersion: payload.profile?.processIdentityVersion,
    installedCodeRoot,
    localSockets: { listen: [storage.platformSocket] } });
  const { frameworkJvmOptions } = require(path.join(config.moduleRoot, "jvm-options.js"));
  const query=require("../process-channel").prepareProcessQuerySpawn(
    { cwd: filesRoot, env: isolated.environment, stdio: ["ignore", "ignore", "pipe", "ignore", lockFd, "pipe"] },
    path.join(config.runtimeRoot,"native/android-supervisor-send"));
  const child = spawn(isolated.command, [...isolated.prefix, ...isolated.javaArguments, ...frameworkJvmOptions,
    "-XX:+ErrorFileToStderr", "-cp", ["android-host.jar", "android-framework.jar"].map(file => path.join(config.runtimeRoot, file)).join(path.delimiter),
    "maclauncher.android.PlatformServiceHost", "--config", launchFile],
    query.options);
  query.attach(child);
  // Drain from spawn, including failures before the authority adapter exists.
  // Keep only exception identities/sites; service messages can contain app data.
  const diagnostics=Stages.create();
  child.stderr.on("data",bytes=>diagnostics.write(bytes));
  child.stderr.on("error",()=>{});
  const exited = new Promise(resolve => child.once("close", resolve));
  child.on("error", () => {});
  let closing;
  const stop=authority=>closing??=(async()=>{
    authority?.();child.stdio[5]?.end();
    const timer=setTimeout(()=>{if(child.exitCode==null&&child.signalCode==null)child.kill("SIGKILL");},5000);
    try{await exited;}finally{clearTimeout(timer);}
  })();
  const failed=error=>{
    const failure=diagnostics.snapshot().failure;
    if(failure){error.message="The Android "+config.role+" service stopped ("+Stages.describeFailure(failure)+").";error.platformFailure=failure;}
    return error;
  };
  try {
    const service = await connectAuthority(child, config.role, bootCount, payload.profile?.processIdentityVersion), close = service.close;
    service.socketPath = storage.platformSocket;
    service.failureDiagnostics=()=>diagnostics.snapshot().failure||null;
    service.close=()=>stop(close);
    service.ready=service.ready.catch(async error=>{await service.close();throw failed(error);});
    service.ready.catch(()=>{});
    return service;
  } catch (error) {
    await stop();throw failed(error);
  }
}

module.exports = { startProfileService, connectAuthority };

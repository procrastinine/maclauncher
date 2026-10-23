const fs = require("node:fs/promises"), path = require("node:path"), net = require("node:net");
const crypto = require("node:crypto");
const { receive, send, helperCommand } = require("../process-channel");
const { paths, serviceRole, writePrivate, readPrivate } = require("./paths");

// Common delivered bytes and Android profile define the JVM platform supplier.
// ART execution additions do not replace that supplier. Keep the Node adapter
// location as well: another launcher implementation must retire an idle owner.
function sameRuntimeImplementation(left,right){
  const a=left.runtimeIdentity,b=right.runtimeIdentity;
  const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  if(a&&b&&digest(a.platformHash)&&digest(b.platformHash))
    return a.platformHash===b.platformHash&&
      ((!left.moduleRoot&&!right.moduleRoot)||(!!left.moduleRoot&&!!right.moduleRoot&&path.resolve(left.moduleRoot)===path.resolve(right.moduleRoot)));
  if(a&&b&&[a.sourceHash,a.inputHash,b.sourceHash,b.inputHash].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))
    return a.version===b.version&&a.sourceHash===b.sourceHash&&a.inputHash===b.inputHash;
  return !right.runtimeRoot||path.resolve(left.runtimeRoot)===path.resolve(right.runtimeRoot);
}

async function launchService(config, storage, lockFd) {
  const implementation = config.role === "accounts" ? require(path.join(config.moduleRoot, "account-owner.js")) : require("./jvm");
  return implementation.startProfileService(config, storage, lockFd);
}

async function run(config, { startService = launchService } = {}) {
  config = { ...config, role: serviceRole(config.role) };
  const storage = await paths(config.userDataDir, config.role,config), lockFd = Number(process.env.MACLAUNCHER_ANDROID_OWNER_FD);
  const lock = require("node:fs").fstatSync(lockFd), expected = await fs.stat(storage.lock);
  if (lock.dev !== expected.dev || lock.ino !== expected.ino || lock.uid !== process.getuid())
    throw Error("Android platform supervisor has no profile ownership.");
  delete process.env.MACLAUNCHER_ANDROID_OWNER_FD;
  const helper = path.join(config.runtimeRoot, "native/android-supervisor-send");
  const capability = crypto.randomBytes(32).toString("hex"), controllers = new Set(), peers = new Map();
  const packageSources=require("./package-sources").createPackageSources(config.userDataDir);
  let packageOperations=Promise.resolve();
  const packageTransaction=operation=>{const result=packageOperations.then(operation,operation);packageOperations=result.catch(()=>{});return result;};
  let child, service, identity, server, closing, idle, startupTimer, detail = "", exitStatus;
  const startedAt = Date.now();
  let startupResolve, startupReject, startupFinished=false, startupSettled=false, startupStage="start-service", firstFailure;
  const recordFailure=(error, stage=service?.startupStage?.()||startupStage, diagnostic)=>{
    if(firstFailure)return;
    const value=require("../account-stages").lifecycleFailure(error,stage);
    firstFailure=diagnostic?{...diagnostic,stage:value.stage}:value;
  };
  const startup = new Promise((resolve, reject) => {
    startupResolve=value=>{if(startupSettled)return;startupSettled=true;startupFinished=true;resolve(value);};
    startupReject=error=>{if(startupSettled)return;startupSettled=true;if(!closing)recordFailure(error);reject(error);};
  });
  // Startup failures may precede the await below; retain one rejection owner.
  startup.catch(() => {});
  async function close(reason) {
    if (closing) return closing;
    closing = (async () => {
      clearTimeout(idle);
      for (const controller of controllers) controller.socket.destroy();
      server?.close();
      const retired = Promise.resolve().then(() => service?.close()).catch(() => {});
      if (child?.pid && child.exitCode == null && child.signalCode == null) {
        await new Promise(resolve => {
          const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
          child.once("exit", () => { clearTimeout(timer); resolve(); });
        });
      }
      // An adapter may own authenticator children and storage leases beyond its
      // primary JVM. Keep profile ownership until the whole service retires.
      await retired;
      await packageOperations;await packageSources.close();
      await Promise.all([storage.metadata, storage.controllerSocket, storage.platformSocket].map(file => fs.rm(file, { force: true })));
      if (detail) await fs.writeFile(path.join(storage.root, "runtime.log"), detail, { mode: 0o600 });
      // Retain bounded owner outcomes across restarts. Authenticator output is
      // deliberately excluded: lifecycle facts suffice to distinguish normal
      // idle retirement, runtime replacement and an unexpected service exit.
      const historyPath = path.join(storage.root, "lifecycle.json");
      try {
        const previous = await readPrivate(historyPath).catch(() => []);
        const history = Array.isArray(previous) ? previous.slice(-15) : [];
        history.push({ startedAt, endedAt: Date.now(), reason, role: config.role,
          ownerPid: process.pid, servicePid: child?.pid ?? null,
          exitCode: exitStatus?.code ?? child?.exitCode ?? null,
          signal: exitStatus?.signal ?? child?.signalCode ?? null,
          ...(firstFailure?{failure:firstFailure}:{}) });
        await writePrivate(historyPath, history);
      } catch { /* Diagnostic persistence does not retain a terminated owner. */ }
      require("node:fs").closeSync(lockFd);
    })();
    return closing;
  }
  function scheduleIdle(delay = 2000) {
    clearTimeout(idle);
    if (!controllers.size && !closing) idle = setTimeout(() => { void close("no-controllers"); }, delay);
  }
  function command(value) {
    if (closing) return Promise.reject(Error("Android platform service stopped."));
    return value.op === "enroll" ? service.enroll(value.peer, value.authorization) : service.retire(value.peer);
  }
  async function descendant(pid, owner) {
    let current = await helperCommand(helper, ["--process", String(pid)]), original = current;
    const visited = new Set();
    while (current.pid !== owner.pid) {
      if (current.uid !== owner.uid || current.parentPid <= 1 || visited.has(current.pid))
        throw Error("Android process was not created by this launcher controller.");
      visited.add(current.pid); current = await helperCommand(helper, ["--process", String(current.parentPid)]);
    }
    if (current.startedSeconds !== owner.startedSeconds || current.startedMicros !== owner.startedMicros)
      throw Error("Android launcher controller was replaced.");
    return original;
  }
  async function retire(controller, pid) {
    const entry = controller.children.get(pid); if (!entry) return;
    controller.children.delete(pid);
    if (peers.get(pid) === controller) peers.delete(pid);
    await packageTransaction(async()=>{
      if(closing)return; // The service's complete retirement releases these sources.
      await command({ op: "retire", peer: entry.identity });
      await entry.releaseSources?.();
    });
  }
  async function accept(socket) {
    socket.pause();
    const controller = { socket, children: new Map(), authenticated: false, operations: Promise.resolve(),
      cancellation: new AbortController(), access: "read" };
    controllers.add(controller); clearTimeout(idle);
    const authenticationDeadline = setTimeout(() => socket.destroy(), 5000);
    socket.once("close", () => clearTimeout(authenticationDeadline));
    let credentials;
    const retired = () => {
      controller.cancellation.abort(Error("Android platform controller disconnected."));
      controllers.delete(controller);
      // All requests from one controller are serialized. A late enrollment
      // completes before its lease is retired, even after abrupt disconnect.
      controller.operations = controller.operations.catch(() => {}).then(async () => {
        await Promise.allSettled([...controller.children.keys()].map(pid => retire(controller, pid)));
        scheduleIdle();
      });
    };
    socket.once("close", retired);
    try {
      credentials = await helperCommand(helper, ["--peer"], socket._handle.fd);
      if (credentials.uid !== process.getuid()) throw Error("Android controller identity differs from the profile owner.");
      const actual = await helperCommand(helper, ["--process", String(credentials.pid)]);
      if (actual.uid !== credentials.uid) throw Error("Android controller identity changed.");
      credentials = { ...credentials, ...actual };
      if (socket.destroyed || closing) return socket.destroy();
      receive(socket, request => {
        controller.operations = controller.operations.catch(() => {}).then(async () => {
          try {
            controller.cancellation.signal.throwIfAborted();
            if (!controller.authenticated) {
              const supplied = Buffer.from(String(request.capability || "")), expected = Buffer.from(capability);
              if (request.op !== "hello" || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected))
                throw Error("Android controller authorization failed.");
              if (serviceRole(request.role) !== config.role) throw Error("Android platform service role differs.");
              const identityChanged = (request.processIdentityVersion ?? 0) !== (config.processIdentityVersion ?? 0);
              const runtimeChanged = !sameRuntimeImplementation(config,request);
              if (runtimeChanged || identityChanged) {
                if ([...controllers].some(value => value !== controller && value.authenticated))
                  throw Object.assign(Error("Close running Android games before changing the Android runtime."), { code: "EBUSY" });
                // A live lease owns its exact Java/native supplier as well as
                // its process protocol. Matching Binder descriptors alone do
                // not make another framework or database implementation safe.
                // Retire an idle supplier under the existing profile lock;
                // acquisition retries after its complete service exits.
                await send(socket, { id: request.id, error: "Android platform runtime is changing.", code: "ESTALE" });
                void close("runtime-change"); return;
              }
              if (!["read", "manage", "game"].includes(request.access || "read")) throw Error("Invalid Android platform service access.");
              controller.access = request.access || "read";
              controller.authenticated = true; controllers.add(controller); clearTimeout(idle); clearTimeout(authenticationDeadline);
              await startup;
              return send(socket, { id: request.id, result: { identity, socketPath: storage.platformSocket,
                processIdentityVersion: config.processIdentityVersion ?? 0 } });
            }
            if (request.op === "enroll") {
              const peer = request.peer;
              const hostPid = peer?.hostPid ?? peer?.pid;
              const system = peer?.uid === 1000 && peer.packageName === "android" && peer.securityContext === "u:r:system_server:s0";
              if (!peer || !Number.isSafeInteger(peer.pid) || peer.pid < 2 || !Number.isSafeInteger(hostPid) || hostPid < 2 || !Number.isSafeInteger(peer.uid) || peer.uid < 10000 && !system ||
                  typeof peer.packageName !== "string" || !peer.packageName || typeof peer.processName !== "string" || !peer.processName ||
                  peer.securityContext != null && (typeof peer.securityContext !== "string" || !peer.securityContext || peer.securityContext.includes('\0')))
                throw Error("Invalid Android application enrollment.");
              if (hostPid === credentials.pid) throw Error("Android application must be a child of its launcher controller.");
              const process = await descendant(hostPid, credentials);
              controller.cancellation.signal.throwIfAborted();
              const value = { packageName: peer.packageName, processName: peer.processName, pid: peer.pid, hostPid, uid: peer.uid,
                hostUid: credentials.uid, securityContext: system ? "u:r:system_server:s0" : peer.securityContext || "u:r:untrusted_app:s0" };
              if (peers.has(peer.pid)) throw Error("Android application process is already enrolled.");
              peers.set(peer.pid, controller);
              await packageTransaction(async()=>{
                let releaseInputs,releaseCanonical,enrollmentStarted=false;
                try {
                  // Another controller may own a slow package transaction.
                  // A request whose connection closed while queued owns no
                  // enrollment and must not start one when that queue resumes.
                  controller.cancellation.signal.throwIfAborted();
                  releaseInputs=await packageSources.acquire(request.authorization?.packages||[]);
                  controller.cancellation.signal.throwIfAborted();
                  enrollmentStarted=true;
                  const enrolled=await command({ op: "enroll", peer: value, authorization: request.authorization });
                  if(Array.isArray(enrolled?.preparedRoots))releaseCanonical=packageSources.retainCanonical(enrolled.preparedRoots);
                  controller.cancellation.signal.throwIfAborted();
                  const current = await helperCommand(helper, ["--process", String(hostPid)]);
                  controller.cancellation.signal.throwIfAborted();
                  if (current.startedSeconds !== process.startedSeconds || current.startedMicros !== process.startedMicros)
                    throw Error("Android application process was replaced during enrollment.");
                  if(releaseCanonical){await releaseInputs();releaseInputs=null;}
                  controller.children.set(peer.pid, { identity: value, process, authorization:request.authorization,releaseSources:releaseCanonical||releaseInputs });
                } catch (error) {
                  peers.delete(peer.pid);
                  // A lost retirement acknowledgement can leave a catalog row
                  // alive. Its sources then remain owned until the service ends.
                  try{if(enrollmentStarted)await command({ op: "retire", peer: value });await releaseCanonical?.();await releaseInputs?.();}catch{}
                  throw error;
                }
              });
              return send(socket, { id: request.id, result: identity });
            }
            if (request.op === "retire") {
              await retire(controller, request.pid); return send(socket, { id: request.id, result: true });
            }
            if(request.op==="process-state"){
              const entry=controller.children.get(request.pid);
              if(config.role!=="system"||identity.processStateVersion!==1||!entry||peers.get(request.pid)!==controller)
                throw Error("Android process lifecycle has no active enrollment.");
              if(!Number.isInteger(request.state)||request.state<0||request.state>=20)throw Error("Invalid Android process state.");
              await service.processState(entry.identity,request.state);
              return send(socket,{id:request.id,result:true});
            }
            if (request.op === "request" && service && config.role === "accounts") {
              const enumeration = request.command === "accounts";
              if (controller.access === "game" || !enumeration &&
                  (controller.access !== "manage" || !["addAccount", "removeAccount", "diagnostics", "removePackages"].includes(request.command)))
                throw Error("This Android account operation requires account management.");
              if (request.command === "diagnostics") return send(socket, { id: request.id, result: service.accountStages?.() || null });
              const result = await service.request(request.command, request.payload, {
                networkAllowed: !enumeration && request.networkAllowed === true,
                interactive: ["addAccount","removeAccount"].includes(request.command), signal: controller.cancellation.signal,
              });
              return send(socket, { id: request.id, result });
            }
            throw Error("Invalid Android platform request.");
          } catch (error) {
            if (!socket.destroyed) await send(socket, { id: request.id, error: error.message, code: error.code,
              ...(Number.isSafeInteger(error.providerCode) ? { providerCode: error.providerCode } : {}),
              ...require("../account-stages").providerFailureDetails(error) }).catch(() => {});
            if (!controller.authenticated) socket.destroy();
          }
        });
      }, () => socket.destroy());
      socket.resume();
    } catch { socket.destroy(); }
  }
  try {
    for (const socket of [storage.metadata, storage.controllerSocket, storage.platformSocket]) await fs.rm(socket, { force: true });
    service = await startService(config, storage, lockFd);
    startupStage="initialize-service";
    child = service.child;
    // Each adapter owns its diagnostic policy. Account authenticators can emit
    // credentials to stderr, so the broker must never persist raw child output
    // merely because it owns that process's lifetime.
    service.diagnostics?.on("data", value => { detail = (detail + value).slice(-16384); });
    child.once("error", startupReject);
    child.once("exit", (code,signal)=>{exitStatus={code,signal};});
    child.once("close", (code, signal) => {
      exitStatus = { code, signal };
      const failure=service.failureDiagnostics?.();
      const diagnostic=failure?require("../account-stages").describeFailure(failure):detail.trim();
      const error = service.startupFailure?.() || Error("Android platform service stopped (" + (signal || code) + "): " + diagnostic);
      if(!closing)recordFailure(error,startupFinished?"service-exit":service.startupStage?.()||startupStage,
        service.startupFailure?.()?undefined:failure);
      startupReject(error); void close(startupFinished?"service-exit":"startup-failed");
    });
    identity = service.identity;
    Promise.resolve(service.ready).then(startupResolve, startupReject);
    startupTimer = setTimeout(() => startupReject(Error("Android platform service startup did not complete.")), 30000);
    await startup;
    server = net.createServer(socket => { void accept(socket); });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(storage.controllerSocket, resolve); });
    await fs.chmod(storage.controllerSocket, 0o600);
    const self = await helperCommand(helper, ["--process", String(process.pid)]);
    await writePrivate(storage.metadata, { schemaVersion: 1, capability, socketPath: storage.controllerSocket, owner: self });
    try { await startup; } finally { clearTimeout(startupTimer); }
    scheduleIdle(15000);
    for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void close(signal); });
  } catch (error) { recordFailure(error);await close("startup-failed"); throw error; }
  finally{clearTimeout(startupTimer);}
}

if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", data => { input += data; if (input.length > 65536) process.exit(1); });
  process.stdin.on("end", () => { run(JSON.parse(input)).catch(error => { console.error(error.message); process.exitCode = 1; }); });
}

module.exports = { run, launchService, sameRuntimeImplementation };

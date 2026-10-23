const net = require("node:net"), path = require("node:path"), { spawn } = require("node:child_process");
const { receive, send, helperCommand } = require("../process-channel");
const { paths, serviceRole, readPrivate } = require("./paths");

async function connect(storage, helper, signal, config) {
  const metadata = await readPrivate(storage.metadata);
  if (metadata.schemaVersion !== 1 || metadata.socketPath !== storage.controllerSocket || typeof metadata.capability !== "string")
    throw Error("Android platform connection metadata is invalid.");
  signal?.throwIfAborted();
  const socket = net.createConnection(storage.controllerSocket), pending = new Map();
  let serial = 0, closed = false, terminalFailure;
  const abort = () => socket.destroy(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const fail = (cause, phase = "transport") => {
    // A service can retire while its acquired controller is preparing an app.
    // Keep that first outcome for a later request instead of replacing it with
    // an unqualified closed-socket error at application enrollment.
    terminalFailure ||= Object.assign(Error("Android " + config.role + " controller " +
      (phase === "released" ? "lease was closed." : phase === "timeout" ? "request did not complete." : "connection closed."),
      cause ? { cause } : undefined), {
      code: cause?.code || (phase === "timeout" ? "ETIMEDOUT" : "ECONNRESET"),
      platformRole: config.role, platformConnection: phase
    });
    closed = true; signal?.removeEventListener("abort", abort);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(terminalFailure); }
    pending.clear(); socket.destroy();
  };
  const close = () => { fail(null, "released"); };
  socket.once("close", () => fail(null, "peer-closed"));
  receive(socket, value => {
    const request = pending.get(value.id); if (!request) return;
    pending.delete(value.id); clearTimeout(request.timer);
    if (value.error) request.reject(Object.assign(Error(value.error), { code: value.code,
      ...(Number.isSafeInteger(value.providerCode) ? { providerCode: value.providerCode } : {}),
      ...require("../account-stages").providerFailureDetails(value) })); else request.resolve(value.result);
  }, fail);
  const request = (op, fields = {}, timeout = 20000) => new Promise((resolve, reject) => {
    if (closed || socket.destroyed) {
      fail(null, "peer-closed"); return reject(terminalFailure);
    }
    const id = String(++serial), timer = setTimeout(() => {
      fail(null, "timeout");
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    send(socket, { op, id, ...fields }).catch(fail);
  });
  try {
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const peer = await helperCommand(helper, ["--peer"], socket._handle.fd);
    if (peer.pid !== metadata.owner?.pid || peer.uid !== process.getuid())
      throw Object.assign(Error("Android platform controller identity has changed."), { code: "ESTALE" });
    const current = await helperCommand(helper, ["--process", String(peer.pid)]);
    if (current.startedSeconds !== metadata.owner.startedSeconds || current.startedMicros !== metadata.owner.startedMicros)
      throw Object.assign(Error("Android platform controller was replaced."), { code: "ESTALE" });
    const service = await request("hello", { capability: metadata.capability, role: config.role,
      runtimeRoot: config.runtimeRoot, runtimeIdentity:config.runtimeIdentity, moduleRoot:config.moduleRoot,
      access: config.access, processIdentityVersion: config.processIdentityVersion });
    // Older owners use physical Android PIDs. They may retain active games,
    // but cannot interpret a newer client's logical process identities.
    if ((service.processIdentityVersion ?? 0) !== config.processIdentityVersion)
      throw Object.assign(Error("Close running Android games before changing the Android runtime."), { code: "EBUSY" });
    const systemService = config.role === "accounts" || config.role === "system";
    if (service.socketPath !== storage.platformSocket || service.identity?.uid !== (systemService ? 1000 : 1017) ||
        service.identity?.securityContext !== (systemService ? "u:r:system_server:s0" : "u:r:keystore:s0"))
      throw Error("Android platform service identity is invalid.");
    // Cancellation is an acquisition concern. The returned lease explicitly
    // owns its connection and cannot be killed by another launch's signal.
    signal?.removeEventListener("abort", abort);
    return { ...service, enroll: (peer, authorization) => request("enroll", { peer, authorization }),
      retire: peer => request("retire", { pid: peer.pid }),
      processState:(peer,state)=>request("process-state",{pid:peer.pid,state}),
      request: (command, payload, options = {}) => request("request", { command, payload,
        networkAllowed: options.networkAllowed === true }, command === "accounts" ? 30000 : 15 * 60 * 1000), close };
  } catch (error) { close(); throw error; }
}

function configuration({ userDataDir, runtimeRoot, runtimeIdentity, javaPath, moduleRoot, role = "keystore", access = "read", processIdentityVersion = 0 }) {
  role = serviceRole(role);
  if (!["read", "manage", "game"].includes(access)) throw Error("Invalid Android platform service access.");
  // All nested profile services derive the protocol from the selected immutable
  // payload. Copying a capability through each caller allows an account service
  // to accidentally request a different protocol for its own dependencies.
  if (runtimeIdentity) {
    const selected=require("../runtime").resolve({ root: runtimeRoot }, runtimeIdentity);
    processIdentityVersion=selected.profile?.processIdentityVersion??0;
    runtimeIdentity=selected.runtimeIdentity;
  }
  return { userDataDir, runtimeRoot, runtimeIdentity, javaPath, moduleRoot, role, access, processIdentityVersion };
}

/** Reserve an existing compatible owner without starting an unused service. */
async function retainExisting(options) {
  const config=configuration(options),{signal}=options;
  const storage=await paths(config.userDataDir,config.role,config);
  const helper=path.join(config.runtimeRoot,"native/android-supervisor-send"),deadline=Date.now()+35000;
  while(Date.now()<deadline){
    signal?.throwIfAborted();
    try{return await connect(storage,helper,signal,config);}
    catch(error){
      if(error.code==="ENOENT"||error.code==="ECONNREFUSED")return null;
      // Only the existing authenticated idle-owner retirement protocol is
      // retried. Busy owners and other connection failures remain failures.
      if(error.code!=="ESTALE")throw error;
    }
    await new Promise(resolve=>setTimeout(resolve,75));
  }
  throw Object.assign(Error("Android platform service retirement did not complete."),{code:"ETIMEDOUT",platformRole:config.role});
}

async function acquire(options) {
  const config=configuration(options),{userDataDir,runtimeRoot,role}=config,{signal,logger}=options;
  const storage = await paths(userDataDir, role,config), helper = path.join(runtimeRoot, "native/android-supervisor-send");
  let startupError, detail = "", child;
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (startupError) throw startupError;
    try {
      const service=await connect(storage, helper, signal, config);
      if(role==="system"&&service.identity?.packageSourceLifetimeVersion!==1)
        logger?.debug?.("[android] Existing platform owner retains the earlier package-source lifetime protocol until normal retirement.");
      return service;
    }
    catch (error) {
      if (!["ENOENT", "ECONNREFUSED", "ECONNRESET", "ESTALE"].includes(error.code)) throw error;
    }
    // A lock contender may lose to an owner that is already shutting down.
    // Retry ownership after that contender exits; do not wait for a publisher
    // which no longer exists, and never remove another owner's kernel lock.
    if (!child || child.exitCode != null || child.signalCode != null) {
      child = spawn(helper, ["--lock", storage.lock, process.execPath, path.join(__dirname, "owner.js")], {
        detached: true, stdio: ["pipe", "ignore", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      });
      child.on("error", error => { startupError = error; });
      child.stderr.on("data", bytes => { detail = (detail + bytes).slice(-8192); });
      child.once("exit", (code, signal) => {
        if (code !== 0 && code !== 73) startupError = Error("Android platform owner could not start (" + (signal || code) + "): " + detail.trim());
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(config));
      child.unref(); child.stderr.unref();
    }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  logger?.warn?.("[android] Platform startup: " + detail.trim());
  throw Error("Android platform service startup did not complete.");
}

// Endpoint grants can be prepared while the original service initializes.
// Every operation still waits for the same authenticated acquisition; this
// handle never supplies a provisional identity or another profile owner.
async function prepare(options) {
  options.signal?.throwIfAborted();
  const role = serviceRole(options.role), storage = await paths(options.userDataDir, role, options);
  options.signal?.throwIfAborted();
  let owner;
  const ready = acquire({ ...options, role }).then(value => (owner = value));
  ready.catch(() => {});
  return { socketPath: storage.platformSocket, ready,
    get identity() { return owner?.identity; },
    enroll: (...args) => ready.then(value => value.enroll(...args)),
    retire: (...args) => ready.then(value => value.retire(...args)),
    processState: (...args) => ready.then(value => value.processState(...args)),
    close: () => ready.then(value => value.close(), () => {}) };
}

module.exports = { acquire, prepare, retainExisting };

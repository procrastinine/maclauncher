const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { EventEmitter } = require("node:events");
const { createRuntimeCoordinator, coordinatorFor, isRuntimeProcessAlive } = require("./runtime-coordinator");
const { stopProcessTree, normalizeShutdownGraceMs } = require("./process-stop");
const { createAbortError } = require("../modules/shared/runtime/download-utils");
const { bindProcessStop, processStopBinding } = require("./process-lifecycle");

function errorRecord(error) {
  return { message: String(error?.message || error), name: error?.name || "Error",
    ...(error?.code != null ? { code: error.code } : {}),
    ...(error?.stack ? { stack: error.stack } : {}),
    ...(error?.detection ? { detection: error.detection } : {}) };
}
function restoreError(record = {}) {
  const error = new Error(record.message || "Backend operation failed.");
  error.name = record.name || "Error";
  for (const key of ["code", "stack", "detection"]) if (record[key] != null) error[key] = record[key];
  return error;
}

/** A Node worker owns backend CPU/IO. UI callbacks are asynchronous messages. */
class BackendWorkerClient extends EventEmitter {
  constructor({ workerPath = path.join(__dirname, "backend-worker.js"), workerData, callbacks = {} } = {}) {
    super();
    const github = require("../modules/shared/runtime/github-transport").createBroker();
    this.callbacks = { githubFetch: (...args) => github.request(...args), githubCancel: id => github.cancel(id),
      githubAuthStatus: () => github.authenticationStatus(), ...callbacks };
    this.on("closed", () => github.close());
    this.pending = new Map();
    this.callbackRequests = new Map();
    this.children = new Map();
    this.finishedChildren = new Map();
    this.temporaryProcesses = new Map();
    this.temporaryStops = new Map();
    this.nextId = 0;
    this.retainedProcesses = 0;
    this.closed = false;
    this.shuttingDown = false;
    this.worker = new Worker(workerPath, { workerData });
    this.worker.on("message", message => this.handleMessage(message));
    this.worker.on("error", error => this.fail(error));
    this.worker.on("exit", code => {
      void this.stopTemporaryProcesses();
      this.fail(new Error(`Backend worker exited (${code}).`));
      this.emit("closed");
    });
  }

  async handleMessage(message) {
    if (message.type === "cancelCallback") { this.cancelCallback(message.id);return; }
    if (message.type === "callback") {
      const controller = message.cancellable === true ? new AbortController() : null;
      if (controller) this.callbackRequests.set(message.id, controller);
      try {
        if (controller && this.shuttingDown) throw createAbortError("Launcher is closing.");
        const handler = this.callbacks[message.method];
        if (typeof handler !== "function") throw new Error(`Host service unavailable: ${message.method}`);
        const result = await handler(...message.args, ...(controller ? [{signal: controller.signal}] : []));
        if (!this.closed && (!controller || this.callbackRequests.get(message.id) === controller))
          this.worker.postMessage({ type: "callbackResult", id: message.id, result });
      } catch (error) {
        if (!this.closed && (!controller || this.callbackRequests.get(message.id) === controller))
          this.worker.postMessage({ type: "callbackResult", id: message.id, error: errorRecord(error) });
      } finally { if (controller && this.callbackRequests.get(message.id) === controller) this.callbackRequests.delete(message.id); }
      return;
    }
    if (message.type === "event") {
      if (message.event === "process") this.handleProcessEvent(message.payload);
      if (message.event === "toolProcess" && message.payload.stopOnLauncherExit === true) {
        const child = this.process(message.payload.process);
        if (child.exitCode == null && child.signalCode == null) this.temporaryProcesses.set(message.payload.process.id,
          {shutdownGraceMs: normalizeShutdownGraceMs(message.payload.shutdownGraceMs)});
        if (this.shuttingDown) void this.stopTemporaryProcesses();
      }
      if (message.event === "activity") this.retainedProcesses = message.payload.processes;
      this.emit("event", message.event, message.payload);
      return;
    }
    if (message.type !== "result") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(restoreError(message.error));
    else pending.resolve(message.result);
    this.emit("idle");
  }

  request(method, ...args) {
    if (this.closed) return Promise.reject(new Error("Backend worker is closed."));
    if (this.shuttingDown) return Promise.reject(createAbortError("Launcher is closing."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ type: "request", id, method, args }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  process(record) {
    if (!record?.id || !Number.isSafeInteger(record.pid)) throw new Error("Backend returned an invalid game process.");
    let child = this.children.get(record.id) || this.finishedChildren.get(record.id)?.deref();
    if (child && child.pid !== record.pid) throw new Error("Backend process identity changed.");
    if (!child) {
      child = new EventEmitter();
      child.on("error", () => {});
      child.pid = record.pid;
      child.exitCode = record.exitCode ?? null;
      child.signalCode = record.signalCode ?? null;
      child.kill = signal => { try { process.kill(child.pid, signal || "SIGTERM"); return true; } catch { return false; } };
      if (child.exitCode != null || child.signalCode != null) this.rememberFinished(record.id, child);
      else this.children.set(record.id, child);
    }
    if (typeof record.stopToken === "string" && record.stopToken) {
      const binding = processStopBinding(child);
      if (binding && binding.token !== record.stopToken) throw new Error("Backend Stop identity changed.");
      const id = record.id, pid = record.pid, token = record.stopToken;
      bindProcessStop(child, () => {
        if (child.pid !== pid || (this.children.get(id) !== child && this.finishedChildren.get(id)?.deref() !== child)) return false;
        return this.request("stopProcess", { id, pid, stopToken: token });
      }, { token });
    }
    if (record.stopRequested === true) child.stopRequested = true;
    // A launch reply can arrive after a terminal event. Never replace completed
    // diagnostics with the earlier pending snapshot carried by that reply.
    if (record.completionDiagnostics && child.completionDiagnostics?.pending !== false)
      child.completionDiagnostics = record.completionDiagnostics;
    return child;
  }

  rememberFinished(id, child) {
    this.children.delete(id);
    this.finishedChildren.delete(id);
    // Retain identity for late IPC delivery without retaining exited process
    // listeners or their captured game state. IDs themselves are bounded too.
    for (const [key, reference] of this.finishedChildren) if (!reference.deref()) this.finishedChildren.delete(key);
    while (this.finishedChildren.size >= 64) this.finishedChildren.delete(this.finishedChildren.keys().next().value);
    this.finishedChildren.set(id, new WeakRef(child));
  }

  handleProcessEvent(event) {
    const child = this.process(event.process);
    if (event.event === "exit" || event.event === "close") {
      this.temporaryProcesses.delete(event.process.id);
      child.exitCode = event.code ?? null;
      child.signalCode = event.signal ?? null;
      child.emit(event.event, event.code, event.signal);
      if (event.event === "close") this.rememberFinished(event.process.id, child);
    } else if (event.event === "error") child.emit("error", restoreError(event.error));
    else if (event.event === "diagnostics") child.emit("diagnostics");
  }

  fail(error) {
    this.closed = true;
    for (const id of this.callbackRequests.keys()) this.cancelCallback(id);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.emit("idle");
  }

  async close() {
    if (!this.closePromise) this.closePromise = (async () => {
      this.beginShutdown();
      await this.stopTemporaryProcesses();
      this.fail(new Error("Backend worker was closed."));
      await this.worker.terminate();
      await this.stopTemporaryProcesses();
      this.children.clear(); this.finishedChildren.clear();
    })();
    return this.closePromise;
  }

  beginShutdown() {
    if (this.shuttingDown || this.closed) return;
    this.shuttingDown = true;
    for (const id of this.callbackRequests.keys()) this.cancelCallback(id);
    this.emit("shutdown");
    this.worker.postMessage({ type: "beginShutdown" });
  }

  cancelCallback(id) {
    const controller = this.callbackRequests.get(id);
    if (!controller) return false;
    this.callbackRequests.delete(id);controller.abort();return true;
  }

  async shutdownTemporaryProcesses() {
    if (!this.shutdownPromise) {
      this.beginShutdown();
      this.shutdownPromise = (async () => {
        // Existing jobs may still register a server. Admission stays closed and
        // every late registration is stopped before the drain can finish.
        do {
          await this.stopTemporaryProcesses();
          if (this.pending.size && !this.closed) await new Promise(resolve => this.once("idle", resolve));
        } while (this.pending.size || this.temporaryProcesses.size || this.temporaryStops.size);
      })();
    }
    return this.shutdownPromise;
  }

  stopTemporaryProcess(id) {
    if (this.temporaryStops.has(id)) return this.temporaryStops.get(id);
    const graceMs = normalizeShutdownGraceMs(this.temporaryProcesses.get(id)?.shutdownGraceMs);
    this.temporaryProcesses.delete(id);
    const stopping = (async () => {
      const child = this.children.get(id);
      if (!child || child.exitCode != null || child.signalCode != null) return;
      let timer, finish, finished = false;
      const stopped = new Promise(resolve => {
        finish = () => { finished = true;clearTimeout(timer); child.removeListener("close", finish); resolve(); };
        child.once("close", finish);
        // A live worker forwards close. If it exits first, wait for the owned
        // process to disappear after forced termination instead of declaring
        // cleanup complete while the helper is still running.
        const retired = async () => {
          const alive = await isRuntimeProcessAlive(child.pid).catch(() => true);
          if (finished) return;
          if (!alive) { finish();return; }
          timer = setTimeout(retired, 100);
        };
        timer = setTimeout(retired, graceMs + 1000);
      });
      if (!stopProcessTree(child.pid, {graceMs})) finish();
      await stopped;
    })();
    this.temporaryStops.set(id, stopping);
    void stopping.finally(() => this.temporaryStops.delete(id));
    return stopping;
  }

  async stopTemporaryProcesses() {
    await Promise.all([...this.temporaryProcesses.keys()].map(id => this.stopTemporaryProcess(id))
      .concat([...this.temporaryStops.values()]));
  }
}

/** Lazy lanes keep one game's resolution independent of other game jobs. */
function createBackendService({ userDataDir, appInfo, callbacks, onEvent,
  idleMs = 120000, maxIdleWorkers = 2, workerPath, runtimeCoordinator } = {}) {
  const coordinator = runtimeCoordinator || (userDataDir ? coordinatorFor(userDataDir) : createRuntimeCoordinator());
  const clients = new Map();
  const timers = new Map();
  const downloads = new Map();
  let currentRunning = {};
  let disposed = false;
  let shuttingDown = false;
  function cancelIdle(lane) { clearTimeout(timers.get(lane)); timers.delete(lane); }
  function idle(lane, client) {
    if (clients.get(lane) !== client) return;
    cancelIdle(lane);
    if (client.pending.size || client.retainedProcesses || lane === "state") return;
    const idleClients = [...clients].filter(([key, value]) => key !== "state" && !value.pending.size && !value.retainedProcesses);
    for (const [key, value] of idleClients.slice(0, Math.max(0, idleClients.length - maxIdleWorkers))) {
      cancelIdle(key); clients.delete(key); downloads.delete(key); void value.close();
    }
    if (clients.get(lane) !== client) return;
    const timer = setTimeout(() => {
      if (client.pending.size || client.retainedProcesses) return;
      clients.delete(lane); downloads.delete(lane); timers.delete(lane); void client.close();
    }, idleMs);
    timer.unref(); timers.set(lane, timer);
  }
  function get(lane) {
    if (disposed) throw new Error("Backend service is closed.");
    if (shuttingDown) throw createAbortError("Launcher is closing.");
    cancelIdle(lane);
    let client = clients.get(lane);
    if (!client || client.closed) {
      const coordination = coordinator.client();
      const coordinationCallbacks = Object.fromEntries(["acquireMutation", "extendMutation", "acquireUse", "acquireGameUse", "acquireGameRemoval", "completeGameRemoval", "release", "bindUse", "applySettings"].map(method =>
        [`runtimeCoordinator.${method}`, (...args) => coordination[method](...args)]));
      client = new BackendWorkerClient({ workerPath, workerData: { userDataDir, appInfo, lane, running: currentRunning },
        callbacks: { ...callbacks, ...coordinationCallbacks } });
      clients.set(lane, client);
      // Reject queued coordination work during shutdown. Bound game/editor
      // leases become PID-tracked orphans and keep their independent lifecycle.
      client.on("shutdown", () => coordination.close());
      client.on("event", (event, payload) => {
        if (clients.get(lane) !== client) return;
        if (event === "downloads") downloads.set(lane, payload);
        if ((event === "toolLaunch" || event === "gameProcess") && payload.process) payload = { ...payload, child: client.process(payload.process) };
        onEvent?.(event, payload, lane);
        if (event === "activity") idle(lane, client);
      });
      client.on("idle", () => idle(lane, client));
      client.on("closed", () => {
        coordination.close();
        if (clients.get(lane) === client) {
          clients.delete(lane); downloads.delete(lane); cancelIdle(lane);
        }
      });
    }
    return client;
  }
  return {
    request: (lane, method, ...args) => shuttingDown
      ? Promise.reject(createAbortError("Launcher is closing.")) : get(lane).request(method, ...args),
    async launchEntry(entry, options) {
      const client = get(`game:${entry.gameId || entry.gamePath}`);
      const result = await client.request("launchEntry", entry, options);
      return result.kind === "process" ? { ...result, child: client.process(result.process) } : result;
    },
    cancelLaunch(entry) {
      const client = clients.get(`game:${entry.gameId || entry.gamePath}`);
      return client && !client.closed ? client.request("cancelLaunch", entry) : Promise.resolve(false);
    },
    invalidateGraphicsPreparation(entry){const client=clients.get(`game:${entry.gameId||entry.gamePath}`);return client&&!client.closed?client.request('invalidateGraphicsPreparation',entry):Promise.resolve(false);},
    listDownloads: () => [...downloads].flatMap(([lane, tasks]) => tasks.map(task => ({ ...task, id: `${lane}|${task.id}` }))),
    cancelDownload(id) {
      const separator = String(id).lastIndexOf("|");
      if (separator < 0) return Promise.resolve(false);
      const client = clients.get(id.slice(0, separator));
      return client ? client.request("cancelDownload", id.slice(separator + 1)) : Promise.resolve(false);
    },
    hasPendingOperations: () => [...clients.values()].some(client => client.pending.size > 0),
    hasTemporaryProcesses: () => [...clients.values()].some(client => client.temporaryProcesses.size > 0 || client.temporaryStops.size > 0),
    stopTemporaryProcesses: () => Promise.all([...clients.values()].map(client => client.stopTemporaryProcesses())),
    beginShutdown() { shuttingDown = true; for (const client of clients.values()) client.beginShutdown(); },
    async shutdownTemporaryProcesses() {
      this.beginShutdown();
      await Promise.all([...clients.values()].map(client => client.shutdownTemporaryProcesses()));
    },
    async close() { disposed = true; for (const lane of timers.keys()) cancelIdle(lane); await Promise.all([...clients.values()].map(client => client.close())); clients.clear(); },
    // State propagation is a cheap message; workers never query Electron synchronously.
    updateRunning: running => { currentRunning = running; for (const client of clients.values()) if (!client.closed) client.worker.postMessage({ type: "running", running }); }
  };
}

module.exports = { BackendWorkerClient, createBackendService, errorRecord, restoreError };

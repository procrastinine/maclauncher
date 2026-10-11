const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { EventEmitter } = require("node:events");
const { createRuntimeCoordinator, coordinatorFor } = require("./runtime-coordinator");

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
    this.callbacks = callbacks;
    this.pending = new Map();
    this.children = new Map();
    this.nextId = 0;
    this.retainedProcesses = 0;
    this.closed = false;
    this.worker = new Worker(workerPath, { workerData });
    this.worker.on("message", message => this.handleMessage(message));
    this.worker.on("error", error => this.fail(error));
    this.worker.on("exit", code => {
      this.fail(new Error(`Backend worker exited (${code}).`));
      this.emit("closed");
    });
  }

  async handleMessage(message) {
    if (message.type === "callback") {
      try {
        const handler = this.callbacks[message.method];
        if (typeof handler !== "function") throw new Error(`Host service unavailable: ${message.method}`);
        const result = await handler(...message.args);
        if (!this.closed) this.worker.postMessage({ type: "callbackResult", id: message.id, result });
      } catch (error) {
        if (!this.closed) this.worker.postMessage({ type: "callbackResult", id: message.id, error: errorRecord(error) });
      }
      return;
    }
    if (message.type === "event") {
      if (message.event === "process") this.handleProcessEvent(message.payload);
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
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ type: "request", id, method, args }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  process(record) {
    if (!record?.id || !Number.isSafeInteger(record.pid)) throw new Error("Backend returned an invalid game process.");
    let child = this.children.get(record.id);
    if (!child) {
      child = new EventEmitter();
      child.on("error", () => {});
      child.pid = record.pid;
      child.exitCode = record.exitCode ?? null;
      child.signalCode = record.signalCode ?? null;
      child.kill = signal => { try { process.kill(child.pid, signal || "SIGTERM"); return true; } catch { return false; } };
      this.children.set(record.id, child);
    }
    return child;
  }

  handleProcessEvent(event) {
    const child = this.process(event.process);
    if (event.event === "exit" || event.event === "close") {
      child.exitCode = event.code ?? null;
      child.signalCode = event.signal ?? null;
      child.emit(event.event, event.code, event.signal);
    } else if (event.event === "error") child.emit("error", restoreError(event.error));
  }

  fail(error) {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async close() {
    this.fail(new Error("Backend worker was closed."));
    await this.worker.terminate();
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
  function cancelIdle(lane) { clearTimeout(timers.get(lane)); timers.delete(lane); }
  function idle(lane, client) {
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
    cancelIdle(lane);
    let client = clients.get(lane);
    if (!client || client.closed) {
      const coordination = coordinator.client();
      const coordinationCallbacks = Object.fromEntries(["acquireMutation", "extendMutation", "acquireUse", "acquireGameUse", "acquireGameRemoval", "completeGameRemoval", "release", "bindUse", "applySettings"].map(method =>
        [`runtimeCoordinator.${method}`, (...args) => coordination[method](...args)]));
      client = new BackendWorkerClient({ workerPath, workerData: { userDataDir, appInfo, lane, running: currentRunning },
        callbacks: { ...callbacks, ...coordinationCallbacks } });
      clients.set(lane, client);
      client.on("event", (event, payload) => {
        if (event === "downloads") downloads.set(lane, payload);
        if (event === "toolLaunch" && payload.process) payload = { ...payload, child: client.process(payload.process) };
        onEvent?.(event, payload, lane);
        if (event === "activity") idle(lane, client);
      });
      client.on("idle", () => idle(lane, client));
      client.on("closed", () => {
        coordination.close();
        if (clients.get(lane) === client) clients.delete(lane);
        downloads.delete(lane); cancelIdle(lane);
      });
    }
    return client;
  }
  return {
    request: (lane, method, ...args) => get(lane).request(method, ...args),
    async launchEntry(entry, options) {
      const client = get(`game:${entry.gameId || entry.gamePath}`);
      const result = await client.request("launchEntry", entry, options);
      return result.kind === "process" ? { ...result, child: client.process(result.process) } : result;
    },
    listDownloads: () => [...downloads].flatMap(([lane, tasks]) => tasks.map(task => ({ ...task, id: `${lane}|${task.id}` }))),
    cancelDownload(id) {
      const separator = String(id).lastIndexOf("|");
      if (separator < 0) return Promise.resolve(false);
      const client = clients.get(id.slice(0, separator));
      return client ? client.request("cancelDownload", id.slice(separator + 1)) : Promise.resolve(false);
    },
    async close() { disposed = true; for (const lane of timers.keys()) cancelIdle(lane); await Promise.all([...clients.values()].map(client => client.close())); clients.clear(); },
    // State propagation is a cheap message; workers never query Electron synchronously.
    updateRunning: running => { currentRunning = running; for (const client of clients.values()) if (!client.closed) client.worker.postMessage({ type: "running", running }); }
  };
}

module.exports = { BackendWorkerClient, createBackendService, errorRecord, restoreError };

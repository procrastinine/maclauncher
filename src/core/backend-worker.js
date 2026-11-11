const { parentPort, workerData } = require("node:worker_threads");
const { errorRecord, restoreError } = require("./backend-worker-client");
const { createBackendOperations } = require("./backend-operations");
const { remoteRuntimeCoordinator } = require("./runtime-coordinator");

let nextCallback = 0;
let running = workerData.running || {};
const callbacks = new Map();
const requestHost = (method, args, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const id = ++nextCallback;
  const cleanup = () => signal?.removeEventListener("abort", cancel);
  const cancel = () => {
    if (!callbacks.delete(id)) return;
    cleanup();parentPort.postMessage({ type: "cancelCallback", id });reject(signal.reason);
  };
  callbacks.set(id, { resolve, reject, cleanup });
  signal?.addEventListener("abort", cancel, { once: true });
  try { parentPort.postMessage({ type: "callback", id, method, args, ...(signal ? { cancellable: true } : {}) }); }
  catch (error) { callbacks.delete(id);cleanup();reject(error); }
});
const callHost = (method, ...args) => requestHost(method, args);
callHost.withSignal = (signal, method, ...args) => requestHost(method, args, signal);
require("../modules/shared/runtime/github-transport").configureHostTransport(callHost);
require("./json-files").onUnreadablePreserved(notice => parentPort.postMessage({ type: "event", event: "unreadablePreserved", payload: notice }));
const InventoryRevision = require("./runtime-inventory-revision");
InventoryRevision.activate({ retainReads: workerData.retainReads === true });
// Startup preparation continues only while no other request is in progress.
const PREPARATION = "warmInspectorLane";
let requestsInProgress = 0, idleWaiters = [];
const whenIdle = () => new Promise(resolve => setImmediate(() => requestsInProgress ? idleWaiters.push(resolve) : resolve()));
const operations = createBackendOperations({ ...workerData, getRunning: () => running, whenIdle,
  emit: (event, payload) => {
    if (InventoryRevision.EVENTS.has(event)) InventoryRevision.advance();
    parentPort.postMessage({ type: "event", event, payload });
  },
  callHost, runtimeCoordinator: remoteRuntimeCoordinator(callHost)
});

parentPort.on("message", async message => {
  if (message.type === "beginShutdown") { operations.beginShutdown(); return; }
  if (message.type === "running") { running = message.running; return; }
  if (message.type === "runtimeInventoryChanged") { InventoryRevision.advance(); return; }
  if (message.type === "callbackResult") {
    const callback = callbacks.get(message.id);
    if (!callback) return;
    callbacks.delete(message.id);
    callback.cleanup();
    if (message.error) callback.reject(restoreError(message.error)); else callback.resolve(message.result);
    return;
  }
  if (message.type !== "request") return;
  const counted = message.method !== PREPARATION;
  if (counted) requestsInProgress += 1;
  try {
    if (!Object.hasOwn(operations, message.method)) throw new Error(`Unknown backend operation: ${message.method}`);
    const result = await operations[message.method](...message.args);
    parentPort.postMessage({ type: "result", id: message.id, result });
  } catch (error) { parentPort.postMessage({ type: "result", id: message.id, error: errorRecord(error) }); }
  finally { if (counted && --requestsInProgress === 0) for (const resolve of idleWaiters.splice(0)) resolve(); }
});

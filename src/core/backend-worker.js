const { parentPort, workerData } = require("node:worker_threads");
const { errorRecord, restoreError } = require("./backend-worker-client");
const { createBackendOperations } = require("./backend-operations");
const { remoteRuntimeCoordinator } = require("./runtime-coordinator");

let nextCallback = 0;
let running = workerData.running || {};
const callbacks = new Map();
const callHost = (method, ...args) => new Promise((resolve, reject) => {
  const id = ++nextCallback; callbacks.set(id, { resolve, reject });
  parentPort.postMessage({ type: "callback", id, method, args });
});
const operations = createBackendOperations({ ...workerData, getRunning: () => running,
  emit: (event, payload) => parentPort.postMessage({ type: "event", event, payload }),
  callHost, runtimeCoordinator: remoteRuntimeCoordinator(callHost)
});

parentPort.on("message", async message => {
  if (message.type === "running") { running = message.running; return; }
  if (message.type === "callbackResult") {
    const callback = callbacks.get(message.id);
    if (!callback) return;
    callbacks.delete(message.id);
    if (message.error) callback.reject(restoreError(message.error)); else callback.resolve(message.result);
    return;
  }
  if (message.type !== "request") return;
  try {
    if (!Object.hasOwn(operations, message.method)) throw new Error(`Unknown backend operation: ${message.method}`);
    const result = await operations[message.method](...message.args);
    parentPort.postMessage({ type: "result", id: message.id, result });
  } catch (error) { parentPort.postMessage({ type: "result", id: message.id, error: errorRecord(error) }); }
});

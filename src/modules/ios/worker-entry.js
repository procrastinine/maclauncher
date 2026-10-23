const { parentPort, workerData } = require("node:worker_threads");

// Only this dedicated entry owns its message port. The importable client also
// runs inside the launcher's workers and must never close their ports.
const controller = new AbortController();
parentPort.on("message", message => { if (message === "abort") controller.abort(); });
async function run() {
  const { action, options } = workerData;
  if (action === "inspect") return require("./inspect").inspectIpa(options.source);
  if (action !== "prepare" && action !== "extract") throw new Error("Unknown IPA operation.");
  return require("./prepare")[action](options, controller.signal);
}
Promise.resolve().then(run).then(
  result => parentPort.postMessage({ result }),
  error => parentPort.postMessage({ error: error.message })
).finally(() => parentPort.close());

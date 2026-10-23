const path = require("node:path");
const { Worker } = require("node:worker_threads");
function run(action, options, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "worker-entry.js"), { workerData: { action, options } }); let result;
    const abort = () => worker.postMessage("abort"); signal?.addEventListener("abort", abort, { once: true });
    worker.on("message", value => { result = value; }); worker.once("error", reject);
    worker.once("exit", code => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(signal.reason || new Error("Operation cancelled."));
      else if (code || !result || result.error) reject(new Error(result?.error || "IPA preparation stopped unexpectedly."));
      else resolve(result.result);
    });
  });
}
module.exports = { run };

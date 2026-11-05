const fs = require("node:fs");
const threads = require("node:worker_threads");

if (!threads.isMainThread && threads.workerData?.pathStatProbe) {
  let code = null;
  try { fs.statSync(threads.workerData.path); }
  catch (error) { code = typeof error.code === "string" && error.code ? error.code : "EIO"; }
  threads.parentPort.postMessage(code);
}

// A synchronous stat on its own thread cannot queue behind unrelated libuv
// work. Each pending path gets its own probe, so a stalled mount cannot hold
// checks of other locations. The availability caller owns the time limit.
function statPath(file) {
  return new Promise((resolve, reject) => {
    const worker = new threads.Worker(__filename, { workerData: { pathStatProbe: true, path: file } });
    let settled = false;
    const finish = code => {
      if (settled) return;
      settled = true;
      if (code) reject(Object.assign(new Error(`The path could not be read (${code}).`), { code }));
      else resolve();
    };
    worker.once("message", finish);
    worker.once("error", error => finish(typeof error.code === "string" && error.code ? error.code : "EIO"));
    worker.once("exit", () => { if (!settled) finish("EIO"); });
    worker.unref();
  });
}

module.exports = { statPath };

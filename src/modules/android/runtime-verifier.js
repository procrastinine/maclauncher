const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { createAbortError } = require("../shared/runtime/download-utils");

let worker, retiring, active, nextId = 0;
const jobs = new Map(), queue = [];

function settle(request, error, result) {
  request.signal?.removeEventListener("abort", request.cancel);
  if (error) request.reject(error); else request.resolve(result);
}
function finish(job, error, result) {
  if (jobs.get(job.key) !== job) return;
  jobs.delete(job.key);
  if (active === job) active = null;
  for (const request of job.requests) settle(request, error, result);
  job.requests.clear();
  pump();
}
function retire() {
  if (retiring) return retiring;
  const prior = worker; worker = null;
  if (!prior) return Promise.resolve();
  retiring = prior.terminate().catch(() => {}).finally(() => {
    retiring = null;
    pump();
  });
  return retiring;
}
function start() {
  if (worker) return worker;
  const current = new Worker(path.join(__dirname, "runtime-verifier-worker.js"), {
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
  });
  worker = current;
  current.on("message", ({ id, result, error }) => {
    if (worker !== current || active?.id !== id) return;
    finish(active, error ? Object.assign(new Error(error.message), { name: error.name, code: error.code }) : null, result);
  });
  const failed = error => {
    if (worker !== current) return;
    const job = active;
    void retire();
    if (job) finish(job, error);
  };
  current.once("error", failed);
  current.once("exit", code => failed(new Error(`Android runtime verification stopped before completion (${code}).`)));
  return current;
}
function pump() {
  if (active || retiring) return;
  while (queue.length) {
    const job = queue.shift();
    if (jobs.get(job.key) !== job) continue;
    active = job;
    try {
      const current = start();
      current.ref();
      current.postMessage({ id: job.id, root: job.root, declaration: job.declaration });
    } catch (error) { finish(job, error); }
    return;
  }
  worker?.unref();
}
function stop(error = createAbortError("Android runtime verification stopped.")) {
  const pending = [...jobs.values()];
  jobs.clear(); queue.length = 0; active = null;
  for (const job of pending) {
    for (const request of job.requests) settle(request, error);
    job.requests.clear();
  }
  return retire();
}
function verifyPayload(root, declaration, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(createAbortError("Android runtime verification canceled."));
  return new Promise((resolve, reject) => {
    root = path.resolve(root);
    const key = JSON.stringify([root, declaration]);
    let job = jobs.get(key);
    if (!job) {
      // Capture the selected immutable version before a queued job begins.
      job = { id: ++nextId, key, root, declaration: structuredClone(declaration), requests: new Set() };
      jobs.set(key, job); queue.push(job);
    }
    const request = { resolve, reject, signal };
    request.cancel = () => {
      if (!job.requests.delete(request)) return;
      settle(request, createAbortError("Android runtime verification canceled."));
      if (!job.requests.size) {
        jobs.delete(key);
        const waiting = queue.indexOf(job);
        if (waiting >= 0) queue.splice(waiting, 1);
        if (active === job) { active = null; void retire(); }
        pump();
      }
    };
    job.requests.add(request);
    signal?.addEventListener("abort", request.cancel, { once: true });
    if (signal?.aborted) request.cancel(); else pump();
  });
}
module.exports = { verifyPayload, close: stop };

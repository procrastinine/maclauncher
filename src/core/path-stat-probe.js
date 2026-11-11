const fs = require("node:fs");
const threads = require("node:worker_threads");

if (!threads.isMainThread && threads.workerData?.pathStatProbe) {
  threads.parentPort.on("message", file => {
    let code = null;
    try { fs.statSync(file); }
    catch (error) { code = typeof error.code === "string" && error.code ? error.code : "EIO"; }
    threads.parentPort.postMessage({ code });
  });
  threads.parentPort.postMessage({ ready: true });
}

// Synchronous stats on a probe thread cannot queue behind unrelated libuv
// work. One thread answers stats in order. A stat that runs longer than
// STALL_MS keeps that thread to itself, and later stats move to a new thread,
// so a stalled mount cannot hold checks of other locations. A stat's time starts
// when its thread is ready and the stat is next in line, so a thread that is slow
// to start under load does not count against the location: the stall timer waits
// for it, and statPath reports the start to its caller. The availability caller
// owns the time limit; the threads never keep the process running.
const STALL_MS = 250;
let lane = null;

function openLane() {
  const worker = new threads.Worker(__filename, { workerData: { pathStatProbe: true } });
  const current = { worker, queue: [], timer: null, ready: false };
  const finish = (job, code) => {
    if (code) job.reject(Object.assign(new Error(`The path could not be read (${code}).`), { code }));
    else job.resolve();
  };
  // The stat at the head of the queue runs now: report its start and time it.
  const watch = () => {
    clearTimeout(current.timer);
    if (!current.ready || !current.queue.length) return;
    current.queue[0].started?.();
    current.timer = setTimeout(() => {
      if (lane !== current) return;
      lane = null;
      for (const job of current.queue.splice(1)) send(job);
    }, STALL_MS);
    current.timer.unref();
  };
  const fail = () => {
    clearTimeout(current.timer);
    if (lane === current) lane = null;
    for (const job of current.queue.splice(0)) finish(job, "EIO");
  };
  worker.on("message", message => {
    if (message?.ready) { current.ready = true; watch(); return; }
    const job = current.queue.shift();
    if (job) finish(job, message?.code ?? null);
    if (lane !== current && !current.queue.length) void worker.terminate();
    else watch();
  });
  worker.once("error", fail);
  worker.once("exit", fail);
  worker.unref();
  current.post = job => {
    current.queue.push(job);
    worker.postMessage(job.file);
    if (current.queue.length === 1) watch();
  };
  return current;
}

function send(job) {
  (lane ||= openLane()).post(job);
}

// started, when given, is called once the probe thread begins this stat.
function statPath(file, { started } = {}) {
  return new Promise((resolve, reject) => send({ file, resolve, reject, started }));
}

module.exports = { statPath, STALL_MS };

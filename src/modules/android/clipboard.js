const { spawn } = require("node:child_process");
const { MAX_FRAME } = require("./process-channel");

// One supervisor-owned helper observes real shortcuts for its enrolled children.
// Enrollment never reads the pasteboard. Transfers consume a native gesture;
// guest messages cannot create one or choose another process's identity.
function create(executable, { onSpawn } = {}) {
  const enrolled = new Set(), pending = new Map();
  let child, closed = false, failed = false, nextId = 0n, output = Buffer.alloc(0), stopping;
  function settle(id, result = { allowed: false }) {
    const request = pending.get(id); if (!request) return;
    pending.delete(id); clearTimeout(request.timer);
    request.signal?.removeEventListener("abort", request.abort);
    request.resolve(result);
  }
  function unavailable() {
    failed = true; output = Buffer.alloc(0);
    for (const id of pending.keys()) settle(id);
  }
  function send(value) {
    if (!child || closed || failed || !child.stdin.writable) return false;
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    if (bytes.length > MAX_FRAME) return false;
    try { child.stdin.write(bytes); return true; } catch { unavailable(); return false; }
  }
  function start() {
    if (child || closed || failed || !enrolled.size) return;
    child = spawn(executable, [], { stdio: ["pipe", "pipe", "ignore"] });
    child.once("error", unavailable); child.once("close", unavailable);
    child.stdin.on("error", unavailable); child.stdout.on("error", unavailable);
    child.stdout.on("data", bytes => {
      if (closed || failed) return;
      output = Buffer.concat([output, bytes]);
      let newline;
      while ((newline = output.indexOf(10)) >= 0) {
        const line = output.subarray(0, newline); output = output.subarray(newline + 1);
        try {
          if (line.length > MAX_FRAME) throw Error();
          const value = JSON.parse(line.toString("utf8")), request = pending.get(value?.id);
          if (!request) continue;
          const allowed = value.allowed === true && (request.operation !== "paste" || typeof value.text === "string");
          settle(value.id, allowed ? { allowed: true, text: request.operation === "paste" ? value.text : "" } : { allowed: false });
        } catch { unavailable(); child.kill(); return; }
      }
      if (output.length > MAX_FRAME) { unavailable(); child.kill(); }
    });
    onSpawn?.(child);
    for (const pid of enrolled) send({ op: "enroll", pid });
  }
  function enroll(pid) {
    if (closed || !Number.isSafeInteger(pid) || pid <= 0 || enrolled.has(pid)) return;
    enrolled.add(pid);
    if (child) send({ op: "enroll", pid }); else start();
  }
  function retire(pid) {
    if (!enrolled.delete(pid)) return;
    send({ op: "retire", pid });
    for (const [id, request] of pending) if (request.pid === pid) settle(id);
  }
  function transfer(pid, operation, text, { signal } = {}) {
    if (closed || failed || !enrolled.has(pid) || signal?.aborted || !["copy", "paste"].includes(operation) ||
        operation === "copy" && typeof text !== "string" || [...pending.values()].some(request => request.pid === pid))
      return Promise.resolve({ allowed: false });
    const id = (++nextId).toString();
    return new Promise(resolve => {
      const abort = () => settle(id), timer = setTimeout(abort, 2000); timer.unref();
      pending.set(id, { pid, operation, signal, abort, timer, resolve });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted || !send({ op: "transfer", id, pid, operation, ...(operation === "copy" ? { text } : {}) })) settle(id);
    });
  }
  function close() {
    if (stopping) return stopping;
    closed = true; enrolled.clear(); unavailable();
    if (!child || child.exitCode != null || child.signalCode != null) return stopping = Promise.resolve();
    stopping = new Promise(resolve => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 2000); timer.unref();
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
    return stopping;
  }
  return { enroll, retire, transfer, close };
}

module.exports = { create };

const { EventEmitter } = require("node:events");

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 8192;
const HEADER = Buffer.from("Content-Length:");

// xsystem35 2.20.0 passes its exact input allocation to cJSON_Parse rather
// than a length-aware parser. Its reviewed adapter includes a terminal NUL
// inside Content-Length; this stays a versioned client-side compatibility
// option, with no change to the vendored native runtime.
function encodeRequest(message, { terminalNul = false } = {}) {
  const bytes = Buffer.from(JSON.stringify(message) + (terminalNul ? "\0" : ""), "utf8");
  if (bytes.length > MAX_FRAME_BYTES) throw new Error("Debugger request is too large.");
  return Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`, "ascii"), bytes]);
}

class DapTransport extends EventEmitter {
  constructor(child, { timeout = 10000, terminalNul = false } = {}) {
    super();
    if (!child?.stdin?.write || !child?.stdout?.on) throw new Error("Debugger requires an owned process with piped input and output.");
    this.child = child;
    this.timeout = timeout;
    this.terminalNul = terminalNul;
    this.sequence = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.frameLength = null;
    this.closed = false;
    this.diagnostics = "";
    this.listeners = {
      data: chunk => { try { this.accept(chunk); } catch (error) { this.fail(error); } },
      stderr: chunk => this.capture(chunk),
      stdoutEnd: () => this.fail(new Error("Debugger output closed.")),
      stdinError: error => this.fail(error),
      error: error => this.fail(error),
      exit: (code, signal) => {
        this.exitCode = code;
        this.exitSignal = signal;
        this.fail(new Error(`Game exited${signal ? ` (${signal})` : ` (${code})`}.`));
      }
    };
    child.stdout.on("data", this.listeners.data);
    child.stdout.on("end", this.listeners.stdoutEnd);
    child.stderr?.on("data", this.listeners.stderr);
    child.stdin.on("error", this.listeners.stdinError);
    child.on("error", this.listeners.error);
    child.on("exit", this.listeners.exit);
  }

  capture(chunk) {
    this.diagnostics = (this.diagnostics + Buffer.from(chunk).toString("utf8")).slice(-65536);
  }

  accept(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (this.buffer.length) {
      if (this.frameLength === null) {
        const marker = this.buffer.indexOf(HEADER);
        if (marker < 0) {
          // Native startup messages can precede DAP. Retain a possible split
          // header prefix while bounding diagnostic text and buffered bytes.
          const consumed = Math.max(0, this.buffer.length - HEADER.length + 1);
          this.capture(this.buffer.subarray(0, consumed));
          this.buffer = this.buffer.subarray(consumed);
          return;
        }
        if (marker) {
          this.capture(this.buffer.subarray(0, marker));
          this.buffer = this.buffer.subarray(marker);
        }
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (this.buffer.length > MAX_HEADER_BYTES) throw new Error("Debugger header is too large.");
          return;
        }
        if (end > MAX_HEADER_BYTES) throw new Error("Debugger header is too large.");
        const lengths = this.buffer.subarray(0, end).toString("ascii").split("\r\n")
          .filter(line => /^Content-Length:/i.test(line));
        const match = lengths.length === 1 && /^Content-Length:\s*(\d+)\s*$/i.exec(lengths[0]);
        const length = match && Number(match[1]);
        if (!Number.isSafeInteger(length) || length < 1 || length > MAX_FRAME_BYTES) throw new Error("Invalid debugger frame length.");
        this.frameLength = length;
        this.buffer = this.buffer.subarray(end + 4);
      }
      if (this.buffer.length < this.frameLength) return;
      const bytes = this.buffer.subarray(0, this.frameLength);
      this.buffer = this.buffer.subarray(this.frameLength);
      this.frameLength = null;
      const message = JSON.parse(bytes.toString("utf8"));
      if (!message || typeof message !== "object") throw new Error("Invalid debugger message.");
      if (message.type === "response") {
        const pending = this.pending.get(message.request_seq);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.request_seq);
        if (message.success !== true) pending.reject(new Error(message.message || `Debugger ${pending.command} failed.`));
        else pending.resolve(message.body || {});
      } else if (message.type === "event") {
        this.emit("event", message);
      }
    }
  }

  request(command, args = {}) {
    if (this.closed) return Promise.reject(new Error("Debugger is closed."));
    const seq = ++this.sequence;
    let frame;
    try { frame = encodeRequest({ seq, type: "request", command, arguments: args }, { terminalNul: this.terminalNul }); }
    catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`Debugger ${command} timed out.`));
      }, this.timeout);
      this.pending.set(seq, { resolve, reject, timer, command });
      try {
        this.child.stdin.write(frame, error => { if (error) this.fail(error); });
      } catch (error) { this.fail(error); }
    });
  }

  waitFor(eventName, { timeout = this.timeout } = {}) {
    if (this.closed) return Promise.reject(new Error("Debugger is closed."));
    return new Promise((resolve, reject) => {
      const clear = () => { clearTimeout(timer); this.off("event", onEvent); this.off("closed", onClosed); };
      const onEvent = event => { if (event.event === eventName) { clear(); resolve(event.body || {}); } };
      const onClosed = error => { clear(); reject(error); };
      const timer = setTimeout(() => { clear(); reject(new Error(`Debugger did not report ${eventName}.`)); }, timeout);
      this.on("event", onEvent);
      this.on("closed", onClosed);
    });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.emit("closed", error);
    // Keep pipes drained even after a protocol failure: closing stdout while
    // the game is alive can terminate a native process with SIGPIPE.
    this.child.stdout.off("data", this.listeners.data);
    this.child.stdout.on("data", this.listeners.stderr);
  }
}

module.exports = { DapTransport, encodeRequest, MAX_FRAME_BYTES };

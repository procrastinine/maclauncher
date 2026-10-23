const { Duplex } = require("node:stream");

const commands = new Set(["accounts", "addAccount", "removeAccount", "enroll", "retire", "initializeServices", "removePackages", "storeToken", "storeImport"]);
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function error(code, message, name = "Error") {
  const failure = new Error(message);
  failure.name = name;
  failure.code = code;
  return failure;
}

/**
 * Requests over a dedicated, already connected supervisor-owned control Duplex.
 * Request: { schemaVersion: 1, id: decimalString, command, payload }.
 * Reply:   { schemaVersion: 1, id, result } or { schemaVersion: 1, id, error: { code, type?, site? } }.
 * Error diagnostics contain code identity only, never provider messages or values.
 * Each JSON document has a four-byte big-endian positive signed Java int length.
 *
 * This adapter never starts or stops the child. close() pauses the control reader
 * and detaches this adapter; the supervisor retains stream/process teardown.
 * Aborting a sent request cancels its original Android authenticator session.
 */
function createAccountControl({ child, control }) {
  if (!child || typeof child.on !== "function" || typeof child.removeListener !== "function"
      || !Number.isSafeInteger(child.pid) || child.pid <= 0)
    throw new TypeError("An owned Android account process is required.");
  if (!(control instanceof Duplex))
    throw new TypeError("A connected Android account control stream is required.");

  const pending = new Map(), queued = new Map(), abortGroups = new Map();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const header = Buffer.allocUnsafe(4);
  let nextId = 0n, closed = null, flushing = false, blocked = false;
  let headerBytes = 0, expectedBytes = null, bodyBytes = 0, bodyParts = [];

  function unwatchAbort(id, signal) {
    if (!signal) return;
    const group = abortGroups.get(signal);
    if (!group) return;
    group.ids.delete(id);
    if (!group.ids.size) {
      signal.removeEventListener("abort", group.abort);
      abortGroups.delete(signal);
    }
  }

  function settle(id, failure, result) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    queued.delete(id);
    unwatchAbort(id, entry.signal);
    if (failure) entry.reject(failure);
    else entry.resolve(result);
  }

  function terminate(failure) {
    if (closed) return;
    closed = failure;
    control.pause();
    for (const [event, listener] of controlListeners) control.removeListener(event, listener);
    for (const [event, listener] of childListeners) child.removeListener(event, listener);
    for (const id of pending.keys()) settle(id, failure);
    queued.clear();
    bodyParts = [];
    headerBytes = bodyBytes = 0;
    expectedBytes = null;
  }

  function protocolFailure() {
    terminate(error("ACCOUNT_CONTROL_PROTOCOL", "The Android account service returned an invalid response."));
  }

  function receive(bytes) {
    let reply;
    // JSON/parser exceptions may include account data; never propagate their text.
    try { reply = JSON.parse(decoder.decode(bytes)); }
    catch { protocolFailure(); return; }
    const latestId = nextId.toString();
    if (!reply || typeof reply !== "object" || Array.isArray(reply) || reply.schemaVersion !== 1
        || typeof reply.id !== "string" || !/^[1-9][0-9]*$/.test(reply.id)
        || reply.id.length > latestId.length || reply.id.length === latestId.length && reply.id > latestId
        || owns(reply, "result") === owns(reply, "error")) {
      protocolFailure(); return;
    }
    if (owns(reply, "error")) {
      if (!reply.error || typeof reply.error !== "object" || Array.isArray(reply.error)) {
        protocolFailure(); return;
      }
      const failure = error("ACCOUNT_PROVIDER_ERROR", "The Android account provider could not complete the request.");
      if (Number.isSafeInteger(reply.error.code)) failure.providerCode = reply.error.code;
      if (typeof reply.error.type === "string" && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){1,30}$/.test(reply.error.type) && reply.error.type.length <= 256)
        failure.providerFailureType = reply.error.type;
      if (typeof reply.error.site === "string" && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){1,30}:-?\d{1,7}$/.test(reply.error.site) && reply.error.site.length <= 384)
        failure.providerFailureSite = reply.error.site;
      settle(reply.id, failure);
    } else {
      // Includes false/null provider results; transport delivery does not imply success.
      settle(reply.id, null, reply.result);
    }
    // Settled/cancelled IDs need no tombstones: valid late replies are discarded.
  }

  function onData(chunk) {
    if (closed) return;
    if (!(chunk instanceof Uint8Array)) { protocolFailure(); return; }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < bytes.length && !closed) {
      if (expectedBytes === null) {
        const count = Math.min(4 - headerBytes, bytes.length - offset);
        bytes.copy(header, headerBytes, offset, offset + count);
        offset += count;
        headerBytes += count;
        if (headerBytes < 4) continue;
        expectedBytes = header.readUInt32BE(0);
        headerBytes = 0;
        if (!expectedBytes || expectedBytes > 0x7fffffff) { protocolFailure(); return; }
      }
      const count = Math.min(expectedBytes - bodyBytes, bytes.length - offset);
      if (count) {
        bodyParts.push(bytes.subarray(offset, offset + count));
        bodyBytes += count;
        offset += count;
      }
      if (bodyBytes === expectedBytes) {
        const message = bodyParts.length === 1 ? bodyParts[0] : Buffer.concat(bodyParts, bodyBytes);
        bodyParts = [];
        bodyBytes = 0;
        expectedBytes = null;
        receive(message);
      }
    }
  }

  function onControlError() {
    terminate(error("ACCOUNT_CONTROL_IO", "The Android account control connection failed."));
  }

  function onControlEnd() {
    terminate(error("ACCOUNT_CONTROL_EOF", "The Android account control connection closed."));
  }

  function onChildEnd() {
    terminate(error("ACCOUNT_OWNER_EXITED", "The Android account service process stopped."));
  }

  function flush() {
    if (closed || blocked || flushing) return;
    flushing = true;
    try {
      while (!closed && !blocked && queued.size) {
        const [id, frame] = queued.entries().next().value;
        queued.delete(id);
        blocked = !control.write(frame, failure => { if (failure) onControlError(); });
      }
    } catch { onControlError(); }
    finally { flushing = false; }
  }

  function onDrain() { blocked = false; flush(); }

  const controlListeners = [["data", onData], ["drain", onDrain], ["error", onControlError],
    ["end", onControlEnd], ["finish", onControlEnd], ["close", onControlEnd]];
  const childListeners = [["exit", onChildEnd], ["close", onChildEnd], ["error", onChildEnd]];
  for (const [event, listener] of controlListeners) control.on(event, listener);
  for (const [event, listener] of childListeners) child.on(event, listener);
  if (child.exitCode != null || child.signalCode != null) onChildEnd();
  else if (control.destroyed || control.readableEnded || control.writableEnded
      || !control.readable || !control.writable) onControlEnd();
  else control.resume();

  function request(command, payload = null, { signal, networkAllowed = false, interactive = false } = {}) {
    if (closed) return Promise.reject(closed);
    if (!commands.has(command)) return Promise.reject(new TypeError("The Android account command is invalid."));
    if (signal && !(signal instanceof AbortSignal))
      return Promise.reject(new TypeError("An account request requires a valid abort signal."));
    const aborted = () => error("ABORT_ERR", "The Android account request was cancelled.", "AbortError");
    if (signal?.aborted) return Promise.reject(aborted());

    const id = (++nextId).toString();
    let frame;
    try {
      const body = Buffer.from(JSON.stringify({ schemaVersion: 1, id, command, payload, networkAllowed, interactive }), "utf8");
      if (body.length > 0x7fffffff) return Promise.reject(new RangeError("The Android account request exceeds the framing limit."));
      const prefix = Buffer.allocUnsafe(4);
      prefix.writeUInt32BE(body.length);
      frame = Buffer.concat([prefix, body]);
    } catch { return Promise.reject(new TypeError("The Android account request must contain valid JSON data.")); }
    // Serialization can invoke caller-owned toJSON methods, including close/abort.
    if (closed) return Promise.reject(closed);
    if (signal?.aborted) return Promise.reject(aborted());

    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, signal });
      queued.set(id, frame);
      if (signal) {
        let group = abortGroups.get(signal);
        if (!group) {
          group = { ids: new Set(), abort: null };
          group.abort = () => { for (const pendingId of [...group.ids]) {
            const sent = !queued.has(pendingId); settle(pendingId, aborted());
            if (sent && !closed) {
              const cancelId = (++nextId).toString();
              const body = Buffer.from(JSON.stringify({ schemaVersion: 1, id: cancelId, command: "cancel", payload: { id: pendingId } }));
              const prefix = Buffer.allocUnsafe(4); prefix.writeUInt32BE(body.length);
              queued.set(cancelId, Buffer.concat([prefix, body])); flush();
            }
          } };
          abortGroups.set(signal, group);
          signal.addEventListener("abort", group.abort, { once: true });
        }
        group.ids.add(id);
        if (signal.aborted) settle(id, aborted());
      }
      flush();
    });
  }

  function close() {
    terminate(error("ACCOUNT_CONTROL_CLOSED", "The Android account control connection was closed."));
  }

  return { request, close };
}

module.exports = { createAccountControl };

const { randomBytes } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { spawnDetachedChecked } = require("./processes");
const { TOKEN_ENV, PROTOCOL_PREFIX, MAX_REPORT_BYTES, createHostedStartupReporter } = require("./hosted-startup-reporter");

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_DIAGNOSTIC_BYTES = 32768;

function boundedTail(current, next, limit = MAX_DIAGNOSTIC_BYTES) {
  const bytes = Buffer.concat([current, Buffer.isBuffer(next) ? next : Buffer.from(String(next))]);
  return bytes.length > limit ? bytes.subarray(bytes.length - limit) : bytes;
}

function diagnosticText(bytes) {
  const utf8 = Buffer.from(bytes.toString("utf8"));
  if (utf8.length <= MAX_DIAGNOSTIC_BYTES) return utf8.toString("utf8");
  let start = utf8.length - MAX_DIAGNOSTIC_BYTES;
  while ((utf8[start] & 0xc0) === 0x80) start++;
  return utf8.subarray(start).toString("utf8");
}

function validateElectronReady(report) {
  return Number.isSafeInteger(report.windowId) && report.windowId >= 1 && typeof report.url === "string" && Boolean(report.url);
}

/** Returns the original ChildProcess only after the real host reports loaded. */
async function launchHostedProcess({ executable, args = [], env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS,
  spawn = spawnDetachedChecked, forwardOutput = false, output = process.stdout, errors = process.stderr,
  logger, onDiagnostics, validateReady = validateElectronReady } = {}) {
  if (typeof executable !== "string" || !executable) throw new TypeError("Missing hosted runtime executable.");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new RangeError("Invalid hosted startup timeout.");
  if (typeof validateReady !== "function") throw new TypeError("Missing hosted readiness validator.");
  const token = randomBytes(24).toString("hex");
  const prefix = `${PROTOCOL_PREFIX}${token} `;
  const child = await spawn(executable, args, { env: { ...env, [TOKEN_ENV]: token }, detached: true,
    stdio: ["ignore", "pipe", "pipe"] });
  if (!child?.stdout || !child?.stderr || typeof child.once !== "function") {
    try { child?.kill?.("SIGKILL"); } catch {}
    throw new Error("Hosted runtime requires captured stdout and stderr for startup verification.");
  }
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), pending = "";
  const decoder = new StringDecoder("utf8");
  let settled = false, timer, exitTimer;
  child.ref?.();
  return new Promise((resolve, reject) => {
    const onStderr = bytes => {
      stderr = boundedTail(stderr, bytes);
      if (forwardOutput) errors.write(bytes);
    };
    function cleanup() {
      clearTimeout(timer); clearTimeout(exitTimer);
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
    }
    function releaseStreams(success) {
      if (success && forwardOutput) {
        const forwardStdout = bytes => output.write(bytes);
        const forwardStderr = bytes => errors.write(bytes);
        const closed = () => {
          child.stdout.removeListener("data", forwardStdout);
          child.stderr.removeListener("data", forwardStderr);
          child.removeListener("close", closed);
        };
        child.stdout.on("data", forwardStdout);
        child.stderr.on("data", forwardStderr);
        child.once("close", closed);
      } else {
        child.stdout.resume(); child.stderr.resume();
      }
      child.unref?.(); child.stdout.unref?.(); child.stderr.unref?.();
    }
    function fail(message, code, terminate = false, cause) {
      if (settled) return;
      settled = true;
      cleanup();
      if (forwardOutput && pending) output.write(pending);
      pending = "";
      let drainTimer, completed = false;
      const complete = () => {
        if (completed) return;
        completed = true; clearTimeout(drainTimer);
        child.stderr.removeListener("data", onStderr); child.removeListener("close", complete);
        releaseStreams(false);
        const diagnostic = diagnosticText(stderr).trim();
        const summary = String(message).split(/\r?\n/, 1)[0].slice(0, 400);
        const usefulLine = diagnostic.split(/\r?\n/).map(text => text.trim()).find(text =>
          text && !/^at\s|^\[\d+:.*:(?:ERROR|WARNING):/i.test(text));
        const detail = usefulLine?.slice(0, 200);
        const failure = new Error(`${summary}${detail && !summary.includes(detail) ? `\n${detail}` : ""}`, cause ? { cause } : undefined);
        failure.code = code; failure.stderr = diagnostic; failure.stdout = diagnosticText(stdout);
        failure.exitCode = child.exitCode ?? null; failure.signalCode = child.signalCode ?? null;
        const diagnostics = { code, executable, stderr: failure.stderr, stdout: failure.stdout,
          exitCode: failure.exitCode, signalCode: failure.signalCode };
        try { onDiagnostics?.(diagnostics); } catch {}
        try { logger?.error?.("[hosted] startup failed", diagnostics); } catch {}
        reject(failure);
      };
      if (terminate && child.exitCode == null && child.signalCode == null) {
        // Capture any already-written stderr as the owned child closes. The
        // drain is bounded even if a child inherited its parent's pipe handles.
        child.stderr.on("data", onStderr); child.once("close", complete);
        child.stdout.resume(); drainTimer = setTimeout(complete, 150);
        // Never signal a process group or unrelated host.
        try { child.kill("SIGKILL"); } catch {}
      } else complete();
    }
    function line(text) {
      if (!text.startsWith(prefix)) { if (forwardOutput) output.write(text + "\n"); return; }
      let report;
      try { report = JSON.parse(text.slice(prefix.length)); }
      catch { fail("Hosted runtime sent an invalid startup report.", "HOSTED_STARTUP_PROTOCOL", true); return; }
      if (report?.protocol !== 1 || !["ready", "error"].includes(report.status)) {
        fail("Hosted runtime sent an invalid startup report.", "HOSTED_STARTUP_PROTOCOL", true); return;
      }
      if (report.status === "error") {
        fail(`Hosted runtime failed to start: ${String(report.message || "Unknown host error").slice(0, 2048)}`,
          "HOSTED_STARTUP_ERROR", true); return;
      }
      let ready;
      try { ready = validateReady(report) === true; }
      catch (error) { fail("Hosted runtime could not verify its loaded game window.", "HOSTED_STARTUP_PROTOCOL", true, error); return; }
      if (!ready) {
        fail("Hosted runtime did not verify a loaded game window.", "HOSTED_STARTUP_PROTOCOL", true); return;
      }
      if (child.exitCode != null || child.signalCode != null) {
        fail("Hosted runtime exited before its game window was ready.", "HOSTED_STARTUP_EXIT"); return;
      }
      settled = true; cleanup(); releaseStreams(true); resolve(child);
    }
    function onStdout(bytes) {
      stdout = boundedTail(stdout, bytes);
      pending += decoder.write(bytes);
      let end;
      while (!settled && (end = pending.indexOf("\n")) >= 0) {
        const text = pending.slice(0, end).replace(/\r$/, ""); pending = pending.slice(end + 1);
        if (text.startsWith(prefix) && Buffer.byteLength(text) > MAX_REPORT_BYTES + prefix.length) {
          fail("Hosted startup report exceeds its limit.", "HOSTED_STARTUP_PROTOCOL", true); return;
        }
        line(text);
      }
      if (settled) {
        if (forwardOutput && pending) output.write(pending);
        pending = ""; return;
      }
      if (Buffer.byteLength(pending) > MAX_REPORT_BYTES + prefix.length) {
        if (pending.startsWith(prefix)) fail("Hosted startup report exceeds its limit.", "HOSTED_STARTUP_PROTOCOL", true);
        else { if (forwardOutput) output.write(pending); pending = ""; }
      }
    }
    const onError = error => fail(`Hosted runtime could not start: ${error.message}`, "HOSTED_STARTUP_ERROR", true, error);
    const onClose = (code, signal) => fail(`Hosted runtime exited before its game window was ready (${signal || `exit ${code ?? "unknown"}`}).`, "HOSTED_STARTUP_EXIT");
    const onExit = (code, signal) => {
      // Give stderr a bounded opportunity to drain before returning the failure.
      exitTimer = setTimeout(() => onClose(code, signal), 200);
    };
    child.stdout.on("data", onStdout); child.stderr.on("data", onStderr);
    child.once("error", onError); child.once("exit", onExit); child.once("close", onClose);
    timer = setTimeout(() => fail(`Hosted runtime did not load its game window within ${timeoutMs} ms.`, "HOSTED_STARTUP_TIMEOUT", true), timeoutMs);
    if (child.exitCode != null || child.signalCode != null) onClose(child.exitCode, child.signalCode);
  });
}

module.exports = { TOKEN_ENV, PROTOCOL_PREFIX, DEFAULT_TIMEOUT_MS, MAX_REPORT_BYTES, MAX_DIAGNOSTIC_BYTES,
  createHostedStartupReporter, launchHostedProcess };

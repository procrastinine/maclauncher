// Dependency-free trusted reporter, also suitable for copying into private hosts.
const TOKEN_ENV = "MACLAUNCHER_HOST_STARTUP_TOKEN";
const PROTOCOL_PREFIX = "MACLAUNCHER_HOST_STARTUP ";
const MAX_REPORT_BYTES = 8192;
const guardedStreams = new WeakSet();

function guardHostedOutput(streams = [process.stdout, process.stderr]) {
  for (const stream of streams) {
    if (!stream || typeof stream.on !== "function" || guardedStreams.has(stream)) continue;
    guardedStreams.add(stream);
    stream.on("error", error => {
      // Detached launchers close the captured startup pipes after readiness.
      // Continuing game logging must not open an uncaught-exception dialog.
      if (error?.code !== "EPIPE" && error?.code !== "ECONNRESET") throw error;
    });
  }
}

function createHostedStartupReporter({ token = process.env[TOKEN_ENV], write = text => process.stdout.write(text) } = {}) {
  const enabled = typeof token === "string" && /^[a-f0-9]{48}$/.test(token);
  let reported = false;
  function report(status, detail = {}) {
    if (!enabled || reported) return false;
    reported = true;
    const record = { ...detail, protocol: 1, status };
    let serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized) > MAX_REPORT_BYTES) serialized = JSON.stringify({ protocol: 1,
      status: "error", message: "Hosted startup metadata exceeds its limit." });
    write(`\n${PROTOCOL_PREFIX}${token} ${serialized}\n`);
    return true;
  }
  return {
    enabled,
    ready: detail => report("ready", detail),
    error: error => report("error", { message: String(error?.message || error).slice(0, 2048),
      stack: String(error?.stack || "").slice(0, 4096) })
  };
}

module.exports = { TOKEN_ENV, PROTOCOL_PREFIX, MAX_REPORT_BYTES, createHostedStartupReporter, guardHostedOutput };

const path = require("node:path");
const { formatWithOptions } = require("node:util");

// A detached host outlives its startup capture pipes. Keep runtime diagnostics
// in the profile log used by the launcher instead of relying on those pipes.
function createHostedLogger(userDataDir, { output = console, pid = process.pid } = {}) {
  const file = path.join(userDataDir, "logs", "main.log");
  const sink = require("./buffered-log").createBufferedLog(file);
  const write = (level, args) => {
    const message = formatWithOptions({ depth: 3, maxArrayLength: 30, maxStringLength: 4096 }, ...args).slice(0, 8192);
    const line = `[${new Date().toISOString()}] [${level}] [host:${pid}] ${message}\n`;
    sink.write(line);
    try { output?.[level === "debug" ? "log" : level]?.(message); } catch {}
  };
  return { path: file, flush: sink.flush, ...Object.fromEntries(["debug", "info", "warn", "error"].map(level => [level, (...args) => write(level, args)])) };
}

module.exports = { createHostedLogger };

const fs = require("node:fs");
const path = require("node:path");

const MAX_LOG_BYTES = 256 * 1024;
const MAX_ERROR_BYTES = 8192;

function retainNativeOutput(child, { directory, entry, context, version }) {
  if (!child?.once || !child.stdout || !child.stderr) return child;
  const file = path.join(directory, "native.log");
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600); }
  catch (error) { context.logger?.warn?.(`[nitroplus] Native log unavailable: ${error.message}`); return child; }
  let written = 0, closed = false, errorTail = Buffer.alloc(0), reported = false;
  function persist() {
    try {
      const result = context.onEntryChange?.({ moduleData: entry.moduleData });
      result?.catch?.(error => context.logger?.warn?.(`[nitroplus] Native log metadata: ${error.message}`));
    } catch (error) { context.logger?.warn?.(`[nitroplus] Native log metadata: ${error.message}`); }
  }
  function append(chunk, isError = false) {
    if (closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (isError) errorTail = Buffer.concat([errorTail, bytes.subarray(-MAX_ERROR_BYTES)]).subarray(-MAX_ERROR_BYTES);
    const count = Math.min(bytes.length, MAX_LOG_BYTES - written);
    if (count > 0 && fd !== undefined) {
      try { fs.writeSync(fd, bytes, 0, count); written += count; }
      catch (error) {
        try { fs.closeSync(fd); } catch {}
        fd = undefined;
        context.logger?.warn?.(`[nitroplus] Native log write failed: ${error.message}`);
      }
    }
  }
  function failed(code, signal, error) {
    if (reported || !error && !(code != null && code !== 0) && !["SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL", "SIGFPE"].includes(signal)) return;
    reported = true;
    const output = errorTail.toString("utf8").trim();
    const nativeError = output.split(/\r?\n/).filter(line => line.startsWith("Nitroplus:")).at(-1);
    const detail = nativeError || output || error?.message || `Native interpreter ended with ${signal || `exit ${code}`}.`;
    entry.moduleData = { ...entry.moduleData, nativeRuntimeError: detail, nativeRuntimeLogPath: file };
    persist();
    context.logger?.error?.(`[nitroplus] ${detail}`);
  }
  append(Buffer.from(`libnpengine ${version} native output\n`));
  entry.moduleData = { ...entry.moduleData, nativeRuntimeError: null, nativeRuntimeLogPath: file };
  persist();
  child.stdout.on("data", chunk => append(chunk));
  child.stderr.on("data", chunk => append(chunk, true));
  child.once("error", error => failed(null, null, error));
  child.once("close", (code, signal) => {
    if (!closed) { closed = true; if (fd !== undefined) fs.closeSync(fd); }
    failed(code, signal);
  });
  return child;
}

function readNativeLog(directory, entry) {
  const file = path.join(directory, "native.log");
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_LOG_BYTES) throw new Error("Nitroplus native log exceeds its read limit.");
    const bytes = Buffer.alloc(stat.size);
    fs.readSync(fd, bytes, 0, bytes.length, 0);
    return { available: true, error: entry.moduleData?.nativeRuntimeError || null, output: bytes.toString("utf8"), directory };
  } catch (error) {
    if (error.code === "ENOENT") return { available: false, output: "No native run log is available yet." };
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { MAX_LOG_BYTES, MAX_ERROR_BYTES, retainNativeOutput, readNativeLog };

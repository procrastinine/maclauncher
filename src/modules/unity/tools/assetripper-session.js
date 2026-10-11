const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createAbortError, throwIfAborted } = require("../../shared/runtime/download-utils");

// The supplied application uses its executable directory for preferences and
// temporary files. Hard links give each game a private directory without a
// second binary allocation, while the managed version remains shared.
function prepareWorkspace(install, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const linked = []; let cleaned = false;
  const cleanup = () => {
    if (cleaned) return; cleaned = true;
    for (const target of linked) fs.rmSync(target, { force: true });
    fs.rmSync(path.join(directory, "temp"), { recursive: true, force: true });
  };
  try {
  for (const [relative, record] of Object.entries(install.installationMetadata.files)) {
    if (relative !== "AssetRipper.GUI.Free" && !relative.endsWith(".dylib")) continue;
    const target = path.join(directory, relative), source = path.join(install.installDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      const original = fs.statSync(source), existing = fs.lstatSync(target);
      if (!existing.isFile() || existing.dev !== original.dev || existing.ino !== original.ino) fs.rmSync(target);
    }
    if (!fs.existsSync(target)) fs.linkSync(source, target);
    linked.push(target);
    if ((fs.statSync(target).mode & 0o777) !== record.mode) throw new Error("AssetRipper workspace executable changed.");
  }
  } catch (error) { cleanup(); throw error; }
  return { executable: path.join(directory, "AssetRipper.GUI.Free"), cleanup };
}
async function startSession(install, directory, { signal, onSpawn, spawnChild = spawn, timeout = 30000 } = {}) {
  throwIfAborted(signal);
  const workspace = prepareWorkspace(install, directory), logPath = path.join(directory, "AssetRipper.log");
  let child;
  try { child = spawnChild(workspace.executable, ["--headless", "--port", "0", "--log-path", logPath],
    { cwd: directory, env: { ...process.env, TMPDIR: directory, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { workspace.cleanup(); throw error; }
  let output = "", resolveReady, rejectReady, closed = false, stopping = false, force;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const close = () => {
    if (closed || stopping) return;
    stopping = true;
    try { child.kill("SIGTERM"); } catch {}
    force = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
    force.unref?.();
  };
  const record = data => {
    output = (output + data.toString()).slice(-32768);
    const match = /Now listening on:\s+(http:\/\/127\.0\.0\.1:([0-9]{1,5}))\b/.exec(output);
    if (match && Number(match[2]) > 0 && Number(match[2]) <= 65535) resolveReady(match[1]);
  };
  child.stdout.on("data", record); child.stderr.on("data", record);
  child.once("error", error => { rejectReady(error); workspace.cleanup(); });
  child.once("close", () => { closed = true; clearTimeout(force); rejectReady(new Error("AssetRipper closed before opening its inspector. " + output.slice(-1500))); workspace.cleanup(); });
  const abort = () => { rejectReady(createAbortError()); close(); };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { rejectReady(new Error("AssetRipper did not open its local inspector in time. See " + logPath + ".")); close(); }, timeout);
  try {
    const owned = Promise.resolve(onSpawn?.(child));
    const [url] = await Promise.all([ready, owned]);
    throwIfAborted(signal);
    return { child, url, logPath, directory, close, isOpen: () => !closed,
      waitClosed: () => closed ? Promise.resolve() : new Promise(resolve => child.once("close", resolve)) };
  } catch (error) { close(); throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
async function localRequest(session, endpoint, fields, { signal, timeout = 300000, fetch: request = fetch } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(session.url) || !/^\/[A-Za-z]+(?:\/[A-Za-z]+)?$/.test(endpoint))
    throw new Error("AssetRipper requests require its local inspector.");
  throwIfAborted(signal);
  const response = await request(session.url + endpoint, { method: "POST", redirect: "manual",
    body: new URLSearchParams(fields), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  if (response.status !== 302 && !response.ok) throw new Error(`AssetRipper could not complete this action (${response.status}). See ${session.logPath}.`);
}
module.exports = { prepareWorkspace, startSession, localRequest };

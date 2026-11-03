const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { stopProcessTree } = require("../../core/process-stop");

function toolEnvironment(input = process.env) {
  const env = { ...input };
  for (const key of Object.keys(env)) {
    if (/^(?:DYLD_|RESHADE_|MACLAUNCHER_)/.test(key) || key === "NODE_OPTIONS") delete env[key];
  }
  return env;
}

function hasResourceCache(project) {
  const cache = path.join(project, ".godot");
  let directory;
  try {
    directory = fs.opendirSync(path.join(cache, "imported"));
    let entry;
    while ((entry = directory.readSync())) {
      if (entry.isFile() && fs.statSync(path.join(cache, "imported", entry.name)).size > 0) return true;
    }
  } catch { /* A fresh project still needs Godot's ordinary import. */ }
  finally {directory?.closeSync();directory = null;}
  // Script-only projects need no imported asset. Godot saves this versioned
  // editor index after its first import scan; a class index alone is not enough.
  try {
    directory = fs.opendirSync(path.join(cache, "editor"));
    let entry;
    while ((entry = directory.readSync())) {
      if (/^filesystem_cache[0-9]+$/.test(entry.name) && entry.isFile() &&
          fs.statSync(path.join(cache, "editor", entry.name)).size > 0) return true;
    }
  } catch { /* No completed editor cache was found. */ }
  finally {directory?.closeSync();}
  return false;
}

function runImport(executable, project, { signal, onToolProcessSpawn, env, logFile, stop = stopProcessTree } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(executable, ["--headless", "--editor", "--path", project, "--import"],
      { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error, timedOut = false;
    const collect = data => { output = (output + data.toString("utf8")).slice(-1024 * 1024); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const stopFailed = value => {
      error ||= value;
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill("SIGKILL"); } catch {}
      }
    };
    const abort = () => {
      if (child.exitCode != null || child.signalCode != null) return;
      try { Promise.resolve(stop(child.pid)).catch(stopFailed); }
      catch (value) { stopFailed(value); }
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; abort(); }, 180000);
    child.on("error", value => { error = value; });
    try {
      Promise.resolve(onToolProcessSpawn?.(child, { stopOnLauncherExit: true })).catch(value => {
        error = value; abort();
      });
    } catch (value) { error = value; abort(); }
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      try { if (logFile) fs.writeFileSync(logFile, output); } catch {}
      if (signal?.aborted) return reject(signal.reason || new Error("Godot project preparation was cancelled."));
      if (error) return reject(error);
      if (timedOut) return reject(new Error("Godot project resource preparation timed out."));
      if (code !== 0) return reject(new Error(`Godot could not prepare project resources (exit ${code}).`));
      resolve();
    });
    if (signal?.aborted) abort();
  });
}

async function prepare(_entry, { target, executable, version, signal,
  onToolProcessSpawn, run = runImport } = {}) {
  if (target?.kind !== "project" || !/^4\./.test(String(version))) return target;
  signal?.throwIfAborted();
  const source = path.resolve(target.path);
  if (hasResourceCache(source)) return target;
  // Godot imports beside the original resources and owns .godot plus .import
  // sidecars. Keep its ordinary project, cwd, HOME and user-data routes intact.
  await run(executable, source, {signal, onToolProcessSpawn, env: toolEnvironment()});
  signal?.throwIfAborted();
  return target;
}

module.exports = { prepare, toolEnvironment, runImport };

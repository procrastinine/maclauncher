const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { stopProcessTree } = require("../../core/process-stop");
const GameData = require("../shared/game-data");

const ignoredDirectory = name => name === ".git" || name === ".godot" || name === ".import";
const within = (root, file) => file === root || file.startsWith(root + path.sep);

function destinationPath(file) {
  let existing = path.resolve(file);
  const missing = [];
  while (!fs.existsSync(existing)) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

function toolEnvironment(input = process.env) {
  const env = { ...input };
  for (const key of Object.keys(env)) {
    if (/^(?:DYLD_|RESHADE_|MACLAUNCHER_)/.test(key) || key === "NODE_OPTIONS") delete env[key];
  }
  return env;
}

// Inspect only contained resources. Internal links become regular private files;
// neither a cyclic link nor an external directory can expand the preparation.
async function inspect(directory, signal, {omitDirectory = ignoredDirectory} = {}) {
  const root = fs.realpathSync(directory), entries = [];
  const hash = crypto.createHash("sha256");
  async function visit(current, relative = "", ancestors = new Set(), depth = 0) {
    signal?.throwIfAborted();
    if (depth > 128) throw new Error("Godot project directories are nested too deeply.");
    let actual;
    try { actual = fs.realpathSync(current); }
    catch (error) {
      if (error.code === "ELOOP" || error.code === "ENOENT") throw new Error(`Godot project contains a broken or cyclic link: ${relative || "."}`);
      throw error;
    }
    if (!within(root, actual)) throw new Error(`Godot project links must stay inside the project: ${relative}`);
    if (ancestors.has(actual)) throw new Error(`Godot project contains a cyclic directory link: ${relative}`);
    const parents = new Set(ancestors); parents.add(actual);
    for (const name of (await fs.promises.readdir(actual)).sort()) {
      signal?.throwIfAborted();
      if (omitDirectory(name)) continue;
      const file = path.join(actual, name), key = path.join(relative, name);
      let resolved;
      try { resolved = fs.realpathSync(file); }
      catch (error) {
        if (error.code === "ELOOP" || error.code === "ENOENT") throw new Error(`Godot project contains a broken or cyclic link: ${key}`);
        throw error;
      }
      if (!within(root, resolved)) throw new Error(`Godot project links must stay inside the project: ${key}`);
      const stat = fs.statSync(resolved, { bigint: true });
      if (!stat.isDirectory() && !stat.isFile()) throw new Error(`Godot project resources must be files or directories: ${key}`);
      if (entries.length >= 250000) throw new Error("Godot project contains too many resource entries to prepare.");
      entries.push({ source: resolved, relative: key, stat });
      hash.update(`${key}\0${stat.isDirectory() ? "directory" : "file"}\0${stat.size}\0${stat.mtimeNs}\0`);
      if (stat.isDirectory()) await visit(resolved, key, parents, depth + 1);
    }
  }
  await visit(root);
  return { root, entries, fingerprint: hash.digest("hex") };
}

// Metadata checks detect asset updates without reading large texture/model data.
async function fingerprint(directory, signal) { return (await inspect(directory, signal)).fingerprint; }

function hasResourceCache(project, allowScriptOnly = false) {
  try {
    const cache = path.join(project, ".godot");
    if (!fs.lstatSync(cache).isDirectory()) return false;
    const classes = path.join(cache, "global_script_class_cache.cfg");
    // A script index alone does not prove an original project's assets were
    // imported. It is sufficient only after our editor import completed.
    if (allowScriptOnly && fs.existsSync(classes) && fs.lstatSync(classes).isFile() && fs.statSync(classes).size > 0) return true;
    const imported = path.join(cache, "imported");
    return fs.lstatSync(imported).isDirectory() && fs.readdirSync(imported).some(name => {
      const stat = fs.lstatSync(path.join(imported, name));
      return stat.isFile() && stat.size > 0;
    });
  } catch { return false; }
}

async function copyResources(snapshot, destination, signal) {
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const entry of snapshot.entries) {
    signal?.throwIfAborted();
    const actual = fs.realpathSync(entry.source), stat = fs.statSync(actual, { bigint: true });
    if (actual !== entry.source || !within(snapshot.root, actual) || stat.dev !== entry.stat.dev ||
        stat.ino !== entry.stat.ino || stat.size !== entry.stat.size || stat.mtimeNs !== entry.stat.mtimeNs)
      throw new Error("Godot project resources changed during preparation. Try Play again.");
    const output = path.join(destination, entry.relative);
    if (stat.isDirectory()) fs.mkdirSync(output, { mode: 0o700 });
    else {
      await fs.promises.copyFile(actual, output, fs.constants.COPYFILE_FICLONE);
      // Only newly copied regular files are made writable; no source or link
      // target is chmodded, even when source assets were read-only.
      fs.chmodSync(output, (Number(stat.mode) & 0o777) | 0o600);
    }
  }
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
      try { fs.writeFileSync(logFile, output); } catch {}
      if (signal?.aborted) return reject(signal.reason || new Error("Godot project preparation was cancelled."));
      if (error) return reject(error);
      if (timedOut) return reject(new Error("Godot project resource preparation timed out."));
      if (code !== 0) return reject(new Error(`Godot could not prepare project resources (exit ${code}).`));
      resolve();
    });
    if (signal?.aborted) abort();
  });
}

async function prepare(entry, { target, executable, version, userDataDir, signal,
  onToolProcessSpawn, run = runImport } = {}) {
  if (target?.kind !== "project" || !/^4\./.test(String(version))) return target;
  signal?.throwIfAborted();
  const source = fs.realpathSync(target.path);
  // Projects already prepared by their editor keep their existing launch path.
  if (hasResourceCache(source)) return target;
  const identity = crypto.createHash("sha256").update(source + "\0" + executable + "\0" + version).digest("hex").slice(0, 20);
  const directory = destinationPath(path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, "godot"), "source-projects", identity));
  if (directory === source || directory.startsWith(source + path.sep)) throw new Error("Godot project storage must be outside the original project.");
  const snapshot = await inspect(source, signal), input = snapshot.fingerprint;
  const project = path.join(directory, "project"), marker = path.join(directory, "prepared.json");
  try {
    const previous = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (previous.schema === 1 && previous.input === input && previous.version === version && hasResourceCache(project, true))
      return { ...target, path: project };
  } catch {}
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, "preparing-" + crypto.randomBytes(8).toString("hex"));
  try {
    // Imports write sidecar metadata alongside resources. A writable private
    // clone keeps those writes away from the selected source project.
    await copyResources(snapshot, temporary, signal);
    signal?.throwIfAborted();
    const home = path.join(directory, "editor-home"); fs.mkdirSync(home, { recursive: true });
    await run(executable, temporary, { signal, onToolProcessSpawn,
      env: { ...toolEnvironment(), HOME: home, XDG_DATA_HOME: home, XDG_CONFIG_HOME: home },
      logFile: path.join(directory, "import.log") });
    signal?.throwIfAborted();
    if (!hasResourceCache(temporary, true)) throw new Error("Godot did not create the project resource cache.");
    // Never replace the accepted cache until the new import has completed.
    const previous = path.join(directory, "previous");
    fs.rmSync(previous, { recursive: true, force: true });
    if (fs.existsSync(project)) fs.renameSync(project, previous);
    try { fs.renameSync(temporary, project); }
    catch (error) { if (fs.existsSync(previous)) fs.renameSync(previous, project); throw error; }
    fs.writeFileSync(marker, JSON.stringify({ schema: 1, input, version, source, preparedAt: Date.now() }));
    fs.rmSync(previous, { recursive: true, force: true });
    return { ...target, path: project };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { prepare, toolEnvironment, fingerprint, runImport, inspect, copyResources };

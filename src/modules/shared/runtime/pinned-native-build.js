const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const Native = require("./local-native");
const Guards = require("./guards");
const { createAbortError, isAbortError, throwIfAborted } = require("./download-utils");

const execFileAsync = promisify(execFile);

async function git(sourceDir, args, signal) {
  const result = await execFileAsync("git", ["-c", "core.fsmonitor=false", "-C", sourceDir, ...args], {
    encoding: "utf8", maxBuffer: Guards.limit(16 * 1024 * 1024), timeout: 30000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, ...(signal ? { signal } : {})
  });
  return result.stdout;
}

function validateSourceScope(sourceScope) {
  if (sourceScope === undefined) return undefined;
  if (!sourceScope || typeof sourceScope !== "object" || Array.isArray(sourceScope) ||
      Object.keys(sourceScope).some(key => !["kind", "omittedSubmodules"].includes(key)) ||
      sourceScope.kind !== "primary-tree" || !Array.isArray(sourceScope.omittedSubmodules) ||
      !sourceScope.omittedSubmodules.length || sourceScope.omittedSubmodules.length > Guards.limit(64) ||
      sourceScope.omittedSubmodules.some(value => typeof value !== "string" || !value || value.length > 1024 ||
        /[\\\r\n\0]/.test(value) || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) ||
        value.split("/").some(part => ["", ".", "..", ".git"].includes(part))) ||
      new Set(sourceScope.omittedSubmodules).size !== sourceScope.omittedSubmodules.length) {
    throw new Error("Primary source scopes require exact, unique relative omitted-submodule paths.");
  }
  return { kind: "primary-tree", omittedSubmodules: [...sourceScope.omittedSubmodules] };
}

async function validatePinnedSource(sourceDir, revision, { signal, sourceScope } = {}) {
  throwIfAborted(signal);
  const scope = validateSourceScope(sourceScope);
  if (!path.isAbsolute(sourceDir || "") || !/^[a-f0-9]{40}$/.test(revision || "")) throw new Error("A local source checkout and full pinned Git revision are required.");
  let head;
  try { head = (await git(sourceDir, ["rev-parse", "HEAD"], signal)).trim(); }
  catch (error) { if (isAbortError(error)) throw error; throw new Error("The runtime source is missing. Initialize its submodule or choose a Git checkout in Runtime Settings."); }
  if (head !== revision) throw new Error(`Source revision mismatch: expected ${revision}, found ${head}.`);
  if ((await git(sourceDir, ["status", "--porcelain=v1", "--untracked-files=no", ...(scope ? ["--ignore-submodules=all"] : [])], signal)).trim()) throw new Error("Pinned source checkout has tracked changes; use a clean checkout.");
  if (scope) {
    const entries = (await git(sourceDir, ["ls-tree", "-r", "-z", "--full-tree", revision], signal)).split("\0").filter(Boolean);
    const files = [], omittedSubmodules = [];
    for (const entry of entries) {
      const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40})\t([^]*)$/.exec(entry);
      if (!match || (match[1] === "160000") !== (match[2] === "commit")) throw new Error("Pinned primary tree contains an unsupported Git entry.");
      if (match[1] === "160000") omittedSubmodules.push({ path: match[4], revision: match[3] });
      else files.push(match[4]);
    }
    omittedSubmodules.sort((a, b) => a.path.localeCompare(b.path));
    if (JSON.stringify(omittedSubmodules.map(item => item.path).sort()) !== JSON.stringify([...scope.omittedSubmodules].sort())) {
      throw new Error("Primary source scope must list every direct pinned Git submodule exactly.");
    }
    if (!files.length || files.length > Guards.limit(100000)) throw new Error("Pinned source file inventory is empty or exceeds supported bounds.");
    return { head, files, sourceScope: scope, omittedSubmodules };
  }
  const submodules = await git(sourceDir, ["submodule", "status", "--recursive"], signal);
  if (submodules.split("\n").some(line => line && line[0] !== " ")) throw new Error("Pinned source submodules are missing or use a different revision. Initialize them explicitly before building.");
  const files = (await git(sourceDir, ["ls-files", "-z", "--recurse-submodules"], signal)).split("\0").filter(Boolean);
  if (!files.length || files.length > Guards.limit(100000)) throw new Error("Pinned source file inventory is empty or exceeds supported bounds.");
  return { head, files };
}

function visitPinnedFiles(sourceDir, files, visitor) {
  const tree = crypto.createHash("sha256");
  for (const relative of [...files].sort()) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === ".git" || part === "..")) throw new Error("Unsafe path in pinned source inventory.");
    const source = path.join(sourceDir, relative);
    const stat = fs.lstatSync(source);
    tree.update(relative + "\0");
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(source);
      const resolved = path.resolve(path.dirname(source), link);
      if (path.isAbsolute(link) || !resolved.startsWith(sourceDir + path.sep)) throw new Error("Pinned source symlink escapes the source tree.");
      visitor?.({ source, relative, stat, link });
      tree.update("symlink\0" + link + "\0");
    } else {
      if (!stat.isFile()) throw new Error("Pinned source inventory contains an uninitialized submodule or non-file entry.");
      const target = visitor?.({ source, relative, stat });
      tree.update(Native.hashFile(target || source) + "\0");
    }
  }
  return tree.digest("hex");
}

function hashPinnedFiles(sourceDir, files) {
  return visitPinnedFiles(sourceDir, files);
}

// A build lists its declared Homebrew formula prefixes in CMAKE_PREFIX_PATH.
function declaredToolDirectories(env = process.env) {
  return String(env.CMAKE_PREFIX_PATH || "").split(path.delimiter).filter(Boolean)
    .flatMap(prefix => [path.join(prefix, "bin"), path.join(prefix, "sbin")]).filter(directory => fs.existsSync(directory));
}

// Declared formulae come before PATH, where the Xcode compiler directory also carries older flex and bison.
function findBuildTool(name, env = process.env) {
  const directories = [...new Set([...declaredToolDirectories(env), "/opt/homebrew/bin", "/usr/local/bin", ...String(env.PATH || "").split(path.delimiter)].filter(Boolean))];
  for (const directory of directories) {
    const file = path.join(directory, name);
    try { if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return file; } } catch {}
  }
  const install = ["cmake", "ninja"].includes(name)
    ? `Install with 'brew install ${name}' (https://brew.sh/); executables belong in /opt/homebrew/bin on Apple Silicon or /usr/local/bin on Intel.`
    : "Install the upstream build prerequisites explicitly.";
  throw new Error(`${name} is required for a native source build. ${install} See docs/runtimes/NATIVE_TOOL_SETUP.md, then retry.`);
}

async function runBuildCommand(command, args, { cwd, logPath, env, signal, timeout = 15 * 60 * 1000 } = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(logPath, "a");
    fs.writeSync(fd, `$ ${command} ${args.join(" ")}\n`);
    let child;
    const grouped = process.platform !== "win32";
    try { child = spawn(command, args, { cwd, env, detached: grouped, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { fs.closeSync(fd); reject(error); return; }
    let bytes = 0;
    let tail = "";
    let settled = false;
    let stopped = false;
    let timedOut = false;
    let forceKillTimer;
    const record = data => {
      if (settled) return;
      tail = (tail + data.toString()).slice(-8192);
      if (bytes < 8 * 1024 * 1024) { const chunk = data.subarray(0, 8 * 1024 * 1024 - bytes); fs.writeSync(fd, chunk); bytes += chunk.length; }
    };
    const stop = () => {
      if (settled || stopped) return;
      stopped = true;
      try { if (grouped && child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch {}
      forceKillTimer = setTimeout(() => {
        try { if (grouped && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {}
      }, 5000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    const finish = error => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(forceKillTimer); signal?.removeEventListener("abort", stop); fs.closeSync(fd);
      if (error) reject(error); else resolve();
    };
    child.stdout.on("data", record); child.stderr.on("data", record);
    child.once("error", finish);
    child.once("close", (code, exitSignal) => finish(signal?.aborted ? createAbortError()
      : timedOut ? new Error(`Native build command timed out. See ${logPath}.`)
      : code === 0 ? null : new Error(`Native build command failed (${exitSignal || code}). See ${logPath}.\n${tail}`)));
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
  });
}

module.exports = { validateSourceScope, validatePinnedSource, hashPinnedFiles, runBuildCommand, findBuildTool, declaredToolDirectories };

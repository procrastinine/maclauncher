const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const ChildProcess = require("node:child_process");

// The one copy path for game files, imports and runtime payloads. An APFS clone
// shares blocks with its source until either side is written: unchanged bytes
// take no space, and later edits to the game, the runtime or the copy stay on
// their own side. Node's COPYFILE_FICLONE copies bytes on macOS (libuv clones
// only on Linux), so Darwin uses cp -c. It clones and falls back to copyfile on
// a filesystem without clones; a failed file clone falls back to cp -p.
// Asynchronous file clones go through one long-lived clonefile worker instead,
// because a process per file costs milliseconds. A clone needs the source and
// the destination on one volume: other pairs, and volumes that reported they
// cannot clone, go straight to cp -p. Each new file or tree lands under a
// temporary name beside its destination and is then renamed into place, so an
// interrupted copy never leaves a partial file under the real name. A tree
// merged into an existing directory is staged whole the same way and then
// moved in entry by entry; a failure while moving can leave some of its
// complete files merged.
// Copies keep modes, timestamps and verbatim symbolic links. A clone also
// carries the original's ACL and BSD flags, such as Finder's lock, which
// Node's copies dropped and which would keep the copy from being published,
// written or removed; the staged copy drops them, and quarantine wherever it
// can affect loading: trees, executables and libraries. Other extended
// attributes and resource forks stay with real macOS files, including when a
// clone is unavailable. Small files skip the clone attempt: below SMALL_FILE
// synchronously and SMALL_CLONE asynchronously. Members of Electron's app.asar
// exist only through Electron's fs, which extracts their bytes to the real
// destination; they and files on other platforms keep the Node copy path.
const SMALL_FILE = 1024 * 1024, SMALL_CLONE = 64 * 1024;
const native = () => process.platform === "darwin";
const archived = file => file.split(path.sep).includes("app.asar");
const lstat = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
const lstatAsync = file => fs.promises.lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
const exists = destination => Object.assign(new Error("The destination already exists."), { code: "EEXIST", path: destination });
// $1 staged target, $2 nonempty to drop quarantine. Never modify the source.
const SANITIZE_SCRIPT = '/usr/bin/chflags -R nouchg,nouappnd "$1"; /bin/chmod -R -N "$1" 2>/dev/null; ' +
  '[ -z "$2" ] || /usr/bin/xattr -d -r -s com.apple.quarantine "$1" 2>/dev/null; exit 0';
// $1 cp flags, $2 source, $3 target, $4 nonempty to drop quarantine.
const CP_SCRIPT = '/bin/cp "$1" "$2" "$3" || exit 1; shift 2; ' + SANITIZE_SCRIPT;
const UNLOCK_SCRIPT = '/usr/bin/chflags -R nouchg,nouappnd "$1"; /bin/chmod -R -N "$1"; /bin/chmod -R u+w "$1"; exit 0';
const ENOTSUP = 45, EXDEV = 18;
// Devices that reported they cannot clone.
const unclonable = new Set();

// A copy interrupted by a crash leaves its staged name behind. The first copy
// into a folder in each process removes staged names there whose change time
// is over an hour old; a copy in progress keeps changing its own.
const STAGED = /^\.clone-[0-9a-f]{12}$/, STALE = 60 * 60 * 1000, swept = new Set();
function stagedName(destination) {
  const parent = path.dirname(destination);
  if (!swept.has(parent)) {
    if (swept.size >= 4096) swept.clear();
    swept.add(parent);
    try {
      for (const name of fs.readdirSync(parent)) {
        if (!STAGED.test(name)) continue;
        const file = path.join(parent, name);
        if (Date.now() - fs.lstatSync(file).ctimeMs > STALE) discardSync(file);
      }
    } catch {}
  }
  return path.join(parent, ".clone-" + crypto.randomBytes(6).toString("hex"));
}
// Never throws, so a failed cleanup cannot hide the copy's own error. A locked
// or read-only leftover is made removable and tried once more.
function discardSync(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.rmSync(file, { recursive: true, force: true }); return; } catch {}
    if (attempt === 0 && native()) ChildProcess.spawnSync("/bin/sh", ["-c", UNLOCK_SCRIPT, "sh", file], { stdio: "ignore" });
  }
}
async function discard(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await fs.promises.rm(file, { recursive: true, force: true }); return; } catch {}
    if (attempt === 0 && native()) await run("/bin/sh", ["-c", UNLOCK_SCRIPT, "sh", file]).catch(() => {});
  }
}

function plan(source, options, info, parent, small) {
  const directory = info.isDirectory();
  if (!directory && !info.isFile()) throw Object.assign(new Error("Only files and directories can be copied."), { code: "EINVAL", path: source });
  const usable = native() && !archived(source), clone = usable && info.dev === parent.dev && !unclonable.has(info.dev);
  return { directory, overwrite: options.overwrite !== false && !options.exclusive, clone, metadata: usable && !directory,
    cp: usable && (directory || clone && info.size >= small),
    strip: directory || !!(info.mode & 0o111) || /\.(?:dylib|so|bundle)$/i.test(source) };
}
// Targets are new; merges move a new staged tree into place.
function cpArgs(job, options, source, target) {
  const flags = "-cp" + (job.directory ? "R" + (options.dereference ? "L" : "") : "");
  return ["-c", CP_SCRIPT, "sh", flags, job.directory ? source + "/" : source, target, job.strip ? "1" : ""];
}
function treeOptions(job, options) {
  return { recursive: true, force: job.overwrite, errorOnExist: false, dereference: !!options.dereference, verbatimSymlinks: !options.dereference,
    preserveTimestamps: true, mode: fs.constants.COPYFILE_FICLONE };
}
const NEW_FILE = fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL;
const sanitizeArgs = (target, job) => ["-c", SANITIZE_SCRIPT, "sh", target, job.strip ? "1" : ""];
const copyFailure = exitCode => Object.assign(new Error("The file could not be copied with its metadata."), { code: "COPY_FAILED", exitCode });
// Moving into a destination that is a symbolic link would write into its target.
function assertMergeable(destination, before) {
  if (before.isSymbolicLink()) throw Object.assign(new Error("A folder cannot be copied into a symbolic link."), { code: "EINVAL", path: destination });
}

// Copy to a new target.
function copySync(source, target, job, info, options) {
  if (job.cp) {
    const result = ChildProcess.spawnSync("/bin/sh", cpArgs(job, options, source, target), { stdio: "ignore" });
    if (!result.error && result.status === 0) return;
    discardSync(target);
  }
  if (job.directory) return fs.cpSync(source, target, treeOptions(job, options));
  if (job.metadata) {
    // cp -p uses macOS copyfile for xattrs/resource forks as well as data. Do
    // not publish a bytes-only copy if this real-file fallback fails.
    for (const [command, args] of [["/bin/cp", ["-p", source, target]], ["/bin/sh", sanitizeArgs(target, job)]]) {
      const result = ChildProcess.spawnSync(command, args, { stdio: "ignore" });
      if (result.error) throw result.error;
      if (result.status !== 0) throw copyFailure(result.status);
    }
    return;
  }
  fs.copyFileSync(source, target, NEW_FILE);
  fs.utimesSync(target, info.atimeMs / 1000, info.mtimeMs / 1000);
}
function mergeSync(source, destination, job, options) {
  const staged = stagedName(destination);
  try { copySync(source, staged, job, null, options); moveInSync(staged, destination, job.overwrite); } finally { discardSync(staged); }
}
// Folders merge; other entries replace what is there, or are left out with
// `overwrite: false`. Renaming never writes through a link.
function moveInSync(from, to, overwrite) {
  for (const name of fs.readdirSync(from)) {
    const source = path.join(from, name), target = path.join(to, name), existing = lstat(target);
    if (existing?.isDirectory() && fs.lstatSync(source).isDirectory()) moveInSync(source, target, overwrite);
    else if (!existing || overwrite) fs.renameSync(source, target);
  }
}
// Rename replaces a file without writing through links. A hard link publishes
// without replacing; filesystems without hard links fall back to a checked rename.
// Returns false when a tree must merge into a directory that appeared meanwhile.
function publishSync(staged, destination, job, exclusive) {
  if (job.directory || job.overwrite) {
    try { fs.renameSync(staged, destination); return true; } catch (error) {
      if (!job.directory || !["ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
      if (exclusive) throw exists(destination);
      return false;
    }
  }
  try { fs.linkSync(staged, destination); } catch (error) {
    if (error.code !== "EEXIST" && !lstat(destination)) return fs.renameSync(staged, destination), true;
    if (exclusive) throw exists(destination);
  }
  return true;
}

/** Clone or copy one file or directory tree. A directory merges into an
 * existing destination. `exclusive` refuses an existing destination and
 * `overwrite: false` keeps existing files; `dereference` follows links inside a tree. */
function cloneOrCopySync(source, destination, options = {}) {
  source = path.resolve(source); destination = path.resolve(destination);
  const info = fs.statSync(source), before = lstat(destination);
  if (before && options.exclusive) throw exists(destination);
  // Like fs.cp, a tree copy creates missing parent directories.
  if (info.isDirectory()) fs.mkdirSync(path.dirname(destination), { recursive: true });
  const job = plan(source, options, info, fs.statSync(path.dirname(destination)), SMALL_FILE);
  if (before) {
    if (job.directory) { assertMergeable(destination, before); return mergeSync(source, destination, job, options); }
    if (!job.overwrite) return;
  }
  const staged = stagedName(destination);
  try {
    copySync(source, staged, job, info, options);
    if (!publishSync(staged, destination, job, options.exclusive)) moveInSync(staged, destination, job.overwrite);
  } finally { discardSync(staged); }
}

// Wait for close, including after cancellation, before removing a partial copy.
function run(command, args, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = ChildProcess.spawn(command, args, { stdio: "ignore" });
    let failure;
    const abort = () => child.kill("SIGTERM");
    child.once("error", error => { failure = error; });
    child.once("close", code => {
      signal?.removeEventListener("abort", abort);
      try { signal?.throwIfAborted(); } catch (error) { reject(error); return; }
      resolve(failure ? -1 : code);
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
// clonefile with CLONE_NOOWNERCOPY; then, on the clone, Foundation clears the
// lock and append-only flags (keeping every other flag), an empty ACL replaces
// the copied one and removexattr with XATTR_NOFOLLOW drops quarantine. Lines
// are ASCII JSON so a read can split anywhere; each answer is 0 or clonefile's errno.
// The worker ends at end of input, which also follows its parent's death. JXA
// returns NSData's length as a string, so it is converted before the test.
// While it waits for input it also keeps an alarm armed, whose default action
// ends it: a worker can never wait unattended for longer than WORKER_ORPHAN.
const WORKER_IDLE = 10000, WORKER_TIMEOUT = 30000, WORKER_ORPHAN = 30;
const WORKER_SCRIPT = `ObjC.import("Foundation");
ObjC.bindFunction("clonefile", ["int", ["char *", "char *", "unsigned int"]]);
ObjC.bindFunction("removexattr", ["int", ["char *", "char *", "int"]]);
ObjC.bindFunction("acl_init", ["void *", ["int"]]);
ObjC.bindFunction("acl_set_link_np", ["int", ["char *", "int", "void *"]]);
ObjC.bindFunction("acl_free", ["int", ["void *"]]);
ObjC.bindFunction("__error", ["int *", []]);
ObjC.bindFunction("alarm", ["unsigned int", ["unsigned int"]]);
function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput, output = $.NSFileHandle.fileHandleWithStandardOutput;
  const files = $.NSFileManager.defaultManager, unlock = $({ NSFileImmutable: false, NSFileAppendOnly: false });
  let pending = "";
  for (;;) {
    $.alarm(${WORKER_ORPHAN});
    const data = input.availableData;
    $.alarm(0);
    if (!Number(data.length)) return;
    pending += $.NSString.alloc.initWithDataEncoding(data, $.NSASCIIStringEncoding).js;
    for (let end = pending.indexOf("\\n"); end >= 0; end = pending.indexOf("\\n")) {
      const row = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
      const failure = $.clonefile(row[0], row[1], 2) === 0 ? 0 : $.__error()[0] || -1;
      if (!failure) {
        files.setAttributesOfItemAtPathError(unlock, row[1], null);
        const acl = $.acl_init(0); $.acl_set_link_np(row[1], 0x100, acl); $.acl_free(acl);
        if (row[2]) $.removexattr(row[1], "com.apple.quarantine", 1);
      }
      output.writeData($(failure + "\\n").dataUsingEncoding($.NSASCIIStringEncoding));
    }
  }
}`;
// A clone on a sleeping or unresponsive volume must not hold every later copy.
// An idle worker is stopped, and so is any worker when this process exits.
let worker, workerUnavailable = false;
function startWorker() {
  let child;
  try { child = ChildProcess.spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", WORKER_SCRIPT], { stdio: ["pipe", "pipe", "ignore"] }); }
  catch (error) {
    if (error?.syscall !== "spawn" || typeof error.code !== "string" || !/^E[A-Z0-9]+$/.test(error.code)) throw error;
    workerUnavailable = true;
    return null;
  }
  const state = { child, waiting: [], received: "", answered: false, killed: false, idle: null };
  const hold = active => {
    for (const handle of [child, child.stdin, child.stdout]) active ? handle.ref?.() : handle.unref?.();
    clearTimeout(state.idle);
    if (!active) { state.idle = setTimeout(state.kill, WORKER_IDLE); state.idle.unref(); }
  };
  state.kill = () => { if (worker === state) worker = null; state.killed = true; child.kill("SIGKILL"); };
  process.once("exit", state.kill);
  const finish = () => {
    process.removeListener("exit", state.kill);
    if (worker === state) worker = null;
    if (!state.answered && !state.killed) workerUnavailable = true;
    clearTimeout(state.idle);
    for (const answer of state.waiting.splice(0)) answer(null);
  };
  child.once("error", finish); child.once("exit", finish); child.stdin.on("error", () => {});
  child.stdout.setEncoding("ascii");
  child.stdout.on("data", chunk => {
    state.received += chunk; state.answered = true;
    for (let end = state.received.indexOf("\n"); end >= 0; end = state.received.indexOf("\n")) {
      const line = state.received.slice(0, end); state.received = state.received.slice(end + 1);
      state.waiting.shift()?.(line === "0" ? true : Number(line) || -1);
    }
    if (!state.waiting.length) hold(false);
  });
  state.request = (source, destination, strip) => new Promise(resolve => {
    const timer = setTimeout(state.kill, WORKER_TIMEOUT); timer.unref();
    state.waiting.push(answer => { clearTimeout(timer); resolve(answer); }); hold(true);
    const ascii = JSON.stringify([source, destination, strip]).replace(/[\u007f-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    child.stdin.write(ascii + "\n");
  });
  return state;
}
// true: cloned; a number: clonefile's errno; null: no answer (no worker, or it was stopped).
function cloneFile(source, destination, strip) {
  if (workerUnavailable) return { answer: Promise.resolve(null) };
  const state = worker ??= startWorker();
  if (!state) return { answer: Promise.resolve(null) };
  return { answer: state.request(source, destination, strip), stop: state.kill };
}
// Cancellation stops waiting at once and stops the worker; a clone that still
// lands is removed.
async function cloneWithin(source, target, strip, signal) {
  signal?.throwIfAborted();
  const { answer, stop } = cloneFile(source, target, strip);
  if (!signal) return answer;
  let abort;
  try {
    return await Promise.race([answer, new Promise((_, reject) => {
      abort = () => {
        stop?.();
        answer.then(() => discard(target));
        reject(signal.reason ?? Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
      };
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

async function copy(source, target, job, info, options, signal) {
  if (job.cp && !job.directory) {
    const answer = await cloneWithin(source, target, job.strip, signal);
    if (answer === true) return;
    // A stopped worker may still have left a clone here.
    await discard(target);
    if (answer !== null) {
      job.cp = false;
      if (answer === ENOTSUP || answer === EXDEV) unclonable.add(info.dev);
    }
  }
  if (job.cp) {
    if (await run("/bin/sh", cpArgs(job, options, source, target), signal) === 0) return;
    await discard(target);
  }
  if (job.directory) return fs.promises.cp(source, target, { ...treeOptions(job, options), filter: () => { signal?.throwIfAborted(); return true; } });
  if (job.metadata) {
    // Own cp directly so cancellation waits for the data writer to close
    // before the staged copy is removed. Cleanup changes only that copy.
    for (const [command, args] of [["/bin/cp", ["-p", source, target]], ["/bin/sh", sanitizeArgs(target, job)]]) {
      const code = await run(command, args, signal);
      if (code !== 0) throw copyFailure(code);
    }
    return;
  }
  await fs.promises.copyFile(source, target, NEW_FILE);
  await fs.promises.utimes(target, info.atimeMs / 1000, info.mtimeMs / 1000);
}
async function merge(source, destination, job, options, signal) {
  const staged = stagedName(destination);
  try {
    await copy(source, staged, job, null, options, signal);
    signal?.throwIfAborted();
    await moveIn(staged, destination, job.overwrite);
  } finally { await discard(staged); }
}
async function moveIn(from, to, overwrite) {
  for (const name of await fs.promises.readdir(from)) {
    const source = path.join(from, name), target = path.join(to, name), existing = await lstatAsync(target);
    if (existing?.isDirectory() && (await fs.promises.lstat(source)).isDirectory()) await moveIn(source, target, overwrite);
    else if (!existing || overwrite) await fs.promises.rename(source, target);
  }
}
async function publish(staged, destination, job, exclusive) {
  if (job.directory || job.overwrite) {
    try { await fs.promises.rename(staged, destination); return true; } catch (error) {
      if (!job.directory || !["ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
      if (exclusive) throw exists(destination);
      return false;
    }
  }
  try { await fs.promises.link(staged, destination); } catch (error) {
    if (error.code !== "EEXIST" && !await lstatAsync(destination)) return fs.promises.rename(staged, destination).then(() => true);
    if (exclusive) throw exists(destination);
  }
  return true;
}

/** Asynchronous cloneOrCopySync. Cancellation leaves a new destination absent. */
async function cloneOrCopy(source, destination, { signal, ...options } = {}) {
  signal?.throwIfAborted();
  source = path.resolve(source); destination = path.resolve(destination);
  const info = await fs.promises.stat(source), before = await lstatAsync(destination);
  if (before && options.exclusive) throw exists(destination);
  if (info.isDirectory()) await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const job = plan(source, options, info, await fs.promises.stat(path.dirname(destination)), SMALL_CLONE);
  if (before) {
    if (job.directory) { assertMergeable(destination, before); return merge(source, destination, job, options, signal); }
    if (!job.overwrite) return;
  }
  const staged = stagedName(destination);
  try {
    await copy(source, staged, job, info, options, signal);
    signal?.throwIfAborted();
    if (!await publish(staged, destination, job, options.exclusive)) await moveIn(staged, destination, job.overwrite);
  } finally { await discard(staged); }
}

/** Copy a regular file to a new path through a private stage. `validate`
 * inspects the staged copy before it is published without replacing anything. */
async function copyFileExclusive(source, destination, { signal, mode, validate } = {}) {
  signal?.throwIfAborted();
  source = path.resolve(source); destination = path.resolve(destination);
  try {
    await fs.promises.lstat(destination);
    throw exists(destination);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const original = await fs.promises.stat(source);
  if (!original.isFile()) throw Object.assign(new Error("The source must be a regular file."), { code: "EINVAL" });
  const directory = await fs.promises.mkdtemp(path.join(path.dirname(destination), ".copy-"));
  const staged = path.join(directory, "file");
  let published = false, copied;
  try {
    await cloneOrCopy(source, staged, { signal, exclusive: true });
    copied = await fs.promises.lstat(staged);
    if (!copied.isFile() || original.dev === copied.dev && original.ino === copied.ino)
      throw new Error("The copied file must have an independent file identity.");
    await fs.promises.chmod(staged, mode ?? original.mode & 0o777);
    await validate?.(staged);
    signal?.throwIfAborted();
    await fs.promises.link(staged, destination);
    published = true;
    signal?.throwIfAborted();
  } catch (error) {
    if (published) {
      const current = await fs.promises.lstat(destination).catch(() => null);
      if (current?.dev === copied.dev && current?.ino === copied.ino) await fs.promises.unlink(destination);
    }
    throw error;
  } finally { await discard(directory); }
}

// For a caller that chooses its own fallback when a volume cannot clone. libuv
// does not implement forced Darwin cloning in all supported Node builds, so
// call clonefile through the system.
const CLONE_SCRIPT = `ObjC.import("Foundation");
ObjC.bindFunction("clonefile", ["int", ["char *", "char *", "unsigned int"]]);
function run() {
  const rows = JSON.parse($.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding).js);
  for (const row of rows) if ($.clonefile(row[0], row[1], 0) !== 0) throw Error("This volume cannot clone the application or game files.");
}`;
/** Clone each [source, output] file pair, or throw when the volume cannot clone. */
function cloneOnlySync(rows) {
  for (let index = 0; index < rows.length; index++) {
    const [source, output] = rows[index];
    try {
      if (!fs.constants.COPYFILE_FICLONE_FORCE) throw Object.assign(Error("Forced cloning is unavailable."), { code: "ENOSYS" });
      fs.copyFileSync(source, output, fs.constants.COPYFILE_FICLONE_FORCE | fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== "ENOSYS" || !native()) throw error;
      const result = ChildProcess.spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", CLONE_SCRIPT],
        { input: JSON.stringify(rows.slice(index)), encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
      if (result.error) throw result.error;
      if (result.status !== 0) throw Error("This volume cannot clone the application or game files.");
      return;
    }
  }
}

module.exports = { cloneOrCopySync, cloneOrCopy, copyFileExclusive, cloneOnlySync, SMALL_FILE };

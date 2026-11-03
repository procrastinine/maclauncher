const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const ChildProcess = require("node:child_process");
const { copyFileExclusive } = require("../src/modules/shared/copy-file");
const { untilTestEnds } = require("./helpers/fixture-process");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "copy-file-")), source = path.join(root, "source");
  fs.writeFileSync(source, crypto.randomBytes(65536), { mode: 0o640 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, source, target: path.join(root, "target") };
}
const noStages = root => assert.deepEqual(fs.readdirSync(root).filter(x => /^\.(?:copy|clone)-/.test(x)), []);
// Clone/tree cp runs inside sh; the metadata-preserving file fallback is direct.
const cpTarget = (command, args) => command === "/bin/cp" && args[0] === "-p" ? args[2]
  : command === "/bin/sh" && /^-cp/.test(args[3] || "") ? args[5] : null;

// Select the cross-device route without mounting or changing a filesystem.
function differentDevice(t, directory) {
  const sync = fs.statSync.bind(fs), async = fs.promises.stat.bind(fs.promises);
  const outside = (file, info) => typeof file === "string" && (file === directory || file.startsWith(directory + path.sep))
    ? Object.create(info, { dev: { value: info.dev + 1 } }) : info;
  t.mock.method(fs, "statSync", (file, ...args) => outside(file, sync(file, ...args)));
  t.mock.method(fs.promises, "stat", async (file, ...args) => outside(file, await async(file, ...args)));
}

test("Exclusive copies preserve bytes and modes without sharing writable inodes", async t => {
  const { root, source, target } = fixture(t), original = fs.readFileSync(source);
  await copyFileExclusive(source, target, { validate: async staged => {
    assert.equal(fs.statSync(path.dirname(staged)).mode & 0o777, 0o700);
    assert.deepEqual(fs.readFileSync(staged), original);
    assert.equal(fs.existsSync(target), false, "validation precedes publication");
  } });
  assert.deepEqual(fs.readFileSync(target), original);
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  assert.notEqual(fs.statSync(source).ino, fs.statSync(target).ino);
  fs.writeFileSync(source, "source edit"); assert.deepEqual(fs.readFileSync(target), original);
  fs.writeFileSync(target, "destination edit"); assert.equal(fs.readFileSync(source, "utf8"), "source edit");
  noStages(root);
});

test("Exclusive publication preserves files, directories, symlinks and a competing creator", async t => {
  const { root, source, target } = fixture(t), file = path.join(root, "existing"), directory = path.join(root, "directory");
  fs.writeFileSync(file, "preserved"); fs.mkdirSync(directory);
  const alias = path.join(root, "alias"), dangling = path.join(root, "dangling");
  fs.symlinkSync(file, alias); fs.symlinkSync("absent", dangling);
  for (const existing of [file, directory, alias, dangling])
    await assert.rejects(copyFileExclusive(source, existing), { code: "EEXIST" });
  await assert.rejects(copyFileExclusive(source, target, { validate: async () => fs.writeFileSync(target, "competing creator", { flag: "wx" }) }), { code: "EEXIST" });
  assert.equal(fs.readFileSync(file, "utf8"), "preserved"); assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(fs.readlinkSync(alias), file); assert.equal(fs.readlinkSync(dangling), "absent");
  assert.equal(fs.readFileSync(target, "utf8"), "competing creator"); noStages(root);
});

test("Validation failure and cancellation remove private copies before publication", async t => {
  const { root, source, target } = fixture(t), failed = new Error("invalid bytes");
  await assert.rejects(copyFileExclusive(source, target, { validate: async () => { throw failed; } }), error => error === failed);
  const before = new AbortController(); before.abort();
  await assert.rejects(copyFileExclusive(source, target, { signal: before.signal }), { name: "AbortError" });
  const during = new AbortController();
  await assert.rejects(copyFileExclusive(source, target, { signal: during.signal, validate: async () => during.abort() }), { name: "AbortError" });
  const publishing = new AbortController(), link = fs.promises.link.bind(fs.promises);
  t.mock.method(fs.promises, "link", async (...args) => { await link(...args); publishing.abort(); });
  await assert.rejects(copyFileExclusive(source, target, { signal: publishing.signal }), { name: "AbortError" });
  assert.equal(fs.existsSync(target), false); noStages(root);
});


const { cloneOrCopy, cloneOrCopySync, SMALL_FILE } = require("../src/modules/shared/copy-file");
const darwin = { skip: process.platform !== "darwin" };
const physical = require("./helpers/clone-blocks.cjs").physicalOffset;
function large(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clone-copy-")), source = path.join(root, "source");
  fs.writeFileSync(source, crypto.randomBytes(SMALL_FILE * 4), { mode: 0o750 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, source };
}

test("Large files and trees are APFS clones that keep their own writes", darwin, async t => {
  const { root, source } = large(t), probe = path.join(root, "probe");
  ChildProcess.execFileSync("/bin/cp", ["-c", source, probe]);
  const origin = physical(source);
  if (!origin || physical(probe) !== origin) return t.skip("this volume or Mac cannot report clones");
  const original = fs.readFileSync(source), file = path.join(root, "file"), tree = path.join(root, "tree"), copy = path.join(root, "copy");
  cloneOrCopySync(source, file);
  await cloneOrCopy(source, path.join(root, "async"));
  fs.mkdirSync(tree); fs.copyFileSync(source, path.join(tree, "asset"));
  cloneOrCopySync(tree, copy);
  assert.equal(physical(file), origin); assert.equal(physical(path.join(root, "async")), origin);
  assert.equal(physical(path.join(copy, "asset")), physical(path.join(tree, "asset")));
  // Writes on either side stay there.
  fs.writeFileSync(source, "edited game file");
  assert.deepEqual(fs.readFileSync(file), original);
  fs.appendFileSync(file, "private write");
  assert.equal(fs.readFileSync(source, "utf8"), "edited game file");
  fs.writeFileSync(path.join(copy, "asset"), "private tree write");
  assert.deepEqual(fs.readFileSync(path.join(tree, "asset")), original);
});

test("A failed clone falls back to an ordinary copy", darwin, async t => {
  const { root, source } = large(t), original = fs.readFileSync(source), spawnSync = ChildProcess.spawnSync, spawn = ChildProcess.spawn;
  const seen = [];
  t.mock.method(ChildProcess, "spawnSync", (command, args, options) => {
    const target = command === "/bin/sh" && cpTarget(command, args);
    if (!target) return spawnSync(command, args, options);
    seen.push("cp"); fs.writeFileSync(target, "partial"); return { status: 1 };
  });
  // A clone worker whose clonefile always reports ENOTSUP, as on a volume without clones, and a failing cp.
  t.mock.method(ChildProcess, "spawn", (command, args, options) => {
    if (command !== "/usr/bin/osascript" && !(command === "/bin/sh" && cpTarget(command, args))) return spawn(command, args, options);
    seen.push(cpTarget(command, args) ? "cp" : command);
    return spawn(process.execPath, ["-e", cpTarget(command, args) ? "process.exitCode=1"
      : 'process.stdin.on("data",data=>process.stdout.write(String(data).replace(/[^\\n]+/g,"45")))'], options);
  });
  const module = require.resolve("../src/modules/shared/copy-file");
  delete require.cache[module]; const Fresh = require(module); delete require.cache[module];
  const file = path.join(root, "file"), asynchronous = path.join(root, "async"), tree = path.join(root, "tree");
  Fresh.cloneOrCopySync(source, file, { exclusive: true });
  await Fresh.cloneOrCopy(source, asynchronous, { exclusive: true });
  // The refused clone is remembered: later files copy without retrying a clone.
  const later = [path.join(root, "later-async"), path.join(root, "later-sync")];
  await Fresh.cloneOrCopy(source, later[0]); Fresh.cloneOrCopySync(source, later[1]);
  assert.deepEqual(seen, ["cp", "/usr/bin/osascript"]);
  fs.mkdirSync(path.join(tree, "nested"), { recursive: true }); fs.writeFileSync(path.join(tree, "nested", "data"), "tree");
  Fresh.cloneOrCopySync(tree, path.join(root, "copy"));
  await Fresh.cloneOrCopy(tree, path.join(root, "async-copy"));
  assert.deepEqual(seen, ["cp", "/usr/bin/osascript", "cp", "cp"]);
  noStages(root);
  for (const output of [file, asynchronous, ...later]) {
    assert.deepEqual(fs.readFileSync(output), original);
    assert.equal(fs.statSync(output).mode & 0o777, 0o750);
    assert.ok(Math.abs(fs.statSync(output).mtimeMs - fs.statSync(source).mtimeMs) < 1);
  }
  for (const copy of ["copy", "async-copy"]) assert.equal(fs.readFileSync(path.join(root, copy, "nested", "data"), "utf8"), "tree");
});

test("Directory copies keep modes, timestamps and verbatim symbolic links and merge into a destination", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clone-tree-")), tree = path.join(root, "game"), copy = path.join(root, "copy");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tree, "bin"), { recursive: true }); fs.mkdirSync(path.join(tree, "private"), { mode: 0o700 });
  fs.writeFileSync(path.join(tree, "bin", "game"), crypto.randomBytes(SMALL_FILE + 1), { mode: 0o755 });
  fs.writeFileSync(path.join(tree, "private", "config.ini"), "volume=1", { mode: 0o600 });
  fs.utimesSync(path.join(tree, "private", "config.ini"), 1000, 2000);
  fs.symlinkSync("bin/game", path.join(tree, "launcher")); fs.symlinkSync("absent", path.join(tree, "dangling"));
  fs.symlinkSync(path.join(root, "outside"), path.join(tree, "external"));
  fs.mkdirSync(copy); fs.writeFileSync(path.join(copy, "kept"), "kept");
  if (process.platform === "darwin") ChildProcess.execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Test;", path.join(tree, "bin", "game")]);
  cloneOrCopySync(tree, copy);
  assert.equal(fs.readFileSync(path.join(copy, "kept"), "utf8"), "kept");
  assert.equal(fs.statSync(path.join(copy, "bin", "game")).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(copy, "private")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(copy, "private", "config.ini")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(copy, "private", "config.ini")).mtimeMs, 2000000);
  assert.equal(fs.readlinkSync(path.join(copy, "launcher")), "bin/game");
  assert.equal(fs.readlinkSync(path.join(copy, "dangling")), "absent");
  assert.equal(fs.readlinkSync(path.join(copy, "external")), path.join(root, "outside"));
  if (process.platform === "darwin") assert.doesNotMatch(ChildProcess.execFileSync("/usr/bin/xattr", [path.join(copy, "bin", "game")], { encoding: "utf8" }), /quarantine/);
  fs.writeFileSync(path.join(copy, "private", "config.ini"), "volume=0");
  assert.equal(fs.readFileSync(path.join(tree, "private", "config.ini"), "utf8"), "volume=1");
  // dereference copies link targets instead.
  const followed = path.join(root, "followed");
  fs.rmSync(path.join(tree, "dangling")); fs.rmSync(path.join(tree, "external"));
  await cloneOrCopy(tree, followed, { dereference: true });
  assert.equal(fs.lstatSync(path.join(followed, "launcher")).isFile(), true);
});

test("Existing destinations are refused, replaced without writing through links, or kept", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clone-existing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const size of [16, SMALL_FILE * 2]) {
    const source = path.join(root, "source-" + size), game = path.join(root, "game-" + size), alias = path.join(root, "alias-" + size);
    fs.writeFileSync(source, crypto.randomBytes(size)); fs.writeFileSync(game, "original game file"); fs.linkSync(game, alias);
    assert.throws(() => cloneOrCopySync(source, alias, { exclusive: true }), { code: "EEXIST" });
    await assert.rejects(cloneOrCopy(source, alias, { exclusive: true }), { code: "EEXIST" });
    cloneOrCopySync(source, alias, { overwrite: false });
    assert.equal(fs.readFileSync(alias, "utf8"), "original game file");
    cloneOrCopySync(source, alias);
    assert.deepEqual(fs.readFileSync(alias), fs.readFileSync(source));
    assert.equal(fs.readFileSync(game, "utf8"), "original game file", "the hard-linked original is untouched");
  }
  const before = new AbortController(); before.abort();
  await assert.rejects(cloneOrCopy(path.join(root, "game-16"), path.join(root, "never"), { signal: before.signal }), { name: "AbortError" });
  assert.equal(fs.existsSync(path.join(root, "never")), false);
});

test("Cancellation waits for the owned copy process before removing its partial output", { ...darwin, timeout: 10000 }, async t => {
  const { root, source } = large(t), spawn = ChildProcess.spawn, children = [], tree = path.join(root, "tree");
  fs.mkdirSync(tree); fs.copyFileSync(source, path.join(tree, "asset"));
  let closed;
  t.after(() => children.forEach(child => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }));
  const cancel = new AbortController();
  t.mock.method(ChildProcess, "spawn", (command, args, options) => {
    assert.ok(cpTarget(command, args)); closed = false;
    const child = spawn(process.execPath, ["-e", 'require("fs").writeFileSync(process.argv[1],"partial");' + untilTestEnds, cpTarget(command, args)], options);
    children.push(child); child.once("close", () => { closed = true; });
    setTimeout(() => cancel.abort(), 100);
    return child;
  });
  const target = path.join(root, "target");
  await assert.rejects(cloneOrCopy(tree, target, { signal: cancel.signal }), { name: "AbortError" });
  assert.equal(closed, true); assert.equal(fs.existsSync(target), false);
  await assert.rejects(copyFileExclusive(source, target, { signal: AbortSignal.abort() }), { name: "AbortError" });
  noStages(root);
});

test("A copy killed before it publishes leaves the previous destination whole", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clone-crash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The child dies while writing or after a complete copy, before the rename.
  const script = `const fs = require("node:fs"), [module, source, destination, point] = process.argv.slice(1);
const die = () => process.kill(process.pid, "SIGKILL");
if (point === "write") {
  const partial = (from, to) => { fs.writeFileSync(to, fs.readFileSync(from).subarray(0, 100)); die(); };
  fs.copyFileSync = partial;
  const cp = require("node:child_process"), spawn = cp.spawnSync;
  cp.spawnSync = (command, args, options) => command === "/bin/cp" && args[0] === "-p" ? partial(args[1], args[2]) : spawn(command, args, options);
}
else fs.renameSync = die;
require(module).cloneOrCopySync(source, destination);`;
  for (const [point, size] of [["write", 4096], ["rename", SMALL_FILE * 2]]) {
    const source = path.join(root, point + "-source"), destination = path.join(root, point + "-save");
    fs.writeFileSync(source, crypto.randomBytes(size)); fs.writeFileSync(destination, "previous save");
    const result = ChildProcess.spawnSync(process.execPath, ["-e", script, require.resolve("../src/modules/shared/copy-file"), source, destination, point]);
    assert.equal(result.signal, "SIGKILL");
    assert.equal(fs.readFileSync(destination, "utf8"), "previous save");
  }
  // Only staged names remain from the killed copies, and a new copy still publishes.
  assert.equal(fs.readdirSync(root).filter(name => !/-(?:source|save)$/.test(name)).every(name => /^\.clone-[0-9a-f]{12}$/.test(name)), true);
  cloneOrCopySync(path.join(root, "write-source"), path.join(root, "write-save"));
  assert.deepEqual(fs.readFileSync(path.join(root, "write-save")), fs.readFileSync(path.join(root, "write-source")));
  assert.ok(fs.readdirSync(root).some(name => name.startsWith(".clone-")), "recent leftovers may still be copies in progress");
  // A later process removes leftovers that have not changed for over an hour.
  const module = require.resolve("../src/modules/shared/copy-file");
  delete require.cache[module]; const Later = require(module); delete require.cache[module];
  const now = Date.now(); t.mock.method(Date, "now", () => now + 2 * 60 * 60 * 1000);
  Later.cloneOrCopySync(path.join(root, "write-source"), path.join(root, "write-save"));
  noStages(root);
});

test("A locked original, or one with an ACL, is copied without its lock or ACL", darwin, async t => {
  const { root, source } = large(t), tree = path.join(root, "tree"), locked = path.join(tree, "locked");
  fs.mkdirSync(tree); fs.copyFileSync(source, locked);
  const lock = file => { ChildProcess.execFileSync("/bin/chmod", ["+a", "everyone deny write,delete", file]); ChildProcess.execFileSync("/usr/bin/chflags", ["uchg", file]); };
  const unlock = () => { for (const file of [source, locked]) { ChildProcess.spawnSync("/usr/bin/chflags", ["nouchg", file]); ChildProcess.spawnSync("/bin/chmod", ["-N", file]); } };
  t.after(unlock); lock(source); lock(locked);
  const outputs = [path.join(root, "sync"), path.join(root, "async")];
  cloneOrCopySync(source, outputs[0]); await cloneOrCopy(source, outputs[1]);
  cloneOrCopySync(tree, path.join(root, "tree-sync")); await cloneOrCopy(tree, path.join(root, "tree-async"));
  outputs.push(path.join(root, "tree-sync", "locked"), path.join(root, "tree-async", "locked"));
  for (const output of outputs) {
    assert.deepEqual(fs.readFileSync(output), fs.readFileSync(source), output);
    assert.doesNotMatch(ChildProcess.execFileSync("/bin/ls", ["-lOed", output], { encoding: "utf8" }), /uchg|deny/, output);
    fs.appendFileSync(output, "writable"); fs.rmSync(output);
  }
  noStages(root); unlock();
});

test("Cancelling a clone that does not answer returns at once and a later copy still works", darwin, async t => {
  const { root, source } = large(t), spawn = ChildProcess.spawn, children = [];
  t.after(() => children.forEach(child => child.kill("SIGKILL")));
  let workers = 0;
  t.mock.method(ChildProcess, "spawn", (command, args, options) => {
    if (command !== "/usr/bin/osascript") return spawn(command, args, options);
    // The first worker hangs, as on a sleeping volume; the next one reports EACCES.
    const child = spawn(process.execPath, ["-e", workers++ ? 'process.stdin.on("data",data=>process.stdout.write(String(data).replace(/[^\\n]+/g,"13")))'
      : "process.stdin.resume()"], options);
    children.push(child); return child;
  });
  const module = require.resolve("../src/modules/shared/copy-file");
  delete require.cache[module]; const Fresh = require(module); delete require.cache[module];
  const cancel = new AbortController(), started = Date.now();
  setTimeout(() => cancel.abort(), 100);
  await assert.rejects(Fresh.cloneOrCopy(source, path.join(root, "hung"), { signal: cancel.signal }), { name: "AbortError" });
  assert.ok(Date.now() - started < 5000);
  assert.equal(fs.existsSync(path.join(root, "hung")), false);
  // EACCES is not a missing clone capability: the next file asks the new worker again.
  await Fresh.cloneOrCopy(source, path.join(root, "first")); await Fresh.cloneOrCopy(source, path.join(root, "second"));
  assert.equal(workers, 2);
  for (const name of ["first", "second"]) assert.deepEqual(fs.readFileSync(path.join(root, name)), fs.readFileSync(source));
  noStages(root);
});

test("A folder copy refuses to merge into a symbolic link", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clone-link-")), tree = path.join(root, "tree"), elsewhere = path.join(root, "elsewhere");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(tree); fs.mkdirSync(elsewhere); fs.writeFileSync(path.join(tree, "file"), "data");
  fs.symlinkSync(elsewhere, path.join(root, "link"));
  assert.throws(() => cloneOrCopySync(tree, path.join(root, "link")), { code: "EINVAL" });
  await assert.rejects(cloneOrCopy(tree, path.join(root, "link")), { code: "EINVAL" });
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("A folder that fails to copy merges nothing, and a merge replaces files without writing through links", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clone-merge-")), tree = path.join(root, "tree"), copy = path.join(root, "copy");
  const unreadable = path.join(tree, "unreadable"), small = path.join(copy, "nested", "small");
  t.after(() => { fs.chmodSync(unreadable, 0o600); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(tree, "nested"), { recursive: true }); fs.mkdirSync(path.join(copy, "nested"), { recursive: true });
  fs.writeFileSync(path.join(tree, "large"), crypto.randomBytes(SMALL_FILE * 2)); fs.writeFileSync(path.join(tree, "nested", "small"), "new");
  fs.writeFileSync(unreadable, "data"); fs.chmodSync(unreadable, 0);
  fs.writeFileSync(small, "old"); fs.writeFileSync(path.join(copy, "kept"), "kept"); fs.linkSync(small, path.join(root, "alias"));
  const untouched = () => {
    assert.deepEqual(fs.readdirSync(copy).sort(), ["kept", "nested"]); assert.equal(fs.readFileSync(small, "utf8"), "old"); noStages(root);
  };
  assert.throws(() => cloneOrCopySync(tree, copy)); untouched();
  await assert.rejects(cloneOrCopy(tree, copy)); untouched();
  fs.chmodSync(unreadable, 0o600);
  cloneOrCopySync(tree, copy);
  assert.equal(fs.readFileSync(small, "utf8"), "new"); assert.equal(fs.readFileSync(path.join(copy, "kept"), "utf8"), "kept");
  assert.deepEqual(fs.readFileSync(path.join(copy, "large")), fs.readFileSync(path.join(tree, "large")));
  assert.equal(fs.readFileSync(path.join(root, "alias"), "utf8"), "old", "a hard link to the replaced file is untouched");
  fs.writeFileSync(small, "game edit"); await cloneOrCopy(tree, copy, { overwrite: false });
  assert.equal(fs.readFileSync(small, "utf8"), "game edit"); noStages(root);
});

test("The clone worker ends when its input closes, when its parent is killed and when its parent exits", darwin, async t => {
  const { root, source } = large(t), workers = [];
  t.after(() => workers.forEach(pid => { try { process.kill(pid, "SIGKILL"); } catch {} }));
  // Each run makes one asynchronous clone, prints its worker's process ID and
  // then closes the worker's input, waits to be killed or simply ends.
  const script = `const ChildProcess = require("node:child_process"), spawn = ChildProcess.spawn, started = [];
    ChildProcess.spawn = (...args) => { const child = spawn(...args); if (args[0] === "/usr/bin/osascript") started.push(child); return child; };
    const { cloneOrCopy } = require(${JSON.stringify(require.resolve("../src/modules/shared/copy-file"))});
    const [source, root, scenario] = process.argv.slice(1);
    cloneOrCopy(source, root + "/" + scenario).then(() => {
      const worker = started[0]; console.log(worker.pid);
      if (scenario === "input") {
        const closed = Date.now(), limit = setTimeout(() => { console.log("still running"); process.exit(); }, 5000);
        worker.ref(); worker.once("exit", (code, signal) => { clearTimeout(limit); console.log(Date.now() - closed, code, signal); });
        worker.stdin.end();
      } else if (scenario === "killed") ${untilTestEnds}
    });`;
  const run = scenario => new Promise((resolve, reject) => {
    const child = ChildProcess.spawn(process.execPath, ["-e", script, source, root, scenario], { stdio: ["ignore", "pipe", "inherit"] });
    let output = ""; child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (!output.includes("\n") && (output += chunk).includes("\n")) workers.push(Number(output.split("\n")[0]));
      else output += chunk;
      if (scenario === "killed" && output.includes("\n")) child.kill("SIGKILL");
    });
    child.once("error", reject); child.once("exit", () => resolve(output.trim().split("\n")));
  });
  const gone = async pid => {
    for (const deadline = Date.now() + 5000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 50)))
      try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return true; throw error; }
    return false;
  };
  const [, closed] = await run("input");
  const [elapsed, code] = closed.split(" ");
  assert.ok(Number(elapsed) < 5000 && code === "0", `a worker whose input closed ends by itself (${closed})`);
  for (const scenario of ["killed", "exit"]) {
    const [pid] = await run(scenario);
    assert.ok(await gone(Number(pid)), `no clone worker remains after its parent is ${scenario === "killed" ? "killed" : "gone"}`);
  }
});

test("Real-file fallbacks preserve data xattrs, resource forks and data quarantine without changing the original", darwin, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "copy-metadata-")), output = path.join(root, "output"), locked = [];
  t.after(() => {
    for (const file of locked) {
      ChildProcess.spawnSync("/usr/bin/chflags", ["nouchg", file]);
      ChildProcess.spawnSync("/bin/chmod", ["-N", file]);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(output); differentDevice(t, output);
  const xattr = (file, name) => ChildProcess.execFileSync("/usr/bin/xattr", ["-p", "-x", name, file], { encoding: "utf8" }).replace(/\s/g, "").toLowerCase();
  const attrs = {
    "com.maclauncher.copy-test": "0001ff0074657374",
    "com.apple.ResourceFork": Buffer.from("resource fork\0\xff", "latin1").toString("hex"),
    "com.apple.FinderInfo": "544553544d434c52" + "00".repeat(24),
    "com.apple.quarantine": Buffer.from("0081;00000000;CopyTest;").toString("hex")
  };
  for (const size of [4096, SMALL_FILE * 2]) {
    const source = path.join(root, `data-${size}`), bytes = Buffer.alloc(size, 0x61);
    fs.writeFileSync(source, bytes, { mode: 0o640 });
    const probe = ChildProcess.spawnSync("/usr/bin/xattr", ["-w", "-x", "com.maclauncher.copy-test", attrs["com.maclauncher.copy-test"], source]);
    if (probe.status !== 0) return t.skip("real extended attributes are unavailable on the temporary volume");
    for (const [name, hex] of Object.entries(attrs)) ChildProcess.execFileSync("/usr/bin/xattr", ["-w", "-x", name, hex, source]);
    fs.utimesSync(source, 1000, 2000);
    if (size === 4096) {
      locked.push(source);
      ChildProcess.execFileSync("/bin/chmod", ["+a", "everyone deny write,delete", source]);
      ChildProcess.execFileSync("/usr/bin/chflags", ["uchg", source]);
    }
    const outputs = ["sync", "async", "exclusive"].map(name => path.join(output, `${name}-${size}`));
    cloneOrCopySync(source, outputs[0]); await cloneOrCopy(source, outputs[1]); await copyFileExclusive(source, outputs[2]);
    for (const target of outputs) {
      assert.equal(fs.statSync(target).mode & 0o777, 0o640);
      assert.equal(fs.statSync(target).mtimeMs, 2000000);
      assert.notEqual(fs.statSync(target).ino, fs.statSync(source).ino);
      assert.deepEqual(fs.readFileSync(target), bytes);
      for (const [name, hex] of Object.entries(attrs)) assert.equal(xattr(target, name), hex, `${target}: ${name}`);
      assert.deepEqual(fs.readFileSync(target + "/..namedfork/rsrc"), Buffer.from(attrs["com.apple.ResourceFork"], "hex"));
      assert.doesNotMatch(ChildProcess.execFileSync("/bin/ls", ["-lOed", target], { encoding: "utf8" }), /uchg|deny/);
      fs.appendFileSync(target, "private data");
      ChildProcess.execFileSync("/usr/bin/xattr", ["-w", "-x", "com.maclauncher.copy-test", "ff", target]);
      fs.writeFileSync(target + "/..namedfork/rsrc", "private fork");
    }
    assert.deepEqual(fs.readFileSync(source), bytes);
    for (const [name, hex] of Object.entries(attrs)) assert.equal(xattr(source, name), hex, `original: ${name}`);
    if (size === 4096) assert.match(ChildProcess.execFileSync("/bin/ls", ["-lOed", source], { encoding: "utf8" }), /uchg[\s\S]*deny/);
  }
  // The same fallback strips only quarantine for executables and libraries.
  for (const [name, mode] of [["tool", 0o755], ["plugin.dylib", 0o644]]) {
    const source = path.join(root, name), target = path.join(output, name);
    fs.writeFileSync(source, "code", { mode });
    for (const [key, hex] of Object.entries(attrs)) ChildProcess.execFileSync("/usr/bin/xattr", ["-w", "-x", key, hex, source]);
    await cloneOrCopy(source, target);
    const names = ChildProcess.execFileSync("/usr/bin/xattr", [target], { encoding: "utf8" });
    assert.doesNotMatch(names, /com\.apple\.quarantine/);
    for (const [key, hex] of Object.entries(attrs).filter(([key]) => key !== "com.apple.quarantine")) assert.equal(xattr(target, key), hex);
    assert.equal(xattr(source, "com.apple.quarantine"), attrs["com.apple.quarantine"]);
  }
  noStages(output);
});

test("A failed real-file metadata copy preserves an existing destination and removes partial stages", darwin, async t => {
  const { root, source, target } = fixture(t), sync = ChildProcess.spawnSync, async = ChildProcess.spawn;
  fs.writeFileSync(source, "new data"); fs.writeFileSync(target, "previous data");
  t.mock.method(ChildProcess, "spawnSync", (command, args, options) => {
    if (command !== "/bin/cp") return sync(command, args, options);
    fs.writeFileSync(args[2], "partial"); return { status: 17 };
  });
  t.mock.method(ChildProcess, "spawn", (command, args, options) => command === "/bin/cp"
    ? async(process.execPath, ["-e", 'require("fs").writeFileSync(process.argv[1],"partial");process.exitCode=17;', args[2]], options)
    : async(command, args, options));
  assert.throws(() => cloneOrCopySync(source, target), { code: "COPY_FAILED", exitCode: 17 });
  await assert.rejects(cloneOrCopy(source, target), { code: "COPY_FAILED", exitCode: 17 });
  assert.equal(fs.readFileSync(target, "utf8"), "previous data");
  assert.equal(fs.readFileSync(source, "utf8"), "new data"); noStages(root);
});

test("Cancellation waits for the direct metadata copy writer before removing its stage", { ...darwin, timeout: 10000 }, async t => {
  const { root, source, target } = fixture(t), spawn = ChildProcess.spawn, cancel = new AbortController();
  fs.writeFileSync(source, "small data");
  let closed = false, child;
  t.after(() => { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  t.mock.method(ChildProcess, "spawn", (command, args, options) => {
    assert.equal(command, "/bin/cp"); assert.equal(args[0], "-p");
    child = spawn(process.execPath, ["-e", 'require("fs").writeFileSync(process.argv[1],"partial");' + untilTestEnds, args[2]], options);
    child.once("close", () => { closed = true; }); setTimeout(() => cancel.abort(), 100); return child;
  });
  await assert.rejects(cloneOrCopy(source, target, { signal: cancel.signal }), { name: "AbortError" });
  assert.equal(closed, true); assert.equal(fs.existsSync(target), false); noStages(root);
});

test("ASAR member paths stay on Electron's filesystem copy path", async t => {
  const { root, source, target } = fixture(t), archive = path.join(root, "app.asar"), member = path.join(archive, "member");
  fs.mkdirSync(archive); fs.renameSync(source, member);
  // A real folder models the path boundary here; actual ASAR members are
  // supplied by Electron's fs and are never passed to external copy tools.
  t.mock.method(ChildProcess, "spawnSync", () => { throw Error("ASAR member passed to an external tool"); });
  t.mock.method(ChildProcess, "spawn", () => { throw Error("ASAR member passed to an external tool"); });
  cloneOrCopySync(member, target);
  await cloneOrCopy(member, path.join(root, "async"));
  await copyFileExclusive(member, path.join(root, "exclusive"));
  for (const name of ["target", "async", "exclusive"]) assert.deepEqual(fs.readFileSync(path.join(root, name)), fs.readFileSync(member));
  noStages(root);
});

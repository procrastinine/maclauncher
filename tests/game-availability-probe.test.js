const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { once } = require("node:events");
const threads = require("node:worker_threads");
const Availability = require("../src/core/game-availability");

// A fresh copy of the availability modules starts without a probe thread.
function fresh() {
  for (const file of ["../src/core/path-stat-probe", "../src/core/game-availability"]) delete require.cache[require.resolve(file)];
  return require("../src/core/game-availability");
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "game-availability-probe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("availability probes a real root while unrelated filesystem work saturates the shared pool", async t => {
  const root = fixture(t), pipes = [], pending = [], writers = [];
  const poolThreads = Number(process.env.UV_THREADPOOL_SIZE || 4);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    for (const pipe of pipes) writers.push(fs.openSync(pipe, "r+"));
    for (const fd of await Promise.all(pending)) fs.closeSync(fd);
    for (const fd of writers) fs.closeSync(fd);
  };
  t.after(release);
  for (let i = 0; i < poolThreads; i++) {
    const pipe = path.join(root, "pending-open-" + i); pipes.push(pipe);
    execFileSync("/usr/bin/mkfifo", ["-m", "600", pipe]);
    pending.push(new Promise((resolve, reject) => fs.open(pipe, "r", (error, fd) => error ? reject(error) : resolve(fd))));
  }
  let queuedStatFinished = false;
  const queuedStat = fs.promises.stat(root).then(() => { queuedStatFinished = true; });
  try {
    assert.deepEqual(await Availability.checkGameAvailability({ gamePath: root }, { timeoutMs: 1000 }), { available: true });
    assert.equal(queuedStatFinished, false, "the ordinary asynchronous stat is still queued behind occupied pool threads");
  } finally { await release(); }
  await queuedStat;
  assert.equal(queuedStatFinished, true);
});

test("many roots share one probe thread", async t => {
  const root = fixture(t), OriginalWorker = threads.Worker, roots = [], Availability = fresh();
  let created = 0;
  t.mock.method(threads, "Worker", function(filename, options) { created++; return new OriginalWorker(filename, options); });
  for (let i = 0; i < 40; i++) { roots.push(path.join(root, "game-" + i)); fs.mkdirSync(roots.at(-1)); }
  const results = await Promise.all(roots.map(gamePath => Availability.checkGameAvailability({ gamePath }, { timeoutMs: 1000 })));
  assert.ok(results.every(result => result.available));
  assert.deepEqual(await Availability.checkGameAvailability({ gamePath: path.join(root, "absent") }, { timeoutMs: 1000 }),
    { available: false, reason: "missing", path: path.join(root, "absent"), message: "The game's files were not found at their saved location." });
  assert.equal(created, 1, "stats reuse one probe thread");
});

test("one blocked probe times out without blocking another root and recovers when it completes", async t => {
  const root = fixture(t), blocked = path.join(root, "blocked"), healthy = path.join(root, "healthy");
  fs.mkdirSync(blocked); fs.mkdirSync(healthy);
  const preload = path.join(root, "hold-stat.js");
  fs.writeFileSync(preload, `const fs = require('node:fs'), {workerData} = require('node:worker_threads');
const stat = fs.statSync, gate = new Int32Array(workerData.testGate);
fs.statSync = function(file, ...args) {
  if (file === workerData.testBlocked && Atomics.add(gate, 2, 1) === 0) {
    Atomics.store(gate, 0, 1);
    while (Atomics.load(gate, 1) === 0) Atomics.wait(gate, 1, 0);
  }
  return stat.call(this, file, ...args);
};\n`);
  const gate = new Int32Array(new SharedArrayBuffer(12)), workers = [], Availability = fresh();
  const OriginalWorker = threads.Worker;
  t.mock.method(threads, "Worker", function(filename, options) {
    const worker = new OriginalWorker(filename, { ...options, execArgv: ["--require", preload],
      workerData: { ...options.workerData, testGate: gate.buffer, testBlocked: blocked } });
    workers.push(worker);
    return worker;
  });
  const release = () => { Atomics.store(gate, 1, 1); Atomics.notify(gate, 1); };
  t.after(async () => { release(); await Promise.all(workers.map(worker => worker.terminate())); });
  const options = { timeoutMs: 150 }, entry = { gamePath: blocked };
  const results = await Promise.all([Availability.checkGameAvailability(entry, options), Availability.checkGameAvailability(entry, options)]);
  assert.equal(Atomics.load(gate, 0), 1, "the probe thread reached the synchronous filesystem call");
  assert.ok(results.every(result => result.reason === "unresponsive"));
  assert.equal(Atomics.load(gate, 2), 1, "concurrent requests retain one outstanding probe for this path");
  const started = performance.now();
  assert.equal((await Availability.checkGameAvailability(entry, options)).reason, "unresponsive");
  assert.ok(performance.now() - started < 75, "the expired path is reported without waiting for another timeout");
  assert.deepEqual(await Availability.checkGameAvailability({ gamePath: healthy }, { timeoutMs: 1000 }), { available: true });
  assert.equal(workers.length, 2, "later stats move to a new thread while the stalled one keeps its path");
  const stalledExit = once(workers[0], "exit");
  release(); await stalledExit;
  assert.deepEqual(await Availability.checkGameAvailability(entry, { timeoutMs: 1000 }), { available: true });
  assert.equal(Atomics.load(gate, 2), 2, "completion releases the path for a fresh probe");
  assert.equal(workers.length, 2, "the replacement thread answers later stats");
});

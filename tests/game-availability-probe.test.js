const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { once } = require("node:events");
const threads = require("node:worker_threads");
const Availability = require("../src/core/game-availability");

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

test("one blocked isolated probe times out without blocking another root and recovers when it completes", async t => {
  const root = fixture(t), blocked = path.join(root, "blocked"), healthy = path.join(root, "healthy");
  fs.mkdirSync(blocked); fs.mkdirSync(healthy);
  const preload = path.join(root, "hold-stat.js");
  fs.writeFileSync(preload, `const fs = require('node:fs'), {workerData} = require('node:worker_threads');
const stat = fs.statSync;
fs.statSync = function(file, ...args) {
  if (workerData.testGate && file === workerData.path) {
    const gate = new Int32Array(workerData.testGate);
    Atomics.store(gate, 0, 1);
    while (Atomics.load(gate, 1) === 0) Atomics.wait(gate, 1, 0);
  }
  return stat.call(this, file, ...args);
};\n`);
  const gate = new Int32Array(new SharedArrayBuffer(8)), workers = [];
  const OriginalWorker = threads.Worker;
  let blockedCount = 0, firstExit;
  t.mock.method(threads, "Worker", function(filename, options) {
    const held = options.workerData.path === blocked;
    const worker = new OriginalWorker(filename, held ? { ...options, execArgv: ["--require", preload],
      workerData: { ...options.workerData, testGate: gate.buffer } } : options);
    workers.push(worker);
    if (held && ++blockedCount === 1) firstExit = once(worker, "exit");
    return worker;
  });
  const release = () => { Atomics.store(gate, 1, 1); Atomics.notify(gate, 1); };
  t.after(async () => { release(); await Promise.all(workers.map(worker => worker.terminate())); });
  const options = { timeoutMs: 150 }, entry = { gamePath: blocked };
  const results = await Promise.all([Availability.checkGameAvailability(entry, options), Availability.checkGameAvailability(entry, options)]);
  assert.equal(Atomics.load(gate, 0), 1, "the actual probe worker reached the synchronous filesystem call");
  assert.ok(results.every(result => result.reason === "unresponsive"));
  assert.equal(blockedCount, 1, "concurrent requests retain one outstanding probe for this path");
  const started = performance.now();
  assert.equal((await Availability.checkGameAvailability(entry, options)).reason, "unresponsive");
  assert.ok(performance.now() - started < 75, "the expired path is reported without waiting for another timeout");
  assert.equal(blockedCount, 1);
  assert.deepEqual(await Availability.checkGameAvailability({ gamePath: healthy }, { timeoutMs: 1000 }), { available: true });
  release(); await firstExit;
  assert.deepEqual(await Availability.checkGameAvailability(entry, { timeoutMs: 1000 }), { available: true });
  assert.equal(blockedCount, 2, "completion releases the path for a fresh probe");
});

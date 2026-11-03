const test = require("node:test"), assert = require("node:assert/strict");
const { scheduleStorageMaintenance } = require("../src/main/storage-maintenance");

test("upkeep runs one pass per app start, after the launcher is quiet", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  let quiet = false;
  const schedule = scheduleStorageMaintenance({ firstDelayMs: 100, retryMs: 10,
    isQuiet: () => quiet, request: async () => { calls.push(Date.now()); } });
  t.after(() => schedule.stop());
  const advance = async ms => { t.mock.timers.tick(ms); await new Promise(resolve => setImmediate(resolve)); };
  await advance(99);
  assert.equal(calls.length, 0, "startup settles first");
  await advance(1);
  assert.equal(calls.length, 0, "a busy launcher postpones the pass");
  await advance(50);
  assert.equal(calls.length, 0);
  quiet = true;
  await advance(10);
  assert.equal(calls.length, 1);
  await advance(24 * 60 * 60 * 1000);
  assert.equal(calls.length, 1, "nothing repeats until the next start");
});

test("a failed pass is logged and not retried, and stop cancels a waiting pass", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const advance = async ms => { t.mock.timers.tick(ms); await new Promise(resolve => setImmediate(resolve)); };
  const warnings = [];
  let calls = 0;
  const failing = scheduleStorageMaintenance({ firstDelayMs: 10, retryMs: 10,
    logger: { warn: message => warnings.push(message) },
    request: async () => { calls++; throw new Error("worker closed"); } });
  t.after(() => failing.stop());
  await advance(10);
  await advance(1000);
  assert.equal(calls, 1);
  assert.match(warnings.join("\n"), /upkeep could not run: worker closed/);

  let waiting = 0, quiet = false;
  const stopped = scheduleStorageMaintenance({ firstDelayMs: 10, retryMs: 10,
    isQuiet: () => { if (quiet) return true; throw new Error("state unavailable"); }, request: async () => { waiting++; } });
  await advance(10);
  stopped.stop();
  quiet = true;
  await advance(1000);
  assert.equal(waiting, 0, "a stopped schedule starts nothing");
});

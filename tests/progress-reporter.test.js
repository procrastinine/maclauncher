const test = require("node:test");
const assert = require("node:assert/strict");
const { createProgressReporter } = require("../src/core/progress-reporter");

test("chunk progress stays bounded and publishes the latest value at four updates per second", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const seen = [], progress = createProgressReporter(value => seen.push(value));
  for (let downloaded = 0; downloaded <= 10000; downloaded++) progress.report("game", { downloaded, phase: "download" });
  assert.deepEqual(seen, [{ downloaded: 0, phase: "download" }]);
  t.mock.timers.tick(249); assert.equal(seen.length, 1);
  t.mock.timers.tick(1); assert.deepEqual(seen.at(-1), { downloaded: 10000, phase: "download" });
  progress.report("game", { downloaded: 10001, phase: "download" });
  progress.report("game", { phase: "launch" });
  assert.equal(seen.at(-1).phase, "launch");
  progress.report("game", { phase: "done" });
  assert.equal(progress.size, 0);
  const count = seen.length; t.mock.timers.tick(1000);
  assert.equal(seen.length, count, "old progress must not resurrect a completed operation");
});

test("independent operations finish, cancel and clear without retaining progress", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const seen = [], progress = createProgressReporter(value => seen.push(value));
  for (let index = 0; index < 1000; index++) {
    progress.report(index, { phase: "download", downloaded: 1 });
    progress.report(index, { phase: "download", downloaded: 2 });
    progress.report(index, { phase: "done" });
  }
  assert.equal(progress.size, 0);
  progress.report("a", { phase: "download", downloaded: 3 });
  progress.report("b", { phase: "download", downloaded: 4 });
  progress.report("a", { phase: "download", downloaded: 5 });
  progress.report("b", { phase: "download", downloaded: 6 });
  assert.equal(progress.size, 2);
  progress.clear(); const count = seen.length;
  t.mock.timers.tick(1000);
  assert.equal(progress.size, 0); assert.equal(seen.length, count);
});

const test = require("node:test"), assert = require("node:assert/strict");
const BoundedRetry = require("../src/modules/shared/bounded-retry");

function timers() {
  const queue = [];
  return {queue, setTimeout: (callback, ms) => {const timer = {callback, ms, unref() {}};queue.push(timer);return timer;},
    clearTimeout: timer => {timer.cleared = true;}, run: () => queue.shift().callback()};
}

test("a state read again on a bounded schedule stops once settled, stopped or exhausted", async () => {
  const clock = timers(), retry = BoundedRetry.create({delays: [10, 20, 40], timers: clock});
  let ready = false, attempts = 0, exhausted = 0;
  assert.equal(retry.start("game", () => {attempts++;return ready;}, () => exhausted++), true);
  assert.equal(retry.start("game", () => true), false, "one schedule per key");
  clock.run();assert.equal(clock.queue[0].ms, 20);
  ready = true;clock.run();
  assert.equal(attempts, 2);assert.equal(clock.queue.length, 0);assert.equal(retry.has("game"), false);assert.equal(exhausted, 0);
  // Never settled: the last delay ends the schedule once.
  retry.start("never", () => false, () => exhausted++);
  for (const ms of [10, 20, 40]) {assert.equal(clock.queue[0].ms, ms);clock.run();}
  assert.equal(exhausted, 1);assert.equal(clock.queue.length, 0);
  // A stopped schedule cancels its timer and ignores an attempt in flight.
  retry.start("stopped", () => false, () => exhausted++);
  const pending = clock.queue[0];retry.stop("stopped");
  assert.equal(pending.cleared, true);assert.equal(retry.has("stopped"), false);clock.queue.shift();
  let finish;
  retry.start("async", () => new Promise(resolve => {finish = resolve;}), () => exhausted++);
  clock.run();retry.stop("async");finish(false);await new Promise(setImmediate);
  assert.equal(clock.queue.length, 0);assert.equal(exhausted, 1);
  // An asynchronous attempt continues the schedule with its result.
  retry.start("later", async () => false, () => exhausted++);
  clock.run();await new Promise(setImmediate);assert.equal(clock.queue[0].ms, 20);
});

test("one operation asks again after each delay until settled, and an abort ends its wait", async () => {
  const clock = timers(), results = [false, true];let attempts = 0;
  const tick = () => new Promise(setImmediate);
  const running = BoundedRetry.until(false, async () => results[attempts++], {delays: [10, 20, 40], settled: value => value, timers: clock});
  await tick();clock.run();await tick();clock.run();
  assert.equal(await running, true);assert.equal(attempts, 2);assert.equal(clock.queue.length, 0);
  const exhausted = BoundedRetry.until(false, async () => false, {delays: [10, 20], settled: value => value, timers: clock});
  await tick();clock.run();await tick();clock.run();
  assert.equal(await exhausted, false, "the last result is returned after the last delay");
  const controller = new AbortController(), reason = Object.assign(new Error("replaced"), {name: "AbortError"});
  const waiting = BoundedRetry.until(false, () => assert.fail("no attempt after an abort"), {delays: [10], settled: value => value, signal: controller.signal, timers: clock});
  await tick();const timer = clock.queue[0];controller.abort(reason);
  await assert.rejects(waiting, reason);assert.equal(timer.cleared, true);
});

const test = require("node:test"), assert = require("node:assert/strict");
const {createRuntimeCoordinator} = require("../src/core/runtime-coordinator");
const {createGraphicsRuntimeUse} = require("../src/main/graphics-runtime-use");

function fixture() {
  const coordinator = createRuntimeCoordinator(), owner = coordinator.client(), writer = coordinator.client();
  let current = true;
  const use = createGraphicsRuntimeUse({session: {pid: process.pid}, isCurrent: () => current,
    coordinator: owner, managers: [{id: "graphics-models"}, {id: "graphics-neural-models"}]});
  return {coordinator, owner, writer, use, stop: () => {current = false;}};
}

test("live-selected models remain protected by the real coordinator until the game session ends", async () => {
  const f = fixture(), a = {managerId: "graphics-models", version: "first"}, b = {managerId: "graphics-neural-models", version: "second"};
  await f.use.useRuntime(a);await f.use.useRuntime(b);await f.use.useRuntime(a);
  assert.equal(f.coordinator.snapshot().active.length, 2, "reusing a model does not duplicate its lease");
  for (const lease of f.coordinator.snapshot().active) assert.deepEqual(lease.pids, [process.pid]);
  await assert.rejects(f.writer.acquireMutation(a), {code: "RUNTIME_IN_USE"});
  await assert.rejects(f.writer.acquireMutation(b), {code: "RUNTIME_IN_USE"});
  const unrelated = await f.writer.acquireMutation({...a, version: "another"});await f.writer.release(unrelated);
  f.stop();await f.use.release();
  assert.equal(f.coordinator.snapshot().active.length, 0);
  const removed = await f.writer.acquireMutation(a);await f.writer.release(removed);
  await assert.rejects(f.use.useRuntime(a), /game has stopped/);
});

test("a game exiting during model preparation releases the pending lease instead of publishing stale ownership", async () => {
  const f = fixture(), identity = {managerId: "graphics-models", version: "waiting"};
  const mutation = await f.writer.acquireMutation(identity);
  const pending = f.use.useRuntime(identity);
  assert.equal(f.coordinator.snapshot().pending, 1);
  f.stop();const released = f.use.release();
  await f.writer.release(mutation);
  await assert.rejects(pending, {code: "RUNTIME_USE_CLOSED"});await released;
  assert.equal(f.coordinator.snapshot().active.length, 0);
  assert.equal(f.coordinator.snapshot().pending, 0);
});

test("an already stopped session cannot acquire model access", async () => {
  const f = fixture();f.stop();
  await assert.rejects(f.use.useRuntime({managerId: "graphics-models", version: "never-used"}), /game has stopped/);
  assert.equal(f.coordinator.snapshot().active.length, 0);
});

test("overlapping preparations can release their own access without unprotecting a retained candidate", async () => {
  const f = fixture(), identity = {managerId: "graphics-models", version: "overlap"};
  const first = f.use.begin(), second = f.use.begin();
  await Promise.all([first.useRuntime(identity), second.useRuntime(identity)]);
  assert.equal(f.coordinator.snapshot().active.length, 2);
  second.retain();await first.release();
  assert.equal(f.coordinator.snapshot().active.length, 1);
  await assert.rejects(f.writer.acquireMutation(identity), {code: "RUNTIME_IN_USE"});
  const reused = f.use.begin();await reused.useRuntime(identity);await reused.release();
  assert.equal(f.coordinator.snapshot().active.length, 1);
  f.stop();await f.use.release();assert.equal(f.coordinator.snapshot().active.length, 0);
});

test("cancellation before publication releases only the preparation and preserves the abort reason", async () => {
  const f = fixture(), controller = new AbortController(), reason = new Error("Reset requested");
  const accepted = {managerId: "graphics-models", version: "accepted"}, unused = {managerId: "graphics-neural-models", version: "candidate"};
  await f.use.useRuntime(accepted);
  const candidate = f.use.begin({signal: controller.signal});await candidate.useRuntime(unused);
  controller.abort(reason);
  await assert.rejects(candidate.useRuntime(unused), error => error === reason);
  await candidate.release();assert.equal(f.coordinator.snapshot().active.length, 1);
  await assert.rejects(f.writer.acquireMutation(accepted), {code: "RUNTIME_IN_USE"});
  const token = await f.writer.acquireMutation(unused);await f.writer.release(token);
  f.stop();await f.use.release();
});

test("canceling an unbound model wait lets Off finish before a writer retires and releases its exact late token", async () => {
  const f = fixture(), accepted = {managerId: "graphics-models", version: "accepted"},
    next = {managerId: "graphics-neural-models", version: "waiting"};
  await f.use.useRuntime(accepted);
  const writer = await f.writer.acquireMutation(next), controller = new AbortController(),
    reason = Object.assign(new Error("Off"), {name: "AbortError"});
  const candidate = f.use.begin({signal: controller.signal}), pending = candidate.useRuntime(next);
  assert.equal(f.coordinator.snapshot().pending, 1);
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);await candidate.release();
  assert.equal(f.coordinator.snapshot().active.length, 2, "accepted use and actual writer remain owned");
  await assert.rejects(f.writer.acquireMutation(accepted), {code: "RUNTIME_IN_USE"});
  await f.writer.release(writer);await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.coordinator.snapshot().pending, 0);
  assert.equal(f.coordinator.snapshot().active.length, 1, "late unbound candidate lease is released without touching accepted use");
  f.stop();await f.use.release();assert.equal(f.coordinator.snapshot().active.length, 0);
});

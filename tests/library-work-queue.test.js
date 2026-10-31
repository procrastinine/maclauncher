const test = require("node:test");
const assert = require("node:assert/strict");
const { createLibraryWorkQueue } = require("../src/main/library-work-queue");
const { createAvailabilityMonitor } = require("../src/main/game-availability-monitor");
const turn = () => new Promise(resolve => setImmediate(resolve));

test("pending refreshes coalesce, selected games start while background lanes are busy, and unchanged active work is shared", async () => {
  const started = [], finish = new Map();
  const queue = createLibraryWorkQueue({ concurrency: 1, run: request => new Promise(resolve => {
    started.push(request); finish.set(request.id, resolve);
  }) });
  const first = queue.enqueue({ id: "first", key: "1" });
  const later = queue.enqueue({ id: "later", key: "old" });
  const selected = queue.enqueue({ id: "selected", key: "old" });
  assert.equal(queue.enqueue({ id: "selected", key: "new", refreshMetadata: true }), selected);
  await turn();
  assert.equal(started.length, 1);
  assert.equal(queue.enqueue({ id: "first", key: "1" }), first);
  queue.prioritize("selected");
  await turn();
  assert.deepEqual(started.map(row => row.id), ["first", "selected"]);
  assert.equal(started[1].key, "new");
  assert.equal(started[1].refreshMetadata, true);
  finish.get("selected")(); await selected;
  finish.get("first")(); await first; await turn();
  assert.equal(started[2].id, "later"); finish.get("later")(); await later;
});

test("a game's replacement waits for its active job, keeps only the latest inputs, and removed games do no work", async () => {
  let finish;
  const started = [];
  const queue = createLibraryWorkQueue({ run: request => {
    started.push(request);
    if (started.length === 1) return new Promise(resolve => { finish = resolve; });
  } });
  const first = queue.enqueue({ id: "game", key: "old" });
  await turn();
  const next = queue.enqueue({ id: "game", key: "middle", refreshMetadata: true }, { priority: true });
  assert.equal(queue.enqueue({ id: "game", key: "latest" }), next);
  const removed = queue.enqueue({ id: "removed", key: "1" });
  queue.retain(new Set(["game"])); await removed; await turn();
  assert.equal(started.length, 1);
  finish(); await first; await next;
  assert.deepEqual(started.map(row => row.key), ["old", "latest"]);
  assert.equal(started[1].refreshMetadata, true);
});

test("startup work and inventory changes share one availability probe per game, including simultaneous requests and changed paths", async () => {
  let probes = 0, complete;
  const monitor = createAvailabilityMonitor({ listGames: () => [], check: () => {
    probes++; return new Promise(resolve => { complete = resolve; });
  } });
  const entry = { gameId: "game", gamePath: "/game" };
  const first = monitor.ensure(entry), duplicate = monitor.ensure(entry);
  assert.equal(first, duplicate);
  assert.equal(monitor.known(entry), false);
  await turn(); complete({ available: true }); await first;
  assert.equal((await monitor.ensure(entry)).available, true);
  assert.equal(monitor.known(entry), true);
  assert.equal(probes, 1);
  const moved = { ...entry, gamePath: "/moved" };
  assert.equal(monitor.known(moved), false);
  const second = monitor.ensure(moved); await turn(); complete({ available: true }); await second;
  assert.equal(probes, 2);
  monitor.close();
});

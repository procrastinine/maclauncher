const assert = require("node:assert/strict");
const test = require("node:test");

const { DownloadManager } = require("../src/modules/shared/runtime/download-manager");
const { isAbortError } = require("../src/modules/shared/runtime/download-utils");

test("runtime section wrappers preserve caller cancellation and shared Downloads controls", async t => {
  const Nwjs = require("../src/modules/shared/web/runtime/nwjs-manager");
  const Greenworks = require("../src/modules/shared/web/runtime/greenworks-runtime");
  const Onsyuri = require("../src/modules/shared/onsyuri/runtime/onsyuri-manager");
  const cases = [
    ["NW.js", Nwjs, Nwjs.core, "installVersion", { version: "0.107.0", variant: "sdk" }],
    ["Greenworks", Nwjs, Greenworks, "installVersion", { version: "0.107.0", sectionId: "greenworks" }],
    ["Onsyuri Mac", Onsyuri, Onsyuri.core, "installMacVersion", { version: Onsyuri.core.recommendedVersion, sectionId: "mac" }],
    ["Onsyuri Web", Onsyuri, Onsyuri.core, "installWebVersion", { version: "1.8.0", sectionId: "web" }]
  ];
  for (const [label, owner, core, method, options] of cases) for (const origin of ["caller", "downloads"]) await t.test(label + " " + origin, async t => {
    const caller = new AbortController(), downloads = new DownloadManager(); let start, observedSignal;
    const ready = new Promise(resolve => { start = resolve; });
    t.mock.method(core, method, async ({ signal, onProgress }) => {
      observedSignal = signal; onProgress({ downloaded: 10, total: 100 }); start();
      await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const pending = owner.installRuntime({ ...options, userDataDir: "/unused-cancellation-control", downloads, signal: caller.signal });
    const rejected = assert.rejects(pending, { name: "AbortError" }); await ready;
    const task = downloads.list()[0]; assert.equal(task.downloaded, 10);
    try {
      if (origin === "caller") caller.abort(); else assert.equal(downloads.cancel(task.id), true);
      assert.equal(observedSignal.aborted, true, "The selected section retains both cancellation sources");
    } finally { if (!observedSignal.aborted) downloads.cancel(task.id); await rejected; }
    assert.deepEqual(downloads.list(), []);
  });
});

test("DownloadManager tracks progress and clears finished tasks", async () => {
  const manager = new DownloadManager();
  const promise = manager.runTask({ label: "Test download", dedupeKey: "test" }, ({ onProgress }) => {
    onProgress({ downloaded: 5, total: 10 });
    return new Promise(resolve => {
      setTimeout(() => {
        onProgress({ downloaded: 10, total: 10 });
        resolve("ok");
      }, 10);
    });
  });

  const list = manager.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].downloaded, 5);
  assert.equal(list[0].total, 10);

  const result = await promise;
  assert.equal(result, "ok");
  assert.equal(manager.list().length, 0);
});

test("DownloadManager dedupes tasks by key", async () => {
  const manager = new DownloadManager();
  let resolveTask;
  const runner = () =>
    new Promise(resolve => {
      resolveTask = resolve;
    });

  const first = manager.runTask({ label: "Deduped", dedupeKey: "same" }, runner);
  const second = manager.runTask({ label: "Deduped", dedupeKey: "same" }, runner);
  assert.strictEqual(first, second);
  assert.equal(manager.list().length, 1);

  resolveTask("done");
  await first;
  assert.equal(manager.list().length, 0);
});

test("DownloadManager exposes preparation stages without resetting download progress", async () => {
  let update, finish;
  let changes = 0;
  const manager = new DownloadManager({ onChange: () => { changes++; }, progressThrottleMs: 0 });
  const task = manager.runTask({ label: "Runtime", detail: "Selected version" }, ({ onProgress }) => {
    update = onProgress;
    return new Promise(resolve => { finish = resolve; });
  });
  update({ downloaded: 100, total: 100 });
  const before = changes;
  update({ detail: " Extracting support libraries… " });
  assert.equal(manager.list()[0].detail, "Extracting support libraries…");
  assert.equal(manager.list()[0].downloaded, 100);
  assert.equal(manager.list()[0].total, 100);
  assert.ok(changes > before);
  update({ detail: null });
  assert.equal(manager.list()[0].detail, null);
  finish();
  await task;
});

test("DownloadManager cancel aborts the task", async () => {
  const manager = new DownloadManager();
  let seenAbort = false;
  const promise = manager.runTask({ label: "Cancelable", dedupeKey: "cancel" }, ({ signal }) => {
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        seenAbort = true;
        reject(signal.reason || new Error("aborted"));
      });
    });
  });

  const taskId = manager.list()[0]?.id;
  assert.ok(taskId);
  const canceled = manager.cancel(taskId);
  assert.equal(canceled, true);

  await assert.rejects(promise, err => isAbortError(err));
  assert.equal(seenAbort, true);
  assert.equal(manager.list().length, 0);
});

test("completed downloads remove pending progress timers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let changes = 0, update, finish;
  const manager = new DownloadManager({ onChange: () => changes++ });
  const task = manager.runTask({ label: "Runtime" }, ({ onProgress }) => {
    update = onProgress;
    return new Promise(resolve => { finish = resolve; });
  });
  for (let downloaded = 1; downloaded <= 10000; downloaded++) update({ downloaded, total: 10000 });
  assert.equal(changes, 1);
  t.mock.timers.tick(250); assert.equal(changes, 2);
  update({ downloaded: 10001 });
  finish(); await task;
  assert.equal(manager.tasks.size, 0); assert.equal(manager._progressEmitTimer, null);
  const completed = changes; t.mock.timers.tick(1000);
  assert.equal(changes, completed);
});

const assert = require("node:assert/strict");
const test = require("node:test");

const { DownloadManager } = require("../src/modules/shared/runtime/download-manager");
const { isAbortError } = require("../src/modules/shared/runtime/download-utils");

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

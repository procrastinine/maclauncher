const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { createGameImportQueue } = require("../src/core/game-import-queue");
const { gameFileAssociations } = require("../src/core/file-associations");

test("cold Finder imports wait for initialization and then preserve arrival order", async () => {
  const queue = createGameImportQueue(), calls = [];
  const first = queue.import("game/first.exe"), second = queue.import("game/second.pck");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
  queue.setImporter(async input => { calls.push(input); return input; });
  assert.deepEqual(await Promise.all([first, second]), [path.resolve("game/first.exe"), path.resolve("game/second.pck")]);
  assert.deepEqual(calls, [path.resolve("game/first.exe"), path.resolve("game/second.pck")]);
});

test("background Steam imports retain their request options while ordinary queued imports use defaults", async () => {
  const queue = createGameImportQueue(), calls = [];
  const background = { background: true };
  const first = queue.import("steam/Example Game", background);
  const second = queue.import("finder/Example.app");
  queue.setImporter(async (input, options) => { calls.push({ input, options }); return input; });
  await Promise.all([first, second]);
  assert.deepEqual(calls.map(call => call.input), [path.resolve("steam/Example Game"), path.resolve("finder/Example.app")]);
  assert.equal(calls[0].options, background);
  assert.deepEqual(calls[1].options, {});
  assert.deepEqual(queue.list(), []);
});

test("concurrent drop/menu imports serialize persistence and deduplicate an in-flight path", async () => {
  const queue = createGameImportQueue(), stored = [];
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  queue.setImporter(async input => {
    const snapshot = [...stored];
    if (input.endsWith("first.exe")) await slow;
    stored.splice(0, stored.length, ...snapshot, input);
    return input;
  });
  const first = queue.import("first.exe");
  assert.equal(queue.import("./first.exe"), first);
  const second = queue.import("second.pck");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(stored, []);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(stored, [path.resolve("first.exe"), path.resolve("second.pck")]);
});

test("an unsupported Finder document does not block later imports or retries", async () => {
  const queue = createGameImportQueue();
  let reject = true;
  queue.setImporter(async input => {
    if (input.endsWith("bad.exe") && reject) throw new Error("Unsupported game format");
    return input;
  });
  const first = assert.rejects(queue.import("bad.exe"), error => {
    assert.match(error.message, /bad\.exe.*could not be added/);
    assert.equal(error.cause.message, "Unsupported game format");
    return true;
  });
  const second = queue.import("good.exe");
  await first;
  assert.equal(await second, path.resolve("good.exe"));
  reject = false;
  assert.equal(await queue.import("bad.exe"), path.resolve("bad.exe"));
  await assert.rejects(queue.import(null), /Choose a game/);
  await assert.rejects(queue.import("bad\0.exe"), /Choose a game/);
  assert.throws(() => queue.setImporter(() => {}), /configured once/);
});

test("Finder prefers supported game formats and offers common sidecars without taking over macOS apps", () => {
  const associations = gameFileAssociations(["exe", "pck", "love", "jar", "swf", "html", "json", "app", "exe", "../bad"]);
  const primary = associations.find(row => row.rank === "Owner");
  const common = associations.find(row => row.rank === "Alternate");
  assert.deepEqual(primary.ext, ["exe", "jar", "love", "pck", "swf"]);
  assert.deepEqual(common.ext, ["html", "json"]);
  assert.equal(associations.some(row => row.ext.includes("app")), false);
  assert.equal(primary.role, "Viewer");
});

test("queued cancellation prevents import work and reports every pending input without blocking active work", async () => {
  let release; const updates = [], calls = [];
  const queue = createGameImportQueue({ onChange: value => updates.push(value) });
  queue.setImporter(async input => { calls.push(input); await new Promise(resolve => { release = resolve; }); return input; });
  const first = queue.import("first.exe"), second = queue.import("second.exe");
  const cancelled = assert.rejects(second, error => error.code === "ABORT_ERR");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.list().length, 2); assert.equal(queue.list()[0].phase, "processing"); assert.equal(queue.list()[1].phase, "queued");
  assert.equal(await queue.cancel("second.exe"), true); assert.equal(queue.list().length, 1);
  release(); await first; await cancelled;
  assert.deepEqual(calls, [path.resolve("first.exe")]); assert.deepEqual(queue.list(), []);
  assert.ok(updates.some(value => value.length === 2));
});

test("active import cancellation delegates to the asynchronous backend and queue recovers", async () => {
  let fail;
  const queue = createGameImportQueue();
  queue.setImporter(input => new Promise((resolve, reject) => { fail = reject; }), {
    cancelImporter: async () => { fail(Object.assign(new Error("Import cancelled"), { code: "ABORT_ERR" })); return true; }
  });
  const result = assert.rejects(queue.import("setup.exe"), error => error.code === "ABORT_ERR");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await queue.cancel("setup.exe"), true); await result;
  assert.deepEqual(queue.list(), []); assert.equal(await queue.cancel("missing.exe"), false);
});

test("a cancelled queued path can be re-added before the earlier import completes", async () => {
  const queue = createGameImportQueue(), calls = []; let release;
  queue.setImporter(async input => { calls.push(input); if (input.endsWith("first.exe")) await new Promise(resolve => { release = resolve; }); return input; });
  const first = queue.import("first.exe"), skipped = queue.import("second.exe");
  const cancelled = assert.rejects(skipped, error => error.code === "ABORT_ERR");
  await new Promise(resolve => setImmediate(resolve));
  await queue.cancel("second.exe"); const retried = queue.import("second.exe");
  assert.notEqual(retried, skipped); assert.equal(queue.list().length, 2);
  release(); await first; await cancelled; assert.equal(await retried, path.resolve("second.exe"));
  assert.deepEqual(calls, [path.resolve("first.exe"), path.resolve("second.exe")]); assert.deepEqual(queue.list(), []);
});

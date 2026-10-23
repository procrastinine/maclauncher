const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createBufferedLog } = require("../src/core/buffered-log");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maclauncher-log-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, "main.log") };
}
test("a synchronous logging burst is bounded and reports suppressed messages", async t => {
  const { file } = await fixture(t);
  const sink = createBufferedLog(file, { delayMs: 60000 });
  sink.write("First failure\n");
  for (let i = 0; i < 10000; i++) sink.write("x".repeat(9000) + "\n");
  await sink.flush();
  const bytes = await fs.readFile(file);
  assert.ok(bytes.length <= 64 * 1024 + 100);
  assert.match(bytes.toString(), /^First failure\n/);
  assert.match(bytes.toString(), /messages omitted while output was busy/);
  assert.ok(bytes.toString().split("\n").every(line => Buffer.byteLength(line) <= 8192));
});
test("repeated log rotation retains only a bounded current and previous file", async t => {
  const { root, file } = await fixture(t);
  const sink = createBufferedLog(file, { maximumBytes: 16384, queueBytes: 8192 });
  for (let batch = 0; batch < 20; batch++) {
    for (let line = 0; line < 4; line++) sink.write(`batch ${batch} ${"x".repeat(3000)}\n`);
    await sink.flush();
  }
  assert.deepEqual((await fs.readdir(root)).sort(), ["main.log", "main.log.previous"]);
  for (const name of await fs.readdir(root)) assert.ok((await fs.stat(path.join(root, name))).size <= 16384);
  assert.match(await fs.readFile(file, "utf8"), /batch 19 /);
});
test("concurrent shutdown flushes include messages arriving during an earlier write exactly once", async t => {
  const { file } = await fixture(t), sink = createBufferedLog(file);
  sink.write("first\n"); const first = sink.flush();
  sink.write("second\n"); const second = sink.flush();
  await Promise.all([first, second]);
  assert.equal(await fs.readFile(file, "utf8"), "first\nsecond\n");
});
test("logs retained from an older version are reduced to their bounded diagnostic tail", async t => {
  const { file } = await fixture(t), maximumBytes = 16384;
  await fs.writeFile(file + ".previous", "x".repeat(1024 * 1024) + "old diagnostic\n");
  const sink = createBufferedLog(file, { maximumBytes });
  sink.write("new session\n"); await sink.flush();
  assert.equal((await fs.stat(file + ".previous")).size, maximumBytes);
  assert.match(await fs.readFile(file + ".previous", "utf8"), /old diagnostic\n$/);
  await fs.writeFile(file, "y".repeat(1024 * 1024) + "recent diagnostic\n");
  sink.write("after rotation\n"); await sink.flush();
  assert.equal((await fs.stat(file + ".previous")).size, maximumBytes);
  assert.match(await fs.readFile(file + ".previous", "utf8"), /recent diagnostic\n$/);
  assert.equal(await fs.readFile(file, "utf8"), "after rotation\n");
});
test("a failed log write does not retain its queue or prevent later output", async t => {
  const { file } = await fixture(t), sink = createBufferedLog(file);
  await fs.mkdir(file);
  sink.write("cannot write\n"); await sink.flush();
  await fs.rm(file, { recursive: true });
  sink.write("recovered\n"); await sink.flush();
  assert.equal(await fs.readFile(file, "utf8"), "recovered\n");
});

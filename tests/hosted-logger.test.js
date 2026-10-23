const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createHostedLogger } = require("../src/core/hosted-logger");

test("detached host errors remain in the profile log after its output stream closes", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-logger-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logger = createHostedLogger(root, { pid: 123, output: { error: () => { const error = Error("pipe closed"); error.code = "EPIPE"; throw error; } } });
  const cycle = {}; cycle.self = cycle;
  logger.error("Renderer library bootstrap failed", cycle);
  await logger.flush();
  const log = fs.readFileSync(logger.path, "utf8");
  assert.match(log, /\[error\] \[host:123\] Renderer library bootstrap failed/);
  assert.match(log, /Circular/);
  logger.info("x".repeat(20000));
  await logger.flush();
  assert.ok(fs.readFileSync(logger.path, "utf8").split("\n").at(-2).length < 8400);
});

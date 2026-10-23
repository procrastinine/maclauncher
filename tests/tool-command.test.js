const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runToolCommand } = require("../src/modules/shared/runtime/tool-command");
const { isRuntimeProcessAlive } = require("../src/core/runtime-coordinator");
function options(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-tool-command-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return { cwd, logPath: path.join(cwd, "tool.log"), timeout: 10000 };
}
test("tool commands record bounded output and wait for asynchronous process ownership", async t => {
  const opts = options(t); let bound = false, pid;
  await runToolCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(9*1024*1024));process.stderr.write('finished');"], {
    ...opts, onSpawn: async child => { pid = child.pid; await new Promise(resolve => setTimeout(resolve, 10)); bound = true; }
  });
  assert.equal(bound, true); assert.equal(await isRuntimeProcessAlive(pid), false);
  assert.ok(fs.statSync(opts.logPath).size <= 8 * 1024 * 1024 + 1024);
});
test("cancelled tool commands stop their owned process before releasing the operation", async t => {
  const opts = options(t), abort = new AbortController(); let pid;
  await assert.rejects(runToolCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    ...opts, signal: abort.signal, onSpawn: child => { pid = child.pid; abort.abort(); }
  }), { code: "ABORT_ERR" });
  assert.equal(await isRuntimeProcessAlive(pid), false);
});
test("failed process ownership stops a tool and returns the original binding error", async t => {
  const opts = options(t); let pid;
  await assert.rejects(runToolCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    ...opts, onSpawn: child => { pid = child.pid; throw Object.assign(new Error("Binding failed"), { code: "BIND_FAILED" }); }
  }), { code: "BIND_FAILED" });
  assert.equal(await isRuntimeProcessAlive(pid), false);
});

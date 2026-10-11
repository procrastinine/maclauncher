const assert = require("node:assert/strict");
const test = require("node:test");

const ChildProcessGuard = require("../src/modules/shared/web/runtime/child-process-guard");

test("wrapChildProcessModule allows import-time probes and blocks process launch methods", () => {
  const actual = require("node:child_process");
  const guarded = ChildProcessGuard.wrapChildProcessModule(actual, {
    messageSuffix: " is disabled in MacLauncher offline mode"
  });

  assert.notEqual(guarded, actual);
  assert.equal(guarded.ChildProcess, actual.ChildProcess);
  assert.equal(typeof guarded.spawn, "function");
  assert.equal(typeof guarded.exec, "function");

  assert.throws(
    () => guarded.spawn(process.execPath, ["-v"]),
    /Blocked: child_process\.spawn is disabled in MacLauncher offline mode/
  );
  assert.throws(
    () => guarded.exec("true"),
    /Blocked: child_process\.exec is disabled in MacLauncher offline mode/
  );
});

test("buildDisableChildScript wraps child_process imports instead of blocking require", () => {
  const source = ChildProcessGuard.buildDisableChildScript({ alert: true, log: true });
  assert.ok(source.includes('if(id==="child_process"||id==="node:child_process")return wrap(loaded)'));
  assert.ok(source.includes("Blocked: \"+name+MESSAGE_SUFFIX"));
  assert.equal(source.includes('if(id==="child_process"||id==="node:child_process")block('), false);
});

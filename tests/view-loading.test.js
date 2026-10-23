const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLocalView } = require("../src/core/view-loading");

test("a restarted local Chromium network service recovers in the same launcher", async () => {
  let attempts = 0; const delays = [];
  const result = await loadLocalView({ url: "http://127.0.0.1:5174/?view=launcher",
    delay: async milliseconds => delays.push(milliseconds), load: async () => {
      attempts++; if (attempts < 3) throw Object.assign(new Error("ERR_FAILED (-2)"), { code: "ERR_FAILED" });
    } });
  assert.equal(result, true); assert.equal(attempts, 3); assert.deepEqual(delays, [100, 300]);
});

test("permanent failures, remote URLs and closed windows are not retried", async () => {
  for (const url of ["https://example.com/", "file:///missing/index.html"]) {
    let attempts = 0;
    await assert.rejects(loadLocalView({ url, load: async () => { attempts++; throw new Error("ERR_FAILED"); } }), /ERR_FAILED/);
    assert.equal(attempts, 1);
  }
  let attempts = 0;
  await assert.rejects(loadLocalView({ url: "http://localhost:5174/", load: async () => { attempts++; throw new Error("ERR_FILE_NOT_FOUND"); } }));
  assert.equal(attempts, 1);
  assert.equal(await loadLocalView({ url: "http://localhost:5174/", isDestroyed: () => true, load: () => assert.fail("closed window") }), false);
});

const assert = require("node:assert/strict");
const test = require("node:test");

const Runtime = require("../src/modules/shared/onsyuri/runtime/onsyuri-runtime");

test("getWebArchiveType identifies supported web archives", () => {
  assert.equal(Runtime.__test.getWebArchiveType("onsyuri_web.7z"), "7z");
  assert.equal(Runtime.__test.getWebArchiveType("onsyuri-web.zip"), "zip");
  assert.equal(Runtime.__test.getWebArchiveType("ONSYURI_WEB.ZIP"), "zip");
  assert.equal(Runtime.__test.getWebArchiveType("onsyuri_web.tar.gz"), null);
});

const assert = require("node:assert/strict");
const test = require("node:test");

const NscripterModule = require("../src/modules/nscripter/main");

test("parseMissingDylibs ignores system libs and keeps brew hints", () => {
  const output = [
    "/path/to/onsyuri:",
    "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.120.2)",
    "\t/opt/homebrew/opt/lua/lib/liblua.dylib (compatibility version 5.4.0, current version 5.4.8)",
    "\t@rpath/libSomething.dylib (compatibility version 1.0.0, current version 1.0.0)"
  ].join("\n");
  const existsFn = dep => dep !== "/opt/homebrew/opt/lua/lib/liblua.dylib";
  const result = NscripterModule.__test.parseMissingDylibs(output, existsFn);
  assert.deepEqual(result?.missing, ["/opt/homebrew/opt/lua/lib/liblua.dylib"]);
  assert.ok(result?.brewHints.includes("lua"));
});

test("parseMissingDylibs returns null when nothing is missing", () => {
  const output = [
    "/path/to/onsyuri:",
    "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.120.2)"
  ].join("\n");
  const result = NscripterModule.__test.parseMissingDylibs(output, () => true);
  assert.equal(result, null);
});

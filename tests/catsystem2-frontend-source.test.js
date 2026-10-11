const test = require("node:test"), assert = require("node:assert/strict");
const { runtimeSource } = require("../src/modules/catsystem2/runtime/frontend-source");
const source = text => ({ sourceEncoding: "UTF-8", runtimeEncodingProven: false, text });
const options = { engineVersion: "2.6.1.76" };
test("FES ASCII controls retain opaque diagnostic/comment text without inferring Unicode execution", () => {
  const decoded = source('#START\n// diagnostic —\ndbgstr "— // retained"\ntext layout prof 0 \u3000\n$1=7\n');
  assert.equal(runtimeSource(decoded, options), decoded.text); assert.equal(decoded.runtimeEncodingProven, false);
  assert.equal(runtimeSource({ sourceEncoding: "CP932", text: "#START" }), "#START");
});
test("FES executable Unicode values, ambiguous whitespace and unsupported encoding profiles remain explicit", () => {
  for (const text of ['#START\nstrvar 1 "—"', '#DEFINE\nIMAGE —', '#START\n$1=—', '#START\n\u3000dbgstr —'])
    assert.throws(() => runtimeSource(source(text), options), /executable string encoding/);
  assert.throws(() => runtimeSource(source("#START")), /runtime text encoding/);
  assert.throws(() => runtimeSource(source("#START"), { engineVersion: "4.1" }), /runtime text encoding/);
});

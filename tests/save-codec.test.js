const assert = require("node:assert/strict");
const test = require("node:test");

const SaveCodec = require("../src/modules/shared/mvmz/rpgmaker-save");

test("encode/decode roundtrip for mv", () => {
  const input = JSON.stringify({ ok: true, value: 42 });
  const encoded = SaveCodec.encodeSave("mv", input);
  const decoded = SaveCodec.decodeSave("mv", encoded);
  assert.equal(decoded, input);
});

test("encode/decode roundtrip for mz", () => {
  const input = JSON.stringify({ ok: true, value: 7 });
  const encoded = SaveCodec.encodeSave("mz", input);
  const decoded = SaveCodec.decodeSave("mz", encoded);
  assert.equal(decoded, input);
});

test("encodeSave rejects non-string input", () => {
  assert.throws(() => SaveCodec.encodeSave("mv", { ok: true }));
});

test("decodeSave rejects missing input", () => {
  assert.throws(() => SaveCodec.decodeSave("mv", null));
});

test("save codec rejects unsupported engine", () => {
  assert.throws(() => SaveCodec.encodeSave("unknown", "{}"));
  assert.throws(() => SaveCodec.decodeSave("unknown", "{}"));
});

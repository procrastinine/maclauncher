const test = require("node:test");
const assert = require("node:assert/strict");
const { nativeLibrary } = require("./helpers/hashlink-native");
const Primitives = require("../src/modules/hashlink/runtime/primitive-signatures");

test("HashLink reads release and debug native signatures without executing getters", () => {
  for (const optimization of ["release", "debug"]) {
    const image = nativeLibrary({ mp3_open: "PBi_Xfmt_mp3_", event_loop: "PD_b" }, { optimization });
    const original = Buffer.from(image), result = Primitives.inspectSignatures(image);
    assert.deepEqual(result.signatures, { event_loop: "PD_b", mp3_open: "PBi_Xfmt_mp3_" });
    assert.deepEqual(result.unsupported, []); assert.deepEqual(image, original);
  }
});

test("HashLink rejects malformed native bounds and keeps opaque getter code unsupported", () => {
  for (const mutate of [bytes => bytes.writeUInt32LE(0xffffffff, 272), bytes => bytes.writeUInt32LE(8191, 280),
    bytes => bytes.writeBigUInt64LE(0xffffffffffffffffn, 136), bytes => bytes.writeUInt32LE(0x0100000c, 4)]) {
    const image = nativeLibrary(); mutate(image); assert.throws(() => Primitives.inspectSignatures(image), /bounds|Intel|metadata/);
  }
  const branch = nativeLibrary(); branch[516] = 0xe9;
  const result = Primitives.inspectSignatures(branch);
  assert.deepEqual(result.signatures, {}); assert.equal(result.unsupported[0].name, "native_function");
  const writable = nativeLibrary(); writable.writeUInt32LE(7, 92);
  assert.equal(Primitives.inspectSignatures(writable).unsupported.length, 1);
});

test("HashLink compares every required native primitive, with explicit optional and callback contracts", () => {
  const required = [{ library: "fmt", name: "mp3_open", signature: "PBi_Xfmt_mp3_", optional: false },
    { library: "openal", name: "al_gen_effects", signature: "PiB_v", optional: false },
    { library: "?unused", name: "feature", signature: "P_v", optional: true }];
  const incompatible = Primitives.compareRequired(required, { fmt: { signatures: { mp3_open: "P_Xfmt_mp3_" } } });
  assert.equal(incompatible.ready, false); assert.equal(incompatible.incompatible[0].name, "mp3_open");
  assert.deepEqual(incompatible.missing.map(x => x.name), ["al_gen_effects"]);
  const compatible = { fmt: { signatures: { mp3_open: "PBi_Xfmt_mp3_" } }, openal: { signatures: { al_gen_effects: "PiB_v" } } };
  assert.equal(Primitives.compareRequired(required, compatible).ready, true);
  const callback = [{ library: "std", name: "call_method", signature: "PDA_D", optional: false }];
  const library = { std: { signatures: { call_method: "PDA_DC" } } };
  assert.equal(Primitives.compareRequired(callback, library).ready, false);
  assert.equal(Primitives.compareRequired(callback, library, { callbackMarker: true }).ready, true);
  assert.equal(Primitives.compareRequired([{ ...callback[0], signature: undefined }], library).unknown.length, 1);
});

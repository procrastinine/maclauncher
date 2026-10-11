const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { readPeResources, LIMITS } = require("../src/modules/shared/runtime/pe-resources");
const { resourceFixture } = require("./helpers/pe-resources-fixture");

const selections = [{ type: "KEY_CODE", name: "KEY" }, { type: "V_CODE2", name: "DATA" }];
function file(t, fixture) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "named-pe-resources-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = path.join(root, "runner.exe"); fs.writeFileSync(result, fixture.bytes); return result;
}
function fixture(options) {
  return resourceFixture([{ type: 3, name: 1, data: Buffer.alloc(128 * 1024, 0x61) },
    { type: "KEY_CODE", name: "KEY", data: Buffer.from("fixture-key") },
    { type: "V_CODE2", name: "DATA", data: Buffer.from("opaque-vcode") },
    { type: "V_CODE2", name: "DATA", language: 1033, data: Buffer.from("localized") }], options);
}

test("bounded named PE resources select exact PE32/PE32+ branches and all declared languages", t => {
  for (const is64 of [false, true]) {
    const f = fixture({ is64 }), reads = [], results = readPeResources(file(t, f), selections, { detection: {
      stat: fs.statSync, readBytes: (_file, offset, length) => { reads.push(length); return f.bytes.subarray(offset, offset + length); }
    } });
    assert.equal(results.length, 3); assert.equal(results[0].data.toString(), "fixture-key");
    assert.deepEqual(results.slice(1).map(r => r.language).sort(), [1033, 1041]);
    assert.ok(reads.reduce((n, size) => n + size, 0) < 2048, "unrelated large icon payload was not read");
    assert.ok(reads.length < LIMITS.reads);
    assert.deepEqual(readPeResources(file(t, f), [{ type: "MISSING", name: "KEY" }]), []);
  }
});

test("named PE resources fail closed on corrupt ranges, cycles, oversized names and values", t => {
  for (const corrupt of [
    f => f.bytes.writeUInt16LE(0, 0),
    f => f.bytes.writeUInt32LE(1024 * 1024 + 1, 60),
    f => f.bytes.writeUInt16LE(257, f.raw + 12),
    f => f.bytes.writeUInt32LE(0x80000000, f.raw + 20),
    f => f.bytes.writeUInt32LE(0x8000ffff, f.raw + 16),
    f => f.bytes.writeUInt32LE(f.resourceSize + 100, f.directories + 20)
  ]) { const f = fixture(); corrupt(f); assert.deepEqual(readPeResources(file(t, f), selections), []); }
  const large = resourceFixture([{ type: "KEY_CODE", name: "KEY", data: Buffer.alloc(LIMITS.resourceBytes + 1) }]);
  assert.deepEqual(readPeResources(file(t, large), selections), []);
  assert.throws(() => readPeResources("unused", [{ type: "", name: "KEY" }]), /selectors/);
  const limited = Object.assign(new Error("bounded"), { code: "DETECTION_LIMIT" });
  assert.throws(() => readPeResources(file(t, fixture()), selections, { detection: { stat: fs.statSync, readBytes: () => { throw limited; } } }), { code: "DETECTION_LIMIT" });
});

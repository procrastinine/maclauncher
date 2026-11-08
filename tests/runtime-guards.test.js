const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Guards = require("../src/modules/shared/runtime/guards");
const Bundled = require("../src/modules/shared/runtime/bundled-native");

function producing(t) {
  const previous = process.env[Guards.PRODUCER_ENV];
  process.env[Guards.PRODUCER_ENV] = "1";
  t.after(() => { if (previous === undefined) delete process.env[Guards.PRODUCER_ENV]; else process.env[Guards.PRODUCER_ENV] = previous; });
}

test("live guards keep their values and package production lifts them", t => {
  const table = Guards.limits({ files: 20 });
  assert.equal(Guards.limit(64), 64);
  assert.equal(Guards.optional(64), 64);
  assert.equal(table.files, 20);
  assert.equal(Bundled.LIMITS.files, 20000);
  producing(t);
  assert.equal(Guards.limit(64), Infinity);
  assert.equal(Guards.optional(64), undefined);
  assert.equal(table.files, Infinity);
  assert.equal(Bundled.LIMITS.fileBytes, Infinity);
});

test("a bounded read fails live and succeeds while producing packages", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runtime-guards-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "payload.bin");
  fs.writeFileSync(file, Buffer.alloc(32, 1));
  assert.throws(() => Bundled.readRegular(file, 16), /exceeds its limit/);
  producing(t);
  assert.equal(Bundled.readRegular(file, 16).bytes.length, 32);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { MAX_LOG_BYTES, retainNativeOutput, readNativeLog } = require("../src/modules/nitroplus/native-output");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nitroplus-native-output-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const entry = { moduleData: { scriptVersion: "2.00" } }, errors = [], changes = [];
  const context = { onEntryChange: value => changes.push(value), logger: { error: value => errors.push(value), warn() {} },
    ui: { dialog: { showMessageBox: () => assert.fail("Native detail retention must not duplicate the host's failure UI") } } };
  return { directory, child, entry, context, errors, changes };
}

test("native stderr detail and its private log survive an actual nonzero terminal event", t => {
  const f = fixture(t);
  assert.equal(retainNativeOutput(f.child, { ...f, version: "0.5.3-macos-v3" }), f.child);
  f.child.stdout.write("Compile nss/boot.nss\n");
  f.child.stderr.write("Nitroplus: Unimplemented native NSS function: UnknownFunction\n");
  f.child.emit("close", 1, null);
  const result = readNativeLog(f.directory, f.entry);
  assert.match(result.error, /UnknownFunction/);
  assert.match(result.output, /Compile nss\/boot.nss/);
  assert.equal(f.entry.moduleData.scriptVersion, "2.00");
  assert.equal(f.errors.length, 1);
  assert.equal(f.changes.length, 2);
  f.child.emit("close", 1, null);
  assert.equal(f.errors.length, 1);
});

test("large native output stays bounded while the latest stderr error remains readable", t => {
  const f = fixture(t);
  retainNativeOutput(f.child, { ...f, version: "0.5.3-macos-v3" });
  f.child.stdout.write(Buffer.alloc(MAX_LOG_BYTES * 2, 65));
  f.child.stderr.write(Buffer.alloc(20000, 66));
  f.child.stderr.write("\nNitroplus: Missing NSS object namespace: original/menu\n");
  f.child.emit("close", 1, null);
  assert.equal(fs.statSync(path.join(f.directory, "native.log")).size, MAX_LOG_BYTES);
  assert.equal(readNativeLog(f.directory, f.entry).error, "Nitroplus: Missing NSS object namespace: original/menu");
  f.child.stdout.write("late ignored output");
  assert.equal(fs.statSync(path.join(f.directory, "native.log")).size, MAX_LOG_BYTES);
});

test("ordinary quit and Inspector Stop leave no native error detail", t => {
  for (const [code, signal] of [[0, null], [null, "SIGTERM"], [null, "SIGKILL"]]) {
    const f = fixture(t);
    retainNativeOutput(f.child, { ...f, version: "0.5.3-macos-v3" });
    f.child.stderr.write("ordinary output\n");
    f.child.emit("close", code, signal);
    assert.equal(readNativeLog(f.directory, f.entry).error, null);
    assert.deepEqual(f.errors, []);
  }
});

test("log failures cannot leak the already spawned child or follow an external symlink", t => {
  const f = fixture(t), outside = path.join(f.directory, "original.txt");
  fs.writeFileSync(outside, "original data unchanged");
  fs.symlinkSync(outside, path.join(f.directory, "native.log"));
  assert.equal(retainNativeOutput(f.child, { ...f, version: "0.5.3-macos-v3" }), f.child);
  assert.equal(fs.readFileSync(outside, "utf8"), "original data unchanged");
  assert.throws(() => readNativeLog(f.directory, f.entry), /symbolic|ELOOP/);
  fs.unlinkSync(path.join(f.directory, "native.log"));
  assert.equal(readNativeLog(f.directory, f.entry).available, false);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LIMITS, readPeVersion, parseVersionResource } = require("../src/modules/shared/runtime/pe-version");
const { versionResource, peFixture } = require("./helpers/pe-fixture");

function temporary(t, bytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-version-")), file = path.join(root, "AI5WIN.EXE");
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.writeFileSync(file, bytes); return file;
}

test("PE32 and PE32+ version resources retain exact file/product versions and only declared fields", t => {
  for (const is64 of [false, true]) {
    const file = temporary(t, peFixture({ is64, version: versionResource({ strings: { ProductName: "AI5WIN", FileVersion: "marketing label", CompanyName: "Example", Comments: "ignored" } }) }).bytes);
    const version = readPeVersion(file);
    assert.equal(version.fileVersion, "1.5.7.23"); assert.equal(version.productVersion, "2.0.4.6");
    assert.equal(version.flags, 1); assert.deepEqual(version.strings, { ProductName: "AI5WIN", FileVersion: "marketing label", CompanyName: "Example" });
    assert.equal(version.source, "AI5WIN.EXE!RT_VERSION/1/1033");
  }
  assert.equal(parseVersionResource(versionResource({ flags: 0xffffffff, mask: 0x80000000 })).flags, 0x80000000);
});

test("PE metadata inspection skips unrelated resources and obeys the detection read budget", t => {
  const fixture = peFixture({ largeIcon: true }), file = temporary(t, fixture.bytes), reads = [];
  const result = readPeVersion(file, { detection: { stat: fs.statSync, readBytes: (_file, offset, length) => {
    reads.push({ offset, length }); return fixture.bytes.subarray(offset, offset + length);
  } } });
  assert.equal(result.strings.ProductName, "AI5WIN");
  assert.ok(reads.length <= LIMITS.reads);
  assert.ok(reads.reduce((sum, read) => sum + read.length, 0) < 2048);
  assert.ok(reads.every(read => read.offset + read.length <= fixture.raw + 0x1000), "large icon data was never read");
  const limited = Object.assign(new Error("budget exhausted"), { code: "DETECTION_LIMIT" });
  assert.throws(() => readPeVersion(file, { detection: { stat: fs.statSync, readBytes: () => { throw limited; } } }), { code: "DETECTION_LIMIT" });
});

test("PE version inspection fails closed on bad magic, cyclic directories and resource ranges", t => {
  const cases = [
    f => { f.bytes[0] |= 0x80; },
    f => { f.bytes[f.peOffset] |= 0x80; },
    f => { f.bytes.writeUInt32LE(1024 * 1024 + 1, 60); },
    f => { f.bytes.writeUInt16LE(97, f.peOffset + 6); },
    f => { f.bytes.writeUInt32LE(2, f.directories - 4); },
    f => { f.bytes.writeUInt32LE(0x1800, f.directories + 20); },
    f => { f.bytes.writeUInt32LE(0x80000000, f.raw + 20); },
    f => { f.bytes.writeUInt16LE(257, f.raw + 14); },
    f => { f.bytes.writeUInt32LE(0xffffff00, f.raw + 0x80); },
    f => { f.bytes.writeUInt32LE(65536, f.raw + 0x84); },
    f => { f.bytes.writeUInt16LE(0xffff, f.blob); }
  ];
  for (const mutate of cases) { const fixture = peFixture(); mutate(fixture); assert.equal(readPeVersion(temporary(t, fixture.bytes)), null); }
  const signature = versionResource(); signature.writeUInt32LE(0, 40);
  assert.equal(parseVersionResource(signature), null);
  assert.equal(parseVersionResource(Buffer.from("VS_VERSION_INFO")), null);
});

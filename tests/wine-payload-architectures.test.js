const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Payload = require("../src/modules/crossover/sources/wine-payload");

// A thin 64-bit Mach-O dylib with one LC_BUILD_VERSION command for macOS.
function dylib(cpu, major) {
  const bytes = Buffer.alloc(56);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(cpu, 4); bytes.writeUInt32LE(6, 12);
  bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0x32, 32); bytes.writeUInt32LE(24, 36); bytes.writeUInt32LE(1, 40);
  bytes.writeUInt32LE(major << 16, 44);
  return bytes;
}
const X86_64 = 0x01000007, ARM64 = 0x0100000c;
function tree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wine-payload-cpu-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), bytes);
  }
  return { root, records: Object.keys(files).map(relative => ({ relative, kind: "file" })) };
}

test("a Wine tree reports the CPU its native images measure, arm64 included", t => {
  const arm = tree(t, { "lib/wine.dylib": dylib(ARM64, 12), "lib/server.dylib": dylib(ARM64, 13) });
  assert.deepEqual(Payload.inspectClosure(arm.root, arm.records), { minimumMacOS: "13.0.0", nativeComponents: 2, architectures: ["arm64"] });
  const intel = tree(t, { "lib/wine.dylib": dylib(X86_64, 11) });
  assert.deepEqual(Payload.inspectClosure(intel.root, intel.records), { minimumMacOS: "11.0.0", nativeComponents: 1, architectures: ["x86_64"] });
});

test("native images without a shared CPU are refused with that reason", t => {
  const mixed = tree(t, { "lib/wine.dylib": dylib(ARM64, 12), "lib/server.dylib": dylib(X86_64, 12) });
  assert.throws(() => Payload.inspectClosure(mixed.root, mixed.records, undefined, { label: "Sample" }), /Sample native components share no CPU architecture/);
});

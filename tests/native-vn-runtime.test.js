const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Native = require("../src/modules/shared/runtime/local-native");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-native-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function thin(cpu = 0x0100000c, type = 2) {
  const data = Buffer.alloc(32);
  data.writeUInt32LE(0xfeedfacf, 0); data.writeUInt32LE(cpu, 4); data.writeUInt32LE(type, 12);
  return data;
}
function executable(root, data, name = "runtime") {
  const file = path.join(root, name); fs.writeFileSync(file, data, { mode: 0o755 }); return file;
}
const identity = { runtimeVersion: "1.0.0", upstreamRevision: "a".repeat(40), platform: "darwin", arch: "arm64" };

test("local native runtimes require explicit version, native executable, CPU and permission", t => {
  const root = fixture(t);
  const binary = executable(root, thin());
  const runtime = Native.resolveLocalRuntime({ runtimePath: binary, ...identity });
  assert.deepEqual(runtime.architectures, ["arm64"]);
  assert.equal(runtime.needsRosetta, false);
  assert.equal(runtime.sha256, Native.hashFile(binary));
  assert.equal(runtime.upstreamRevision, identity.upstreamRevision);
  assert.throws(() => Native.resolveLocalRuntime({ runtimePath: binary, platform: "darwin" }), /version/);
  assert.throws(() => Native.resolveLocalRuntime({ runtimePath: "relative", ...identity }), /absolute/);
  assert.throws(() => Native.resolveLocalRuntime({ runtimePath: binary, ...identity, platform: "linux" }), /macOS host/);
  assert.throws(() => Native.resolveLocalRuntime({ runtimePath: binary, ...identity, arch: "x64" }), /CPU/);
  assert.throws(() => Native.resolveLocalRuntime({ runtimePath: binary, ...identity, expectedSha256: "0".repeat(64) }), /checksum changed/);
  fs.chmodSync(binary, 0o644);
  assert.equal(Native.getLocalRuntimeStatus({ runtimePath: binary, ...identity }).ready, false);
  assert.throws(() => Native.resolveLocalRuntime({ runtimePath: binary, ...identity }), /permission/);
});

test("native validation rejects scripts, ELF, PE, dylibs and malformed universal headers", t => {
  const root = fixture(t);
  for (const data of [Buffer.from("#!/bin/sh\nexit 0\n"), Buffer.alloc(40, "MZ"), Buffer.alloc(40, "\x7fELF"), thin(0x0100000c, 6)]) {
    const file = executable(root, data);
    assert.throws(() => Native.resolveLocalRuntime({ runtimePath: file, ...identity }), /Mach-O/);
  }
  const java = Buffer.alloc(40); java.writeUInt32BE(0xcafebabe, 0); java.writeUInt32BE(0xffff, 4);
  assert.throws(() => Native.readMachOArchitectures(executable(root, java)), /universal/);
  const dylib = executable(root, thin(0x0100000c, 6));
  assert.deepEqual(Native.readMachOArchitectures(dylib, { allowLibrary: true }), ["arm64"]);
});

test("universal Mach-O verifies each bounded slice and selects Rosetta explicitly", t => {
  const root = fixture(t);
  const fat = Buffer.alloc(112);
  fat.writeUInt32BE(0xcafebabe, 0); fat.writeUInt32BE(2, 4);
  for (const [i, cpu] of [[0, 0x01000007], [1, 0x0100000c]]) {
    const table = 8 + 20 * i; const offset = 48 + 32 * i;
    fat.writeUInt32BE(cpu, table); fat.writeUInt32BE(offset, table + 8); fat.writeUInt32BE(32, table + 12);
    thin(cpu).copy(fat, offset);
  }
  const binary = executable(root, fat);
  assert.deepEqual(Native.resolveLocalRuntime({ runtimePath: binary, ...identity }).architectures, ["x86_64", "arm64"]);
  const x64 = executable(root, thin(0x01000007), "x64");
  assert.equal(Native.resolveLocalRuntime({ runtimePath: x64, ...identity }).needsRosetta, true);
  fat.writeUInt32BE(0x0100000c, 8);
  assert.throws(() => Native.readMachOArchitectures(executable(root, fat)), /mismatch/);
  fat.writeUInt32BE(0xfffffff0, 16);
  assert.throws(() => Native.readMachOArchitectures(executable(root, fat)), /slice/);
});

test("app bundles resolve their executable and native launches preserve literal arguments", { skip: process.platform !== "darwin" }, async t => {
  const root = fixture(t); const app = path.join(root, "Runtime.app");
  const macos = path.join(app, "Contents", "MacOS"); fs.mkdirSync(macos, { recursive: true });
  const binary = executable(macos, thin(process.arch === "x64" ? 0x01000007 : 0x0100000c));
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), '<plist><dict><key>CFBundleExecutable</key><string>runtime</string></dict></plist>');
  const resolved = Native.resolveLocalRuntime({ runtimePath: app, ...identity, arch: process.arch });
  assert.equal(resolved.executablePath, binary);
  const args = ["spaces in path", "$(touch nope)", "`echo nope`"];
  const calls = [];
  const result = await Native.launchLocalRuntime({ runtimePath: app, runtimeVersion: identity.runtimeVersion, upstreamRevision: identity.upstreamRevision,
    args, cwd: root, context: { spawnDetachedChecked: (...input) => { calls.push(input); return "process"; } } });
  assert.equal(result, "process"); assert.deepEqual(calls[0], [binary, args, { cwd: root }, false]);
  await assert.rejects(() => Native.launchLocalRuntime({ runtimePath: app, args: [null], cwd: root }), /arguments/);
});

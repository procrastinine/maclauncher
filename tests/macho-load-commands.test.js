const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const M = require("../src/modules/shared/runtime/macho-load-commands");
const { ARM64, X64, image, universal } = require("./fixtures/macho-image");

test("thin native headers retain CPU, byte order, platform, version and dependency kinds", () => {
  for (const little of [true, false]) for (const cpu of [ARM64, X64, 7]) {
    const input = image({ cpu, little, minimumOS: 0x000d0203,
      dependencies: ["/usr/lib/libSystem.B.dylib", { kind: 0x80000018, path: "/System/Library/Frameworks/AppKit.framework/AppKit" }],
      runPaths: ["@loader_path/../Frameworks"] });
    const result = M.parseMachOLoadCommands(input).slices[0];
    assert.equal(result.cpuType, cpu); assert.equal(result.endianness, little ? "little" : "big");
    assert.equal(result.wordSize, cpu === 7 ? 32 : 64); assert.equal(result.platform, 1);
    assert.equal(result.minimumMacOS, "13.2.3"); assert.equal(result.sdkVersion, "27.0.1");
    assert.equal(result.installName.path, "@rpath/libfixture.dylib");
    assert.deepEqual(result.dependencies.map(item => [item.path, item.kind]), [["/usr/lib/libSystem.B.dylib", "load"],
      ["/System/Library/Frameworks/AppKit.framework/AppKit", "weak"]]);
    assert.deepEqual(result.runPaths, ["@loader_path/../Frameworks"]);
  }
});
test("legacy macOS deployment commands remain distinct from iOS images", () => {
  assert.equal(M.parseMachOLoadCommands(image({ legacyVersion: true, minimumOS: 0x000a0f00 })).slices[0].minimumMacOS, "10.15.0");
  const ios = M.parseMachOLoadCommands(image({ platform: 2 }));
  assert.equal(ios.slices[0].minimumMacOS, null);
  assert.throws(() => M.assertSystemLibraryClosure(ios), { code: "MACHO_PLATFORM" });
  assert.throws(() => M.assertSystemLibraryClosure(M.parseMachOLoadCommands(image({ platform: null }))), { code: "MACHO_PLATFORM" });
});
test("fat32 and fat64 select one exact CPU in both byte orders", () => {
  for (const little of [true, false]) for (const wide of [true, false]) {
    const data = universal([{ cpu: X64, bytes: image({ cpu: X64, minimumOS: 0x000a0f00 }) },
      { cpu: ARM64, bytes: image({ cpu: ARM64 }) }], { little, wide });
    assert.deepEqual(M.parseMachOLoadCommands(data).architectures, ["x86_64", "arm64"]);
    assert.deepEqual(M.parseMachOLoadCommands(data, { architecture: "x64" }).architectures, ["x86_64"]);
    assert.equal(M.parseMachOLoadCommands(data, { architecture: "arm64" }).slices[0].minimumMacOS, "13.0.0");
    assert.throws(() => M.parseMachOLoadCommands(data, { architecture: "i386" }), { code: "MACHO_ARCH" });
  }
  assert.throws(() => M.parseMachOLoadCommands(image(), { architecture: "x64" }), { code: "MACHO_ARCH" });
  assert.throws(() => M.parseMachOLoadCommands(image(), { architecture: "unknown" }), { code: "MACHO_ARCH" });
});
test("universal ranges, alignments, header identities and duplicates fail closed", () => {
  const slices = [{ cpu: X64, bytes: image({ cpu: X64 }) }, { cpu: ARM64, bytes: image() }];
  const good = universal(slices), offset = good.readUInt32BE(8 + 20 + 8);
  for (const mutate of [
    bytes => bytes.writeUInt32BE(28, 8 + 8),
    bytes => bytes.writeUInt32BE(bytes.length, 8 + 12),
    bytes => bytes.writeUInt32BE(53, 8 + 16),
    bytes => bytes.writeUInt32BE(good.readUInt32BE(8 + 8), 8 + 20 + 8),
    bytes => bytes.writeUInt32LE(X64, offset + 4),
  ]) { const bad = Buffer.from(good); mutate(bad); assert.throws(() => M.parseMachOLoadCommands(bad)); }
  assert.throws(() => M.parseMachOLoadCommands(universal([slices[0], slices[0]])), { code: "MACHO_ARCH" });
  const wrongWordSize = image(); wrongWordSize.writeUInt32LE(7, 4);
  assert.throws(() => M.parseMachOLoadCommands(wrongWordSize), { code: "MACHO_ARCH" });
});
test("truncation, count limits and load-command alignment reject unsafe ranges", () => {
  const good = image();
  for (let end = 0; end < good.length; end += 1) assert.throws(() => M.parseMachOLoadCommands(good.subarray(0, end)));
  for (const mutate of [bytes => bytes.writeUInt32LE(M.LIMITS.commands + 1, 16),
    bytes => bytes.writeUInt32LE(M.LIMITS.commandBytes + 1, 20), bytes => bytes.writeUInt32LE(9, 36),
    bytes => bytes.writeUInt32LE(0, 36), bytes => bytes.writeUInt32LE(good.length, 36)]) {
    const bad = Buffer.from(good); mutate(bad); assert.throws(() => M.parseMachOLoadCommands(bad));
  }
});
test("dylib and RPATH strings require bounded offsets, terminators and UTF-8", () => {
  const good = image({ platform: null, dependencies: [], installName: "@rpath/x" });
  for (const mutate of [bytes => bytes.writeUInt32LE(4, 40), bytes => bytes.fill(65, 56),
    bytes => { bytes[56] = 255; }, bytes => { bytes[57] = 10; }, bytes => { bytes[bytes.length - 1] = 99; }]) {
    const bad = Buffer.from(good); mutate(bad); assert.throws(() => M.parseMachOLoadCommands(bad));
  }
  assert.throws(() => M.parseMachOLoadCommands(image({ runPaths: ["x".repeat(M.LIMITS.pathBytes + 1)] })), { code: "MACHO_LIMIT" });
  const toolOverflow = image({ installName: null, dependencies: [] }); toolOverflow.writeUInt32LE(129, 32 + 20);
  assert.throws(() => M.parseMachOLoadCommands(toolOverflow), { code: "MACHO_LIMIT" });
});
test("system-only closure rejects external/relative libraries and disguised system roots", () => {
  const valid = M.parseMachOLoadCommands(image());
  assert.equal(M.assertSystemLibraryClosure(valid, { fileType: 6, installName: "@rpath/libfixture.dylib" }), valid);
  for (const value of ["/opt/homebrew/lib/libSDL.dylib", "@rpath/libSDL.dylib", "relative.dylib", "/usr/lib/../../tmp/evil.dylib"]) {
    assert.throws(() => M.assertSystemLibraryClosure(M.parseMachOLoadCommands(image({ dependencies: [value] }))), { code: "MACHO_CLOSURE" });
  }
  assert.throws(() => M.assertSystemLibraryClosure(valid, { fileType: 2 }), { code: "MACHO_TYPE" });
  assert.throws(() => M.assertSystemLibraryClosure(valid, { installName: "@rpath/another.dylib" }), { code: "MACHO_CLOSURE" });
  assert.throws(() => M.assertSystemLibraryClosure(M.parseMachOLoadCommands(image({ runPaths: ["/opt/homebrew/lib"] }))), { code: "MACHO_CLOSURE" });
  assert.equal(M.assertSystemLibraryClosure(valid, { maximumMacOS: "13" }), valid);
  assert.throws(() => M.assertSystemLibraryClosure(valid, { maximumMacOS: "12.9" }), { code: "MACHO_MACOS_VERSION" });
  assert.throws(() => M.assertSystemLibraryClosure(M.parseMachOLoadCommands(image({ minimumOS: 0 }))), { code: "MACHO_PLATFORM" });
});
test("build-version records must agree and dynamic-loader overrides stay outside a system-only closure", () => {
  const otherPlatform = Buffer.alloc(24); otherPlatform.writeUInt32LE(0x32, 0); otherPlatform.writeUInt32LE(24, 4);
  otherPlatform.writeUInt32LE(2, 8); otherPlatform.writeUInt32LE(0x000d0000, 12);
  assert.throws(() => M.parseMachOLoadCommands(image({ extraCommands: [otherPlatform] })), /Conflicting/);
  const text = Buffer.from("DYLD_LIBRARY_PATH=/tmp/foreign\0"), command = Buffer.alloc(Math.ceil((12 + text.length) / 8) * 8);
  command.writeUInt32LE(0x27, 0); command.writeUInt32LE(command.length, 4); command.writeUInt32LE(12, 8); text.copy(command, 12);
  assert.throws(() => M.assertSystemLibraryClosure(M.parseMachOLoadCommands(image({ extraCommands: [command] }))), { code: "MACHO_CLOSURE" });
});
test("file inspection remains bounded for a large sparse native file and supports cancellation", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-macho-load-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "image.dylib"); fs.writeFileSync(file, image()); fs.truncateSync(file, 1024 * 1024 * 1024);
  const result = M.readMachOLoadCommands(file, { architecture: "arm64" });
  assert.equal(result.slices[0].minimumMacOS, "13.0.0"); assert.ok(result.bytesRead < 1024);
  assert.throws(() => M.readMachOLoadCommands(root), /regular file/);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => M.readMachOLoadCommands(file, { signal: controller.signal }), { code: "ABORT_ERR" });
});

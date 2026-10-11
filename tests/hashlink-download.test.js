const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Download = require("../src/modules/hashlink/runtime/download");

const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const packageProfile = () => ({ schemaVersion: 1, architecture: "x86_64", libraries: {
  std: { sha256: "a".repeat(64), signatures: { sys_exit: "Pi_v" }, unsupported: [] },
  sdl: { sha256: "b".repeat(64), signatures: { event_loop: "PD_b" }, unsupported: [] } } });
function command(kind, text, prefix = 24) {
  const bytes = Buffer.from(text + "\0"), size = Math.ceil((prefix + bytes.length) / 8) * 8, data = Buffer.alloc(size);
  data.writeUInt32LE(kind); data.writeUInt32LE(size, 4); data.writeUInt32LE(prefix, 8); bytes.copy(data, prefix);
  if (prefix === 24) { data.writeUInt32LE(0x020000, 16); data.writeUInt32LE(0x020000, 20); }
  return data;
}
function macho({ type = 6, architecture = "x86_64", floor = 0x0a0d00, dependencies = [], runPaths = [], installName } = {}) {
  const build = Buffer.alloc(24); build.writeUInt32LE(0x32); build.writeUInt32LE(24, 4); build.writeUInt32LE(1, 8); build.writeUInt32LE(floor, 12);
  const commands = [build, ...dependencies.map(value => command(0xc, value)), ...runPaths.map(value => command(0x8000001c, value, 12)),
    ...(installName ? [command(0xd, installName)] : [])];
  const header = Buffer.alloc(32); header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
  header.writeUInt32LE(type, 12); header.writeUInt32LE(commands.length, 16); header.writeUInt32LE(commands.reduce((sum, bytes) => sum + bytes.length, 0), 20);
  return Buffer.concat([header, ...commands]);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hashlink-download-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = path.join(root, "package"); fs.mkdirSync(path.join(payload, "include"), { recursive: true });
  const header = "#define HL_VERSION 0x020000\n";
  fs.writeFileSync(path.join(payload, "include", "hl.h"), header);
  fs.writeFileSync(path.join(payload, "hl"), macho({ type: 2, dependencies: ["@rpath/libhl.2.dylib", "/usr/lib/libSystem.B.dylib"], runPaths: ["@executable_path"] }), { mode: 0o755 });
  fs.writeFileSync(path.join(payload, "libhl.2.0.0.dylib"), macho({ dependencies: ["/usr/lib/libSystem.B.dylib"], installName: "@rpath/libhl.2.dylib" }));
  fs.symlinkSync("libhl.2.0.0.dylib", path.join(payload, "libhl.2.dylib"));
  fs.writeFileSync(path.join(payload, "sdl.hdll"), macho({ dependencies: ["@rpath/libhl.2.dylib"], runPaths: ["@loader_path"] }));
  const pin = { version: "2.0.0-dev-test", upstreamVersion: "2.0.0", minimumMacOS: "10.13.0", sourceMetadata: { headerSha256: digest(header) },
    supportedBytecodeVersions: [2, 3, 4, 5, 6], nativeAbi: { sdlEventLoop: "dynamic" } };
  return { root, payload, pin };
}

test("HashLink validates the native dependency closure and returns exact ABI and file metadata", async t => {
  const { root, payload, pin } = fixture(t), calls = [];
  const metadata = await Download.prepareInstall({ unpacked: root, pin }, {
    inspectMachOExports: async () => ["hl_alloc_obj", "hl_alloc_dynamic", "hlp_event_loop", "hlp_init_once"],
    packageProfile,
    run: async (command, args) => { calls.push([command, args]); }
  });
  assert.equal(metadata.files.length, 3); assert.equal(calls.length, 6); assert.equal(metadata.upstreamVersion, "2.0.0");
  assert.equal(metadata.minimumMacOS, "10.13.0"); assert.equal(metadata.nativeAbi.sdlEventLoop, "dynamic");
  assert.equal(metadata.primitiveProfile.libraries.std.primitives, 1); assert.match(metadata.primitiveProfile.sha256, /^[a-f0-9]{64}$/);
  assert.equal(metadata.aliases.length, 1); assert.equal(Download.resolveExecutable(root), path.join(payload, "hl"));
  Download.verifyInstalled({ source: "download", installDir: root, installationMetadata: metadata });
  fs.appendFileSync(path.join(payload, "sdl.hdll"), "changed");
  assert.throws(() => Download.verifyInstalled({ source: "download", installDir: root, installationMetadata: metadata }), /changed/);
});

test("HashLink rejects missing, foreign or higher-floor native dependencies before signing", async t => {
  for (const replacement of [macho({ architecture: "arm64" }), macho({ floor: 0x0e0000 }),
    macho({ dependencies: ["/opt/homebrew/lib/libSDL2.dylib"] }), macho({ dependencies: ["@rpath/missing.dylib"], runPaths: ["@loader_path"] }),
    macho({ runPaths: ["@loader_path/../../../external"] })]) {
    const { root, payload, pin } = fixture(t); fs.writeFileSync(path.join(payload, "sdl.hdll"), replacement);
    await assert.rejects(Download.prepareInstall({ unpacked: root, pin }, { run: () => assert.fail("Invalid package must not be signed") }), /Intel|platform|library|search path/);
  }
});

test("HashLink source headers, aliases and primitive symbols are validated without executing the VM", async t => {
  const { root, payload, pin } = fixture(t);
  await assert.rejects(Download.prepareInstall({ unpacked: root, pin }, { inspectMachOExports: async () => [], run: () => assert.fail("Missing symbols must block signing") }), /symbols/);
  fs.writeFileSync(path.join(payload, "include", "hl.h"), "different commit");
  assert.throws(() => Download.inspectPackage(root, pin), /header differs/);
  const second = fixture(t); fs.unlinkSync(path.join(second.payload, "libhl.2.dylib"));
  fs.symlinkSync("/usr/lib/libSystem.B.dylib", path.join(second.payload, "libhl.2.dylib"));
  assert.throws(() => Download.inspectPackage(second.root, second.pin), /package|ENOENT/);
});

test("HashLink installed metadata rejects path escapes and missing hashes", async t => {
  const { root, pin } = fixture(t);
  const metadata = await Download.prepareInstall({ unpacked: root, pin }, {
    inspectMachOExports: async () => ["hl_alloc_obj", "hl_alloc_dynamic", "hlp_event_loop", "hlp_init_once"], packageProfile, run: async () => {}
  });
  metadata.files[0].path = "../outside";
  assert.throws(() => Download.verifyInstalled({ source: "download", installDir: root, installationMetadata: metadata }), /invalid path/);
  assert.throws(() => Download.verifyInstalled({ source: "download", installDir: root }), /metadata is missing/);
  assert.doesNotThrow(() => Download.verifyInstalled({ source: "local" }));
});

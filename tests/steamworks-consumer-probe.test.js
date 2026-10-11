const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Probe = require("../src/modules/shared/runtime/steamworks/native-consumer-probe");
const AppId = require("../src/modules/shared/runtime/steamworks/app-id");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steam-consumer-"));
  t.after(() => { Probe.clearProbeCache(); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function pe({ library = "steam_api.dll", symbol = "SteamAPI_Init", delay = false, ordinal = false, x64 = false } = {}) {
  const bytes = Buffer.alloc(4096), optionalSize = x64 ? 240 : 224, optional = 0x80 + 24, directories = optional + (x64 ? 112 : 96);
  bytes.write("MZ"); bytes.writeUInt32LE(0x80, 60); bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(x64 ? 0x8664 : 0x14c, 0x84); bytes.writeUInt16LE(1, 0x86); bytes.writeUInt16LE(optionalSize, 0x94);
  bytes.writeUInt16LE(x64 ? 0x20b : 0x10b, optional);
  if (x64) bytes.writeBigUInt64LE(0x140000000n, optional + 24); else bytes.writeUInt32LE(0x400000, optional + 28);
  bytes.writeUInt32LE(512, optional + 60); bytes.writeUInt32LE(16, directories - 4);
  const section = optional + optionalSize;
  bytes.write(".idata", section); bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(3584, section + 16); bytes.writeUInt32LE(512, section + 20);
  const directory = directories + (delay ? 13 : 1) * 8;
  bytes.writeUInt32LE(0x1000, directory); bytes.writeUInt32LE(delay ? 64 : 40, directory + 4);
  if (delay) {
    bytes.writeUInt32LE(1, 512); bytes.writeUInt32LE(0x1100, 516); bytes.writeUInt32LE(0x1120, 524); bytes.writeUInt32LE(0x1120, 528);
  } else {
    bytes.writeUInt32LE(0x1120, 512); bytes.writeUInt32LE(0x1100, 524); bytes.writeUInt32LE(0x1120, 528);
  }
  bytes.write(library + "\0", 768);
  const value = ordinal ? (1n << BigInt(x64 ? 63 : 31)) | 17n : 0x1140n;
  if (x64) bytes.writeBigUInt64LE(value, 800); else bytes.writeUInt32LE(Number(value), 800);
  bytes.write(symbol + "\0", 834);
  bytes.write("unused steam_api.dll SteamAPI_Init", 1100);
  return bytes;
}
function macho({ architecture = "x86_64", library = "@rpath/libsteam_api.dylib", symbol = "_SteamAPI_Init", ordinal = 1 } = {}) {
  const librarySize = Math.ceil((24 + Buffer.byteLength(library) + 1) / 8) * 8, commandsSize = librarySize + 24;
  const symbolOffset = 32 + commandsSize, stringsOffset = symbolOffset + 16, strings = Buffer.from("\0" + symbol + "\0");
  const bytes = Buffer.alloc(stringsOffset + strings.length);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
  bytes.writeUInt32LE(2, 12); bytes.writeUInt32LE(2, 16); bytes.writeUInt32LE(commandsSize, 20);
  bytes.writeUInt32LE(0xc, 32); bytes.writeUInt32LE(librarySize, 36); bytes.writeUInt32LE(24, 40); bytes.write(library + "\0", 56);
  const table = 32 + librarySize; bytes.writeUInt32LE(2, table); bytes.writeUInt32LE(24, table + 4);
  bytes.writeUInt32LE(symbolOffset, table + 8); bytes.writeUInt32LE(1, table + 12);
  bytes.writeUInt32LE(stringsOffset, table + 16); bytes.writeUInt32LE(strings.length, table + 20);
  bytes.writeUInt32LE(1, symbolOffset); bytes[symbolOffset + 4] = 1; bytes.writeUInt16LE(ordinal << 8, symbolOffset + 6); strings.copy(bytes, stringsOffset);
  return bytes;
}
function fat() {
  const arm = macho({ architecture: "arm64", library: "/usr/lib/libSystem.B.dylib" }), intel = macho();
  const bytes = Buffer.alloc(8192 + intel.length); bytes.writeUInt32BE(0xcafebabe); bytes.writeUInt32BE(2, 4);
  for (const [index, cpu, offset, image] of [[0, 0x0100000c, 4096, arm], [1, 0x01000007, 8192, intel]]) {
    const row = 8 + index * 20; bytes.writeUInt32BE(cpu, row); bytes.writeUInt32BE(offset, row + 8); bytes.writeUInt32BE(image.length, row + 12); bytes.writeUInt32BE(12, row + 16); image.copy(bytes, offset);
  }
  return bytes;
}
function write(root, name, bytes) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; }

test("PE direct and delayed Steam imports retain exact symbols without inferring interface versions", t => {
  const root = temporary(t);
  for (const delay of [false, true]) {
    const file = write(root, delay ? "delayed.dll" : "caller.exe", pe({ delay, x64: delay }));
    const before = fs.readFileSync(file), result = Probe.inspectNativeSteamConsumer(file);
    assert.equal(result.requiresSteamApi, true); assert.deepEqual(result.symbols, ["SteamAPI_Init"]);
    assert.equal(result.architecture, delay ? "x86_64" : "x86"); assert.equal(result.interfacesKnown, false);
    assert.deepEqual(result.interfaces, []); assert.equal(result.evidence[0].kind, delay ? "pe-delay-import" : "pe-import");
    assert.ok(result.bytesRead < 4096); assert.deepEqual(fs.readFileSync(file), before);
  }
});
test("filenames, incidental strings, unrelated imported functions and ordinals do not establish a Steam consumer", t => {
  const root = temporary(t);
  for (const [name, bytes] of [["steam_api.dll", Buffer.from("unused SteamAPI_Init libsteam_api.dylib")],
    ["unrelated.dll", pe({ library: "other.dll" })], ["wrong-symbol.dll", pe({ symbol: "Other_Init" })], ["ordinal.dll", pe({ ordinal: true })]]) {
    assert.equal(Probe.inspectNativeSteamConsumer(write(root, name, bytes)).requiresSteamApi, false);
  }
});
test("Mach-O loader dependencies and bound undefined symbols are inspected within the requested slice", t => {
  const root = temporary(t), thin = Probe.inspectNativeSteamConsumer(write(root, "caller", macho()));
  assert.equal(thin.requiresSteamApi, true); assert.deepEqual(thin.symbols, ["_SteamAPI_Init"]);
  const universal = write(root, "universal", fat());
  const arm = Probe.inspectNativeSteamConsumer(universal, { architecture: "arm64" });
  assert.equal(arm.requiresSteamApi, false); assert.deepEqual(arm.architectures, ["arm64", "x86_64"]);
  const intel = Probe.inspectNativeSteamConsumer(universal, { architecture: "x64" });
  assert.equal(intel.requiresSteamApi, true); assert.equal(intel.architecture, "x86_64");
  assert.throws(() => Probe.inspectNativeSteamConsumer(universal, { architecture: "x86" }), /requested CPU slice/);
  const wrong = Probe.inspectNativeSteamConsumer(write(root, "other", macho({ library: "/usr/lib/libSystem.B.dylib" })));
  assert.equal(wrong.requiresSteamApi, false);
});
test("malformed import addresses, unterminated descriptors, symbol bounds and read budgets fail explicitly", t => {
  const root = temporary(t), bad = pe(); bad.writeUInt32LE(0xffffffff, 524);
  assert.throws(() => Probe.inspectNativeSteamConsumer(write(root, "bad-pe", bad)), /outside a file-backed section/);
  const unclosed = pe(); unclosed.writeUInt32LE(20, 0x80 + 24 + 96 + 12);
  assert.throws(() => Probe.inspectNativeSteamConsumer(write(root, "unclosed", unclosed)), /bounded terminator/);
  const bounds = macho(), librarySize = bounds.readUInt32LE(36), table = 32 + librarySize; bounds.writeUInt32LE(0xfffffff0, table + 8);
  assert.throws(() => Probe.inspectNativeSteamConsumer(write(root, "bad-macho", bounds)), /slice bounds/);
  const universal = write(root, "budget", fat());
  assert.throws(() => Probe.inspectNativeSteamConsumer(universal, { maxReadBytes: 4096 - 1 }), /bounded read budget/);
  const huge = Buffer.alloc(8192), fixture = macho(); fixture.copy(huge); huge.writeUInt32LE(4096, 20);
  assert.throws(() => Probe.inspectNativeSteamConsumer(write(root, "huge-commands", huge), { maxReadBytes: 4096 }), error => error.code === "STEAM_PROBE_LIMIT");
});
test("cached import observations cannot be mutated by a caller and invalidate after source changes", t => {
  const root = temporary(t), file = write(root, "cached.exe", pe());
  const first = Probe.inspectNativeSteamConsumer(file); first.symbols[0] = "Changed"; first.steamDependencies.length = 0;
  assert.deepEqual(Probe.inspectNativeSteamConsumer(file).symbols, ["SteamAPI_Init"]);
  write(root, "cached.exe", pe({ library: "other.dll" }));
  assert.equal(Probe.inspectNativeSteamConsumer(file).requiresSteamApi, false);
});

test("AppID discovery reads explicit original-game metadata and preserves it", t => {
  const root = temporary(t), file = write(root, "steam_appid.txt", "105600\n"), before = fs.readFileSync(file);
  const result = AppId.readGameAppId({ gameRoot: root });
  assert.equal(result.value, 105600); assert.equal(result.status, "found"); assert.equal(result.evidence[0].kind, "steam-appid-file");
  assert.deepEqual(fs.readFileSync(file), before);
  write(root, "data/steam_appid.txt", "105600");
  assert.equal(AppId.readGameAppId({ gameRoot: root, extraRoots: [path.join(root, "data")] }).value, 105600);
  write(root, "data/steam_appid.txt", "480");
  const conflict = AppId.readGameAppId({ gameRoot: root, extraRoots: [path.join(root, "data")] });
  assert.equal(conflict.status, "conflict"); assert.equal(conflict.value, null);
});
test("known INI schemas and historical GEN8 metadata produce IDs without reading arbitrary numbers", t => {
  const root = temporary(t); write(root, "SmartSteamEmu.ini", "[Other]\nAppId=480\n[SmartSteamEmu]\nAppId = 303310\n");
  assert.equal(AppId.readGameAppId({ gameRoot: root }).value, 303310);
  fs.rmSync(path.join(root, "SmartSteamEmu.ini")); write(root, "game.lua", "steam.apps.isDlcInstalled(3498040)");
  write(root, "steam_api.dll", "appid 480");
  assert.equal(AppId.readGameAppId({ gameRoot: root }).status, "missing");
  const gen8 = AppId.readGameAppId({ gameRoot: root, gen8SteamAppId: -391540 });
  assert.equal(gen8.value, 391540); assert.equal(gen8.evidence[0].rawSignedValue, -391540);
  assert.equal(AppId.readGameAppId({ gameRoot: root, gen8SteamAppId: 0 }).status, "missing");
  assert.equal(AppId.readGameAppId({ gameRoot: root, gen8SteamAppId: "391540" }).status, "invalid");
});
test("explicit Steam manifests require scoped paths and matching filename/metadata IDs", t => {
  const root = temporary(t), manifest = write(root, "appmanifest_480.acf", '"AppState" { "appid" "480" "installdir" "Example" }');
  const result = AppId.readGameAppId({ gameRoot: root, appManifestPath: manifest, manifestRoot: root });
  assert.equal(result.value, 480); assert.equal(result.evidence[0].kind, "steam-appmanifest");
  write(root, "appmanifest_480.acf", '"AppState" { "appid" "481" }');
  assert.equal(AppId.readGameAppId({ gameRoot: root, appManifestPath: manifest, manifestRoot: root }).status, "invalid");
  assert.throws(() => AppId.parseAppManifest('"AppState" { "appid" "480" "appid" "481" }'), /duplicate field/);
  assert.throws(() => AppId.parseAppManifest('"AppState" { "appid" "480"'), /Truncated/);
  assert.throws(() => AppId.readGameAppId({ gameRoot: root, appManifestPath: manifest }), /explicitly scoped/);
});
test("invalid, oversized, symlinked or outside-root metadata is never guessed as an identity", t => {
  const root = temporary(t), outside = temporary(t);
  for (const text of ["0", "-1", "4294967296", "480\n481", "ID:480", "x".repeat(65537)]) {
    write(root, "steam_appid.txt", text); assert.equal(AppId.readGameAppId({ gameRoot: root }).status, "invalid");
  }
  fs.rmSync(path.join(root, "steam_appid.txt")); fs.symlinkSync(write(outside, "id.txt", "480"), path.join(root, "steam_appid.txt"));
  assert.equal(AppId.readGameAppId({ gameRoot: root }).value, null);
  assert.throws(() => AppId.readGameAppId({ gameRoot: root, extraRoots: [outside] }), /inside the original game root/);
  write(root, "SmartSteamEmu.ini", "[Steam]\nAppId=480\n"); assert.equal(AppId.readGameAppId({ gameRoot: root }).value, null);
});

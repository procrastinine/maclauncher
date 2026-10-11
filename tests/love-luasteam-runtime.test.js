const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const Consumer = require("../src/modules/love/runtime/luasteam-consumer");
const Bridge = require("../src/modules/love/runtime/luasteam-runtime");
const Manager = require("../src/modules/love/runtime/love-runtime-manager");
const Detect = require("../src/modules/love/detect");
const Probe = require("../src/modules/shared/runtime/steamworks/native-consumer-probe");
const Overlay = require("../src/modules/love/runtime/luasteam-source-overlay");
const Package = require("../src/modules/love/runtime/luasteam-package");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "love-steam-runtime-")));
  t.after(() => { Probe.clearProbeCache(); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function write(file, bytes, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { mode }); return file;
}
function steamConsumer(library = "steam_api64.dll") {
  const bytes = Buffer.alloc(4096), optional = 0x98, directories = optional + 112, section = optional + 240;
  bytes.write("MZ"); bytes.writeUInt32LE(0x80, 60); bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(0x8664, 0x84); bytes.writeUInt16LE(1, 0x86); bytes.writeUInt16LE(240, 0x94);
  bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(512, optional + 60); bytes.writeUInt32LE(16, directories - 4);
  bytes.write(".idata", section); bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(3584, section + 16); bytes.writeUInt32LE(512, section + 20);
  bytes.writeUInt32LE(0x1000, directories + 8); bytes.writeUInt32LE(40, directories + 12);
  bytes.writeUInt32LE(0x1120, 512); bytes.writeUInt32LE(0x1100, 524); bytes.writeUInt32LE(0x1120, 528);
  bytes.write(library + "\0", 768); bytes.writeBigUInt64LE(0x1140n, 800); bytes.write("SteamAPI_Init\0", 834); return bytes;
}
function game(root, source = 'local steam = require("luasteam")\nsteam.init()\n') {
  const directory = path.join(root, "original"); write(path.join(directory, "main.lua"), source);
  write(path.join(directory, "luasteam.dll"), steamConsumer());
  return { gameId: "love-original", gamePath: directory, moduleData: { sourceKind: "source-dir", launchTargetPath: directory } };
}
function zip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), bytes = Buffer.from(entry.bytes), compressed = entry.deflate ? zlib.deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30), central = Buffer.alloc(46); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.declaredSize ?? bytes.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(entry.declaredSize ?? bytes.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed); centrals.push(central, name); offset += 30 + name.length + compressed.length;
  }
  const footer = Buffer.alloc(22); footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(entries.length, 10);
  footer.writeUInt32LE(centrals.reduce((sum, bytes) => sum + bytes.length, 0), 12); footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, footer]);
}
function bundleFixture(t, root) {
  const original = { ...Bridge.Catalog[0] }, pin = Bridge.Catalog[0]; t.after(() => Object.assign(pin, original));
  const bytes = Buffer.alloc(8192 + 32); bytes.writeUInt32BE(0xcafebabe); bytes.writeUInt32BE(2, 4);
  for (const [index, cpu, offset] of [[0, 0x0100000c, 4096], [1, 0x01000007, 8192]]) {
    const row = 8 + index * 20; bytes.writeUInt32BE(cpu, row); bytes.writeUInt32BE(offset, row + 8); bytes.writeUInt32BE(32, row + 12);
    bytes.writeUInt32LE(0xfeedfacf, offset); bytes.writeUInt32LE(cpu, offset + 4); bytes.writeUInt32LE(6, offset + 12);
  }
  const directory = path.join(root, "resources/native-runtimes/love-luasteam", pin.version, "universal");
  write(path.join(directory, "luasteam.so"), bytes, 0o755);
  const record = { id: "love-luasteam", version: pin.version, sourceRevision: pin.sourceRevision,
    librarySha256: digest(bytes), abiProfile: pin.abiProfile, hostLuaAbi: "Lua 5.1 C API",
    files: [{ path: "luasteam.so", size: bytes.length, sha256: digest(bytes), mode: 0o755, architectures: ["arm64", "x86_64"] }] };
  const manifest = Buffer.from(JSON.stringify(record)); write(path.join(directory, "helper.json"), manifest);
  Object.assign(pin, { librarySha256: digest(bytes), manifestSha256: digest(manifest) });
  return { resourcesRoot: path.join(root, "resources"), directory, pin };
}

test("Lua source inspection distinguishes required calls, optional pcall and inert examples", () => {
  assert.deepEqual(Consumer.analyzeSource('local ok, steam = pcall(require, "luasteam")\nif ok then steam.init() end'), { required: false, optional: true, apiStyle: null });
  const examples = '--[=[ local steam = require("luasteam"); steam.init() ]=]\nlocal example = [[local steam = require("luasteam"); steam.init()]]\nlocal text = \'steam = require("luasteam")\'';
  assert.equal(Consumer.analyzeSource(examples).required, false);
  assert.equal(Consumer.analyzeSource('local steam=require "luasteam"; steam.Init()').apiStyle, "PascalCase");
  const mixed = 'pcall(require,"luasteam"); local steam=require("luasteam"); steam.init()';
  assert.equal(Consumer.analyzeSource(mixed).required, true);
  assert.equal(Consumer.analyzeSource(mixed).apiStyle, "lowercase");
});
test("fused archive source reads reject duplicate scripts, compiled Lua, oversized and falsely declared output", t => {
  const root = temporary(t), read = entries => Detect.readArchiveText(write(path.join(root, "game.exe"), Buffer.concat([Buffer.from("MZ"), zip(entries)])), "main.lua", 64);
  assert.equal(read([{ name: "main.lua", bytes: "return 1", deflate: true }]), "return 1");
  assert.equal(read([{ name: "main.lua", bytes: "one" }, { name: "main.lua", bytes: "two" }]), null);
  assert.equal(read([{ name: "main.lua", bytes: Buffer.from([0x1b, 0x4c, 0x4a, 0]) }]), null);
  assert.equal(read([{ name: "main.lua", bytes: "x".repeat(1024), deflate: true, declaredSize: 32 }]), null);
  assert.equal(read([{ name: "main.lua", bytes: "x".repeat(65), deflate: true }]), null);
});
test("positive original imports are cached and source or native changes invalidate the cached evidence", t => {
  const root = temporary(t), entry = game(root), source = path.join(entry.gamePath, "main.lua");
  const first = Consumer.inspect(entry); assert.equal(first.required, true); assert.equal(first.consumers.length, 1);
  assert.equal(Consumer.inspect(entry), first);
  assert.throws(() => Consumer.requiredIdentity(entry), { code: "STEAM_API_APP_ID_REQUIRED" });
  write(path.join(entry.gamePath, "steam_appid.txt"), "480\n"); assert.equal(Consumer.requiredIdentity(entry).appId.value, 480);
  write(path.join(entry.gamePath, "luasteam.dll"), steamConsumer("other.dll"));
  assert.notEqual(Consumer.inspect(entry), first); assert.throws(() => Consumer.requiredIdentity(entry), { code: "LUA_STEAM_ABI_UNVERIFIED" });
  write(source, 'local ok, steam=pcall(require,"luasteam")\n'); assert.equal(Consumer.requiredIdentity(entry), null);
});
test("optional code and loose Steam filenames perform no prerequisite setup", async t => {
  const root = temporary(t), entry = game(root, 'local ok,steam=pcall(require,"luasteam"); if ok then steam.init() end');
  let prepared = false;
  const result = await Bridge.prepareLaunchEnvironment(entry, { prepareSteamApi() { prepared = true; throw new Error("unexpected"); } }, {});
  assert.equal(result, null); assert.equal(prepared, false); assert.equal(entry.moduleData.luaSteamEvidence.consumers.length, 0);
  const fake = game(root); write(path.join(fake.gamePath, "luasteam.dll"), "steam_api64.dll SteamAPI_Init");
  assert.throws(() => Consumer.requiredIdentity(fake), { code: "LUA_STEAM_ABI_UNVERIFIED" });
});
test("Included bridge launch verifies complete bytes and the selected Lua ABI before Steam preparation", async t => {
  const root = temporary(t), entry = game(root), fixture = bundleFixture(t, root); write(path.join(entry.gamePath, "steam_appid.txt"), "480");
  const app = path.join(root, "selected.app"), header = path.join(app, "Contents/Frameworks/Lua.framework/Versions/A/Headers/lua.h");
  write(header, "#define LUA_VERSION_NUM 504\n"); let prepared = 0;
  const context = { resourcesRoot: fixture.resourcesRoot, userDataDir: path.join(root, "data"), settings: {}, prepareSteamApi: async () => { prepared++; } };
  await assert.rejects(Bridge.prepareLaunchEnvironment(entry, context, { install: { appPath: app } }), /Lua 5.1/); assert.equal(prepared, 0);
  write(header, "#define LUA_VERSION_NUM 501\n"); fs.appendFileSync(path.join(fixture.directory, "luasteam.so"), "changed");
  await assert.rejects(Bridge.prepareLaunchEnvironment(entry, context, { install: { appPath: app } }), /limit|checksum|changed/); assert.equal(prepared, 0);
});
test("launch bindings use per-game symlinks, preserve host selection and never modify parent environment or originals", async t => {
  const root = temporary(t), entry = game(root), fixture = bundleFixture(t, root); write(path.join(entry.gamePath, "steam_appid.txt"), "480");
  const app = path.join(root, "explicit-selected.app"); write(path.join(app, "Contents/Frameworks/Lua.framework/Versions/A/Headers/lua.h"), "#define LUA_VERSION_NUM 501\n");
  const steamLibrary = write(path.join(root, "shared/libsteam_api.dylib"), "sealed API"), base = { PATH: "fixed", LUA_CPATH: "/user/?.so;;" }, before = fs.readFileSync(path.join(entry.gamePath, "main.lua"));
  let received;
  const context = { resourcesRoot: fixture.resourcesRoot, userDataDir: path.join(root, "data"), settings: {}, prepareSteamApi: async (request, options) => {
    received = request; assert.equal(options.baseEnvironment, base);
    return { libraryPath: steamLibrary, identity: "same API", environment: { ...base, DYLD_LIBRARY_PATH: path.dirname(steamLibrary) } };
  } };
  const result = await Bridge.prepareLaunchEnvironment(entry, context, { install: { appPath: app, requiresRosetta: true } }, base);
  assert.equal(received.arch, "x86_64"); assert.equal(received.abiProfile, fixture.pin.helperAbiProfile); assert.equal(received.version, fixture.pin.helperVersion);
  assert.notEqual(received.abiProfile, fixture.pin.abiProfile); assert.equal(received.appId, 480);
  const aliases = path.dirname(result.environment.LUA_CPATH.split(";")[0]);
  assert.ok(aliases.startsWith(path.join(root, "data/games", entry.gameId))); assert.equal(fs.readdirSync(aliases).length, 2);
  assert.equal(fs.readlinkSync(path.join(aliases, "luasteam.so")), path.join(fixture.directory, "luasteam.so"));
  assert.equal(fs.readlinkSync(path.join(aliases, "libsteam_api.dylib")), steamLibrary);
  assert.equal(result.environment.LUA_CPATH.endsWith(base.LUA_CPATH), true); assert.deepEqual(base, { PATH: "fixed", LUA_CPATH: "/user/?.so;;" });
  assert.deepEqual(fs.readFileSync(path.join(entry.gamePath, "main.lua")), before);
  const second = await Bridge.prepareLaunchEnvironment(entry, context, { install: { appPath: app } }, base); assert.equal(second.environment.LUA_CPATH, result.environment.LUA_CPATH);
  fs.rmSync(path.join(aliases, "luasteam.so")); fs.symlinkSync(steamLibrary, path.join(aliases, "luasteam.so"));
  await assert.rejects(Bridge.prepareLaunchEnvironment(entry, context, { install: { appPath: app } }, base), /aliases changed/);
});
test("LuaSteam selection and refresh cannot change explicit LÖVE release or nightly defaults", async t => {
  const root = temporary(t), fixture = bundleFixture(t, root), original = { stable: { defaultVersion: "11.5" }, nightly: { defaultVersion: "exact-nightly" } };
  const settings = Manager.applySettingsUpdate("setDefault", { sectionId: "luasteam", version: fixture.pin.version }, original);
  assert.deepEqual(settings.stable, original.stable); assert.deepEqual(settings.nightly, original.nightly);
  assert.equal(settings.luasteam.defaultVersion, fixture.pin.version);
  assert.throws(() => Manager.applySettingsUpdate("setDefault", { sectionId: "luasteam", version: "newest" }, settings), /explicitly listed/);
  assert.equal((await Manager.refreshCatalog({ sectionId: "luasteam", force: true })).source, "Included with MacLauncher");
  const installed = await Manager.installRuntime({ sectionId: "luasteam", version: fixture.pin.version, resourcesRoot: fixture.resourcesRoot });
  assert.equal(installed.installDir, fixture.directory); assert.equal(installed.bundledExecution, "direct"); assert.equal(installed.removable, false);
});
test("the source archive allowlist excludes proprietary SDK bytes and binaries", async t => {
  const root = temporary(t), inputs = [...Overlay.INPUTS]; t.after(() => Overlay.INPUTS.splice(0, Overlay.INPUTS.length, ...inputs));
  const sourceRoot = path.join(root, "source"), bytes = Buffer.from("MIT fixture source\n");
  Overlay.INPUTS.splice(0, Overlay.INPUTS.length, { origin: "luasteam", path: "source.cpp", destination: "src/source.cpp", size: bytes.length, sha256: digest(bytes) },
    { origin: "steamSdk", path: "sdk.h", destination: "sdk/proprietary.h", size: 20, sha256: "0".repeat(64) });
  write(path.join(sourceRoot, "src/source.cpp"), bytes); write(path.join(sourceRoot, "sdk/proprietary.h"), "must not be archived");
  write(path.join(sourceRoot, "sdk/libsdkencryptedappticket.dylib"), "must not be archived either");
  const destination = path.join(root, "source.tar.gz"); await Package.createSourceArchive({ sourceRoot, destination });
  const names = execFileSync("/usr/bin/tar", ["-tzf", destination], { encoding: "utf8" });
  assert.match(names, /src\/source.cpp/); assert.match(names, /luasteam-build.js/); assert.doesNotMatch(names, /sdk\/|\.dylib|Readme\.txt/);
  const tar = zlib.gunzipSync(fs.readFileSync(destination));
  for (let offset = 0; offset < tar.length && tar[offset];) {
    const header = tar.subarray(offset, offset + 512), octal = (start, size) => parseInt(header.toString("ascii", start, start + size).replace(/\0/g, "").trim() || "0", 8);
    assert.equal(octal(108, 8), 0); assert.equal(octal(116, 8), 0); assert.equal(octal(136, 12), 0);
    assert.ok(["root", "", "0"].includes(header.toString("ascii", 265, 297).replace(/\0/g, "")));
    assert.ok(["wheel", "", "0"].includes(header.toString("ascii", 297, 329).replace(/\0/g, "")));
    offset += 512 + Math.ceil(octal(124, 12) / 512) * 512;
  }
});

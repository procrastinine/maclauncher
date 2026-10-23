const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("../src/modules/hashlink/main");
const { inspectBytecode } = require("../src/modules/hashlink/bytecode");
const { nativeLibrary } = require("./helpers/hashlink-native");

// Serialized metadata fixture; these are not executable function bodies.
function bytecode(libraries = ["std"], version = 5, { name = "native_function", argumentKind } = {}) {
  const strings = [...libraries, name];
  const raw = Buffer.from(strings.map(value => value + "\0").join(""));
  const size = Buffer.alloc(4); size.writeInt32LE(raw.length);
  const header = [72, 76, 66, version, 0, 0, 0, strings.length];
  if (version >= 5) header.push(0);
  header.push(argumentKind === undefined ? 2 : argumentKind === 11 ? 5 : argumentKind === 9 ? 4 : 3, 0, libraries.length, 1);
  if (version >= 4) header.push(0);
  header.push(0);
  const pieces = [Buffer.from(header), size, raw, Buffer.from(strings.map(value => Buffer.byteLength(value)))];
  if (version >= 5) pieces.push(Buffer.alloc(4));
  pieces.push(Buffer.from(argumentKind === undefined ? [0, 10, 0, 0]
    : argumentKind === 11 ? [0, 10, 1, 2, 4, 11, strings.length - 1, 160, 1, 0, 13, 0, 0,
      ...Array.from({ length: 13 }, (_, i) => [strings.length - 1, i === 9 ? 4 : 3]).flat(), 3, 7]
    : argumentKind === 9 ? [0, 10, 1, 2, 3, 9, 7] : [0, 10, 1, 2, 0, argumentKind]));
  for (let i = 0; i < libraries.length; i += 1) pieces.push(Buffer.from([i, strings.length - 1, 1, i + 1]));
  return Buffer.concat(pieces);
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hashlink-module-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function machO(architecture, fileType = 2) {
  const data = Buffer.alloc(32); data.writeUInt32LE(0xfeedfacf);
  data.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4); data.writeUInt32LE(fileType, 12);
  return data;
}
function mp3Bytecode(legacy = true) {
  const strings = ["fmt", "mp3_open", "fmt_mp3"], raw = Buffer.from(strings.map(value => value + "\0").join(""));
  const length = Buffer.alloc(4); length.writeInt32LE(raw.length);
  const types = [8, 3, 17, 2, 10, ...(legacy ? [2, 0, 1] : [0]), 2];
  return Buffer.concat([Buffer.from([72, 76, 66, 5, 0, 0, 0, 3, 0, 4, 0, 1, 1, 0, 0]), length, raw,
    Buffer.from(strings.map(value => Buffer.byteLength(value))), Buffer.alloc(4), Buffer.from(types), Buffer.from([0, 1, 3, 1])]);
}

function universalVm() {
  const data = Buffer.alloc(112); data.writeUInt32BE(0xcafebabe); data.writeUInt32BE(2, 4);
  for (const [i, architecture] of ["arm64", "x86_64"].entries()) {
    const slice = machO(architecture), offset = 48 + i * 32, table = 8 + i * 20;
    data.writeUInt32BE(slice.readUInt32LE(4), table); data.writeUInt32BE(offset, table + 8); data.writeUInt32BE(32, table + 12); slice.copy(data, offset);
  }
  return data;
}

test("HashLink inspects versions 2–6 and native import tables without executing code", () => {
  for (let version = 2; version <= 6; version += 1) {
    const parsed = inspectBytecode(bytecode(["std", "sdl", "?optional"], version));
    assert.equal(parsed.version, version);
    assert.deepEqual(parsed.nativeLibraries, ["std", "sdl", "?optional"]);
    assert.equal(parsed.inspectionScope, "metadata-and-native-imports");
  }
  const unknown = bytecode(); unknown[3] = 7;
  assert.throws(() => inspectBytecode(unknown), /Unsupported/);
  const invalid = bytecode(); invalid[7] = 127;
  assert.throws(() => inspectBytecode(invalid), /HashLink/);
  assert.throws(() => inspectBytecode(bytecode().subarray(0, 20)), /Truncated/);
});

test("HashLink detection validates bytecode signatures and keeps ambiguous .hl folders unknown", t => {
  const root = temporary(t), boot = path.join(root, "hlboot.dat");
  fs.writeFileSync(boot, "not bytecode");
  assert.equal(Module.detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) }), null);
  fs.writeFileSync(boot, bytecode());
  const detected = Module.detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) });
  assert.equal(detected.moduleData.bytecodePath, boot);
  const future = bytecode(); future[3] = 7; fs.writeFileSync(boot, future);
  const unsupported = Module.detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) });
  assert.equal(unsupported.moduleData.detectedVersion, "7");
  assert.equal(unsupported.moduleData.compatibility, "unsupported-bytecode-version");
  fs.rmSync(boot);
  fs.writeFileSync(path.join(root, "one.hl"), bytecode());
  fs.writeFileSync(path.join(root, "two.hl"), bytecode());
  assert.equal(Module.detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) }), null);
  assert.ok(Module.detectGame({ inputPath: path.join(root, "one.hl"), rootDir: root, stat: fs.statSync(path.join(root, "one.hl")) }));
});

test("HashLink preflight rejects Windows/mismatched native modules and preserves optional imports", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), runtime = path.join(root, "runtime"), game = path.join(root, "game");
  fs.mkdirSync(runtime); fs.mkdirSync(game);
  const executable = path.join(runtime, "hl");
  fs.writeFileSync(executable, machO("x86_64"), { mode: 0o755 });
  fs.writeFileSync(path.join(runtime, "libhl.dylib"), nativeLibrary());
  const manager = Module.runtimeManagers[0];
  manager.core.registerLocal({ userDataDir: root, version: "1.16", runtimePath: executable });
  const boot = path.join(game, "hlboot.dat"); fs.writeFileSync(boot, bytecode(["std", "sdl", "?optional"]));
  const entry = { gamePath: game, moduleData: { bytecodePath: boot } };
  const context = { userDataDir: root, settings: { runtimes: { hashlink: { defaultVersion: "1.16" } } } };
  assert.deepEqual(Module.__test.inspectDependencies(entry, context).missingLibraries, ["sdl"]);
  fs.writeFileSync(path.join(runtime, "sdl.hdll"), "MZwindows-module");
  assert.deepEqual(Module.__test.inspectDependencies(entry, context).incompatibleLibraries, ["sdl"]);
  fs.writeFileSync(path.join(runtime, "sdl.hdll"), machO("arm64", 6));
  assert.equal(Module.__test.inspectDependencies(entry, context).ready, false);
  fs.writeFileSync(path.join(runtime, "sdl.hdll"), nativeLibrary());
  assert.equal(Module.__test.inspectDependencies(entry, context).ready, true);
});

test("HashLink reads original bytecode and isolates relative writes with explicit dylib search and arguments", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), executable = path.join(root, "hl"), game = path.join(root, "source"), userDataDir = path.join(root, "managed");
  fs.mkdirSync(game);
  const boot = path.join(game, "game.hl");
  fs.writeFileSync(path.join(root, "libhl.dylib"), nativeLibrary());
  fs.writeFileSync(executable, machO("x86_64"), { mode: 0o755 }); fs.writeFileSync(boot, bytecode());
  Module.runtimeManagers[0].core.registerLocal({ userDataDir, version: "1.16", runtimePath: executable });
  let call;
  await Module.launchRuntime("hashlink", { gameId: "launch", moduleData: { bytecodePath: boot }, runtimeData: { hashlink: { version: "1.16" } } }, { settings: {}, userDataDir,
    gameArguments: ["--title", "A quoted game", "", "$(literal)"],
    runtimeSettings: { appArgs: ["literal argument"] }, spawnDetachedChecked: async (...args) => { call = args; return {}; } });
  assert.equal(call[0], executable); assert.equal(path.basename(call[1][0]), "game.hl"); assert.equal(call[1][1], "literal argument");
  assert.deepEqual(call[1].slice(2), ["--title", "A quoted game", "", "$(literal)"]);
  assert.equal(call[1][0], boot); assert.notEqual(call[2].cwd, path.dirname(boot));
  assert.equal(call[2].env.DYLD_LIBRARY_PATH, [root, game].join(path.delimiter));
  fs.writeFileSync(path.join(call[2].cwd, "player-save.json"), "keep player save");
  assert.deepEqual(fs.readFileSync(boot), bytecode());
  const again = Module.__test.prepareLaunch({ gameId: "launch", moduleData: { bytecodePath: boot } }, { userDataDir });
  assert.equal(fs.readFileSync(path.join(again.wrapper, "player-save.json"), "utf8"), "keep player save");
  fs.writeFileSync(boot, bytecode(["std"], 4));
  assert.throws(() => Module.__test.prepareLaunch({ gameId: "launch", moduleData: { bytecodePath: boot } }, { userDataDir }), /bytecode changed/);
});

test("HashLink identifies native SDL ABI independently of the shared bytecode format", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), executable = path.join(root, "hl"), boot = path.join(root, "game.hl");
  fs.writeFileSync(executable, machO("x86_64"), { mode: 0o755 });
  Module.runtimeManagers[0].core.registerLocal({ userDataDir: root, version: "1.16", runtimePath: executable });
  const typed = bytecode(["sdl"], 5, { name: "event_loop", argumentKind: 11 });
  const dynamic = bytecode(["sdl"], 5, { name: "event_loop", argumentKind: 9 });
  assert.equal(inspectBytecode(typed).version, inspectBytecode(dynamic).version);
  assert.equal(inspectBytecode(typed).nativeAbi.sdlEventLoop, "typed-event");
  assert.equal(inspectBytecode(dynamic).nativeAbi.sdlEventLoop, "dynamic");
  assert.equal(inspectBytecode(typed).natives[0].signature, "POiiiiiiiiibiii__b");
  assert.equal(inspectBytecode(dynamic).natives[0].signature, "PD_b");
  const entry = { moduleData: { bytecodePath: boot }, runtimeData: { hashlink: { version: "1.16" } } };
  fs.writeFileSync(boot, typed);
  assert.throws(() => Module.__test.inspectDependencies(entry, { userDataDir: root, settings: {} }), /native ABI mismatch.*typed-event.*1\.16/);
  fs.writeFileSync(boot, dynamic);
  assert.deepEqual(Module.__test.inspectDependencies(entry, { userDataDir: root, settings: {} }).missingLibraries, ["sdl"]);
});

test("HashLink legacy fmt selects its complete family and incompatible explicit versions never download", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), boot = path.join(root, "game.hl"), userDataDir = path.join(root, "data");
  const Catalog = require("../src/modules/hashlink/runtime/catalog");
  fs.writeFileSync(boot, mp3Bytecode(true));
  assert.equal(inspectBytecode(fs.readFileSync(boot)).natives[0].signature, "PBi_Xfmt_mp3_");
  const entry = { moduleData: { bytecodePath: boot } }, context = { userDataDir, settings: {} };
  const requirement = Module.ensureRuntime(entry, context);
  assert.equal(entry.runtimeData.hashlink.version, "1.12-macos-v1");
  if (Module.runtimeManagers[0].resolveSelection(entry, {}, userDataDir).ready) assert.equal(requirement, null);
  else assert.deepEqual(requirement, { managerId: "hashlink", version: "1.12-macos-v1", installOptions: {} });
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes")), false);
  const incompatible = { moduleData: { bytecodePath: boot }, runtimeData: { hashlink: { version: Catalog.SNAPSHOT_VERSION } } };
  assert.throws(() => Module.ensureRuntime(incompatible, { ...context,
    onEntryChange: () => assert.fail("Explicit versions must not change") }), /incompatible fmt@mp3_open signature/);
  assert.equal(incompatible.runtimeData.hashlink.version, Catalog.SNAPSHOT_VERSION);
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes")), false);
  fs.writeFileSync(boot, mp3Bytecode(false));
  assert.equal(inspectBytecode(fs.readFileSync(boot)).natives[0].signature, "P_Xfmt_mp3_");
  const modern = { moduleData: { bytecodePath: boot } };
  assert.deepEqual(Module.ensureRuntime(modern, context), { managerId: "hashlink", version: Catalog.SNAPSHOT_VERSION, installOptions: {} });
});

test("HashLink Play selects the exact Mac graphics package without inventing an upstream version", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), boot = path.join(root, "hlboot.dat");
  fs.writeFileSync(boot, bytecode(["sdl"], 5, { name: "event_loop", argumentKind: 11 }));
  const entry = { moduleData: { bytecodePath: boot } };
  let changes = 0;
  const context = { userDataDir: path.join(root, "data"), settings: {}, onEntryChange: () => changes++ };
  const requirement = Module.ensureRuntime(entry, context);
  const selected = Module.runtimeManagers[0].resolveSelection(entry, context.settings, context.userDataDir);
  if (selected.ready) {
    assert.equal(requirement, null, "a verified included graphics package needs no installation");
    assert.equal(selected.install.bundledExecution, "direct");
    assert.equal(selected.install.removable, false);
    assert.equal(fs.existsSync(path.join(context.userDataDir, "runtimes")), false);
  } else assert.deepEqual(requirement, { managerId: "hashlink", version: "1.9-macos-v2", installOptions: {} });
  assert.equal(entry.runtimeData.hashlink.version, "1.9-macos-v2"); assert.equal(changes, 1);
  const pin = Module.runtimeManagers[0].core.catalog.find(pin => pin.version === entry.runtimeData.hashlink.version);
  assert.equal(pin.upstreamVersion, "1.9");
  assert.equal(pin.upstreamRevision, "4a4cfe91f3388a0b05bf2e45e7c4e38bae686dc6");
  assert.equal(pin.nativeAbi.sdlEventLoop, "typed-event");
  entry.runtimeData.hashlink.version = "1.16";
  assert.throws(() => Module.ensureRuntime(entry, context), /incompatible SDL primitive ABI/);
  fs.writeFileSync(boot, bytecode(["sdl"], 5, { name: "event_loop", argumentKind: 9 }));
  if (Module.runtimeManagers[0].resolveSelection(entry, context.settings, context.userDataDir).ready) {
    await assert.rejects(Module.launchRuntime("hashlink", entry, { ...context,
      spawnDetachedChecked: () => assert.fail("Missing native SDL must block execution") }), /Missing: sdl/);
  } else assert.throws(() => Module.ensureRuntime(entry, context), /includes std\/ui only/);
  fs.writeFileSync(boot, bytecode(["std"], 6));
  assert.throws(() => Module.ensureRuntime(entry, context), /cannot read bytecode version 6/);
});

test("retired global HashLink defaults leave exact per-game ABI selection intact", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), boot = path.join(root, "game.hl");
  fs.writeFileSync(boot, bytecode(["sdl"], 5, { name: "event_loop", argumentKind: 11 }));
  const entry = { moduleData: { bytecodePath: boot } }, context = { userDataDir: path.join(root, "data"),
    settings: { runtimes: { hashlink: { defaultVersion: "1.16" } } },
    onEntryChange: () => {} };
  assert.equal(Module.ensureRuntime(entry, context).version, "1.9-macos-v2");
  assert.equal(entry.runtimeData.hashlink.version, "1.9-macos-v2");
  assert.equal(context.settings.runtimes.hashlink.defaultVersion, "1.16");
});

test("existing exact 1.9 registrations and explicit choices retain their identity", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), runtime = path.join(root, "old-runtime"), data = path.join(root, "data");
  fs.mkdirSync(runtime); const executable = path.join(runtime, "hl"), boot = path.join(root, "old-game.hl");
  fs.writeFileSync(executable, machO("x86_64"), { mode: 0o755 });
  fs.writeFileSync(boot, bytecode(["sdl"], 5, { name: "event_loop", argumentKind: 11 }));
  const manager = Module.runtimeManagers[0], installed = manager.core.registerLocal({ userDataDir: data, version: "1.9", runtimePath: executable });
  const entry = { moduleData: { bytecodePath: boot }, runtimeData: { hashlink: { version: "1.9" } } };
  const context = { userDataDir: data, settings: {}, onEntryChange: () => assert.fail("Exact stored choices must not change") };
  assert.equal(Module.ensureRuntime(entry, context), null);
  const selected = manager.resolveSelection(entry, context.settings, data);
  assert.equal(selected.version, "1.9"); assert.equal(selected.install.binarySha256, installed.binarySha256);
  assert.equal(selected.install.upstreamRevision, "4a4cfe91f3388a0b05bf2e45e7c4e38bae686dc6");
  const globalEntry = { moduleData: { bytecodePath: boot } };
  assert.equal(Module.ensureRuntime(globalEntry, { ...context, settings: { runtimes: { hashlink: { defaultVersion: "1.9" } } }, onEntryChange() {} }).version, "1.9-macos-v2");
  assert.equal(globalEntry.runtimeData.hashlink.version, "1.9-macos-v2");
  fs.appendFileSync(executable, "changed");
  assert.throws(() => Module.ensureRuntime(entry, context), /Choose 1\.9 Mac graphics v2/);
  assert.equal(entry.runtimeData.hashlink.version, "1.9");
});

test("HashLink resource overlay aliases static assets and isolates unknown writable sidecars", t => {
  const root = temporary(t), source = path.join(root, "source"); fs.mkdirSync(source);
  const boot = path.join(source, "game.hl"); fs.writeFileSync(boot, bytecode());
  fs.writeFileSync(path.join(source, "assets.pak"), "large immutable resource");
  fs.writeFileSync(path.join(source, "config.json"), "author setting");
  fs.writeFileSync(path.join(source, "sdl.hdll"), "MZwindows-module");
  fs.writeFileSync(path.join(source, "game.exe"), "MZwindows-launcher");
  const launch = Module.__test.prepareLaunch({ gameId: "overlay", moduleData: { bytecodePath: boot } }, { userDataDir: path.join(root, "data") });
  assert.equal(fs.lstatSync(path.join(launch.wrapper, "assets.pak")).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(launch.wrapper, "config.json")).isSymbolicLink(), false);
  assert.equal(launch.bytecodePath, boot);
  assert.deepEqual(fs.readdirSync(launch.wrapper).sort(), ["assets.pak", "config.json"]);
  fs.writeFileSync(path.join(launch.wrapper, "config.json"), "player setting");
  assert.equal(fs.readFileSync(path.join(source, "config.json"), "utf8"), "author setting");
});

test("HashLink requires an Intel bytecode slice before accepting or launching a local runtime", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async t => {
  const root = temporary(t), runtime = path.join(root, "runtime"), source = path.join(root, "source"), userDataDir = path.join(root, "data");
  fs.mkdirSync(runtime); fs.mkdirSync(source); const executable = path.join(runtime, "hl"), boot = path.join(source, "game.hl");
  fs.writeFileSync(executable, universalVm(), { mode: 0o755 }); fs.writeFileSync(boot, bytecode());
  fs.writeFileSync(path.join(runtime, "libhl.dylib"), nativeLibrary());
  Module.runtimeManagers[0].core.registerLocal({ userDataDir, version: "1.16", runtimePath: executable });
  let call; const entry = { gameId: "universal", moduleData: { bytecodePath: boot }, runtimeData: { hashlink: { version: "1.16" } } };
  await Module.launchRuntime("hashlink", entry, { userDataDir, settings: {}, spawnDetachedChecked: async (...args) => { call = args; return {}; } });
  assert.equal(call[3], true, "universal executables must force their Intel VM slice");
  await Module.runtimeManagers[0].uninstallRuntime({ userDataDir, version: "1.16" });
  fs.writeFileSync(executable, machO("arm64"), { mode: 0o755 });
  assert.throws(() => Module.runtimeManagers[0].core.registerLocal({ userDataDir, version: "1.16", runtimePath: executable }), /requires a x86_64 executable/);
  assert.equal(Module.runtimeManagers[0].core.resolveRegistered({ userDataDir, version: "1.16" }), null);
});

test("HashLink removes obsolete copies while retaining player saves and rejecting changed private bytecode", t => {
  const root = temporary(t), source = path.join(root, "source"), userDataDir = path.join(root, "data"); fs.mkdirSync(source);
  const boot = path.join(source, "game.hl"), modulePath = path.join(source, "sdl.hdll");
  fs.writeFileSync(boot, bytecode()); fs.writeFileSync(modulePath, "MZwindows-module");
  const entry = { gameId: "migrate", moduleData: { bytecodePath: boot } };
  const launch = Module.__test.prepareLaunch(entry, { userDataDir });
  const recordPath = path.join(launch.directory, "game-source.json"), record = JSON.parse(fs.readFileSync(recordPath));
  delete record.layoutVersion; fs.writeFileSync(recordPath, JSON.stringify(record));
  const oldBytecode = path.join(launch.wrapper, "game.hl");
  fs.writeFileSync(oldBytecode, "modified private program");
  fs.copyFileSync(modulePath, path.join(launch.wrapper, "sdl.hdll"));
  fs.writeFileSync(path.join(launch.wrapper, "player-save.json"), "player state");
  assert.throws(() => Module.__test.prepareLaunch(entry, { userDataDir }), /Managed HashLink bytecode changed/);
  assert.equal(fs.readFileSync(path.join(launch.wrapper, "player-save.json"), "utf8"), "player state");
  fs.copyFileSync(boot, oldBytecode);
  const migrated = Module.__test.prepareLaunch(entry, { userDataDir });
  assert.equal(migrated.bytecodePath, boot);
  assert.deepEqual(fs.readdirSync(migrated.wrapper), ["player-save.json"]);
  assert.equal(fs.readFileSync(path.join(migrated.wrapper, "player-save.json"), "utf8"), "player state");
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { inspectManagedAssembly, retargetIlAssembly } = require("../src/modules/fna/managed-assembly");
const { detectGame, inspectGameAssembly } = require("../src/modules/fna/detect");
const Fna = require("../src/modules/fna/main");
const Manager = require("../src/modules/fna/runtime/manager");
const Profile = require("../src/modules/fna/runtime/profile");
const FNA_VERSION = "fixture-fna-host", FNA_REVISION = "c".repeat(40), DOTNET_VERSION = "8.0.42";
const Native = require("../src/modules/shared/runtime/local-native");
const SourceInventory = require("../src/modules/fna/source-inventory");
const { managedAssembly, writeAssembly } = require("./helpers/fna-assembly");

function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-fna-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function game(t, options = {}) {
  const root = fixture(t), source = path.join(root, "Game"); fs.mkdirSync(source);
  const assembly = writeAssembly(path.join(source, "Game.dll"), options);
  writeAssembly(path.join(source, "FNA.dll"), { name: "FNA", version: [23, 8, 1, 2], entryPoint: false, references: [] });
  return { root, source, assembly, entry: { gameId: "game-123", gamePath: assembly, moduleData: inspectGameAssembly(assembly) } };
}
function selection(t) {
  const root = path.join(fixture(t), "runtime"); fs.mkdirSync(root);
  for (const name of ["FNA.dll", "MacLauncherFnaHost.dll", "MacLauncherFnaHost.runtimeconfig.json"]) fs.writeFileSync(path.join(root, name), "reviewed " + name);
  return { ready: true, version: FNA_VERSION, install: { executablePath: path.join(root, "dotnet") }, profile: {
    root, architecture: "arm64", frameworkVersion: "26.10.0.0", dotnetVersion: DOTNET_VERSION, files: { "FNA.dll": Native.hashFile(path.join(root, "FNA.dll")) }
  } };
}

// Hold complete stat observations across in-place writes, including descriptor
// stats, as a coarse filesystem can do. File contents remain real.
function heldCoarseTimes(t) {
  const stamps = new Map(), originals = Object.fromEntries(["statSync", "lstatSync", "fstatSync"].map(name => [name, fs[name]]));
  const wrap = stat => {
    if (!stat) return stat;
    const key = `${stat.dev}:${stat.ino}:${typeof stat.ino}`;
    if (!stamps.has(key)) {
      const fields = {};
      for (const name of ["dev", "ino", "mode", "size", "mtimeMs", "ctimeMs", "mtimeNs", "ctimeNs"]) {
        if (stat[name] !== undefined) fields[name] = name.endsWith("Ns") ? stat[name] / 1000000000n * 1000000000n :
          name.endsWith("Ms") ? Math.floor(Number(stat[name]) / 1000) * 1000 : stat[name];
      }
      stamps.set(key, fields);
    }
    const fields = stamps.get(key);
    return new Proxy(stat, { get: (target, name) => Object.hasOwn(fields, name) ? fields[name] : Reflect.get(target, name) });
  };
  for (const name of Object.keys(originals)) t.mock.method(fs, name, (...args) => wrap(originals[name](...args)));
  return { touch(file) {
    for (const bigint of [false, true]) {
      const stat = originals.lstatSync(file, { bigint }), key = `${stat.dev}:${stat.ino}:${typeof stat.ino}`, fields = stamps.get(key);
      if (fields) for (const name of ["mtimeMs", "ctimeMs", "mtimeNs", "ctimeNs"]) if (fields[name] !== undefined)
        fields[name] += name.endsWith("Ns") ? 1000000000n : 1000;
    }
  } };
}
// Observe the real copy route: Darwin preserves metadata through cp, while
// other hosts may use Node's copyFile fallback. Neither route is stubbed.
function afterRealCopy(t, source, callback) {
  const ChildProcess = require("node:child_process"), spawn = ChildProcess.spawnSync, copy = fs.copyFileSync, expected = fs.realpathSync(source);
  t.mock.method(ChildProcess, "spawnSync", (command, args, ...options) => {
    const result = spawn(command, args, ...options);
    if (result.status === 0 && Array.isArray(args) && args.includes(expected)) callback();
    return result;
  });
  t.mock.method(fs, "copyFileSync", (from, ...args) => {
    const result = copy(from, ...args);
    if (path.resolve(from) === expected) callback();
    return result;
  });
}
test("FNA reads structural assembly identity, references and target framework without execution", t => {
  const { assembly } = game(t), info = inspectManagedAssembly(assembly);
  assert.equal(info.assemblyName, "Game"); assert.equal(info.assemblyVersion, "1.2.3.4");
  assert.equal(info.targetFramework, ".NETCoreApp,Version=v7.0"); assert.equal(info.clrMetadataVersion, "v4.0.30319");
  assert.deepEqual(info.references[0], { name: "FNA", version: "23.8.0.0", publicKeyOrToken: "" });
  assert.equal(info.ilOnly, true); assert.equal(info.hasEntryPoint, true);
  const detected = inspectGameAssembly(assembly);
  assert.equal(detected.gameVersion, "1.2.3.4"); assert.equal(detected.detectedVersion, "23.8.1.2");
  assert.equal(detected.detectedVersionSource, "FNA assembly metadata");
});

test("FNA does not recognize a string marker or a framework DLL as a game", t => {
  const root = fixture(t), file = path.join(root, "Fake.exe");
  fs.writeFileSync(file, Buffer.concat([managedAssembly({ references: [], name: "FNA.dll Game" }), Buffer.from("Microsoft.Xna.Framework") ]));
  assert.equal(inspectGameAssembly(file), null);
  writeAssembly(file, { name: "FNA", entryPoint: false });
  assert.equal(inspectGameAssembly(file), null);
});

test("FNA rejects malformed PE metadata ranges, entry points and input bounds", t => {
  const root = fixture(t), file = path.join(root, "Game.exe");
  const bytes = managedAssembly(); bytes.writeUInt32LE(0xffffffff, 520); fs.writeFileSync(file, bytes);
  assert.throws(() => inspectManagedAssembly(file), /outside file-backed/);
  const entry = managedAssembly(); entry.writeUInt32LE(0x06000002, 532); fs.writeFileSync(file, entry);
  assert.throws(() => inspectManagedAssembly(file), /entry point/);
  const truncated = managedAssembly().subarray(0, 610); fs.writeFileSync(file, truncated);
  assert.throws(() => inspectManagedAssembly(file), /Truncated/);
  assert.throws(() => inspectManagedAssembly(file, { maxMetadataBytes: Infinity }), /bound/);
});

test("FNA finds transitive references and the entry assembly in a self-contained folder", t => {
  const { source, assembly } = game(t, { references: [{ name: "Shared", version: [1, 0, 0, 0] }] });
  writeAssembly(path.join(source, "Shared.dll"), { name: "Shared", entryPoint: false });
  for (let index = 0; index < 50; index++) writeAssembly(path.join(source, "A" + index + ".dll"), { name: "A" + index, entryPoint: false, references: [] });
  fs.writeFileSync(path.join(source, "Game.runtimeconfig.json"), "{}");
  const detected = detectGame({ rootDir: source, inputPath: source });
  assert.equal(detected.moduleId, "fna"); assert.equal(detected.moduleData.assemblyPath, assembly);
  assert.equal(detected.moduleData.engineEvidence.assemblyPath, path.join(source, "Shared.dll"));
});

test("FNA detects app resources and preserves the author's native app", t => {
  const root = fixture(t), app = path.join(root, "Example.app"), resources = path.join(app, "Contents", "Resources"); fs.mkdirSync(resources, { recursive: true });
  writeAssembly(path.join(resources, "Example.exe"));
  const result = detectGame({ rootDir: app, isAppBundle: true });
  assert.equal(result.nativeAppPath, app); assert.equal(result.gamePath, app); assert.equal(result.moduleData.gameVersion, "1.2.3.4");
  assert.equal(result.runtimeId, "fna"); // Data alone does not establish a runnable Mac app.
  const executable = path.join(app, "Contents", "MacOS", "Example");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  const native = detectGame({ rootDir: app, isAppBundle: true });
  assert.equal(native.runtimeId, "native");
  assert.equal(Fna.mergeEntry(null, native).runtimeId, "native");
  assert.equal(Fna.mergeEntry({ runtimeId: "fna" }, native).runtimeId, "fna");
  assert.equal(Fna.mergeEntry({ runtimeId: "native" }, result).runtimeId, "native");
});

test("FNA app import keeps the publisher runtime and deduplicates its containing folder", async t => {
  const root = fixture(t), folder = path.join(root, "Installed Game"), app = path.join(folder, "Example.app");
  const resources = path.join(app, "Contents", "Resources"), executable = path.join(app, "Contents", "MacOS", "Example");
  fs.mkdirSync(resources, { recursive: true }); fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  writeAssembly(path.join(resources, "Example.exe"));
  const { createLauncher } = require("../src/core/launcher");
  const launcher = createLauncher({ userDataDir: path.join(root, "profile") });
  const imported = await launcher.resolveEntry(folder);
  assert.equal(imported.gamePath, app); assert.equal(imported.importPath, folder);
  assert.equal(imported.moduleId, "fna"); assert.equal(imported.runtimeId, "native");
  assert.equal((await launcher.resolveEntry(app)).gameId, imported.gameId);
  const selected = await launcher.resolveEntry(app, { runtimeId: "fna" });
  assert.equal(selected.runtimeId, "fna");
  assert.equal((await launcher.resolveEntry(folder)).runtimeId, "fna");
  // The GUI import worker uses the metadata service rather than resolveEntry.
  const { createGameMetadataService } = require("../src/core/game-metadata");
  const metadata = createGameMetadataService({ userDataDir: path.join(root, "gui-profile"), registry: require("../src/modules/registry") });
  const gui = await metadata.importEntry(folder, { modules: { fna: { defaultRuntime: "fna" } } });
  assert.equal(gui.runtimeId, "native");
  assert.equal(gui.gamePath, app);
});

test("FNA qualifies 32-bit, mixed-mode and unsupported XNA services explicitly", t => {
  const root = fixture(t), file = path.join(root, "Game.exe");
  writeAssembly(file, { flags: 3 }); assert.equal(inspectGameAssembly(file).compatibility, "requires-32-bit-host");
  writeAssembly(file, { flags: 0 }); assert.equal(inspectGameAssembly(file).compatibility, "mixed-mode-unsupported");
  writeAssembly(file, { references: [{ name: "Microsoft.Xna.Framework.Game", version: [4, 0, 0, 0] }], types: [{ name: "GamerServicesComponent", namespace: "Microsoft.Xna.Framework.GamerServices" }] });
  const info = inspectGameAssembly(file); assert.equal(info.engineKind, "xna"); assert.deepEqual(info.unsupportedXnaServices, ["Microsoft.Xna.Framework.GamerServices"]);
});

test("FNA preflight prepares qualified legacy conversion by default and preserves exact selection", t => {
  const { entry, root } = game(t), selected = selection(t);
  t.mock.method(Manager, "resolveSelection", () => selected);
  const context = { userDataDir: path.join(root, "userData"), settings: {}, runtimeSettings: {} };
  assert.equal(Fna.__test.runtimeStatus(entry, context).ready, true);
  context.runtimeSettings.useRuntimeFramework = false;
  assert.match(Fna.__test.runtimeStatus(entry, context).reason, /Enable/);
  context.runtimeSettings.useRuntimeFramework = true;
  const result = Fna.__test.runtimeStatus(entry, context);
  assert.equal(result.ready, true); assert.equal(result.gameFrameworkVersion, "23.8.1.2"); assert.equal(result.frameworkVersion, "26.10.0.0"); assert.equal(result.version, FNA_VERSION);
  t.mock.method(Manager, "resolveSelection", () => ({ ready: false, version: "missing-version", reason: "Selected version not installed" }));
  assert.equal(Fna.__test.runtimeStatus(entry, context).version, "missing-version");
});

test("FNA ordinary preparation keeps original assembly, data and cwd without a private tree or asset walk", t => {
  const f = game(t), selected = selection(t);t.mock.method(Manager, "resolveSelection", () => selected);
  const assetRoot = path.join(f.source, "UnusualAssets");fs.mkdirSync(assetRoot);fs.writeFileSync(path.join(assetRoot, "data.bin"), "original data");
  fs.symlinkSync(assetRoot, path.join(f.source, "ExistingLink"));fs.writeFileSync(path.join(f.source, "game.cfg"), "original settings");
  const context = {userDataDir: path.join(f.root, "data"), settings: {}, runtimeSettings: {}};
  t.mock.method(fs, "readdirSync", () => assert.fail("Ordinary FNA Play must not enumerate game assets"));
  t.mock.method(fs, "symlinkSync", () => assert.fail("Ordinary FNA Play must not create game links"));
  t.mock.method(fs, "copyFileSync", () => assert.fail("Ordinary FNA Play must not copy game files"));
  const result = Fna.__test.prepareGame(f.entry, context);
  assert.equal(result.gameRoot, f.source);assert.equal(result.assemblyPath, f.assembly);assert.equal(result.assemblyRoot, null);
  assert.equal(result.hostPath, path.join(selected.profile.root, "MacLauncherFnaHost.dll"));
  assert.equal(fs.existsSync(context.userDataDir), false);assert.equal(fs.readFileSync(path.join(f.source, "game.cfg"), "utf8"), "original settings");
});

test("FNA launches the installed host with original working data and explicit framework selection", async t => {
  const f = game(t), selected = selection(t);t.mock.method(Manager, "resolveSelection", () => selected);
  writeAssembly(path.join(f.source, "FNA.dll"), {name: "FNA", version: [26, 10, 0, 0], entryPoint: false, references: []});
  let call;const context = {userDataDir: path.join(f.root, "data"), settings: {}, runtimeSettings: {}, gameArguments: ["--original"], spawnDetachedChecked: (...args) => {call = args;return {pid: 1, exitCode: 0};}};
  await Fna.launchRuntime("fna", f.entry, context);
  assert.deepEqual(call[1], ["exec", path.join(selected.profile.root, "MacLauncherFnaHost.dll"), f.assembly, selected.profile.root, "--original"]);
  assert.equal(call[2].cwd, f.source);assert.equal(call[2].env.MACLAUNCHER_FNA_GAME_ROOT, f.source);
  assert.equal(call[2].env.MACLAUNCHER_FNA_ASSEMBLY_ROOT, "");assert.equal(call[2].env.MACLAUNCHER_FNA_USE_RUNTIME_FRAMEWORK, "1");
  context.runtimeSettings.useRuntimeFramework = false;await Fna.launchRuntime("fna", f.entry, context);
  assert.equal(call[2].env.MACLAUNCHER_FNA_USE_RUNTIME_FRAMEWORK, "0");assert.equal(call[2].cwd, f.source);
  assert.equal(fs.existsSync(context.userDataDir), false);
});

function convertedGame(t) {
  const f = game(t, {references: [{name: "Shared", version: [1, 0, 0, 0]}]}), selected = selection(t);
  const dependency = path.join(f.source, "Shared.dll");
  const bytes = Buffer.concat([managedAssembly({name: "Shared", entryPoint: false, machine: 0x8664, pe64: true}), Buffer.from([1])]);
  fs.writeFileSync(dependency, bytes);t.mock.method(Manager, "resolveSelection", () => selected);
  return {...f, selected, dependency, bytes, context: {userDataDir: path.join(f.root, "data"), settings: {}, runtimeSettings: {}}};
}

test("FNA derives only reachable CPU-pinned assemblies and leaves original search and data paths authoritative", t => {
  const f = convertedGame(t);fs.writeFileSync(path.join(f.source, "game.cfg"), "original config");
  fs.mkdirSync(path.join(f.source, "Assets"));fs.writeFileSync(path.join(f.source, "Assets", "big.bin"), "live asset");
  writeAssembly(path.join(f.source, "Unreferenced.dll"), {entryPoint: false, machine: 0x8664, pe64: true});
  const result = Fna.__test.prepareGame(f.entry, f.context);
  assert.equal(result.gameRoot, f.source);assert.equal(result.assemblyPath, f.assembly);
  assert.deepEqual(fs.readdirSync(result.assemblyRoot), ["Shared.dll"]);
  assert.equal(inspectManagedAssembly(path.join(result.assemblyRoot, "Shared.dll")).peMachine, 0xaa64);
  assert.deepEqual(fs.readFileSync(f.dependency), f.bytes);assert.equal(fs.existsSync(path.join(f.source, "Unreferenced.dll")), true);
  assert.equal(fs.existsSync(path.join(result.assemblyRoot, "FNA.dll")), false);assert.equal(fs.existsSync(path.join(result.assemblyRoot, "game.cfg")), false);
});

test("FNA uses a required derived entry assembly with original cwd and leaves Intel portable x64 games direct", async t => {
  const f = game(t, {machine: 0x8664, pe64: true}), selected = selection(t);t.mock.method(Manager, "resolveSelection", () => selected);
  let call;const context = {userDataDir: path.join(f.root, "data"), settings: {}, runtimeSettings: {}, spawnDetachedChecked: (...args) => {call = args;return {pid: 1, exitCode: 0};}};
  const original = fs.readFileSync(f.assembly);await Fna.launchRuntime("fna", f.entry, context);
  assert.notEqual(call[1][2], f.assembly);assert.equal(call[2].cwd, f.source);assert.equal(call[2].env.MACLAUNCHER_FNA_GAME_ROOT, f.source);
  assert.equal(call[2].env.MACLAUNCHER_FNA_ASSEMBLY_ROOT, path.dirname(call[1][2]));assert.deepEqual(fs.readFileSync(f.assembly), original);
  selected.profile.architecture = "x64";context.runtimeSettings.retargetIlArchitecture = false;
  const direct = Fna.__test.prepareGame(f.entry, context);assert.equal(direct.assemblyPath, f.assembly);assert.equal(direct.assemblyRoot, null);
});

test("FNA warm conversion reuses validated assembly bytes without hashing, copying or walking assets", t => {
  const f = convertedGame(t), first = Fna.__test.prepareGame(f.entry, f.context), read = fs.readSync;
  t.mock.method(fs, "readSync", (fd, buffer, ...args) => {assert.notEqual(buffer.length, SourceInventory.LIMITS.chunkBytes, "warm precise conversion inputs need no streaming digest");return read(fd, buffer, ...args);});
  t.mock.method(fs, "readdirSync", () => assert.fail("Warm Play must not enumerate assets"));
  t.mock.method(fs, "copyFileSync", () => assert.fail("Warm Play must not recopy assemblies"));
  assert.equal(Fna.__test.prepareGame(f.entry, f.context).assemblyRoot, first.assemblyRoot);
});

test("FNA conversion content keys refresh held-coarse-stat inputs and retain previous derived bytes", t => {
  const f = convertedGame(t);heldCoarseTimes(t);const first = Fna.__test.prepareGame(f.entry, f.context);
  const old = fs.readFileSync(path.join(first.assemblyRoot, "Shared.dll")), updated = Buffer.from(f.bytes);updated[updated.length - 1] = 2;fs.writeFileSync(f.dependency, updated);
  const second = Fna.__test.prepareGame(f.entry, f.context);assert.notEqual(second.assemblyRoot, first.assemblyRoot);
  const expected = Buffer.from(updated);expected.writeUInt16LE(0xaa64, 132);
  assert.deepEqual(fs.readFileSync(path.join(second.assemblyRoot, "Shared.dll")), expected);assert.deepEqual(fs.readFileSync(f.dependency), updated);
  assert.deepEqual(fs.readFileSync(path.join(first.assemblyRoot, "Shared.dll")), old);
});

test("FNA rejects held-stat conversion-input mutation during hashing without publishing a derived cache", t => {
  const f = convertedGame(t);heldCoarseTimes(t);const inode = fs.statSync(f.dependency, {bigint: true}).ino, read = fs.readSync;let mutated = false;
  t.mock.method(fs, "readSync", (fd, buffer, ...args) => {
    const result = read(fd, buffer, ...args);
    if (!mutated && buffer.length === SourceInventory.LIMITS.chunkBytes && fs.fstatSync(fd, {bigint: true}).ino === inode) {mutated = true;const bytes = Buffer.from(f.bytes);bytes[bytes.length - 1] = 2;fs.writeFileSync(f.dependency, bytes);}return result;
  });
  assert.throws(() => Fna.__test.prepareGame(f.entry, f.context), {code: "SOURCE_CHANGED"});assert.equal(mutated, true);assert.equal(fs.existsSync(f.context.userDataDir), false);
});

test("FNA conversion copy races preserve original data and the previous cache receipt", t => {
  const f = convertedGame(t);heldCoarseTimes(t);const first = Fna.__test.prepareGame(f.entry, f.context), marker = path.join(path.dirname(first.assemblyRoot), "prepared.json"), receipt = fs.readFileSync(marker);
  const updated = Buffer.from(f.bytes);updated[updated.length - 1] = 2;fs.writeFileSync(f.dependency, updated);let mutated = false;
  afterRealCopy(t, f.dependency, () => {if (!mutated) {mutated = true;const changed = Buffer.from(updated);changed[changed.length - 1] = 3;fs.writeFileSync(f.dependency, changed);}});
  assert.throws(() => Fna.__test.prepareGame(f.entry, f.context), {code: "SOURCE_CHANGED"});assert.equal(mutated, true);
  assert.deepEqual(fs.readFileSync(marker), receipt);assert.equal(fs.existsSync(path.join(first.assemblyRoot, "Shared.dll")), true);
  assert.ok(fs.readdirSync(path.dirname(first.assemblyRoot)).every(name => !name.startsWith(".prepare-")));
});

test("FNA preserves modified derived assemblies instead of overwriting their only copy", t => {
  const f = convertedGame(t), first = Fna.__test.prepareGame(f.entry, f.context), file = path.join(first.assemblyRoot, "Shared.dll");
  fs.writeFileSync(file, "private edited bytes");const second = Fna.__test.prepareGame(f.entry, f.context);
  assert.notEqual(second.assemblyRoot, first.assemblyRoot);assert.equal(fs.readFileSync(file, "utf8"), "private edited bytes");
  assert.equal(inspectManagedAssembly(path.join(second.assemblyRoot, "Shared.dll")).peMachine, 0xaa64);
});

test("FNA original Play never touches or retires legacy private game data", async t => {
  const f = game(t), selected = selection(t);t.mock.method(Manager, "resolveSelection", () => selected);
  const context = {userDataDir: path.join(f.root, "data"), settings: {}, runtimeSettings: {}};
  const previous = path.join(context.userDataDir, "games", f.entry.gameId, "modules/fna/previous-overlays", "runtime-1700000000000");
  fs.mkdirSync(previous, {recursive: true});const save = path.join(previous, "save.dat");fs.writeFileSync(save, "retained private progress");
  fs.writeFileSync(path.join(previous, ".maclauncher-fna-carried-forward.json"), JSON.stringify({schemaVersion: 2, carriedForward: true, outputFingerprint: "a".repeat(64)}));
  const result = Fna.__test.prepareGame(f.entry, context);assert.equal(result.gameRoot, f.source);assert.equal(Fna.cleanupGameData(f.entry, context), false);
  const cleanup = await require("../src/core/storage-maintenance").maintainStorage({userDataDir: context.userDataDir, stores: require("../src/modules/fna/derived-stores"), now: Date.now() + 30 * 24 * 60 * 60 * 1000});
  assert.equal(cleanup.removed, 0);assert.equal(fs.readFileSync(save, "utf8"), "retained private progress");
});

test("FNA rejects incompatible managed games before requesting runtime installation", async t => {
  const { entry, root } = game(t, { flags: 3 });
  t.mock.method(Manager, "resolveSelection", () => { throw Error("Runtime should not be selected"); });
  await assert.rejects(Fna.ensureRuntime(entry, { runtimeId: "fna", userDataDir: path.join(root, "userData"), settings: {} }), /32-bit CLR/);
});

test("FNA identifies Windows desktop dependencies while accepting portable drawing structs", t => {
  const { entry, assembly } = game(t, { types: [{ namespace: "System.Windows.Forms", name: "MessageBox" }] });
  assert.deepEqual(entry.moduleData.windowsApis, ["Windows Forms"]);
  assert.equal(entry.moduleData.compatibility, "requires-platform-adapter");
  assert.throws(() => Fna.__test.preflight(entry), /Windows Forms/);
  writeAssembly(assembly, { types: [{ namespace: "System.Windows.Threading", name: "Dispatcher" },
    { namespace: "System.Windows.Threading", name: "DispatcherOperation" }] });
  assert.deepEqual(Fna.detectGame({ rootDir: path.dirname(assembly), inputPath: assembly }).moduleData.windowsApis, ["WPF"]);
  assert.throws(() => Fna.__test.preflight(entry), /WPF/);
  writeAssembly(assembly, { types: [{ namespace: "System.Drawing", name: "Rectangle" }, { namespace: "System.Drawing", name: "Color" }] });
  assert.deepEqual(Fna.__test.preflight(entry).windowsApis, []);
});

test("FNA reports native import names and original PE requirements without executing libraries", t => {
  const { entry, assembly } = game(t, { flags: 3, nativeImports: [{ library: "kernel32.dll", name: "GetModuleHandleW" }] });
  const inspected = inspectManagedAssembly(assembly);
  assert.deepEqual(inspected.nativeImports, [{ library: "kernel32.dll", name: "GetModuleHandleW" }]);
  assert.deepEqual(entry.moduleData.nativeLibraries, ["kernel32.dll"]);
  assert.equal(entry.moduleData.peFormat, "PE32"); assert.equal(entry.moduleData.requires32Bit, true);
});

test("FNA rejects a required conversion cache inside the original game", t => {
  const f = convertedGame(t);f.context.userDataDir = path.join(f.source, "launcher-data");
  assert.throws(() => Fna.__test.prepareGame(f.entry, f.context), /separate/);assert.equal(fs.existsSync(f.context.userDataDir), false);
});

test("XNA conversion uses selected runtime facades without copying them over original game files", t => {
  const { entry, root, source } = game(t, { references: [{ name: "Microsoft.Xna.Framework", version: [4, 0, 0, 0] }] }), selected = selection(t);
  const abi = path.join(selected.profile.root, "abi"); fs.mkdirSync(abi);
  fs.writeFileSync(path.join(abi, "Microsoft.Xna.Framework.dll"), "reviewed type forwarders");
  fs.writeFileSync(path.join(source, "Microsoft.Xna.Framework.dll"), "original Windows framework");
  t.mock.method(Manager, "resolveSelection", () => selected);
  const prepared = Fna.__test.prepareGame(entry, { userDataDir: path.join(root, "userData"), settings: {}, runtimeSettings: { useRuntimeFramework: true } });
  assert.equal(prepared.gameRoot, source);assert.equal(prepared.hostPath, path.join(selected.profile.root, "MacLauncherFnaHost.dll"));
  assert.equal(fs.readFileSync(path.join(prepared.runtimeRoot, "abi", "Microsoft.Xna.Framework.dll"), "utf8"), "reviewed type forwarders");
  assert.equal(fs.readFileSync(path.join(source, "Microsoft.Xna.Framework.dll"), "utf8"), "original Windows framework");
});

test("FNA launches a separate host and passes opt-in graphics and argument settings", async t => {
  const { entry, root } = game(t), selected = selection(t); t.mock.method(Manager, "resolveSelection", () => selected);
  const focus = require("../src/modules/shared/runtime/native-focus"), spawnForeground = focus.spawnForegroundNativeGame;
  t.mock.method(focus, "spawnForegroundNativeGame", options => spawnForeground(options, { focus: async () => ({ activated: true }) }));
  let call; const context = { userDataDir: path.join(root, "userData"), settings: {}, gameArguments: ["--title", "  A quoted game  ", "", "$(literal)", "first\nsecond"], runtimeSettings: { useRuntimeFramework: true, softwareOpenGL: true, appArgs: ["--level", "a b"] }, spawnDetachedChecked: (...args) => { call = args; return { pid: 1, exitCode: 0 }; } };
  await Fna.launchRuntime("fna", entry, context);
  assert.equal(call[0], selected.install.executablePath); assert.equal(call[1][0], "exec");
  assert.deepEqual(call[1].slice(3), [selected.profile.root, "--level", "a b", ...context.gameArguments]);
  assert.equal(call[2].env.MACLAUNCHER_ALLOW_SOFTWARE_OPENGL, "1"); assert.equal(call[2].env.FNA3D_FORCE_DRIVER, "OpenGL"); assert.equal(call[3], false);
  if (process.platform === "darwin") assert.equal(call[2].env.SDL_MAC_BACKGROUND_APP, "0");
  context.runtimeSettings.appArgs = ["bad\0arg"]; await assert.rejects(Fna.launchRuntime("fna", entry, context), /arguments/);
});

test("FNA architecture conversion changes only the machine field of qualified pure IL", t => {
  const root = fixture(t), file = path.join(root, "Game.dll"), input = managedAssembly({ machine: 0x8664, pe64: true }); fs.writeFileSync(file, input);
  const result = retargetIlAssembly(file), output = fs.readFileSync(file);
  assert.equal(result.originalMachine, 0x8664); assert.equal(inspectManagedAssembly(file).peMachine, 0xaa64);
  const expected = Buffer.from(input); expected.writeUInt16LE(0xaa64, 132); assert.deepEqual(output, expected);
  assert.equal(inspectManagedAssembly(file).assemblyVersion, "1.2.3.4");
  writeAssembly(file, { machine: 0x8664, pe64: true, nativeManagedCode: true });
  assert.throws(() => retargetIlAssembly(file), /ReadyToRun/);
  writeAssembly(file, { machine: 0x8664, pe64: true, flags: 3 }); assert.throws(() => retargetIlAssembly(file), /64-bit/);
});

test("FNA validates its runtime files and rejects wrong versions or tampering", t => {
  const root = fixture(t), files = {};
  for (const relative of Profile.requiredFiles(DOTNET_VERSION)) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, relative); files[relative] = Native.hashFile(file); }
  const record = { profile: FNA_VERSION, upstreamRevision: FNA_REVISION, dotnetVersion: DOTNET_VERSION, frameworkVersion: "26.10.0.0", architecture: "arm64", files };
  const metadata = path.join(root, "fna-runtime.json"); fs.writeFileSync(metadata, JSON.stringify(record));
  assert.equal(Profile.verifyRuntime({ executablePath: path.join(root, "dotnet"), upstreamRevision: FNA_REVISION }).dotnetVersion, DOTNET_VERSION);
  fs.writeFileSync(metadata, JSON.stringify({ ...record, profile: "fixture-another-host" }));
  assert.equal(Profile.verifyRuntime({ executablePath: path.join(root, "dotnet"), upstreamRevision: FNA_REVISION }).dotnetVersion, DOTNET_VERSION);
  assert.equal(Profile.verifyRuntime({ executablePath: path.join(root, "dotnet"), upstreamRevision: "d".repeat(40) }).sourceIdentity.receiptRevision, "d".repeat(40));
  fs.writeFileSync(path.join(root, "FNA.dll"), "modified"); assert.throws(() => Profile.verifyRuntime({ executablePath: path.join(root, "dotnet"), upstreamRevision: FNA_REVISION }), /integrity/);
  record.frameworkVersion = "invalid-framework"; fs.writeFileSync(metadata, JSON.stringify(record)); assert.throws(() => Profile.verifyRuntime({ executablePath: path.join(root, "dotnet"), upstreamRevision: FNA_REVISION }), /metadata/);
});

test("FNA retains exact retired selections and discovers a default without usable installations", t => {
  const manager = Manager.createManager(), root = fixture(t);
  const entry = { runtimeData: { fna: { version: "fixture-retired-host" } } };
  const result = manager.resolveSelection(entry, {}, root);
  assert.equal(result.version, "fixture-retired-host"); assert.equal(result.ready, false);
  assert.equal(result.upgradedFromVersion, undefined);
  assert.equal(entry.runtimeData.fna.version, "fixture-retired-host");
  assert.equal(manager.getState({ userDataDir: root, settings: { defaultVersion: "fixture-retired-host" } }).defaultVersion, "fixture-retired-host");
  assert.equal(manager.resolveSelection({}, { runtimes: { fna: { defaultVersion: "fixture-retired-host" } } }, root).version, "fixture-retired-host");
  assert.equal(manager.resolveSelection({}, {}, root).version, null);
  assert.equal(manager.resolveSelection({}, {}, root).discoveryRequired, true);
  assert.deepEqual(manager.core.catalog, [], "retired choices are not bundled catalog seeds");
});

test("FNA app resources do not bypass managed download consent or trigger source compilation", async t => {
  const root = fixture(t), resources = path.join(root, "resources"), directory = path.join(resources, "fna", "arm64"), payload = path.join(directory, "files", "fna"); fs.mkdirSync(payload, { recursive: true });
  for (const relative of Profile.requiredFiles(DOTNET_VERSION)) { const file = path.join(payload, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "sealed " + relative); }
  const executable = Buffer.alloc(32); executable.writeUInt32LE(0xfeedfacf); executable.writeUInt32LE(0x0100000c, 4); executable.writeUInt32LE(2, 12); fs.writeFileSync(path.join(payload, "dotnet"), executable, { mode: 0o755 });
  fs.writeFileSync(path.join(payload, "LICENSE.txt"), "test notice");
  fs.writeFileSync(path.join(payload, "fna-runtime.json"), JSON.stringify({ profile: FNA_VERSION, upstreamRevision: FNA_REVISION, frameworkVersion: "26.10.0.0", dotnetVersion: DOTNET_VERSION, architecture: "arm64", files: Object.fromEntries(Profile.requiredFiles(DOTNET_VERSION).map(name => [name, "b".repeat(64)])) }));
  const Bundled = require("../src/modules/shared/runtime/bundled-native");
  const files = Bundled.fileInventory(path.join(directory, "files")).map(relative => { const file = path.join(directory, "files", relative), stat = fs.statSync(file); return { path: relative, size: stat.size, sha256: Native.hashFile(file), mode: stat.mode & 0o777, ...(relative === "fna/dotnet" ? { architectures: ["arm64"] } : {}) }; });
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, managerId: "fna", version: FNA_VERSION, upstreamRevision: FNA_REVISION, platform: "darwin", arch: "arm64", minimumMacOS: "13.0", executableRelative: "fna/dotnet", files, dependencies: [], notices: [{ name: "Fixture notice", license: "Test", sourceUrl: "https://example.com", path: "fna/LICENSE.txt" }], provenance: { sourceRevision: FNA_REVISION } }));
  t.mock.method(require("../src/modules/shared/runtime/maclauncher-builds"), "fetchProjectCatalog", async () => ({ packages: [] }));
  let downloads = 0;
  const manager = Manager.createManager({ dependencies: { bundle: { resourceRoot: resources, platform: "darwin", arch: "arm64", dependencies: { systemVersion: async () => "13.0", systemVersionSync: () => "13.0", verifySignatures: async () => {}, verifySignaturesSync: () => {} } }, manager: { downloadToFile: () => { downloads++; throw Error("Unexpected download"); } }, build: { findBuildTool: () => { throw Error("Unexpected source build"); } } } });
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const userDataDir = path.join(root, "userData");
  assert.equal(manager.resolveSelection({}, {}, userDataDir).ready, false);
  assert.deepEqual(manager.getState({ userDataDir }).installed, []);
  assert.deepEqual(manager.getState({ userDataDir }).catalog.includedVersions, []);
  // Without a hosted package in the catalog nothing is installable; app resources never substitute for it.
  await assert.rejects(manager.installRuntime({ userDataDir, version: FNA_VERSION }), /not available/);
  assert.equal(downloads, 0);
  assert.equal(manager.resolveSelection({}, {}, userDataDir).ready, false);
  assert.ok(fs.existsSync(path.join(payload, "FNA.dll")), "app resources remain unchanged");
});

test("FNA explicit refresh queries only MacLauncher Builds and does not broaden install qualification", async t => {
  t.mock.method(require("../src/modules/shared/runtime/maclauncher-builds"), "fetchProjectCatalog", async () => ({ packages: [] }));
  const Github = require("../src/modules/shared/runtime/github-releases"), root = fixture(t); let requests = 0;
  t.mock.method(Github, "fetchGithubTags", async () => { requests++; return [{ name: "23.08", commit: { sha: "a".repeat(40) } }]; });
  const manager = Manager.createManager(); manager.getState({ userDataDir: root });
  const catalog = await manager.refreshCatalog({ userDataDir: root, force: true });
  assert.equal(requests, 0, "upstream source tags have no Mac host and are not a download source");
  assert.equal(catalog.supportsLatestOnly, false);
  assert.deepEqual(catalog.versions, []);
  assert.deepEqual(catalog.installableVersions, []);
  assert.deepEqual(catalog.includedVersions, []);
  const missing = manager.resolveSelection({ runtimeData: { fna: { version: "23.08-net8-arm64-v2" } } }, {}, root);
  assert.equal(missing.ready, false); assert.equal(missing.version, "23.08-net8-arm64-v2");
});

test("FNA runtime state and module imports remain offline and independent from Electron", t => {
  const root = fixture(t); t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network"); });
  const manager = Manager.createManager(); const state = manager.getState({ userDataDir: root });
  assert.equal(state.catalog.supportsLatestOnly, false);
  assert.deepEqual(state.catalog.versions, [], "download rows begin empty until an explicit query");
  assert.deepEqual(manager.core.catalog, [], "source imports do not ship a final package catalog");
  const child = spawnSync(process.execPath, ["-e", "const M=require('node:module');const original=M._load;M._load=function(id,...args){if(id==='electron')throw Error('Electron imported');return original.call(this,id,...args)};require('./src/modules/fna/main');"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
});

test("FNA downloaded packages bind relocated files to their sealed manifest", t => {
  const root = fixture(t), directory = path.join(root, "project-payload"), payload = path.join(directory, "files", "fna");
  fs.mkdirSync(payload, { recursive: true });
  for (const relative of Profile.requiredFiles(DOTNET_VERSION)) {
    const file = path.join(payload, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "sealed " + relative);
  }
  const executable = Buffer.alloc(32); executable.writeUInt32LE(0xfeedfacf); executable.writeUInt32LE(0x0100000c, 4); executable.writeUInt32LE(2, 12);
  fs.writeFileSync(path.join(payload, "dotnet"), executable, { mode: 0o755 });
  fs.writeFileSync(path.join(payload, "LICENSE.txt"), "notice");
  fs.writeFileSync(path.join(payload, "fna-runtime.json"), JSON.stringify({ profile: FNA_VERSION, upstreamRevision: FNA_REVISION,
    frameworkVersion: "26.10.0.0", dotnetVersion: DOTNET_VERSION, architecture: "arm64",
    files: Object.fromEntries(Profile.requiredFiles(DOTNET_VERSION).map(name => [name, "b".repeat(64)])) }));
  const B = require("../src/modules/shared/runtime/bundled-native"), files = B.fileInventory(path.join(directory, "files")).map(relative => {
    const file = path.join(directory, "files", relative), { bytes, ...record } = B.readRegular(file, B.LIMITS.fileBytes);
    return { path: relative, ...record, ...(relative === "fna/dotnet" ? { architectures: ["arm64"] } : {}) };
  });
  const manifest = { schemaVersion: 1, managerId: "fna", version: FNA_VERSION, upstreamRevision: FNA_REVISION, platform: "darwin", arch: "arm64",
    minimumMacOS: "13.0", executableRelative: "fna/dotnet", files, dependencies: [],
    notices: [{ name: "Notice", license: "MIT", sourceUrl: "https://example.com", path: "fna/LICENSE.txt" }], provenance: { sourceRevision: FNA_REVISION } };
  const bytes = Buffer.from(JSON.stringify(manifest)), metadata = path.join(directory, "manifest.json"); fs.writeFileSync(metadata, bytes);
  const install = { source: "download", version: FNA_VERSION, upstreamRevision: FNA_REVISION, installDir: root, executablePath: path.join(payload, "dotnet"),
    catalogEntry: { projectPackage: { id: "fna", version: FNA_VERSION, manifestRelative: "manifest.json", manifestSha256: B.digest(bytes) } } };
  assert.equal(Profile.verifyRuntime(install).files["FNA.dll"], Native.hashFile(path.join(payload, "FNA.dll")));
  assert.equal(Profile.verifyRuntime({...install, upstreamRevision: undefined}).sourceIdentity.receiptRevision, null);
  const project = install.catalogEntry.projectPackage;
  install.upstreamRevision = "d".repeat(40);
  project.source = {repository: "procrastinine/maclauncher-builds", revision: install.upstreamRevision};
  assert.equal(Profile.verifyRuntime(install).upstreamRevision, FNA_REVISION, "The sealed FNA profile retains its primary upstream, separately from the producer receipt");
  project.source.repository = "FNA-XNA/FNA";
  assert.equal(Profile.verifyRuntime(install).upstreamRevision, FNA_REVISION);
  project.source.repository = "procrastinine/maclauncher-builds";
  install.upstreamRevision = "e".repeat(40);
  assert.equal(Profile.verifyRuntime(install).sourceIdentity.receiptRevision, "e".repeat(40));
  install.upstreamRevision = project.source.revision;
  fs.appendFileSync(metadata, " "); assert.throws(() => Profile.verifyRuntime(install), /manifest changed/); fs.writeFileSync(metadata, bytes);
  fs.writeFileSync(path.join(payload, "native/lib/libSDL3.0.dylib"), "modified"); assert.throws(() => Profile.verifyRuntime(install), /checksum|permissions/i);
});

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
const Build = require("../src/modules/fna/runtime/build");
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
  return { ready: true, version: Build.PROFILE, install: { executablePath: path.join(root, "dotnet") }, profile: {
    root, frameworkVersion: "26.10.0.0", dotnetVersion: Build.DOTNET_VERSION, files: { "FNA.dll": Native.hashFile(path.join(root, "FNA.dll")) }
  } };
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
  assert.equal(result.ready, true); assert.equal(result.gameFrameworkVersion, "23.8.1.2"); assert.equal(result.frameworkVersion, "26.10.0.0"); assert.equal(result.version, Build.PROFILE);
  t.mock.method(Manager, "resolveSelection", () => ({ ready: false, version: "missing-version", reason: "Selected version not installed" }));
  assert.equal(Fna.__test.runtimeStatus(entry, context).version, "missing-version");
});

test("FNA overlays preserve originals and retain private saves on updates", t => {
  const { entry, root, source, assembly } = game(t), selected = selection(t);
  t.mock.method(Manager, "resolveSelection", () => selected);
  const context = { userDataDir: path.join(root, "userData"), settings: {}, runtimeSettings: { useRuntimeFramework: true } };
  const original = Native.hashFile(path.join(source, "FNA.dll")), first = Fna.__test.prepareGame(entry, context);
  assert.equal(Native.hashFile(path.join(source, "FNA.dll")), original);
  assert.equal(Native.hashFile(path.join(first.gameRoot, "FNA.dll")), selected.profile.files["FNA.dll"]);
  fs.writeFileSync(path.join(first.gameRoot, "save.dat"), "private save");
  assert.equal(Fna.__test.prepareGame(entry, context).gameRoot, first.gameRoot);
  assert.equal(fs.readFileSync(path.join(first.gameRoot, "save.dat"), "utf8"), "private save");
  writeAssembly(assembly, { version: [2, 0, 0, 0] }); Fna.__test.prepareGame(entry, context);
  const previous = path.join(context.userDataDir, "games", entry.gameId, "modules", "fna", "previous-overlays");
  assert.equal(fs.readdirSync(previous).length, 1); assert.equal(fs.readFileSync(path.join(previous, fs.readdirSync(previous)[0], "save.dat"), "utf8"), "private save");
});

test("FNA overlays link original assets and refresh without scanning linked content", t => {
  const { entry, root, source } = game(t), selected = selection(t);
  t.mock.method(Manager, "resolveSelection", () => selected);
  const content = path.join(source, "Content"); fs.mkdirSync(content);
  const asset = path.join(content, "level.bin"); fs.writeFileSync(asset, "original asset");
  const context = { userDataDir: path.join(root, "userData"), settings: {}, runtimeSettings: {} };
  const first = Fna.__test.prepareGame(entry, context), fingerprint = Fna.__test.sourceInventory(source);
  assert.equal(fs.lstatSync(path.join(first.gameRoot, "Content")).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(first.gameRoot, "Game.dll")).isSymbolicLink(), false);
  fs.writeFileSync(asset, "updated asset"); fs.writeFileSync(path.join(content, "new.bin"), "new asset");
  assert.equal(Fna.__test.sourceInventory(source), fingerprint);
  assert.equal(Fna.__test.prepareGame(entry, context).gameRoot, first.gameRoot);
  assert.equal(fs.readFileSync(path.join(first.gameRoot, "Content", "level.bin"), "utf8"), "updated asset");
  assert.equal(fs.readFileSync(path.join(first.gameRoot, "Content", "new.bin"), "utf8"), "new asset");
  const previous = path.join(context.userDataDir, "games", entry.gameId, "modules", "fna", "previous-overlays");
  assert.equal(fs.existsSync(previous), false);
});

test("FNA refreshes copied dependencies when equal-sized bytes change with restored mtime", t => {
  const { entry, root, source } = game(t), selected = selection(t);
  const dependency = path.join(source, "Shared.dll");
  const original = Buffer.concat([managedAssembly({ name: "Shared", entryPoint: false, references: [], machine: 0x8664, pe64: true }), Buffer.from([1])]);
  fs.writeFileSync(dependency, original); fs.utimesSync(dependency, 1700000000, 1700000000);
  t.mock.method(Manager, "resolveSelection", () => selected);
  const context = { userDataDir: path.join(root, "userData"), settings: {}, runtimeSettings: {} };
  const first = Fna.__test.prepareGame(entry, context), privateDependency = path.join(first.gameRoot, "Shared.dll");
  assert.equal(inspectManagedAssembly(privateDependency).peMachine, 0xaa64);
  fs.writeFileSync(path.join(first.gameRoot, "save.dat"), "private save");
  const updated = Buffer.from(original); updated[updated.length - 1] = 2;
  fs.writeFileSync(dependency, updated); fs.utimesSync(dependency, 1700000000, 1700000000);
  const second = Fna.__test.prepareGame(entry, context), expected = Buffer.from(updated); expected.writeUInt16LE(0xaa64, 132);
  assert.equal(second.gameRoot, first.gameRoot);
  assert.deepEqual(fs.readFileSync(privateDependency), expected);
  assert.deepEqual(fs.readFileSync(dependency), updated, "Architecture conversion must preserve source bytes");
  const retained = path.join(context.userDataDir, "games", entry.gameId, "modules", "fna", "previous-overlays");
  assert.equal(fs.readdirSync(retained).length, 1);
  assert.equal(fs.readFileSync(path.join(retained, fs.readdirSync(retained)[0], "save.dat"), "utf8"), "private save");
});

test("FNA source identity drift with identical bytes keeps the overlay and local writes without copying", t => {
  const { entry, root, source } = game(t), selected = selection(t);
  const config = path.join(source, "game.cfg"); fs.writeFileSync(config, "original config");
  t.mock.method(Manager, "resolveSelection", () => selected);
  const context = { userDataDir: path.join(root, "userData"), settings: {}, runtimeSettings: {} };
  const first = Fna.__test.prepareGame(entry, context), marker = path.join(first.gameRoot, ".maclauncher-fna.json");
  const cacheRoot = path.join(context.userDataDir, "games", entry.gameId, "modules", "fna", "source-inventories");
  const cacheFile = path.join(cacheRoot, fs.readdirSync(cacheRoot)[0]);
  const cachedBefore = JSON.parse(fs.readFileSync(cacheFile, "utf8")).files.find(file => file.path === "game.cfg");
  const stamp = fs.readFileSync(marker, "utf8"), privateConfig = path.join(first.gameRoot, "game.cfg");
  fs.writeFileSync(privateConfig, "local game config");
  const before = fs.statSync(config, { bigint: true }), replacement = path.join(root, "identical.cfg");
  fs.copyFileSync(config, replacement); fs.renameSync(replacement, config);
  fs.utimesSync(config, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9);
  assert.notEqual(fs.statSync(config, { bigint: true }).ino, before.ino);
  const copy = fs.copyFileSync; let copies = 0;
  t.mock.method(fs, "copyFileSync", (...args) => { copies++; return copy(...args); });
  const second = Fna.__test.prepareGame(entry, context);
  assert.equal(copies, 0);
  assert.equal(second.gameRoot, first.gameRoot); assert.equal(fs.readFileSync(marker, "utf8"), stamp);
  const cachedAfter = JSON.parse(fs.readFileSync(cacheFile, "utf8")).files.find(file => file.path === "game.cfg");
  assert.notEqual(cachedAfter.identity, cachedBefore.identity);
  assert.equal(cachedAfter.sha256, cachedBefore.sha256);
  assert.equal(cachedAfter.sha256, Native.hashFile(config));
  assert.equal(fs.readFileSync(privateConfig, "utf8"), "local game config");
  assert.equal(fs.existsSync(path.join(context.userDataDir, "games", entry.gameId, "modules", "fna", "previous-overlays")), false);
});

test("FNA warm source checks reuse hashes and ignore live linked content changes", t => {
  const { root, source, assembly } = game(t), content = path.join(source, "Content"); fs.mkdirSync(content);
  fs.writeFileSync(path.join(content, "large-asset.bin"), Buffer.alloc(1024));
  const linked = path.join(source, "extra.bin"); fs.writeFileSync(linked, "one");
  const options = { assemblyPath: assembly, converted: true, retargeted: true, cacheFile: path.join(root, "cache", "inputs.json") };
  const readdir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (file, ...args) => { assert.notEqual(file, content, "Linked asset trees must not be scanned"); return readdir(file, ...args); });
  const cold = SourceInventory.inspectSources(source, options);
  assert.equal(cold.statistics.hashedFiles, 2);
  const stamp = fs.readFileSync(options.cacheFile, "utf8"), warm = SourceInventory.inspectSources(source, options);
  assert.equal(warm.digest, cold.digest); assert.equal(warm.statistics.hashedFiles, 0); assert.equal(warm.statistics.reusedFiles, 2);
  assert.equal(fs.readFileSync(options.cacheFile, "utf8"), stamp);
  fs.writeFileSync(path.join(content, "large-asset.bin"), "updated live asset"); fs.writeFileSync(linked, "new linked bytes");
  const refreshed = SourceInventory.inspectSources(source, options);
  assert.equal(refreshed.digest, cold.digest); assert.equal(refreshed.statistics.hashedFiles, 0);
});

test("FNA source-directory aliases reuse the same physical input inventory and overlay", t => {
  const { entry, root, source } = game(t), selected = selection(t);
  t.mock.method(Manager, "resolveSelection", () => selected);
  const context = { userDataDir: path.join(root, "userData"), settings: {}, runtimeSettings: {} };
  const first = Fna.__test.prepareGame(entry, context), alias = path.join(root, "Game Alias"); fs.symlinkSync(source, alias, "dir");
  const alternate = { ...entry, gamePath: path.join(alias, "Game.dll"), moduleData: { ...entry.moduleData, assemblyPath: path.join(alias, "Game.dll") } };
  const copy = fs.copyFileSync; let copies = 0;
  t.mock.method(fs, "copyFileSync", (...args) => { copies++; return copy(...args); });
  assert.equal(Fna.__test.prepareGame(alternate, context).gameRoot, first.gameRoot);
  assert.equal(copies, 0);
  assert.equal(fs.lstatSync(path.join(first.gameRoot, "FNA.dll")).isSymbolicLink(), false);
});

test("FNA rejects source mutation during streaming hashes without publishing a ready overlay", t => {
  const { entry, root, source } = game(t), selected = selection(t), config = path.join(source, "game.cfg");
  fs.writeFileSync(config, Buffer.alloc(SourceInventory.LIMITS.chunkBytes + 32, 1));
  const inode = fs.statSync(config, { bigint: true }).ino, before = fs.statSync(config);
  const read = fs.readSync; let mutated = false;
  t.mock.method(fs, "readSync", (descriptor, ...args) => {
    const count = read(descriptor, ...args);
    if (!mutated && fs.fstatSync(descriptor, { bigint: true }).ino === inode) {
      mutated = true; fs.writeFileSync(config, Buffer.alloc(SourceInventory.LIMITS.chunkBytes + 32, 2)); fs.utimesSync(config, before.atime, before.mtime);
    }
    return count;
  });
  t.mock.method(Manager, "resolveSelection", () => selected);
  const context = { userDataDir: path.join(root, "userData"), settings: {}, runtimeSettings: {} };
  assert.throws(() => Fna.__test.prepareGame(entry, context), { code: "SOURCE_CHANGED" });
  assert.equal(mutated, true);
  assert.equal(fs.existsSync(path.join(context.userDataDir, "games", entry.gameId, "modules", "fna", "overlays")), false);
});

test("FNA cancelled source checks do not create an inventory or overlay", t => {
  const { entry, root } = game(t), selected = selection(t), controller = new AbortController();
  controller.abort(); t.mock.method(Manager, "resolveSelection", () => selected);
  const context = { userDataDir: path.join(root, "userData"), settings: {}, runtimeSettings: {}, signal: controller.signal };
  assert.throws(() => Fna.__test.prepareGame(entry, context), { code: "ABORT_ERR" });
  assert.equal(fs.existsSync(context.userDataDir), false);
});

test("FNA rejects mutation during copying and preserves the previous valid overlay", t => {
  const { entry, root, source, assembly } = game(t), selected = selection(t), config = path.join(source, "game.cfg");
  fs.writeFileSync(config, "original config"); t.mock.method(Manager, "resolveSelection", () => selected);
  const context = { userDataDir: path.join(root, "userData"), settings: {}, runtimeSettings: {} };
  const first = Fna.__test.prepareGame(entry, context), marker = path.join(first.gameRoot, ".maclauncher-fna.json");
  const stamp = fs.readFileSync(marker, "utf8"), privateConfig = fs.readFileSync(path.join(first.gameRoot, "game.cfg"), "utf8");
  writeAssembly(assembly, { version: [2, 0, 0, 0] });
  const canonicalAssembly = fs.realpathSync(assembly);
  const copy = fs.copyFileSync; let mutated = false;
  t.mock.method(fs, "copyFileSync", (from, ...args) => {
    const result = copy(from, ...args);
    if (!mutated && from === canonicalAssembly) { mutated = true; fs.writeFileSync(config, "changed config!"); }
    return result;
  });
  assert.throws(() => Fna.__test.prepareGame(entry, context), { code: "SOURCE_CHANGED" });
  assert.equal(mutated, true); assert.equal(fs.readFileSync(marker, "utf8"), stamp);
  assert.equal(fs.readFileSync(path.join(first.gameRoot, "game.cfg"), "utf8"), privateConfig);
  const module = path.join(context.userDataDir, "games", entry.gameId, "modules", "fna");
  assert.equal(fs.existsSync(path.join(module, "previous-overlays")), false);
  assert.ok(fs.readdirSync(path.join(module, "overlays")).every(name => !name.startsWith(".prepare-")));
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

test("FNA staging rejects recursive user data and symbolic links", t => {
  const { entry, root, source } = game(t), selected = selection(t); t.mock.method(Manager, "resolveSelection", () => selected);
  const context = { userDataDir: path.join(source, "launcher-data"), settings: {}, runtimeSettings: { useRuntimeFramework: true } };
  assert.throws(() => Fna.__test.prepareGame(entry, context), /separate/);
  context.userDataDir = path.join(root, "userData"); fs.symlinkSync(entry.gamePath, path.join(source, "linked.dll"));
  assert.throws(() => Fna.__test.prepareGame(entry, context), /symbolic links/);
});

test("XNA conversion replaces bundled Windows framework facades only in the private copy", t => {
  const { entry, root, source } = game(t, { references: [{ name: "Microsoft.Xna.Framework", version: [4, 0, 0, 0] }] }), selected = selection(t);
  const abi = path.join(selected.profile.root, "abi"); fs.mkdirSync(abi);
  fs.writeFileSync(path.join(abi, "Microsoft.Xna.Framework.dll"), "reviewed type forwarders");
  fs.writeFileSync(path.join(source, "Microsoft.Xna.Framework.dll"), "original Windows framework");
  t.mock.method(Manager, "resolveSelection", () => selected);
  const prepared = Fna.__test.prepareGame(entry, { userDataDir: path.join(root, "userData"), settings: {}, runtimeSettings: { useRuntimeFramework: true } });
  assert.equal(fs.readFileSync(path.join(prepared.gameRoot, "Microsoft.Xna.Framework.dll"), "utf8"), "reviewed type forwarders");
  assert.equal(fs.readFileSync(path.join(source, "Microsoft.Xna.Framework.dll"), "utf8"), "original Windows framework");
});

test("FNA launches a separate host and passes opt-in graphics and argument settings", async t => {
  const { entry, root } = game(t), selected = selection(t); t.mock.method(Manager, "resolveSelection", () => selected);
  const focus = require("../src/modules/shared/runtime/native-focus"), spawnForeground = focus.spawnForegroundNativeGame;
  t.mock.method(focus, "spawnForegroundNativeGame", options => spawnForeground(options, { focus: async () => ({ activated: true }) }));
  let call; const context = { userDataDir: path.join(root, "userData"), settings: {}, runtimeSettings: { useRuntimeFramework: true, softwareOpenGL: true, appArgs: ["--level", "a b"] }, spawnDetachedChecked: (...args) => { call = args; return { pid: 1 }; } };
  await Fna.launchRuntime("fna", entry, context);
  assert.equal(call[0], selected.install.executablePath); assert.equal(call[1][0], "exec"); assert.deepEqual(call[1].slice(-3), [selected.profile.root, "--level", "a b"]);
  assert.equal(call[2].env.MACLAUNCHER_ALLOW_SOFTWARE_OPENGL, "1"); assert.equal(call[2].env.FNA3D_FORCE_DRIVER, "OpenGL"); assert.equal(call[3], false);
  if (process.platform === "darwin") assert.equal(call[2].env.SDL_MAC_BACKGROUND_APP, "0");
  context.runtimeSettings.appArgs = ["bad\0arg"]; await assert.rejects(Fna.launchRuntime("fna", entry, context), /arguments/);
});

test("FNA build overlays affect only private inputs and retain default accelerated graphics", t => {
  const root = fixture(t), source = path.join(root, "upstream.cs"), destination = path.join(root, "staged.cs");
  const line = "[assembly: TypeForwardedToAttribute(typeof(Microsoft.Xna.Framework.GamerServices.GamerServicesComponent))]\n";
  fs.writeFileSync(source, line + "// other types\n"); Build.__test.stageAbiSource(source, destination);
  assert.equal(fs.readFileSync(source, "utf8"), line + "// other types\n"); assert.equal(fs.readFileSync(destination, "utf8"), "// other types\n");
  const gl = path.join(root, "lib", "FNA3D", "src", "FNA3D_Driver_OpenGL.c"); fs.mkdirSync(path.dirname(gl), { recursive: true }); fs.writeFileSync(gl, "SDL_GL_SetAttribute(SDL_GL_ACCELERATED_VISUAL, 1);");
  Build.__test.applyOpenGLPolicy(root); assert.match(fs.readFileSync(gl, "utf8"), /MACLAUNCHER_ALLOW_SOFTWARE_OPENGL/); assert.match(fs.readFileSync(gl, "utf8"), /\? 0 : 1/);
  assert.throws(() => Build.__test.applyOpenGLPolicy(root), /no longer matches/);
  assert.equal(Build.__test.runtimeConfig().runtimeOptions.rollForward, "Disable");
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
  for (const relative of Build.__test.REQUIRED_FILES) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, relative); files[relative] = Native.hashFile(file); }
  const record = { profile: Build.PROFILE, upstreamRevision: Build.FNA_REVISION, dotnetVersion: Build.DOTNET_VERSION, frameworkVersion: "26.10.0.0", architecture: "arm64", files };
  const metadata = path.join(root, "fna-runtime.json"); fs.writeFileSync(metadata, JSON.stringify(record));
  assert.equal(Build.verifyRuntime({ executablePath: path.join(root, "dotnet") }).dotnetVersion, "8.0.31");
  fs.writeFileSync(path.join(root, "FNA.dll"), "modified"); assert.throws(() => Build.verifyRuntime({ executablePath: path.join(root, "dotnet") }), /integrity/);
  record.frameworkVersion = "23.8.0.0"; fs.writeFileSync(metadata, JSON.stringify(record)); assert.throws(() => Build.verifyRuntime({ executablePath: path.join(root, "dotnet") }), /metadata/);
});

test("FNA portable tools download only when a local executable is absent", async t => {
  const temporary = fixture(t); let downloads = 0;
  const found = await Build.__test.resolveBuildTool("ninja", { temporary, findBuildTool: () => "/local/ninja", packageArchive: async () => { downloads++; } });
  assert.equal(found, "/local/ninja"); assert.equal(downloads, 0);
  const installed = await Build.__test.resolveBuildTool("ninja", { temporary, findBuildTool: () => { throw Error("Missing"); }, packageArchive: async (_name, root) => {
    downloads++; fs.mkdirSync(root, { recursive: true }); const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(2, 12); fs.writeFileSync(path.join(root, "ninja"), bytes);
  } });
  assert.equal(downloads, 1); assert.deepEqual(Native.readMachOArchitectures(installed), ["arm64"]);
});

test("FNA compiler preserves declared shader resource identities and refuses missing or duplicate inputs", t => {
  const root = fixture(t), resource = path.join(root, "Sprite.fxb");
  fs.writeFileSync(resource, Buffer.from([1, 2, 3, 4]));
  const item = '<EmbeddedResource Include="Sprite.fxb"><LogicalName>Stock.Sprite.fxb</LogicalName></EmbeddedResource>';
  const project = path.join(root, "FNA.Core.csproj"); fs.writeFileSync(project, '<Project>' + item + '</Project>');
  const resources = Build.__test.frameworkResources(root), response = path.join(root, "compile.rsp");
  Build.__test.writeCompilerResponse(response, { sources: [], references: [], resources, output: path.join(root, "Framework.dll") });
  assert.match(fs.readFileSync(response, "utf8"), /\/resource:"[^\n]+Sprite\.fxb",Stock\.Sprite\.fxb/);
  fs.writeFileSync(project, '<Project>' + item + item + '</Project>');
  assert.throws(() => Build.__test.frameworkResources(root), /duplicate/);
  fs.writeFileSync(project, '<Project>' + item + '</Project>'); fs.rmSync(resource);
  assert.throws(() => Build.__test.frameworkResources(root), /ENOENT/);
});

test("FNA upgrades the retired host profile without changing stored version evidence", t => {
  const manager = Manager.createManager(), root = fixture(t);
  const entry = { runtimeData: { fna: { version: "26.10-net8-arm64-v1" } } };
  const result = manager.resolveSelection(entry, {}, root);
  assert.equal(result.version, Build.PROFILE); assert.equal(result.upgradedFromVersion, "26.10-net8-arm64-v1");
  assert.equal(entry.runtimeData.fna.version, "26.10-net8-arm64-v1");
  assert.equal(manager.getState({ userDataDir: root, settings: { defaultVersion: "26.10-net8-arm64-v1" } }).defaultVersion, Build.PROFILE);
  const legacy = manager.core.catalog.find(pin => pin.version === "26.10-net8-arm64-v1");
  assert.equal(legacy.deprecated, true); assert.match(legacy.installReason, /shader/);
});

test("FNA included resources verify final relocated bytes without copies, source or downloads", async t => {
  const root = fixture(t), resources = path.join(root, "resources"), directory = path.join(resources, "fna", "arm64"), payload = path.join(directory, "files", "fna"); fs.mkdirSync(payload, { recursive: true });
  for (const relative of Build.__test.REQUIRED_FILES) { const file = path.join(payload, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "sealed " + relative); }
  const executable = Buffer.alloc(32); executable.writeUInt32LE(0xfeedfacf); executable.writeUInt32LE(0x0100000c, 4); executable.writeUInt32LE(2, 12); fs.writeFileSync(path.join(payload, "dotnet"), executable, { mode: 0o755 });
  fs.writeFileSync(path.join(payload, "LICENSE.txt"), "test notice");
  fs.writeFileSync(path.join(payload, "fna-runtime.json"), JSON.stringify({ profile: Build.PROFILE, upstreamRevision: Build.FNA_REVISION, frameworkVersion: "26.10.0.0", dotnetVersion: Build.DOTNET_VERSION, architecture: "arm64", files: Object.fromEntries(Build.__test.REQUIRED_FILES.map(name => [name, "b".repeat(64)])) }));
  const Bundled = require("../src/modules/shared/runtime/bundled-native");
  const files = Bundled.fileInventory(path.join(directory, "files")).map(relative => { const file = path.join(directory, "files", relative), stat = fs.statSync(file); return { path: relative, size: stat.size, sha256: Native.hashFile(file), mode: stat.mode & 0o777, ...(relative === "fna/dotnet" ? { architectures: ["arm64"] } : {}) }; });
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, managerId: "fna", version: Build.PROFILE, upstreamRevision: Build.FNA_REVISION, platform: "darwin", arch: "arm64", minimumMacOS: "13.0", executableRelative: "fna/dotnet", files, dependencies: [], notices: [{ name: "Fixture notice", license: "Test", sourceUrl: "https://example.com", path: "fna/LICENSE.txt" }], provenance: { sourceRevision: Build.FNA_REVISION } }));
  const manager = Manager.createManager({ dependencies: { bundle: { resourceRoot: resources, platform: "darwin", arch: "arm64", dependencies: { systemVersion: async () => "13.0", systemVersionSync: () => "13.0", verifySignatures: async () => {}, verifySignaturesSync: () => {} } }, manager: { downloadToFile: () => { throw Error("Unexpected download"); } }, build: { findBuildTool: () => { throw Error("Unexpected source build"); } } } });
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const userDataDir = path.join(root, "userData"), install = await manager.installRuntime({ userDataDir, version: Build.PROFILE });
  assert.equal(install.source, "bundled"); const result = manager.resolveSelection({}, {}, userDataDir); assert.equal(result.ready, true);
  assert.equal(install.bundledExecution, "direct"); assert.equal(install.readOnly, true); assert.equal(install.removable, false);
  assert.equal(fs.existsSync(userDataDir), false);
  assert.equal(result.profile.files["FNA.dll"], Native.hashFile(path.join(payload, "FNA.dll")));
  const verifyRuntime = Build.verifyRuntime; let profileChecks = 0;
  t.mock.method(Build, "verifyRuntime", (...args) => { profileChecks++; return verifyRuntime(...args); });
  for (let i = 0; i < 20; i++) assert.equal(manager.getState({ userDataDir }).installed[0].ready, true);
  assert.equal(profileChecks, 1, "warm runtime broadcasts must reuse profile byte validation");
  assert.equal(manager.resolveSelection({}, {}, userDataDir).ready, true);
  assert.equal(profileChecks, 2, "execution selection must still verify the whole profile");
  fs.writeFileSync(path.join(result.profile.root, "FNA.dll"), "corrupt final bytes");
  const damaged = manager.getState({ userDataDir });
  assert.equal(damaged.installed[0].ready, false); assert.equal(damaged.sections[0].installed[0].ready, false);
  assert.equal(manager.resolveSelection({}, {}, userDataDir).ready, false);
});

test("FNA explicit refresh lists monthly history without broadening install qualification", async t => {
  const Github = require("../src/modules/shared/runtime/github-releases"), root = fixture(t); let requests = 0;
  t.mock.method(Github, "fetchGithubTags", async options => {
    requests++; assert.equal(options.latestOnly, undefined); return [{ name: "26.10", commit: { sha: Build.FNA_REVISION } }, { name: "23.08", commit: { sha: "a".repeat(40) } }];
  });
  const manager = Manager.createManager(); assert.equal(requests, 0); manager.getState({ userDataDir: root }); assert.equal(requests, 0);
  const catalog = await manager.refreshCatalog({ userDataDir: root, force: true });
  assert.equal(requests, 1); assert.ok(catalog.versions.includes("23.08-net8-arm64-v2"));
  assert.equal(catalog.supportsLatestOnly, false);
  assert.deepEqual(catalog.installableVersions, process.platform === "darwin" && process.arch === "arm64" && !catalog.includedVersions.includes(Build.PROFILE) ? [Build.PROFILE] : []);
  const missing = manager.resolveSelection({ runtimeData: { fna: { version: "23.08-net8-arm64-v2" } } }, {}, root);
  assert.equal(missing.ready, false); assert.equal(missing.version, "23.08-net8-arm64-v2");
});

test("FNA runtime state and module imports remain offline and independent from Electron", t => {
  const root = fixture(t); t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network"); });
  const manager = Manager.createManager(); const state = manager.getState({ userDataDir: root });
  assert.equal(state.catalog.supportsLatestOnly, false); assert.ok(state.catalog.versions.includes(Build.PROFILE));
  const child = spawnSync(process.execPath, ["-e", "const M=require('node:module');const original=M._load;M._load=function(id,...args){if(id==='electron')throw Error('Electron imported');return original.call(this,id,...args)};require('./src/modules/fna/main');"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
});

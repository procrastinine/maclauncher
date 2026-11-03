const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const Alice = require("../src/modules/alicesoft/main");

function game(root, generation) {
  const directory = path.join(root, generation);
  fs.mkdirSync(directory);
  if (generation === "system4") {
    const ain = Buffer.alloc(16); ain.write("VERS"); ain.writeUInt32LE(5, 4);
    const compressed = zlib.deflateSync(ain), header = Buffer.alloc(16);
    header.write("AI2"); header.writeUInt32LE(ain.length, 8); header.writeUInt32LE(compressed.length, 12);
    fs.writeFileSync(path.join(directory, "Game.ain"), Buffer.concat([header, compressed]));
    fs.writeFileSync(path.join(directory, "System40.ini"), 'CodeName = "Game.ain"\nSaveFolder = "Authored"\n');
  } else {
    const bytes = Buffer.alloc(768);
    if (generation === "system35") {
      bytes.writeUIntLE(1, 0, 3); bytes.writeUIntLE(2, 3, 3);
      bytes[256] = 1; bytes.writeUInt16LE(1, 257); bytes.writeUInt32LE(32, 512); bytes.writeUInt32LE(4, 516); bytes.write("S380", 544);
      fs.writeFileSync(path.join(directory, "ExampleSA.ALD"), bytes);
      fs.writeFileSync(path.join(directory, ".xsys35rc"), "savedir: Authored\n");
    } else {
      bytes.writeUInt16LE(2, 0); bytes.writeUInt16LE(3, 2);
      fs.writeFileSync(path.join(directory, "ADISK.DAT"), bytes);
      fs.writeFileSync(path.join(directory, "system3.ini"), "[config]\nsavedir = Authored\n");
    }
  }
  return directory;
}

test("ordinary AliceSoft Play retains original cwd and native authored save policy; overrides remain explicit", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alicesoft-paths-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "userdata");
  for (const [generation, runtimeId] of [["system3", "system3"], ["system35", "xsystem35"], ["system4", "xsystem4"]]) {
    const directory = game(root, generation);
    const entry = { gameId: generation, contentRootDir: directory, moduleData: { generation }, defaultSaveDir: path.join(userDataDir, "old-saves") };
    const manager = Alice.runtimeManagers.find(item => item.id === runtimeId);
    const resolve = manager.resolveSelection, catalog = manager.core.listCatalog;
    manager.resolveSelection = () => ({ version: "fixture", install: { runtimePath: path.join(root, "runtime"), source: "local" } });
    manager.core.listCatalog = () => [];
    try {
      const environment = { HOME: path.join(root, "home") };
      const context = { userDataDir, settings: {}, runtimeSettings: {}, gameArguments: ["native-option"], environment };
      const initialNames = fs.readdirSync(directory);
      const spec = Alice.resolveLaunchSpec(runtimeId, entry, context);
      assert.equal(spec.cwd, directory);
      assert.ok(!spec.args.includes("-savedir") && !spec.args.includes("--save-folder"));
      assert.ok(spec.args.includes("native-option"));
      const expectedSaveDir = generation === "system4"
        ? path.join(environment.HOME, ".xsystem4", "Game.ain", "Authored") : path.join(directory, "Authored");
      assert.equal(entry.defaultSaveDir, expectedSaveDir);
      assert.deepEqual(Alice.resolveSaveLocations(entry, context), { primaryDirectory: expectedSaveDir,
        directories: [{ directory: expectedSaveDir, role: "primary", label: "Native saves" }] });
      assert.deepEqual(entry.saveLocations, Alice.resolveSaveLocations(entry, context).directories);
      assert.equal(fs.existsSync(userDataDir), false, "ordinary Play creates no launcher game/save directory");
      assert.deepEqual(fs.readdirSync(directory), initialNames);
      if (runtimeId === "xsystem4") assert.equal(spec.args.at(-1), path.join(directory, "System40.ini"));
      entry.saveDirOverride = path.join(root, generation + "-override");
      const overridden = Alice.resolveLaunchSpec(runtimeId, entry, context);
      const flag = runtimeId === "xsystem4" ? "--save-folder" : "-savedir";
      assert.equal(overridden.args[overridden.args.indexOf(flag) + 1], entry.saveDirOverride);
      assert.equal(fs.statSync(entry.saveDirOverride).isDirectory(), true);
      assert.equal(overridden.cwd, directory);
      assert.equal(entry.defaultSaveDir, entry.saveDirOverride);
      entry.saveDirOverride = "relative";
      assert.throws(() => Alice.resolveLaunchSpec(runtimeId, entry, context), /absolute/);
    } finally {
      manager.resolveSelection = resolve;
      manager.core.listCatalog = catalog;
    }
  }
});

test("save browsing resolves native defaults and layered configuration without creating folders", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alice-save-facts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); fs.mkdirSync(home);
  const environment = { HOME: home };
  const entry = generation => ({ contentRootDir: path.join(root, generation), moduleData: { generation } });
  for (const generation of ["system3", "system35", "system4"]) game(root, generation);
  const resolve = (generation, extra = {}) => Alice.resolveSaveLocations({ ...entry(generation), ...extra }, { environment });
  fs.unlinkSync(path.join(root, "system3", "system3.ini"));
  assert.equal(resolve("system3").primaryDirectory, path.join(root, "system3"));
  fs.unlinkSync(path.join(root, "system35", ".xsys35rc"));
  fs.writeFileSync(path.join(root, "system35", "asleep.asd"), "existing slot");
  assert.equal(resolve("system35").primaryDirectory, path.join(root, "system35"), "current folder discovery does not impose released slot-name guards");
  fs.writeFileSync(path.join(home, ".xsys35rc"), "savedir: ~/NativeSaves\n");
  assert.equal(resolve("system35").primaryDirectory, path.join(home, "NativeSaves"));
  const nativeHome = path.join(root, "native-home"); fs.mkdirSync(nativeHome);
  fs.writeFileSync(path.join(nativeHome, ".xsys4rc"), 'save-folder = "GlobalSaves"\n');
  const system4 = entry("system4");
  assert.equal(Alice.resolveSaveLocations(system4, { environment: { ...environment, XSYSTEM4_HOME: nativeHome } }).primaryDirectory,
    path.join(system4.contentRootDir, "GlobalSaves"));
  fs.writeFileSync(path.join(system4.contentRootDir, ".xsys4rc"), 'save-folder = "LocalSaves"\n');
  assert.equal(resolve("system4").primaryDirectory, path.join(system4.contentRootDir, "LocalSaves"));
  assert.equal(resolve("system3", { launchArguments: '-savedir "Command Saves"' }).primaryDirectory, path.join(root, "system3", "Command Saves"));
  assert.equal(resolve("system4", { launchArguments: '--save-folder=CommandSaves' }).primaryDirectory, path.join(root, "system4", "CommandSaves"));
  assert.equal(resolve("system4", { saveDirOverride: path.join(root, "explicit") }).primaryDirectory, path.join(root, "explicit"));
  assert.equal(fs.existsSync(path.join(home, "NativeSaves")), false);
  assert.equal(fs.existsSync(path.join(system4.contentRootDir, "LocalSaves")), false);
  assert.equal(fs.existsSync(path.join(root, "explicit")), false);
});

test("unresolved native save configuration stays unknown without blocking direct launch facts", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alice-save-unknown-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = game(root, "system4");
  fs.writeFileSync(path.join(directory, "System40.ini"), 'CodeName = "unterminated\n');
  const entry = { contentRootDir: directory, moduleData: { generation: "system4" } };
  assert.deepEqual(Alice.resolveSaveLocations(entry, { environment: {} }), { primaryDirectory: null, directories: [] });
  entry.saveDirOverride = path.join(root, "explicit");
  assert.equal(Alice.resolveSaveLocations(entry).primaryDirectory, entry.saveDirOverride, "known explicit save folder does not depend on malformed native defaults");
  assert.equal(Alice.resolveSaveLocations({ ...entry, launchArguments: "-gamedir other" }).primaryDirectory, null);
});

test("debugger save defaults precede user native arguments as in the released launch order", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alice-debug-order-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = game(root, "system35"), userDataDir = path.join(root, "profile");
  const entry = { gameId: "debug", contentRootDir: directory, moduleData: { generation: "system35" } };
  const manager = Alice.runtimeManagers.find(item => item.id === "xsystem35");
  const Native = require("../src/modules/shared/runtime/local-native");
  const Live = require("../src/modules/alicesoft/live-variables");
  const original = { selection: manager.resolveSelection, catalog: manager.core.listCatalog, runtime: Native.resolveLocalRuntime, start: Live.startSession };
  manager.resolveSelection = () => ({ version: "fixture", install: { runtimePath: path.join(root, "runtime"), source: "local" } });
  manager.core.listCatalog = () => [];
  Native.resolveLocalRuntime = () => ({ executablePath: "fixture-runtime", needsRosetta: false });
  Live.startSession = async options => { await options.spawn(directory); return { child: "fixture-child" }; };
  try {
    const calls = [], userSave = path.join(root, "user-native-save");
    const result = await Alice.launchRuntime("xsystem35", entry, { userDataDir, settings: {}, runtimeSettings: {},
      moduleLaunchOptions: { mode: "liveVariables" }, gameArguments: ["-savedir", userSave],
      spawnOwnedChecked: (...args) => { calls.push(args); return "fixture-child"; } });
    assert.equal(result, "fixture-child");
    const args = calls[0][1];
    assert.deepEqual(args.slice(0, 2), ["-savedir", path.join(userDataDir, "games", "debug", "modules", "alicesoft", "saves")]);
    assert.deepEqual(args.slice(2, 4), ["-savedir", userSave]);
    assert.equal(args.at(-1), "-debug_dap");
  } finally {
    manager.resolveSelection = original.selection; manager.core.listCatalog = original.catalog;
    Native.resolveLocalRuntime = original.runtime; Live.startSession = original.start;
  }
});

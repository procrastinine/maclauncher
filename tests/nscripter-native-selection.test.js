const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Module = require("../src/modules/nscripter/main");
const Runtime = require("../src/modules/shared/onsyuri/runtime/onsyuri-runtime");

test("Onsyuri refuses missing explicit versions and architectures instead of launching another install", t => {
  const previousMac = Runtime.listInstalledMac, previousWeb = Runtime.listInstalledWeb;
  t.after(() => { Runtime.listInstalledMac = previousMac; Runtime.listInstalledWeb = previousWeb; });
  Runtime.listInstalledMac = () => [
    { version: "0.7.7", variant: "arm64", installDir: "/owned/current" },
    { version: "0.7.6", variant: "x64", installDir: "/owned/older" }
  ];
  Runtime.listInstalledWeb = () => [{ version: "0.7.7", installDir: "/owned/web" }];
  const settings = { runtimes: { onsyuri: { mac: { defaultVersion: "0.7.7", defaultVariant: "arm64" } } } };
  assert.throws(() => Module.__test.resolveOnsyuriMacInstall("/owned", settings, { version: "0.7.5", variant: "arm64" }), /0\.7\.5.*unavailable/);
  assert.throws(() => Module.__test.resolveOnsyuriMacInstall("/owned", settings, { version: "0.7.7", variant: "x64" }), /x64.*unavailable/);
  assert.equal(Module.__test.resolveOnsyuriMacInstall("/owned", settings, { version: "0.7.6", variant: "x64" }).installDir, "/owned/older");
  assert.equal(Module.__test.resolveOnsyuriMacInstall("/owned", settings).installDir, "/owned/current");
  assert.throws(() => Module.__test.resolveOnsyuriWebInstall("/owned", {}, { version: "0.7.6" }), /0\.7\.6.*not installed/);
  assert.throws(() => Module.__test.resolveOnsyuriWebInstall("/owned", { runtimes: { onsyuri: { web: { defaultVersion: "0.7.6" } } } }), /0\.7\.6.*not installed/);
  Runtime.listInstalledMac = () => [{ version: "0.7.7", variant: "arm64", ready: false, error: "Runtime requires macOS 27.0." }];
  assert.throws(() => Module.__test.resolveOnsyuriMacInstall("/owned", settings), /requires macOS 27\.0/);
});

test("native save overrides go to the exact configured absolute directory with interpreter path separator", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-onsyuri-save-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, "game"), save = path.join(root, "private", "new saves");
  fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, "sentinel.dat"), "unchanged");
  const args = Module.__test.buildNativeLaunchArgs({ saveDirOverride: save }, game);
  assert.deepEqual(args, ["--root", game, "--save-dir", save + path.sep]);
  assert.equal(fs.statSync(save).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(game, "sentinel.dat"), "utf8"), "unchanged");
  assert.deepEqual(Module.__test.buildNativeLaunchArgs({}, game), ["--root", game]);
  assert.throws(() => Module.__test.buildNativeLaunchArgs({ saveDirOverride: "relative/save" }, game), /absolute/);
  assert.throws(() => Module.__test.buildNativeLaunchArgs({ saveDirOverride: 42 }, game), /absolute/);
});

test("versioned Lua libraries produce the dependency install hint", () => {
  const info = Module.__test.parseMissingDylibs("/owned/onsyuri:\n\t/opt/homebrew/opt/lua/lib/liblua.5.5.dylib (compatibility version 5.5.0)\n", () => false);
  assert.deepEqual(info.brewHints, ["lua"]);
});

test("NScripter encoding selection preserves Japanese defaults, Chinese overrides and declared UTF scripts", () => {
  assert.equal(Module.__test.resolveScriptEncoding({}, {}), "sjis");
  assert.equal(Module.__test.resolveScriptEncoding({}, { scriptEncoding: "gbk" }), "gbk");
  assert.equal(Module.__test.resolveScriptEncoding({ needsAlias: true }, { scriptEncoding: "sjis" }), "utf8");
  assert.equal(Module.__test.resolveScriptEncoding({}, { scriptEncoding: "runtime" }), "runtime");
  assert.throws(() => Module.__test.resolveScriptEncoding({}, { scriptEncoding: "utf8 --debug:1" }), /supported.*encoding/);
});

test("Onsyuri web retains the trusted launch context when delegating to NW.js", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-onsyuri-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, "game"), runtime = path.join(root, "runtime");
  fs.mkdirSync(game); fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(game, "0.txt"), "*define\ngame\n*start\nend\n");
  fs.writeFileSync(path.join(runtime, "index.html"), "<html><body></body></html>");
  t.mock.method(Runtime, "listInstalledWeb", () => [{ version: "0.7.7", installDir: runtime }]);
  const context = { userDataDir: path.join(root, "profile"), settings: {}, moduleSettings: {},
    spawnDetachedChecked: () => assert.fail("delegated process is not launched in this test") };
  const NW = require("../src/modules/shared/web/runtime/nwjs-patched-launcher");
  let received;
  t.mock.method(NW, "launchRuntime", async options => { received = options; return { pid: 123 }; });
  await Module.launchRuntime("onsyuri_web", { gameId: "onsyuri-game", gamePath: game, contentRootDir: game }, context);
  assert.equal(received.context, context);
  assert.equal(received.entry.gameType, "web");
  assert.equal(fs.readFileSync(path.join(game, "0.txt"), "utf8"), "*define\ngame\n*start\nend\n");
});

test("external NScripter apps use their native executable for effects and retain Launch Services when disabled", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-onsyuri-app-effects-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, "game"), app = path.join(root, "External.app"), executable = path.join(app, "Contents", "MacOS", "interpreter");
  fs.mkdirSync(game); fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(path.join(game, "0.txt"), "*define\ngame\n*start\nend\n");
  fs.writeFileSync(executable, "publisher binary", { mode: 0o755 });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), '<?xml version="1.0"?><plist><dict><key>CFBundleExecutable</key><string>interpreter</string></dict></plist>');
  const entry = { gameId: "external-game", gamePath: game, contentRootDir: game };
  for (const enabled of [false, true]) {
    const context = { userDataDir: path.join(root, "profile"), settings: {}, moduleSettings: { externalRuntimePath: app },
      getGameEffectsEnvironment: async () => enabled ? { DYLD_INSERT_LIBRARIES: "/owned/effects.dylib" } : {},
      spawnDetachedChecked: (...args) => args };
    const result = await Module.launchRuntime("external", entry, context);
    assert.deepEqual(result, enabled ? [executable, ["--root", game], { cwd: game }] : ["open", ["-a", app, "--args", "--root", game]]);
  }
  assert.equal(fs.readFileSync(executable, "utf8"), "publisher binary");
});

test("NScripter graphics capabilities follow the selected native interpreter architecture", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nscripter-graphics-inputs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = (name, cpu) => {
    const file = path.join(root, name), bytes = Buffer.alloc(32);
    bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(cpu, 4); bytes.writeUInt32LE(2, 12);
    fs.writeFileSync(file, bytes);
    return file;
  };
  const arm = executable("onsyuri-arm", 0x0100000c), intel = executable("onscripter-intel", 0x01000007);
  t.mock.method(Runtime, "listInstalledMac", () => [
    { version: "current", variant: "arm64", executablePath: arm, ready: true },
    { version: "older", variant: "x64", executablePath: intel, ready: true }
  ]);
  const EN = require("../src/modules/nscripter/runtime/onscripter-en-manager");
  t.mock.method(EN, "resolveSelection", () => ({ ready: true, install: { executablePath: intel, needsRosetta: true } }));
  const context = { userDataDir: root, settings: {} };
  assert.deepEqual(Module.resolveGraphicsInputs({ runtimeId: "onsyuri_mac", runtimeData: { onsyuri: { version: "current", variant: "arm64" } } }, context), { architecture: "arm64" });
  assert.deepEqual(Module.resolveGraphicsInputs({ runtimeId: "onsyuri_mac", runtimeData: { onsyuri: { version: "older", variant: "x64" } } }, context), { architecture: "x86_64" });
  assert.deepEqual(Module.resolveGraphicsInputs({ runtimeId: "onscripter_en" }, context), { architecture: "x86_64" });
  assert.deepEqual(Module.resolveGraphicsInputs({ runtimeId: "external" }, { ...context, moduleSettings: { externalRuntimePath: intel } }), { architecture: "x86_64" });
  assert.equal(Module.resolveGraphicsInputs({ runtimeId: "onsyuri_web" }, context), null);
});

test("NScripter external app metadata uses its executable and unavailable inputs stay unknown", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nscripter-graphics-bundle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "Interpreter.app"), executable = path.join(app, "Contents", "MacOS", "publisher");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x01000007, 4); bytes.writeUInt32LE(2, 12);
  fs.writeFileSync(executable, bytes);
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), '<?xml version="1.0"?><plist><dict><key>CFBundleExecutable</key><string>publisher</string></dict></plist>');
  const context = { userDataDir: root, settings: {}, moduleSettings: { externalRuntimePath: app } };
  assert.deepEqual(Module.resolveGraphicsInputs({ runtimeId: "external" }, context), { architecture: "x86_64" });
  assert.deepEqual(Module.resolveGraphicsInputs({ runtimeId: "external" }, {
    ...context, moduleSettings: { externalRuntimePath: ` ${app} ` }
  }), { architecture: "x86_64" });
  t.mock.method(Runtime, "listInstalledMac", () => []);
  assert.equal(Module.resolveGraphicsInputs({ runtimeId: "onsyuri_mac" }, context), null);
  const EN = require("../src/modules/nscripter/runtime/onscripter-en-manager");
  t.mock.method(EN, "resolveSelection", () => ({ ready: false }));
  assert.equal(Module.resolveGraphicsInputs({ runtimeId: "onscripter_en" }, context), null);
  const script = path.join(root, "interpreter.sh");
  fs.writeFileSync(script, "#!/bin/sh\nexit 0\n");
  assert.equal(Module.resolveGraphicsInputs({ runtimeId: "external" }, { ...context, moduleSettings: { externalRuntimePath: script } }), null);
});

const assert = require("node:assert/strict");
const { EventEmitter, PassThrough } = require("node:stream");
const path = require("node:path");
const test = require("node:test");
const Modules = require("../src/modules/registry");
const SourceResolution = require("../src/modules/shared/reshade/source-resolution");
const Applications = require("../src/modules/window/applications");
const Launch = require("../src/modules/window/launch");
const WindowActions = require("../src/modules/window/app-actions");

const helper = { available: true, root: "/graphics", row: { path: Applications.HELPER }, executable: "/graphics/" + Applications.HELPER,
  library: "/graphics/libreshade-macos.dylib" };

test("window entries declare composed color only, so source and scene options stay hidden", () => {
  const mod = Modules.getModule("window"), info = Modules.getModuleInfo("window");
  assert.deepEqual(info.runtime.supported, ["capture"], "no runtime provider applies");
  assert.equal(info.runtime.entries.capture.graphicsHost, "window");
  assert.equal(info.runtime.entries.capture.explicitFrames, true);
  assert.equal(info.detection, undefined, "nothing is imported as a window");
  const inputs = mod.resolveGraphicsInputs({});
  assert.deepEqual(inputs, { source: "window-capture", sourceResolution: false, depth: false, motionVectors: false, methods: [] });
  assert.deepEqual(SourceResolution.candidates("window", inputs, [1, 1.5, 2], { activationAPI: 1 }), []);
  assert.equal(mod.canLaunchRuntime("capture"), process.platform === "darwin");
  assert.equal(mod.canLaunchRuntime("native"), false);
});

test("window graphics need macOS 15.2 and a graphics package that reports the window source", () => {
  const publication = { forRoot: () => ({ files: [{ path: Applications.HELPER }] }) };
  assert.match(Applications.availability({ platform: "darwin", macOSVersion: "15.1", root: "/graphics" }).reason, /macOS 15\.2/);
  assert.equal(Applications.availability({ platform: "linux", macOSVersion: "15.2", root: "/graphics" }).available, false);
  const older = Applications.availability({ platform: "darwin", macOSVersion: "26.0", root: "/graphics", publication,
    readRecord: () => ({ features: { graphics: { browserFrameAPI: 1 } } }) });
  assert.match(older.reason, /does not include window graphics/);
  const missing = Applications.availability({ platform: "darwin", macOSVersion: "26.0", root: "/nonexistent-graphics", publication,
    readRecord: () => ({ features: { graphics: { windowSourceAPI: 1 } } }) });
  assert.equal(missing.available, false);
});

test("the session helper runs through the launch context with the picked target", async () => {
  const calls = [];
  const child = Object.assign(new EventEmitter(), { pid: 99, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const logged = [];
  const context = { windowGraphics: () => helper, verifyFile: (root, row) => calls.push(["verify", root, row.path]), runtimeSettings: { captureCursor: true, output: "scaled" },
    logger: { info: line => logged.push(line), warn: line => logged.push(line) },
    spawnDetachedChecked: async (command, args, options) => { calls.push(["spawn", command, args, options]); return child; } };
  const entry = { gameId: "session1", moduleData: { target: "application", pid: 4242 } };
  assert.equal(await Launch.launch(entry, context), child);
  assert.deepEqual(calls[0], ["verify", "/graphics", Applications.HELPER]);
  const [, command, args, options] = calls[1];
  assert.equal(command, helper.executable);
  assert.deepEqual(args, ["--pid", "4242", "--scaled", "--cursor", "--library", helper.library]);
  assert.equal(options.graphicsExecutable, null, "the helper loads the library itself");
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  child.stdout.write('{"event":"heartbeat"}\n{"event":"selected","windowID":7}\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(logged, ['[window graphics] {"event":"selected","windowID":7}'], "heartbeats are not logged");
  const written = [];child.stdin.on("data", data => written.push(String(data)));
  assert.equal(Launch.runtimeSettingsChanged(entry, "capture", { captureCursor: false }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(written, ['{"cursor":false,"scaled":false}\n'], "capture settings reach the running session as an option line");
  child.emit("exit", 0, null);
  assert.equal(Launch.runtimeSettingsChanged(entry, "capture", { captureCursor: true }), false);
  assert.deepEqual(Launch.helperArguments({ moduleData: { target: "display" } }, helper, { output: "scaled" }), ["--display", "--library", helper.library],
    "a display is always shown in place");
  assert.deepEqual(Launch.helperArguments({ moduleData: { target: "application", pid: 5, waitWindow: 30 } }, helper),
    ["--pid", "5", "--wait-window", "30", "--library", helper.library]);
  await assert.rejects(Launch.launch({ moduleData: { target: "application" } }, context), /running app/);
  await assert.rejects(Launch.launch(entry, { ...context, windowGraphics: () => ({ available: false, reason: "Requires macOS 15.2 or later." }) }),
    /Window graphics are unavailable\. Requires macOS 15\.2/);
});

test("choosing Scaled output asks for Accessibility and keeps In place until it is granted", () => {
  const prompts = [];
  const ui = trusted => ({ systemPreferences: { isTrustedAccessibilityClient: prompt => { prompts.push(prompt);return trusted; } } });
  const inPlace = { output: "inPlace", captureCursor: false }, scaled = { output: "scaled", captureCursor: true };
  assert.deepEqual(Launch.reviewRuntimeSettings("capture", scaled, inPlace, ui(false)), { output: "inPlace", captureCursor: true },
    "a declined or pending permission keeps In place and the other edits");
  assert.deepEqual(prompts, [true], "the system prompt is requested");
  assert.equal(Launch.reviewRuntimeSettings("capture", scaled, inPlace, ui(true)), scaled);
  prompts.length = 0;
  assert.equal(Launch.reviewRuntimeSettings("capture", scaled, scaled, ui(false)), scaled, "an unchanged Scaled choice asks nothing");
  assert.equal(Launch.reviewRuntimeSettings("capture", inPlace, scaled, ui(false)), inPlace);
  assert.equal(Launch.reviewRuntimeSettings("other", scaled, inPlace, ui(false)), scaled);
  assert.deepEqual(prompts, []);
  assert.deepEqual(Launch.reviewRuntimeSettings("capture", scaled, inPlace, {}).output, "inPlace", "no permission service keeps In place");
  const manifest = require("../src/modules/window/manifest.json");
  const field = manifest.runtime.entries.capture.settings.fields.find(item => item.key === "output");
  assert.deepEqual(field.options.map(option => option.value), ["inPlace", "scaled"]);
  assert.equal(manifest.runtime.entries.capture.settings.defaults.output, "inPlace");
  assert.equal(typeof require("../src/modules/window/main.js").reviewRuntimeSettings, "function");
});

test("the app list offers running apps first and then the whole display", async () => {
  const listed = await WindowActions.applyGraphics.targets({ windowGraphics: () => helper,
    listApplications: async ({ executable, excludePid }) => { assert.equal(executable, helper.executable); assert.equal(excludePid, 7);
      return [{ pid: 11, name: "Example", path: "/Applications/Example.app", bundleIdentifier: "com.example.app" }]; }, excludePid: 7 });
  assert.deepEqual(listed.map(item => [item.id, item.label, Boolean(item.separatorBefore)]), [["application:11", "Example", false], ["display", "Entire Display", true]]);
  assert.equal(listed[0].iconPath, "/Applications/Example.app");
  assert.deepEqual(await WindowActions.applyGraphics.targets({ windowGraphics: () => ({ available: false }) }), []);
  const display = WindowActions.applyGraphics.createEntry({ kind: "display" }, { userDataDir: "/Library", gameId: "abc" });
  assert.deepEqual([display.ephemeral, display.name, display.gamePath, display.moduleData], [true, "Entire Display", path.join("/Library", "games", "abc"), { target: "display" }]);
  const app = WindowActions.applyGraphics.createEntry(listed[0].target, { userDataDir: "/Library", gameId: "def" });
  assert.equal(app.nativeAppPath, "/Applications/Example.app");
  assert.deepEqual(app.moduleData, { target: "application", pid: 11, bundleIdentifier: "com.example.app", applicationPath: "/Applications/Example.app" });
  assert.throws(() => WindowActions.applyGraphics.createEntry({ kind: "application", pid: -1, name: "x" }, { userDataDir: "/Library" }), /running app/);
});

test("64 running apps retain Entire Display within the generic menu target limit", async () => {
  const { createModuleAppActions } = require("../src/main/module-app-actions");
  const apps = Object.freeze(Array.from({ length: 64 }, (_, index) => Object.freeze({ pid: index + 100,
    name: "App " + index, path: "/Applications/App " + index + ".app", bundleIdentifier: "com.example.app" + index,
    executable: "/Applications/App " + index + ".app/Contents/MacOS/App" })));
  const snapshot = structuredClone(apps), chosen = [];
  const listed = await Applications.listApplications({ executable: helper.executable,
    execute: (_file, _args, _options, callback) => callback(null, JSON.stringify({ schema: 1, applications: apps })) });
  assert.equal(listed.length, 64, "the ordinary application source still permits 64 apps");
  const actions = createModuleAppActions({ registry: Modules, choose: (...args) => chosen.push(args),
    targetContext: () => ({ windowGraphics: () => helper, listApplications: async () => listed }) });
  await actions.refresh();
  const targets = actions.forShortcut("windowGraphics").targets;
  assert.equal(targets.length, 64, "63 applications and the display fit the unchanged coordinator cap");
  assert.deepEqual(targets.slice(0, 63).map(item => item.target), apps.slice(0, 63).map(app => ({ kind: "application", ...app })));
  assert.deepEqual(targets.at(-1), { id: "display", label: "Entire Display", separatorBefore: true, target: { kind: "display" } });
  for (const menu of ["file", "dock"]) {
    const items = actions.menuItems(menu, { icon: target => target.iconPath })[0].submenu;
    assert.equal(items.length, 65, "64 selectable items plus the existing display separator");
    assert.equal(items.filter(item => item.type !== "separator").length, 64);
    assert.deepEqual(items.slice(0, 63).map(item => [item.label, item.icon]), apps.slice(0, 63).map(app => [app.name, app.path]));
    assert.deepEqual(items[63], { type: "separator" });
    assert.equal(items[64].label, "Entire Display");
    items[64].click();
  }
  assert.deepEqual(chosen, [0, 1].map(() => ["window", "applyGraphics", targets.at(-1)]));
  assert.deepEqual(apps, snapshot, "source records retain every field and their original ordering");
  assert.deepEqual(listed, snapshot, "menu limits do not truncate or mutate the application source");
});

test("the helper's application list is validated", async () => {
  const execute = (file, args, options, callback) => {
    assert.deepEqual(args, ["--list-applications", "--exclude-pid", "3"]);
    assert.equal(Object.keys(options.env).some(key => /^(DYLD_|RESHADE_)/.test(key)), false);
    callback(null, JSON.stringify({ schema: 1, applications: [{ pid: 4, name: "Ok", path: "/Applications/Ok.app" }, { pid: 0, name: "Bad" },
      { pid: 5, name: "Line\nbreak" }, { pid: 6, name: "Relative", path: "Relative.app" }] }) + "\n");
  };
  assert.deepEqual(await Applications.listApplications({ executable: "/helper", excludePid: 3, execute }),
    [{ pid: 4, name: "Ok", path: "/Applications/Ok.app" }, { pid: 6, name: "Relative" }]);
});

test("a session whose heartbeat stops is ended", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let clock = 0;const killed = [];
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: signal => killed.push(signal) });
  Launch.watch(child, { logger: { info() {}, warn() {} }, now: () => clock });
  clock = 4000;t.mock.timers.tick(1000);
  child.stdout.write('{"event":"heartbeat"}\n');await new Promise(resolve => setImmediate(resolve));
  clock = 8500;t.mock.timers.tick(1000);
  assert.deepEqual(killed, [], "a heartbeat within the limit keeps the session");
  clock = 9100;t.mock.timers.tick(1000);
  assert.deepEqual(killed, ["SIGKILL"]);
});

test("an explicit frame producer on a live host gets the processed screenshot channel", { skip: process.platform !== "darwin" }, async t => {
  const fs = require("node:fs"), os = require("node:os");
  const ReShade = require("../src/modules/shared/reshade"), Native = require("../src/modules/shared/runtime/bundled-native");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "window-screenshots-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime"), userDataDir = path.join(root, "profile");
  fs.mkdirSync(path.join(runtime, "effects"), { recursive: true });
  for (const file of ["libreshade-macos.dylib", "fx-compile", "effects/crt.fx"]) fs.writeFileSync(path.join(runtime, file), "fixture");
  fs.writeFileSync(path.join(runtime, "runtime.json"), JSON.stringify({ schema: 1, version: "test", minimumMacOS: "11.0",
    features: { graphics: { effectPlanAPI: 1, screenshotAPI: 1 } } }));
  t.mock.method(Native, "systemVersionSync", () => "27.0");
  const options = { root: runtime, userDataDir, diagnostics: false, gpuTiming: false, trace: false, verify: () => true, execute: () => assert.fail("no shader") };
  const scaling = { schema: 2, mode: "advanced", enabled: true, video: [{ id: "spatial", kind: "spatial", enabled: true, method: "bilinear", settings: {} }] };
  const launchOf = environment => JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_CONTROL_FILE), "launch.json"), "utf8"));
  const window = await ReShade.prepare({ gameId: "window1", effects: scaling }, { ...options, graphicsHost: "window", explicitHost: true });
  assert.equal(window.RESHADE_EXPLICIT_HOST, "1");
  assert.equal(window.RESHADE_CAPTURE_FINAL, "1");
  assert.deepEqual(launchOf(window).screenshotCapture, { prefix: window.RESHADE_CAPTURE_PREFIX, trigger: window.RESHADE_CAPTURE_TRIGGER });
  const explicit = await ReShade.prepare({ gameId: "explicit1", effects: scaling }, { ...options, graphicsHost: "explicit", explicitHost: true });
  assert.equal(explicit.RESHADE_CAPTURE_FINAL, undefined, "other explicit producers keep their own capture contract");
  assert.equal(launchOf(explicit).screenshotCapture, undefined);
});

test("a pick owned by another process moves the session to that process's identity", async () => {
  const data = { target: "application", pid: 10, bundleIdentifier: "com.example.menu", applicationPath: "/Applications/Menu.app" };
  assert.equal(Launch.capturedApplication(data, { event: "selected", windowID: 3, pid: 10, bundleIdentifier: "com.example.menu" }), null);
  assert.equal(Launch.capturedApplication({ target: "display" }, { event: "selected", pid: 4 }), null);
  assert.deepEqual(Launch.capturedApplication(data, { event: "selected", windowID: 3, pid: 22, name: "Game", executable: "/Games/Game" }),
    { target: "application", pid: 22, executablePath: "/Games/Game", applicationName: "Game" });
  const child = Object.assign(new EventEmitter(), { pid: 99, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const changes = [];
  await Launch.launch({ gameId: "s2", name: "Menu", moduleData: data }, { windowGraphics: () => helper, verifyFile() {}, logger: { info() {}, warn() {} },
    onEntryChange: patch => changes.push(patch), spawnDetachedChecked: async () => child });
  child.stdout.write('{"event":"selected","executable":"/Games/Game","name":"Game","pid":22,"windowID":3}\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(changes, [{ moduleData: { target: "application", pid: 22, executablePath: "/Games/Game", applicationName: "Game" } }]);
  child.emit("exit", 0, null);
  // The ended session's stack is saved under the captured process, never the menu's app.
  const fs = require("node:fs"), os = require("node:os"), Stacks = require("../src/modules/shared/effects/application-stacks");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "window-identity-"));
  try {
    const effects = { schema: 2, mode: "advanced", enabled: true, video: [{ id: "gray", kind: "shader", enabled: true, shader: { enabled: true, preset: "grayscale" } }] };
    assert.equal(WindowActions.applyGraphics.endEntry({ name: "Menu", moduleData: changes[0].moduleData, effects }, { userDataDir }), "saved");
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(Stacks.location(userDataDir), "utf8")).stacks),
      [Stacks.key({ target: "application", executablePath: "/Games/Game", name: "Game" })]);
  } finally { fs.rmSync(userDataDir, { recursive: true, force: true }); }
});

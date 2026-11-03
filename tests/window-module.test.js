const assert = require("node:assert/strict");
const { EventEmitter, PassThrough } = require("node:stream");
const path = require("node:path");
const test = require("node:test");
const Modules = require("../src/modules/registry");
const SourceResolution = require("../src/modules/shared/reshade/source-resolution");
const Applications = require("../src/modules/window/applications");
const Launch = require("../src/modules/window/launch");
const WindowActions = require("../src/modules/window/app-actions");

const created = [];
const createEntry = WindowActions.applyGraphics.createEntry;
WindowActions.applyGraphics.createEntry = (...args) => { const entry = createEntry(...args);created.push(entry);return entry; };
test.afterEach(() => { for (const entry of created.splice(0)) WindowActions.applyGraphics.endEntry({ ...entry, moduleData: { targets: [] } }); });

const helper = { available: true, root: "/graphics", row: { path: Applications.HELPER }, executable: "/graphics/" + Applications.HELPER,
  library: "/graphics/libreshade-macos.dylib" };

test("window entries declare composed color only, so source and scene options stay hidden", () => {
  const mod = Modules.getModule("window"), info = Modules.getModuleInfo("window");
  assert.deepEqual(info.runtime.supported, ["capture"], "no runtime provider applies");
  assert.equal(info.runtime.entries.capture.graphicsHost, "window");
  assert.equal(info.runtime.entries.capture.explicitFrames, true);
  assert.equal(info.detection, undefined, "nothing is imported as a window");
  const inputs = mod.resolveGraphicsInputs({});
  assert.deepEqual(inputs, { source: "window-capture", sourceResolution: false, depth: false, motionVectors: false, methods: [], generationDefaults: { keepStaticContent: true } });
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
  assert.deepEqual(written, ['{"cursor":false,"scaled":false,"scale":0,"pointer":true}\n'], "capture settings reach the running session as an option line");
  child.emit("exit", 0, null);
  assert.equal(Launch.runtimeSettingsChanged(entry, "capture", { captureCursor: true }), false);
  assert.deepEqual(Launch.helperArguments({ moduleData: { target: "display", displayID: 1 } }, helper, { output: "scaled" }), ["--display", "1", "--library", helper.library],
    "a display is always shown in place");
  assert.deepEqual(Launch.helperArguments({ moduleData: { target: "application", pid: 5, waitWindow: 30 } }, helper),
    ["--pid", "5", "--wait-window", "30", "--library", helper.library]);
  await assert.rejects(Launch.launch({ moduleData: { target: "application" } }, context), /File > Apply Graphics/);
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
  assert.deepEqual(field.options.map(option => option.value), ["inPlace", "scaled", ...[150,200,250,300,400,500,600,800,1000].map(n => "scale" + n)]);
  assert.equal(manifest.runtime.entries.capture.settings.defaults.output, "inPlace");
  assert.equal(typeof require("../src/modules/window/main.js").reviewRuntimeSettings, "function");
});

test("the shortcut's app list holds running apps; each kind of choice creates its session entry", async () => {
  const listed = await WindowActions.applyGraphics.targets({ windowGraphics: () => helper,
    listApplications: async ({ executable, excludePid }) => { assert.equal(executable, helper.executable); assert.equal(excludePid, 7);
      return [{ pid: 11, name: "Example", path: "/Applications/Example.app", bundleIdentifier: "com.example.app" }]; }, excludePid: 7 });
  assert.deepEqual(listed.map(item => [item.id, item.label]), [["application:11", "Example"]]);
  assert.equal(listed[0].iconPath, "/Applications/Example.app");
  assert.deepEqual(await WindowActions.applyGraphics.targets({ windowGraphics: () => ({ available: false }) }), []);
  const create = (target, gameId = "abc") => WindowActions.applyGraphics.createEntry(target, { userDataDir: "/Library", gameId });
  const display = create({ kind: "display", displayID: 2, name: "Studio Display", uuid: "UUID-2" });
  assert.deepEqual([display.ephemeral, display.name, display.gamePath, display.moduleData.targets[0]],
    [true, "Studio Display", path.join("/Library", "games", "abc"), { target: "display", displayID: 2, displayName: "Studio Display", displayUUID: "UUID-2" }]);

  const window = create({ kind: "window", windowID: 40, pid: 11, name: "Example", title: "Document", path: "/Applications/Example.app",
    bundleIdentifier: "com.example.app", executable: "/Applications/Example.app/Contents/MacOS/Example" });
  assert.equal(window.nativeAppPath, "/Applications/Example.app");
  assert.deepEqual(window.moduleData.targets[0], { target: "window", pid: 11, windowID: 40, applicationName: "Example", windowTitle: "Document",
    bundleIdentifier: "com.example.app", applicationPath: "/Applications/Example.app", executablePath: "/Applications/Example.app/Contents/MacOS/Example" });
  const app = create(listed[0].target, "def");
  assert.deepEqual(app.moduleData.targets[0], { target: "application", pid: 11, frontWindow: true, bundleIdentifier: "com.example.app", applicationPath: "/Applications/Example.app" });
  assert.throws(() => create({ kind: "application", pid: -1, name: "x" }), /running app/);
  assert.throws(() => create({ kind: "window", pid: 11, name: "x" }), /window/);
  assert.throws(() => create({ kind: "display" }), /display/);
  assert.deepEqual(Launch.helperArguments(window, helper), ["--window", "40", "--library", helper.library]);
  assert.deepEqual(Launch.helperArguments(display, helper, { output: "scaled" }), ["--display", "2", "--library", helper.library]);
  assert.deepEqual(Launch.helperArguments({ moduleData: { target: "all-displays" } }, helper, { output: "scaled" }), ["--all-displays", "--library", helper.library]);
  assert.deepEqual(Launch.helperArguments(window, helper, { output: "scaled", captureCursor: true }), ["--window", "40", "--scaled", "--cursor", "--library", helper.library]);
});

test("the Apply Graphics picker lists displays, All Displays and windows by app, with thumbnails and icons", async () => {
  const updates = [];let catalog;let stopped = 0;let asked = 0;
  const watch = WindowActions.applyGraphics.picker({ windowGraphics: () => helper, get session() { assert.fail("the picker never asks a running session for its catalog"); }, excludePid: 7, screenAccess: async () => { asked++;return "granted"; },
    watchCatalog: options => { catalog = options;assert.equal(options.executable, helper.executable);assert.equal(options.excludePid, 7);return { stop: () => stopped++ }; } },
  update => updates.push(update));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(asked, 1, "MacLauncher checks Screen Recording before the catalog starts");
  catalog.onEvent(Applications.catalogEvent({ event: "icon", path: "/Applications/Example.app", image: "data:image/png;base64,iVBORw0K" }));
  assert.equal(updates.length, 0, "an icon alone changes nothing until the list names its app");
  catalog.onEvent(Applications.catalogEvent({ event: "catalog",
    displays: [{ id: 1, name: "Built-in Retina Display", width: 1512, height: 982, main: true, uuid: "UUID-1" }, { id: 2, name: "Studio Display", width: 2560, height: 1440 }],
    windows: [{ id: 40, pid: 11, application: "Example", title: "Document", path: "/Applications/Example.app", width: 800, height: 600, onScreen: true },
      { id: 41, pid: 11, application: "Example", width: 800, height: 600, onScreen: false, title: "Other" },
      { id: 0, pid: 11, application: "Invalid" }] }));
  const [displays, windows] = updates[0].sections;
  assert.deepEqual(displays.targets.map(target => [target.id, target.label, target.detail]),
    [["display:1", "Built-in Retina Display", "1512 × 982"], ["display:2", "Studio Display", "2560 × 1440"], ["displays:all", "All Displays", "2 displays"]]);
  assert.deepEqual(displays.targets[2].previews, ["display:1", "display:2"]);
  assert.deepEqual(displays.targets[0].target, { kind: "display", displayID: 1, name: "Built-in Retina Display", uuid: "UUID-1" });
  assert.deepEqual(windows.targets.map(target => [target.id, target.label, target.detail, target.group.label, target.group.icon, target.group.iconPath]),
    [["window:40", "Document", undefined, "Example", "data:image/png;base64,iVBORw0K", undefined], ["window:41", "Other", "Other Space or minimized", "Example", undefined, undefined]]);
  assert.equal(Applications.catalogEvent({ event: "icon", path: "relative", image: "data:image/png;base64,AA" }), null);
  assert.equal(Applications.catalogEvent({ event: "icon", path: "/Applications/Example.app", image: "data:image/svg+xml,<svg/>" }), null);
  assert.equal(windows.targets[0].target.kind, "window");
  catalog.onEvent(Applications.catalogEvent({ event: "thumbnail", target: "window:40", image: "data:image/jpeg;base64,AAAA" }));
  assert.deepEqual(updates[1], { thumbnails: { "window:40": "data:image/jpeg;base64,AAAA" } });
  assert.equal(Applications.catalogEvent({ event: "thumbnail", target: "window:40", image: "data:text/html,<b>" }), null);
  assert.equal(Applications.catalogEvent({ event: "catalog", displays: [{ id: 1, name: "One" }], windows: [] }).displays.length, 1);
  assert.deepEqual(Applications.catalogEvent({ event: "failed", reason: "The operation could not be completed." }), { event: "failed", reason: "The operation could not be completed." });
  assert.deepEqual(Applications.catalogEvent({ event: "failed", reason: "x".repeat(513) }), { event: "failed" });
  catalog.onEvent(Applications.catalogEvent({ event: "failed", reason: "The operation could not be completed." }));
  assert.deepEqual(updates.at(-1), { refreshOnFocus: true, sections: [], notice: { message: "The window list is unavailable. The operation could not be completed." } });
  catalog.onEvent(Applications.catalogEvent({ event: "failed" }));
  assert.equal(updates.at(-1).notice.message, "The window list is unavailable.");
  catalog.onExit(new Error(""));
  assert.deepEqual(updates.at(-1), { refreshOnFocus: true, sections: [], notice: { message: "The window list is unavailable." } }, "an ended catalog can be retried by refocusing");
  catalog.onEvent(Applications.catalogEvent({ event: "catalog", displays: [{ id: 1, name: "One" }], windows: [] }));
  assert.equal(updates.at(-1).notice, undefined, "the next list replaces the notice");
  watch.stop();assert.equal(stopped, 1);
});

test("without Screen Recording the picker lists apps for the system picker", async () => {
  const updates = [];let catalog;
  WindowActions.applyGraphics.picker({ windowGraphics: () => helper, watchCatalog: options => { catalog = options;return { stop() {} }; },
    listApplications: async () => [{ pid: 11, name: "Example", path: "/Applications/Example.app" }] }, update => updates.push(update));
  await new Promise(resolve => setImmediate(resolve));
  catalog.onEvent({ event: "permission", screenRecording: false });
  await new Promise(resolve => setImmediate(resolve));
  const [model] = updates;
  assert.equal(model.refreshOnFocus, true);
  assert.match(model.notice.message, /Screen & System Audio Recording/);
  assert.match(model.notice.link.url, /^x-apple\.systempreferences:/);
  assert.deepEqual(model.sections[0].targets, []);
  assert.deepEqual(model.sections[1].targets.map(target => [target.id, target.target.kind]), [["application:11", "application"]]);
  // A permission MacLauncher knows is denied starts no catalog at all.
  const denied = [];let started = 0;
  WindowActions.applyGraphics.picker({ windowGraphics: () => helper, screenAccess: async () => "denied", watchCatalog: () => { started++;return { stop() {} }; },
    listApplications: async () => [{ pid: 11, name: "Example" }] }, update => denied.push(update));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(started, 0);assert.equal(denied[0].refreshOnFocus, true);
  const unavailable = [];
  WindowActions.applyGraphics.picker({ windowGraphics: () => ({ available: false, reason: "Requires macOS 15.2 or later." }) }, update => unavailable.push(update));
  assert.equal(unavailable[0].notice.message, "Requires macOS 15.2 or later.");
});

test("the catalog helper runs while a picker watches it, ends after its requests, and the next starts after it exits", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const children = [];
  const spawn = (file, args, options) => {
    assert.equal(file, "/helper");assert.deepEqual(args, ["--catalog", "--exclude-pid", "3"]);
    assert.equal(Object.keys(options.env).some(key => /^(DYLD_|RESHADE_)/.test(key)), false);
    const child = Object.assign(new EventEmitter(), { pid: 998, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: [], exitCode: null, signalCode: null });
    child.kill = signal => child.killed.push(signal);child.stdinEnded = false;child.stdin.on("finish", () => { child.stdinEnded = true; });
    children.push(child);return child;
  };
  const exit = child => { child.exitCode = 0;child.emit("exit", 0, null); };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const events = [];
  const first = Applications.watchCatalog({ executable: "/helper", excludePid: 3, spawn, sessionCatalog: () => assert.fail("the picker always runs the catalog relay"), onEvent: event => events.push(event) });
  const shared = Applications.watchCatalog({ executable: "/helper", excludePid: 3, spawn, onEvent() {} });
  await settle();
  assert.equal(children.length, 1, "pickers open at the same time share one helper");
  children[0].stdout.write('{"event":"permission","screenRecording":false}\nnot json\n{"event":"other"}\n');
  await settle();
  assert.deepEqual(events, [{ event: "permission", screenRecording: false }]);
  let firstStopped = false;void first.stop().then(() => { firstStopped = true; });
  await settle();
  assert.ok(firstStopped && !children[0].stdinEnded, "the helper keeps running while another picker watches it");
  let stopped = false;void shared.stop().then(() => { stopped = true; });
  await settle();
  assert.ok(children[0].stdinEnded, "the last picker's stop ends the helper's input");
  const next = Applications.watchCatalog({ executable: "/helper", excludePid: 3, spawn, onEvent() {} });
  await settle();
  assert.equal(children.length, 1, "no second helper runs while the first one finishes its requests");
  exit(children[0]);await settle();
  assert.ok(stopped, "stop() resolves when the helper has exited");
  assert.deepEqual(children[0].killed, [], "a helper that ends on its own is not signalled");
  assert.equal(children.length, 2, "the next picker's helper starts after the previous one exits");
  void next.stop();await settle();
  t.mock.timers.tick(2000);
  assert.deepEqual(children[1].killed, ["SIGTERM"], "a helper still running two seconds later gets SIGTERM");
  t.mock.timers.tick(2000);
  assert.deepEqual(children[1].killed, ["SIGTERM", "SIGKILL"], "and SIGKILL two seconds after that");
  exit(children[1]);await settle();
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
  const options = { root: runtime, userDataDir, settings: {launcher: {graphicsShortcuts: {screenshot: "Command+Shift+S"}}}, diagnostics: false, gpuTiming: false, trace: false, verify: () => true, execute: () => assert.fail("no shader") };
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
  assert.equal(Launch.capturedApplication({ target: "window", windowID: 3, pid: 10 }, { event: "selected", windowID: 3, pid: 22 }), null,
    "a window chosen directly keeps its own entry");
  assert.deepEqual(Launch.capturedApplication(data, { event: "selected", windowID: 3, pid: 22, name: "Game", executable: "/Games/Game" }),
    { target: "application", pid: 22, executablePath: "/Games/Game", applicationName: "Game" });
  const child = Object.assign(new EventEmitter(), { pid: 99, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const changes = [];
  await Launch.launch({ gameId: "s2", name: "Menu", moduleData: data }, { windowGraphics: () => helper, verifyFile() {}, logger: { info() {}, warn() {} },
    onEntryChange: patch => changes.push(patch), spawnDetachedChecked: async () => child });
  child.stdout.write('{"event":"selected","executable":"/Games/Game","name":"Game","pid":22,"windowID":3}\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(changes, [{ moduleData: { targets: [{ target: "application", pid: 22, executablePath: "/Games/Game", applicationName: "Game", windowID: 3 }],
    served: [{ target: "application", executablePath: "/Games/Game", name: "Game" }] } }], "the menu app, never picked from, has served nothing");
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

test("All Displays keeps display names and saves its chain after its feeds leave", async t => {
  const fs = require("node:fs"), os = require("node:os"), Stacks = require("../src/modules/shared/effects/application-stacks");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "window-all-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const entry = WindowActions.applyGraphics.createEntry({ kind: "all-displays", displayIDs: [1, 2],
    displays: [{ id: 1, name: "One" }, { id: 2, name: "Two" }] }, { userDataDir, gameId: "all" });
  const child = Object.assign(new EventEmitter(), { pid: 998, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const changes = [];
  await Launch.launch(entry, { windowGraphics: () => helper, verifyFile() {}, logger: {},
    onEntryChange: patch => changes.push(patch), spawnDetachedChecked: async () => child });
  child.stdout.write(['{"event":"targetAdded","target":"d1","kind":"display","displayID":1}',
    '{"event":"targetAdded","target":"d2","kind":"display","displayID":2}'].join("\n") + "\n");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(WindowActions.applyGraphics.sessionTargets({ moduleData: changes.at(-1).moduleData }).map(row => row.label), ["One", "Two"]);
  const actionEntry = { ...entry, moduleData: structuredClone(changes.at(-1).moduleData) };
  const remove = Modules.getModule("window").actions.windowRemoveTarget;
  assert.equal(remove(actionEntry, { id: "d1" }), true);
  assert.equal(remove(actionEntry, { id: "d2" }), true);
  assert.deepEqual(actionEntry.moduleData.targets, []);
  assert.deepEqual(actionEntry.moduleData.served, [{ target: "all-displays" }], "the action's persisted snapshot retains history after the last target leaves");
  const ended = { ...actionEntry, runtimeSettings: { capture: { captureCursor: true } } };
  assert.equal(WindowActions.applyGraphics.endEntry(ended, { userDataDir }), "saved");
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(Stacks.location(userDataDir))).stacks), [Stacks.key({ target: "all-displays" })]);
  child.emit("exit", 0);
});

test("a failed session reports its reason when it ends; a normal end reports none", async () => {
  const run = async lines => {
    const child = Object.assign(new EventEmitter(), { pid: 99, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    await Launch.launch({ gameId: "s3", name: "iTerm2", moduleData: { target: "window", windowID: 18675 } }, { windowGraphics: () => helper, verifyFile() {},
      logger: { info() {}, warn() {} }, spawnDetachedChecked: async () => child });
    assert.deepEqual(child.completionDiagnostics, { pending: true });
    const diagnosed = new Promise(resolve => child.once("diagnostics", resolve));
    child.stdout.end(lines.map(line => line + "\n").join(""));
    await diagnosed;
    return child.completionDiagnostics;
  };
  assert.deepEqual(await run(['{"event":"state","state":"failed"}', '{"event":"failed","reason":"Capturing a window needs the Screen & System Audio Recording permission in System Settings > Privacy & Security"}']),
    { pending: false, message: "Capturing a window needs the Screen & System Audio Recording permission in System Settings > Privacy & Security." });
  assert.deepEqual(await run(['{"event":"state","state":"off"}', '{"event":"closed","reason":"The window closed"}']), { pending: false });
  assert.deepEqual(await run(['{"event":"failed","reason":"The list could not be read"}', '{"event":"state","target":"w18675","state":"on"}', '{"event":"closed"}']),
    { pending: false }, "a served list that fails does not fail the session");
});

test("Stop asks the helper to end its session, and signals only a helper that does not exit", async t => {
  const { requestProcessStop } = require("../src/core/process-lifecycle");
  const { stopProcessTree } = require("../src/core/process-stop");
  const makeChild = pid => Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const child = makeChild(99), lines = [];child.stdin.on("data", data => lines.push(String(data)));
  const entry = { gameId: "s4", name: "System Settings", moduleData: { target: "window", windowID: 42007, pid: 73428 } };
  const launched = await Launch.launch(entry, { windowGraphics: () => helper, verifyFile() {}, logger: { info() {}, warn() {} }, spawnDetachedChecked: async () => child });
  assert.equal(launched, child, "the session's process is the helper");
  // Stop and Trash end the session through the generic process stop.
  const signals = [];
  const stopping = requestProcessStop(launched, { fallback: pid => { signals.push(pid);return true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lines, ['{"stop":true}\n'], "the helper is asked to stop its captures and exit");
  child.exitCode = 0;child.emit("exit", 0, null);
  assert.equal(await stopping, true);
  assert.deepEqual(signals, [], "a helper that exits is not signalled");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stuck = makeChild(98), kills = [];
  Launch.bindSessionStop(stuck, { stopTree: pid => stopProcessTree(pid, { kill: (target, signal) => { kills.push([target, signal]); }, schedule: callback => { callback();return {}; } }) });
  const forced = requestProcessStop(stuck);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(Launch.STOP_WAIT_MS);
  assert.equal(await forced, true);
  assert.ok(kills.length > 0);
  for (const [pid] of kills) assert.equal(Math.abs(pid), 98);
  assert.ok(!kills.some(([pid]) => Math.abs(pid) === 73428), "the captured app's pid is never signalled");
});

test("a session lists each window by title with its app, an app still choosing, and each display", () => {
  const targets = WindowActions.applyGraphics.sessionTargets({ moduleData: { targets: [
    { target: "window", windowID: 3, pid: 7, applicationName: "TextEdit", windowTitle: "Notes.txt" },
    { target: "window", windowID: 4, pid: 7, applicationName: "TextEdit" },
    { target: "application", pid: 8, name: "Preview" },
    { target: "display", displayID: 1, displayName: "Built-in Display" }] } });
  assert.deepEqual(targets, [
    { id: "w3", label: "Notes.txt", detail: "TextEdit", pid: 7 },
    { id: "w4", label: "TextEdit", pid: 7 },
    { id: "p8", label: "Preview", detail: "Choosing a window", pid: 8 },
    { id: "d1", label: "Built-in Display", detail: "Display" }]);
  assert.deepEqual(WindowActions.applyGraphics.sessionTargets({ moduleData: { target: "window", windowID: 9, pid: 2, applicationName: "Old" } }),
    [{ id: "w9", label: "Old", pid: 2 }], "an entry from before several targets still reads");
});

test("a served window, display or All Displays is refused and marked in the picker", () => {
  const create = (target, gameId) => WindowActions.applyGraphics.createEntry(target, { userDataDir: "/Library", gameId });
  const window = create({ kind: "window", windowID: 820, pid: 82, name: "Example" }, "served-window");
  assert.throws(() => create({ kind: "window", windowID: 820, pid: 82, name: "Example" }), { message: "Example already has window graphics. Its library entry controls them." });
  const second = create({ kind: "window", windowID: 821, pid: 82, name: "Example" }, "second-window");
  assert.notEqual(window.gameId, second.gameId);
  assert.equal(WindowActions.applyGraphics.addTarget, undefined);
  const display = create({ kind: "display", displayID: 820, name: "Screen" }, "served-display");
  assert.throws(() => create({ kind: "display", displayID: 820 }), /already has window graphics/);
  assert.throws(() => create({ kind: "all-displays" }), /already has window graphics/);
  let model = WindowActions.catalogModel({ displays: [{ id: 820, name: "Screen" }, { id: 821, name: "Other" }], windows: [{ id: 820, pid: 82, application: "Example", onScreen: false }] });
  assert.equal(model.sections[0].targets[0].detail, "Has window graphics");
  assert.match(model.sections[0].targets[2].detail, /Has window graphics/);
  assert.equal(model.sections[1].targets[0].detail, "Other Space or minimized · Has window graphics");
  WindowActions.applyGraphics.endEntry({ ...display, moduleData: { targets: [] } });
  const all = create({ kind: "all-displays" }, "served-all");
  assert.throws(() => create({ kind: "display", displayID: 821 }), /already has window graphics/);
  assert.throws(() => create({ kind: "all-displays" }), /already has window graphics/);
  model = WindowActions.catalogModel({ displays: [{ id: 821, name: "Other" }], windows: [] });
  assert.equal(model.sections[0].targets[0].detail, "Has window graphics");
  WindowActions.applyGraphics.endEntry({ ...all, moduleData: { targets: [] } });
  assert.ok(create({ kind: "display", displayID: 821 }, "after-end"));
});

test("availability needs window source ABI 2", t => {
  const fs = require("node:fs"), os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "window-abi-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, Applications.HELPER), "fixture");
  for (const version of [undefined, 1, 2, 3]) {
    const result = Applications.availability({ platform: "darwin", macOSVersion: "26.0", root,
      publication: { forRoot: () => ({ files: [{ path: Applications.HELPER }] }) },
      readRecord: () => ({ features: { graphics: { windowSourceAPI: version } } }) });
    assert.equal(result.available, version === 2);
    if (version === 2) assert.equal(result.library, path.join(root, "libreshade-macos.dylib"));
  }
});

test("shortcut targets carry frontWindow and factor outputs pass scale and ask for Accessibility", async () => {
  const [row] = await WindowActions.applyGraphics.targets({ windowGraphics: () => helper, listApplications: async () => [{ pid: 880, name: "Example" }] });
  assert.equal(row.target.frontWindow, true);
  const entry = WindowActions.applyGraphics.createEntry(row.target, { userDataDir: "/Library", gameId: "front" });
  assert.equal(entry.moduleData.targets[0].frontWindow, true);
  assert.deepEqual(Launch.helperArguments(entry, helper), ["--pid", "880", "--front-window", "--library", helper.library]);
  for (const factor of [150,200,250,300,400,500,600,800,1000]) {
    const settings = { output: "scale" + factor };
    assert.deepEqual(Launch.helperArguments(entry, helper, settings), ["--pid", "880", "--front-window", "--scaled", "--scale", String(factor/100), "--library", helper.library]);
    let prompts = 0;
    assert.equal(Launch.reviewRuntimeSettings("capture", settings, { output: "inPlace" }, { systemPreferences: { isTrustedAccessibilityClient: value => { assert.equal(value, true);prompts++;return true; } } }), settings);
    assert.equal(prompts, 1);
    assert.equal(Launch.reviewRuntimeSettings("capture", settings, {}, {}).output, "inPlace");
  }
});

test("L12: running without an image for 2 s shows the waiting reason, and revealed clears it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = Object.assign(new EventEmitter(), { pid: 992, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const changes = [], lines = [];
  child.stdin.on("data", line => lines.push(JSON.parse(String(line))));
  const entry = { gameId: "waiting", moduleData: { target: "window", windowID: 992 } };
  await Launch.launch(entry, { windowGraphics: () => helper, verifyFile() {}, logger: {}, onEntryChange: patch => changes.push(patch), spawnDetachedChecked: async () => child });
  t.after(() => child.emit("exit", 0));
  const event = async value => { child.stdout.write(JSON.stringify(value) + "\n");await new Promise(resolve => setImmediate(resolve)); };
  await event({ event: "state", target: "w992", state: "running", revealed: false });
  t.mock.timers.tick(1999);
  assert.equal(changes.at(-1).moduleData.targets[0].reason, undefined);
  await event({ event: "state", target: "w992", state: "running", revealed: false });
  t.mock.timers.tick(1);
  assert.equal(WindowActions.applyGraphics.sessionTargets({ moduleData: changes.at(-1).moduleData })[0].detail, "Waiting for the window's first image");
  await event({ event: "state", target: "w992", state: "running", revealed: true });
  assert.equal(changes.at(-1).moduleData.targets[0].reason, undefined);
  t.mock.timers.tick(3000);
  assert.equal(changes.at(-1).moduleData.targets[0].reason, undefined);
  assert.equal(Launch.runtimeSettingsChanged(entry, "capture", { output: "scale250", captureCursor: true, showPointer: false }), true);
  assert.equal(require("../src/modules/window/main").actions.windowTogglePointer(entry), true);
  assert.deepEqual(lines, [{ cursor: true, scaled: true, scale: 2.5, pointer: false }, { pointer: "toggle" }]);
});

test("the manifest declares only frame-input and overlay settings and the window module has no capture companion", () => {
  const fs = require("node:fs"), manifest = require("../src/modules/window/manifest.json");
  const capture = manifest.runtime.entries.capture;
  assert.deepEqual(Object.keys(capture).sort(), ["explicitFrames", "graphicsHost", "label", "settings"]);
  assert.deepEqual(capture.settings.fields.map(field => field.key).sort(), ["captureCursor", "output", "showPointer"]);
  assert.equal(capture.settings.defaults.showPointer, true);
  assert.equal(capture.settings.fields.find(field => field.key === "showPointer").label, "Show pointer in picture");
  assert.deepEqual(manifest.ui.appActions[0].sessionShortcuts, [{ shortcut: "windowPointer", action: "windowTogglePointer" }]);
  for (const file of fs.readdirSync(path.join(__dirname, "../src/modules/window")).filter(file => file.endsWith(".js")))
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../src/modules/window", file), "utf8"), /captureCompanion|COMPANION_WAIT_SECONDS|--owner-only/);
});

test("createEntry sets keepStaticContent on frame-generation rows only and preserves a saved value", t => {
  const fs = require("node:fs"), os = require("node:os"), Stacks = require("../src/modules/shared/effects/application-stacks");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "window-defaults-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const effects = { schema: 2, mode: "advanced", enabled: true, video: [
    { id: "gen", kind: "frame-generation", enabled: true, method: "vision-flow", settings: {} },
    { id: "off", kind: "frame-generation", enabled: true, method: "vision-flow", settings: { keepStaticContent: false } },
    { id: "spatial", kind: "spatial", enabled: true, method: "bilinear", settings: {} }] };
  // Seed the serialized rows directly so the absent setting remains absent.
  fs.mkdirSync(path.dirname(Stacks.location(root)), { recursive: true });
  fs.writeFileSync(Stacks.location(root), JSON.stringify({ schema: 1, stacks: { "bundle:com.example.defaults": { effects } } }));
  const entry = WindowActions.applyGraphics.createEntry({ kind: "application", pid: 993, name: "Example", bundleIdentifier: "com.example.defaults" }, { userDataDir: root, gameId: "defaults" });
  assert.equal(entry.effects.video.find(row => row.id === "gen").settings.keepStaticContent, true);
  assert.equal(entry.effects.video.find(row => row.id === "off").settings.keepStaticContent, false);
  assert.equal(entry.effects.video.find(row => row.id === "spatial").settings.keepStaticContent, false);
  assert.equal(require("../src/modules/shared/reshade/graphics-settings").DEFAULTS.keepStaticContent, false);
});

test("catalog more rows become search-only window targets", () => {
  const row = (id, pid, application, extra = {}) => ({ id, pid, application, title: application + " " + id, width: 800, height: 600, onScreen: true, ...extra });
  const event = Applications.catalogEvent({ event: "catalog", displays: [],
    windows: [row(1, 10, "Busy"), row(2, 20, "TextEdit")],
    more: [row(3, 10, "Busy"), row(4, 30, "Quiet", { onScreen: false }), row(5, 20, "TextEdit"), { id: 0, pid: 20, application: "Invalid" }] });
  assert.deepEqual(event.more.map(window => window.id), [3, 4, 5], "invalid rows are dropped");
  assert.equal("more" in Applications.catalogEvent({ event: "catalog", displays: [], windows: [] }), false);
  const [, windows] = WindowActions.catalogModel(event, new Map(), new Map([["w5", "g"]])).sections;
  assert.deepEqual(windows.targets.map(target => [target.id, target.searchOnly === true, target.preview === true, target.group.id, target.detail]), [
    ["window:1", false, true, "application:10", undefined],
    ["window:3", true, false, "application:10", undefined],
    ["window:2", false, true, "application:20", undefined],
    ["window:5", true, false, "application:20", "Has window graphics"],
    ["window:4", true, false, "application:30", "Other Space or minimized"]], "each app's search-only rows follow its listed windows");
  assert.deepEqual(windows.targets[1].target, { kind: "window", windowID: 3, pid: 10, name: "Busy", title: "Busy 3" });
});

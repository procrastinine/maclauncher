const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const ReShade = require("../src/modules/shared/reshade");
const Binding = require("../src/modules/shared/reshade/launch-binding");
const Live = require("../src/modules/shared/reshade/live-controls");
const Injection = require("../src/modules/shared/runtime/native-injection");
const Status = require("../src/modules/shared/reshade/runtime-status");
const Launch = require("../src/modules/window/launch");

const reason = "The executable's hardened runtime does not allow DYLD graphics attachment.";
const plan = enabled => ({ schema: 2, mode: "advanced", enabled, video: [{ id: "gray", kind: "shader", enabled: true, shader: { enabled: true, preset: "grayscale" } }] });

function fixture(t, companion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "window-capture-fallback-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "data"), spawned = [], started = [];
  const manifest = { id: "probe", gameType: "native", runtime: { default: "runner", supported: ["runner"], entries: { runner: { graphicsHost: "window" } } } };
  const capture = { id: "capture", manifest: { id: "capture" }, captureCompanion: library => companion && { start(pid, environment) {
    const child = new EventEmitter();child.kill = signal => child.emit("killed", signal);started.push({ library, pid, environment, child });return child;
  } } };
  const modules = { probe: { id: "probe", manifest }, capture };
  const registry = { listModules: () => [manifest, capture.manifest], getModule: id => modules[id], getModuleInfo: id => id === "probe" ? manifest : capture.manifest };
  const launcher = require("../src/core/launcher").createLauncher({ userDataDir, registry, logger: { warn() {}, info() {} },
    rosetta: { requiresForExecutable: () => false, isAvailable: () => true }, spawn(command, args, options) {
      spawned.push({ command, args, options });const child = new EventEmitter();child.pid = 52000 + spawned.length;
      child.unref = () => queueMicrotask(() => child.emit("spawn"));return child;
    } });
  t.mock.method(ReShade, "prepare", async entry => {
    const file = path.join(path.dirname(Live.file(entry, userDataDir)), "launch.json");fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: 1, phase: "prepared", launchId: entry.gameId, effectPlanAPI: 1 }));
    return { DYLD_INSERT_LIBRARIES: "/owned/graphics/libreshade-macos.dylib", RESHADE_EFFECT_PLAN: "/owned/plan" };
  });
  t.mock.method(Injection, "preflight", async () => ({ available: false, reason }));
  return { root, userDataDir, launcher, spawned, started };
}

test("a refused attachment processes a captured copy of the game's window with the launch's plan", async t => {
  const f = fixture(t, true);
  const entry = { gameId: "captured", gamePath: f.root, moduleId: "probe", runtimeId: "runner", networkAccess: true, effects: plan(true) };
  const context = f.launcher.getGameLaunchContext(entry, {});
  const child = await context.spawnDetachedChecked("/game/Player", [], { env: { KEEP: "yes" } });
  assert.equal(Object.hasOwn(f.spawned[0].options.env, "RESHADE_EFFECT_PLAN"), false, "the game itself runs without the library");
  assert.equal(context.graphicsPreparationFailure, undefined);
  assert.equal(f.started.length, 1);
  const [{ library, pid, environment, child: companion }] = f.started;
  assert.equal(library, "/owned/graphics/libreshade-macos.dylib");
  assert.equal(pid, child.pid, "the companion follows the game's own process");
  assert.equal(environment.RESHADE_EFFECT_PLAN, "/owned/plan");
  assert.equal(environment.RESHADE_EXPLICIT_HOST, "1");
  assert.equal(Object.hasOwn(environment, "DYLD_INSERT_LIBRARIES"), false);
  const launch = Binding.read(entry, { userDataDir: f.userDataDir, runningPids: [child.pid] });
  assert.deepEqual(launch.graphicsAttachment, { available: true, captured: true, reason });
  assert.match(launch.graphicsWarnings.find(row => row.id === "native-attachment").reason, /captured copy of the game's window/);
  assert.notEqual(Status.read(entry, { userDataDir: f.userDataDir, runningPids: [child.pid] }).reason, reason, "live edits are not refused");
  const killed = [];companion.on("killed", signal => killed.push(signal));
  child.emit("exit", 0, null);
  assert.deepEqual(killed, ["SIGTERM"], "the companion ends with the game");
});

test("no companion starts without processing or without window capture", async t => {
  const off = fixture(t, true);
  const idle = { gameId: "idle", gamePath: off.root, moduleId: "probe", runtimeId: "runner", networkAccess: true, effects: plan(false) };
  await off.launcher.getGameLaunchContext(idle, {}).spawnDetachedChecked("/game/Player", [], { env: {} });
  assert.equal(off.started.length, 0);
  const missing = fixture(t, false);
  const entry = { gameId: "uncaptured", gamePath: missing.root, moduleId: "probe", runtimeId: "runner", networkAccess: true, effects: plan(true) };
  const context = missing.launcher.getGameLaunchContext(entry, {});
  const child = await context.spawnDetachedChecked("/game/Player", [], { env: {} });
  assert.equal(context.graphicsPreparationFailure.reason, reason);
  assert.equal(Binding.read(entry, { userDataDir: missing.userDataDir, runningPids: [child.pid] }).graphicsAttachment.available, false);
  assert.equal(Status.read(entry, { userDataDir: missing.userDataDir, runningPids: [child.pid] }).state, "unavailable");
});

test("the window module offers a companion only where window graphics are available", () => {
  const helper = { available: true, root: "/owned/graphics", row: { path: "maclauncher-graphics-window" }, executable: "/owned/graphics/maclauncher-graphics-window" };
  assert.equal(Launch.captureCompanion("/owned/graphics/libreshade-macos.dylib", { availability: () => ({ available: false, reason: "macOS 15.2" }) }), null);
  assert.equal(Launch.captureCompanion("relative.dylib", { availability: () => helper }), null);
  const calls = [];
  const companion = Launch.captureCompanion("/owned/graphics/libreshade-macos.dylib", { availability: ({ root }) => { assert.equal(root, "/owned/graphics");return helper; },
    verifyFile: (root, row) => calls.push(["verify", root, row.path]), logger: { info() {}, warn() {} },
    spawn: (command, args, options) => { calls.push(["spawn", command, args, options.env.MARK]);return Object.assign(new EventEmitter(), { kill() {} }); } });
  companion.start(77, { MARK: "plan" });
  assert.deepEqual(calls, [["verify", "/owned/graphics", "maclauncher-graphics-window"],
    ["spawn", helper.executable, ["--pid", "77", "--wait-window", "120", "--owner-only", "--library", "/owned/graphics/libreshade-macos.dylib"], "plan"]]);
});

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

test("G1: a refused game attachment keeps original rendering even when a capture companion is available", async t => {
  const f = fixture(t, true);
  const entry = { gameId: "captured", gamePath: f.root, moduleId: "probe", runtimeId: "runner", networkAccess: true, effects: plan(true) };
  const context = f.launcher.getGameLaunchContext(entry, {});
  const child = await context.spawnDetachedChecked("/game/Player", [], { env: { KEEP: "yes" } });
  assert.equal(Object.hasOwn(f.spawned[0].options.env, "RESHADE_EFFECT_PLAN"), false);
  assert.equal(context.graphicsPreparationFailure.reason, reason);
  assert.equal(f.started.length, 0);
  const launch = Binding.read(entry, { userDataDir: f.userDataDir, runningPids: [child.pid] });
  assert.deepEqual(launch.graphicsAttachment, { available: false, reason });
  assert.equal(Status.read(entry, { userDataDir: f.userDataDir, runningPids: [child.pid] }).state, "unavailable");
  assert.equal(require("../src/modules/window/main").captureCompanion, undefined);
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

test("explicit window capture remains available independently of game attachment", () => {
  assert.equal(Launch.captureCompanion, undefined);
  const helper = { library: "/owned/graphics/libreshade-macos.dylib" };
  assert.deepEqual(Launch.helperArguments({ moduleData: { target: "application", pid: 77, waitWindow: 120 } }, helper),
    ["--pid", "77", "--wait-window", "120", "--library", helper.library]);
});

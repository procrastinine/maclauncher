const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const ClientStart = require("../src/modules/shared/runtime/steamworks/client-start");
const { findInstalledApp } = require("../src/modules/shared/runtime/steamworks/installed-client");
const { createLauncher } = require("../src/core/launcher");

// No test here runs pgrep or open: every client check and start is injected.
const SIGNED_IN = "[2026-10-28 15:25:43] [Logged On, 4, 7] [U:1:1] RecvMsgClientLogOnResponse() : processing complete\n";
const UNITY_PLUGIN = "Game.app/Contents/PlugIns/steam_api.bundle/Contents/MacOS/libsteam_api.dylib";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steam-client-start-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), logPath = path.join(home, "Library/Application Support/Steam/logs/connection_log.txt");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  // A sign-in from an earlier Steam session must not satisfy a new start.
  fs.writeFileSync(logPath, SIGNED_IN);
  const write = (directory, files) => {
    for (const file of files) { fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); fs.writeFileSync(path.join(directory, file), "#!/bin/sh\nexit 0\n", { mode: 0o755 }); }
    return directory;
  };
  const install = (library, installDir, appId, files) => {
    fs.mkdirSync(path.join(root, library, "steamapps", "common"), { recursive: true });
    fs.writeFileSync(path.join(root, library, "steamapps", `appmanifest_${appId}.acf`), `"AppState" { "appid" "${appId}" "installdir" "${installDir}" }`);
    return write(path.join(root, library, "steamapps", "common", installDir), files);
  };
  const steamGame = install("mac", "Steam Game", 230290, [UNITY_PLUGIN, "Game.app/Contents/MacOS/Game"]);
  const copy = write(path.join(root, "Downloads", "Steam Game"), [UNITY_PLUGIN, "Game.app/Contents/MacOS/Game"]);
  return { root, home, logPath, install, steamGame, copy,
    steamEntry: { gameId: "steam-game", gamePath: path.join(steamGame, "Game.app") }, copyEntry: { gameId: "copy", gamePath: path.join(copy, "Game.app") } };
}

test("only the game's own Steam API from a Steam installation needs the Steam client", t => {
  const f = fixture(t);
  // A native Mac app from a Steam library runs its original macOS Steam API.
  assert.equal(ClientStart.steamInstallation(f.steamEntry).appId, 230290);
  assert.equal(ClientStart.nativeAppNeedsClient(findInstalledApp(f.steamEntry.gamePath)), true);
  const optional = f.install("mac", "No API", 480, ["Other.app/Contents/MacOS/Other"]);
  assert.equal(ClientStart.nativeAppNeedsClient(findInstalledApp(path.join(optional, "Other.app"))), false);
  // Windows APIs run inside private Wine environments that no outside Steam client serves.
  const windows = f.install("Bottles/Steam/drive_c/Program Files (x86)/Steam", "Windows Game", 570, ["bin/win64/steam_api64.dll", "game.exe"]);
  assert.equal(ClientStart.nativeAppNeedsClient(findInstalledApp(path.join(windows, "game.exe"))), false);
  // A DRM-free copy that bundles Steamworks is not a Steam installation.
  assert.equal(ClientStart.steamInstallation(f.copyEntry), null);
  assert.equal(ClientStart.nativeAppNeedsClient(null), false);
  // Shared preparation: the game's own library needs the client; the included helper never does.
  assert.equal(ClientStart.preparedApiNeedsClient({ mode: "native" }, f.steamEntry), true);
  assert.equal(ClientStart.preparedApiNeedsClient({ mode: "offline" }, f.steamEntry), false);
  assert.equal(ClientStart.preparedApiNeedsClient({ mode: "native" }, f.copyEntry), false);
  assert.equal(ClientStart.preparedApiNeedsClient(null, f.steamEntry), false);
  // Only eligible games show the per-game "Start Steam on Play" choice.
  assert.equal(ClientStart.clientEligible(f.steamEntry), true);
  assert.equal(ClientStart.clientEligible(f.copyEntry), false);
  assert.equal(ClientStart.clientStartEnabled({}, {}), true);
  assert.equal(ClientStart.clientStartEnabled({}, { launcher: { startSteamClient: false } }), false);
  assert.equal(ClientStart.clientStartEnabled({ startSteamClient: true }, { launcher: { startSteamClient: false } }), true);
  assert.equal(ClientStart.clientStartEnabled({ startSteamClient: false }, { launcher: { startSteamClient: true } }), false);
});

test("Steam startup defaults to consent, refusal continues without startup, and automatic is explicit", async t => {
  const f = fixture(t), prompts = []; let starts = 0;
  const base = { home: f.home, timeoutMs: 0, isRunning: () => false,
    start: async () => { starts++; }, logger: { warn() {} } };
  assert.deepEqual(await ClientStart.ensureClient(base), { started: false });
  for (const mode of [undefined, "ask", true]) {
    assert.deepEqual(await ClientStart.ensureClient({ ...base, mode, confirmRuntimeInstall: async plan => { prompts.push(plan); return false; } }), { started: false });
  }
  assert.equal(starts, 0); assert.equal(prompts.length, 3);
  assert.equal(prompts[0].cancelLabel, "Launch without Steam");
  assert.equal(prompts[0].requiresDownload, false);
  assert.equal((await ClientStart.ensureClient({ ...base, confirmRuntimeInstall: async () => ({ approved: true }) })).started, true);
  assert.equal((await ClientStart.ensureClient({ ...base, mode: "automatic" })).started, true);
  assert.deepEqual(await ClientStart.ensureClient({ ...base, mode: "never", confirmRuntimeInstall: () => assert.fail("No prompt when disabled") }), { started: false });
  assert.deepEqual(await ClientStart.ensureClient({ ...base, isRunning: () => true, confirmRuntimeInstall: () => assert.fail("No prompt for running Steam") }), { started: false });
  assert.equal(starts, 2);
  assert.equal(ClientStart.clientStartPreference({}, {}), "ask");
  assert.equal(ClientStart.clientStartPreference({}, { launcher: { startSteamClient: true } }), "ask");
  assert.equal(ClientStart.clientStartPreference({ startSteamClient: "ask" }, { launcher: { startSteamClient: "automatic" } }), "ask");
  const aborted = new AbortController();
  await assert.rejects(ClientStart.ensureClient({ ...base, signal: aborted.signal,
    confirmRuntimeInstall: async () => { aborted.abort(); return true; } }), { name: "AbortError" });
  assert.equal(starts, 2);
});

test("Steam starts once, waits for a new sign-in, and a running client is used as it is", async t => {
  const f = fixture(t), events = [];
  let running = false, starts = 0;
  const options = { mode: "automatic", home: f.home, pollMs: 1, timeoutMs: 5000, isRunning: () => running,
    report: label => events.push(label),
    start: async ({ home }) => {
      assert.equal(home, f.home); starts++;
      running = true;
      fs.appendFileSync(f.logPath, "[2026-10-28 15:30:00] [Connecting, 4, 0] [U:1:1] Connect() starting connection\n");
      setTimeout(() => fs.appendFileSync(f.logPath, SIGNED_IN.replace("15:25:43", "15:30:02")), 30);
    } };
  const [first, second] = await Promise.all([ClientStart.ensureClient(options), ClientStart.ensureClient(options)]);
  assert.deepEqual(first, { started: true, ready: true }); assert.deepEqual(second, first);
  assert.equal(starts, 1); assert.deepEqual(events, ["Starting Steam…", "Starting Steam…"]);
  assert.deepEqual(await ClientStart.ensureClient({ ...options, start: () => assert.fail("Steam is already running") }), { started: false });
});

test("a Steam start that times out or fails returns a notice instead of blocking Play, and cancel stops the wait", async t => {
  const f = fixture(t), warnings = [];
  const logger = { warn: (...args) => warnings.push(args.join(" ")) };
  // Steam's process runs, but only the earlier session's sign-in is in its log.
  let running = false;
  const timedOut = await ClientStart.ensureClient({ mode: "automatic", home: f.home, pollMs: 1, timeoutMs: 20, logger,
    isRunning: () => running, start: async () => { running = true; } });
  assert.equal(timedOut.started, true); assert.equal(timedOut.ready, false);
  assert.match(timedOut.notice, /^Steam did not finish signing in within 0 seconds, so the game started without waiting for it\.$/);
  const failed = await ClientStart.ensureClient({ mode: "automatic", home: f.home, logger, isRunning: () => false,
    start: async () => { throw new Error("Steam for Mac is not installed."); } });
  assert.deepEqual(failed, { started: false, notice: "Steam could not be started, so the game started without it." });
  assert.equal(warnings.length, 2);
  const controller = new AbortController();
  const waiting = ClientStart.ensureClient({ mode: "automatic", home: f.home, pollMs: 1, timeoutMs: 50, signal: controller.signal, isRunning: () => false, start: async () => {} });
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  // The shared start keeps waiting for other launches; let it end before later tests.
  await new Promise(resolve => setTimeout(resolve, 150));
});

function launcherFixture(t, f, { mod = {}, steamApiService, steamClientStart, confirmRuntimeInstall } = {}) {
  const manifest = { id: "test", label: "Test engine", gameType: "native",
    runtime: { default: "runner", supported: ["runner", "native"], entries: { runner: {}, native: {} } } };
  // One stand-in child serves every launch in a test.
  const child = new EventEmitter(); child.unref = () => {}; child.setMaxListeners(32);
  const events = [], module = { id: "test", manifest, ...mod };
  const registry = { listModules: () => [manifest], getModule: id => id === "test" ? module : null, getModuleInfo: () => manifest,
    detectGame: input => ({ moduleId: "test", gamePath: input, name: "Test game", moduleData: {} }) };
  const launcher = createLauncher({ userDataDir: path.join(f.root, "userData"), registry,
    rosetta: { requiresForExecutable: () => false }, ...(steamApiService ? { steamApiService } : {}),
    ...(confirmRuntimeInstall ? { confirmRuntimeInstall } : {}),
    steamClientStart: steamClientStart || (async options => {
      events.push("steam"); assert.equal(typeof options.report, "function");
      return { started: true, ready: false, notice: "Steam did not finish signing in within 60 seconds, so the game started without waiting for it." };
    }),
    spawn: () => { events.push("spawn"); process.nextTick(() => child.emit("spawn")); return child; } });
  return launcherFixture.last = { launcher, events, child };
}

test("Play of a native Mac app from a Steam library starts Steam before the game; other paths never do", { skip: process.platform !== "darwin" }, async t => {
  const f = fixture(t), { launcher, events, child } = launcherFixture(t, f);
  const entry = { ...await launcher.resolveEntry(f.steamEntry.gamePath, { runtimeId: "native" }), networkAccess: true };
  await launcher.getLaunchContext(entry, launcher.loadSettings(), { runtimeId: "native" }).prepareNativeSteam(f.steamEntry.gamePath);
  assert.deepEqual(events, []);
  const result = await launcher.launchEntry(entry, { runtimeId: "native" });
  assert.deepEqual(events, ["steam", "spawn"]);
  assert.equal(result.child.listenerCount("exit") > 0, true);
  assert.deepEqual(result.launchNotices, ["Steam did not finish signing in within 60 seconds, so the game started without waiting for it."]);
  child.exitCode = 0; child.emit("exit", 0);
  const copy = { ...await launcher.resolveEntry(f.copyEntry.gamePath, { runtimeId: "native" }), networkAccess: true };
  assert.equal((await launcher.launchEntry(copy, { runtimeId: "native" })).launchNotices, undefined);
  assert.deepEqual(events, ["steam", "spawn", "spawn"]);
});

test("module runtimes start Steam only when shared preparation selects the game's own Steam API", async t => {
  const f = fixture(t);
  for (const [mode, expected] of [["native", ["steam", "spawn"]], ["offline", ["spawn"]]]) {
    const { launcher, events, child } = launcherFixture(t, f, {
      steamApiService: async request => { assert.equal(request.required, true); return { mode, environment: { SteamAppId: "230290" } }; },
      mod: { launchRuntime: async (_id, _entry, context) => {
        const steam = await context.prepareSteamApi({ required: true, appId: 230290, arch: "arm64" });
        return context.spawnDetachedChecked("/bin/game", [], { env: steam.environment });
      } } });
    const entry = { ...await launcher.resolveEntry(f.steamEntry.gamePath, { runtimeId: "runner" }), runtimeId: "runner", networkAccess: true };
    await launcher.launchEntry(entry, { runtimeId: "runner" });
    assert.deepEqual(events, expected, mode);
    child.exitCode = 0; child.emit("exit", 0);
  }
});

test("Steam client on Play: Ask prompts through the consent flow, a decline still launches, and the game's choice overrides the launcher's", { skip: process.platform !== "darwin" }, async t => {
  const f = fixture(t), prompts = [];
  let answer = true, events;
  const { launcher, child } = launcherFixture(t, f, {
    confirmRuntimeInstall: async (plan, entry) => { events.push("prompt"); prompts.push({ plan, entry }); return answer; },
    steamClientStart: options => ClientStart.ensureClient({ ...options, home: f.home, timeoutMs: 0, isRunning: () => false,
      start: async () => { events.push("start"); } }) });
  ({ events } = launcherFixture.last);
  const resolved = { ...await launcher.resolveEntry(f.steamEntry.gamePath, { runtimeId: "native" }), networkAccess: true };
  const settings = startSteamClient => ({ ...launcher.loadSettings(),
    launcher: { ...launcher.loadSettings().launcher, ...(startSteamClient ? { startSteamClient } : {}) } });
  assert.equal(launcher.loadSettings().launcher.startSteamClient, "ask");
  // Play alone is not consent: outside Play nothing prompts or starts, whatever the choice.
  await launcher.getLaunchContext(resolved, settings("automatic"), { runtimeId: "native" }).prepareNativeSteam(f.steamEntry.gamePath);
  assert.deepEqual(events, []);
  for (const [name, global, game, consent, expected] of [
    ["default Ask, Start Steam", undefined, undefined, true, ["prompt", "start", "spawn"]],
    ["default Ask, Launch without Steam", undefined, undefined, false, ["prompt", "spawn"]],
    ["Start automatically", "automatic", undefined, false, ["start", "spawn"]],
    ["Don't start", "never", undefined, true, ["spawn"]],
    ["game Ask over launcher Don't start", "never", "ask", true, ["prompt", "start", "spawn"]],
    ["game Don't start over launcher Start automatically", "automatic", "never", true, ["spawn"]],
    ["game Start automatically over launcher Ask", "ask", "automatic", false, ["start", "spawn"]]
  ]) {
    events.length = 0; answer = consent;
    const entry = { ...resolved, ...(game ? { startSteamClient: game } : {}) };
    const result = await launcher.launchEntry(entry, { runtimeId: "native", settings: settings(global) });
    assert.deepEqual(events, expected, name);
    assert.equal(result.launchNotices?.length ?? 0, expected.includes("start") ? 1 : 0, name);
    child.exitCode = 0; child.emit("exit", 0);
  }
  const { plan, entry } = prompts[0];
  assert.equal(entry.gamePath, f.steamEntry.gamePath);
  assert.deepEqual([plan.kind, plan.requiresDownload, plan.confirmLabel, plan.cancelLabel], ["client-start", false, "Start Steam", "Launch without Steam"]);
  assert.match(plan.detail, /uses the Steam client, which connects to the Internet/);
});

test("an unknown Steam client state neither prompts nor starts Steam", async t => {
  const f = fixture(t);
  const result = await ClientStart.ensureClient({ mode: "automatic", home: f.home, isRunning: () => null, logger: { warn() {} },
    confirmRuntimeInstall: () => assert.fail("No prompt for an unknown state"), start: () => assert.fail("No start for an unknown state") });
  assert.deepEqual(result, { started: false, notice: "Steam's state could not be checked, so the game started without starting Steam." });
  assert.deepEqual(await ClientStart.ensureClient({ mode: "never", isRunning: () => null }), { started: false });
});

test("Steam process detection distinguishes no match from a failed process-list query", async () => {
  const filename = require.resolve("../src/modules/shared/runtime/steamworks/client-start");
  const source = fs.readFileSync(filename, "utf8"), localRequire = createRequire(filename);
  for (const [probe, expected] of [
    [{ status: 0 }, true], [{ status: 1 }, false],
    [{ status: 2 }, null], [{ status: 3 }, null], [{ status: 99 }, null],
    [{ status: null, signal: "SIGTERM" }, null],
    [{ status: null, error: Object.assign(new Error("Cannot spawn pgrep"), { code: "EACCES" }) }, null],
    [{ status: 0, error: Object.assign(new Error("Cannot read process list"), { code: "EPERM" }) }, null]
  ]) {
    const module = { exports: {} };
    vm.runInNewContext(source, { module, require: id => id === "node:child_process" ? {
      spawn: () => assert.fail("No process is started by the process-state check"),
      spawnSync(command, args, options) {
        assert.equal(command, "/usr/bin/pgrep");
        assert.deepEqual(Array.from(args), ["-x", "steam_osx"]);
        assert.equal(options.stdio, "ignore");
        return probe;
      }
    } : localRequire(id) }, { filename });
    const client = module.exports;
    assert.equal(client.clientRunning(), expected);
    if (expected === null) for (const mode of ["ask", "automatic"]) {
      const result = await client.ensureClient({ mode, logger: { warn() {} },
        confirmRuntimeInstall: () => assert.fail("Unknown process state must not prompt"),
        start: () => assert.fail("Unknown process state must not start Steam") });
      assert.equal(result.started, false);
      assert.match(result.notice, /state could not be checked/);
    }
  }
});

test("Steam client on Play also applies to module runtimes, and the game record keeps its choice or inherits", async t => {
  const f = fixture(t);
  const { launcher, events, child } = launcherFixture(t, f, {
    steamApiService: async () => ({ mode: "native", environment: {} }),
    mod: { launchRuntime: async (_id, _entry, context) => {
      await context.prepareSteamApi({ required: true, appId: 230290, arch: "arm64" });
      return context.spawnDetachedChecked("/bin/game", [], {});
    } } });
  const entry = { ...await launcher.resolveEntry(f.steamEntry.gamePath, { runtimeId: "runner" }), runtimeId: "runner", networkAccess: true };
  const off = { ...launcher.loadSettings(), launcher: { ...launcher.loadSettings().launcher, startSteamClient: "never" } };
  await launcher.launchEntry(entry, { runtimeId: "runner", settings: off });
  assert.deepEqual(events, ["spawn"]);
  child.exitCode = 0; child.emit("exit", 0);

  const GameStore = require("../src/core/game-store");
  const userDataDir = path.join(f.root, "userData");
  GameStore.writeGameRecord(userDataDir, { gameId: "steam-game", gamePath: f.steamEntry.gamePath });
  assert.equal(GameStore.setGameSteamClientStart(userDataDir, "steam-game", "automatic").startSteamClient, "automatic");
  assert.equal(GameStore.readGameRecord(userDataDir, "steam-game").startSteamClient, "automatic");
  // An earlier On value never grants startup.
  assert.equal(ClientStart.clientStartPreference(GameStore.setGameSteamClientStart(userDataDir, "steam-game", true), {}), "ask");
  assert.equal(Object.hasOwn(GameStore.setGameSteamClientStart(userDataDir, "steam-game", null), "startSteamClient"), false);
  assert.equal(Object.hasOwn(GameStore.readGameRecord(userDataDir, "steam-game"), "startSteamClient"), false);
  assert.throws(() => GameStore.setGameSteamClientStart(userDataDir, "steam-game", "on"));
});

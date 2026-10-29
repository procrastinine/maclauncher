const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const Isolation = require("../src/modules/shared/runtime/network-isolation");
const { createLauncher } = require("../src/core/launcher");

// No test here starts Steam or applies a sandbox: the client start and process spawn are injected.
const UNITY_PLUGIN = "Game.app/Contents/PlugIns/steam_api.bundle/Contents/MacOS/libsteam_api.dylib";
const STEAM_IPC = /\(allow network-outbound \(remote ip "localhost:57343"\) \(remote ip "localhost:57344"\)\)/;

test("isolation permits only the Steam client's loopback endpoints, and only when requested", () => {
  const base = Isolation.profile();
  assert.doesNotMatch(base, /57343|57344/);
  const steam = Isolation.profile({ steamClientPorts: Isolation.steamClientPorts({}) });
  assert.match(steam, STEAM_IPC);
  assert.match(steam, /\(deny network\*\)/);
  assert.doesNotMatch(steam, /ip "\*|localhost:\*|network-bind|network-inbound/);
  // steamclient reads each endpoint name as an address override; only loopback overrides apply.
  assert.deepEqual(Isolation.steamClientPorts({ Steam3Master: "127.0.0.1:41000", SteamClientService: "10.0.0.2:41001" }), [41000, 57344]);
  assert.deepEqual(Isolation.steamClientPorts({ Steam3Master: "localhost:0", SteamClientService: "localhost:70000" }), [57343, 57344]);
  assert.match(Isolation.profile({ assetPort: 32123, steamClientPorts: [57343, 57343] }),
    /localhost:32123"\)\)\n\(allow network-outbound \(remote ip "localhost:57343"\)\)\n$/);
  assert.throws(() => Isolation.profile({ steamClientPorts: ['1") (allow network*)'] }), /invalid port/);
  if (process.platform === "darwin") {
    const [, args] = Isolation.wrap("/game", [], { Steam3Master: "127.0.0.1:41000" }, { platform: "darwin", steamClient: true });
    assert.match(args[1], /localhost:41000"\) \(remote ip "localhost:57344"/);
    assert.doesNotMatch(Isolation.wrap("/game", [], {}, { platform: "darwin" })[1][1], /57343/);
  }
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steam-client-network-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (directory, files) => {
    for (const file of files) { fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); fs.writeFileSync(path.join(directory, file), "#!/bin/sh\nexit 0\n", { mode: 0o755 }); }
    return directory;
  };
  fs.mkdirSync(path.join(root, "mac", "steamapps", "common"), { recursive: true });
  fs.writeFileSync(path.join(root, "mac", "steamapps", "appmanifest_230290.acf"), '"AppState" { "appid" "230290" "installdir" "Steam Game" }');
  const steamGame = write(path.join(root, "mac", "steamapps", "common", "Steam Game"), [UNITY_PLUGIN, "Game.app/Contents/MacOS/Game"]);
  const copy = write(path.join(root, "Downloads", "Steam Game"), [UNITY_PLUGIN, "Game.app/Contents/MacOS/Game"]);
  return { root, steamApp: path.join(steamGame, "Game.app"), copyApp: path.join(copy, "Game.app") };
}

function launcherFixture(f, { mod = {}, steamApiService } = {}) {
  const manifest = { id: "test", label: "Test engine", gameType: "native",
    runtime: { default: "runner", supported: ["runner", "native"], entries: { runner: {}, native: {} } } };
  const profiles = [], module = { id: "test", manifest, ...mod };
  const registry = { listModules: () => [manifest], getModule: id => id === "test" ? module : null, getModuleInfo: () => manifest,
    detectGame: input => ({ moduleId: "test", gamePath: input, name: "Test game", moduleData: {} }) };
  let child;
  const launcher = createLauncher({ userDataDir: path.join(f.root, "userData"), registry,
    rosetta: { requiresForExecutable: () => false }, ...(steamApiService ? { steamApiService } : {}),
    steamClientStart: async () => ({ started: false }),
    spawn: (command, args) => {
      assert.equal(command, "/usr/bin/sandbox-exec");
      profiles.push(args[1]);
      child = new EventEmitter(); child.pid = 4242; child.exitCode = child.signalCode = null; child.unref = () => {};
      child.stdio = [null, null, null, new PassThrough()];
      process.nextTick(() => { child.emit("spawn"); child.stdio[3].write("isolated\n"); });
      return child;
    } });
  const exit = () => { child.exitCode = 0; child.emit("exit", 0); };
  return { launcher, profiles, exit };
}

test("an isolated game that uses its own Steam API from a Steam installation can reach the running Steam client", { skip: process.platform !== "darwin" }, async t => {
  const f = fixture(t), { launcher, profiles, exit } = launcherFixture(f);
  const never = { ...launcher.loadSettings(), launcher: { ...launcher.loadSettings().launcher, startSteamClient: "never" } };
  for (const [gamePath, settings, expected] of [[f.steamApp, undefined, true], [f.steamApp, never, true], [f.copyApp, undefined, false]]) {
    const entry = { ...await launcher.resolveEntry(gamePath, { runtimeId: "native" }), networkAccess: false };
    await launcher.launchEntry(entry, { runtimeId: "native", ...(settings ? { settings } : {}) });
    const profile = profiles.at(-1);
    assert.match(profile, /\(deny network\*\)/);
    assert.equal(STEAM_IPC.test(profile), expected, gamePath);
    exit();
  }
});

test("module runtimes receive the Steam client connection only for the game's own Steam API, never the included helper", { skip: process.platform !== "darwin" }, async t => {
  const f = fixture(t);
  for (const [mode, expected] of [["native", true], ["offline", false]]) {
    const { launcher, profiles, exit } = launcherFixture(f, {
      steamApiService: async () => ({ mode, environment: { SteamAppId: "230290" } }),
      mod: { launchRuntime: async (_id, _entry, context) => {
        const steam = await context.prepareSteamApi({ required: true, appId: 230290, arch: "arm64" });
        return context.spawnDetachedChecked("/bin/game", [], { env: steam.environment });
      } } });
    const entry = { ...await launcher.resolveEntry(f.steamApp, { runtimeId: "runner" }), runtimeId: "runner", networkAccess: false };
    await launcher.launchEntry(entry, { runtimeId: "runner" });
    assert.equal(STEAM_IPC.test(profiles.at(-1)), expected, mode);
    exit();
  }
});

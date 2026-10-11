const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { createLauncher } = require("../src/core/launcher");
const GameStore = require("../src/core/game-store");

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-core-launcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gamePath = path.join(root, "game");
  fs.mkdirSync(gamePath);
  const userDataDir = path.join(root, "userData");
  const manifest = {
    id: "test", label: "Test engine", gameType: "native", settingsDefaults: { defaultRuntime: "runner" },
    runtime: { default: "runner", supported: ["runner", "native"], entries: {
      runner: { settings: { fields: [{ key: "flag", type: "boolean", default: true }] } }
    } }
  };
  const mod = { id: "test", manifest, ...options.mod };
  const registry = {
    listModules: () => [manifest], getModule: id => id === "test" ? mod : null,
    getModuleInfo: () => manifest,
    detectGame: input => ({ moduleId: "test", gamePath: input, name: "Test game", moduleData: { detected: true } })
  };
  const launcher = createLauncher({ userDataDir, registry, ...options.launcher });
  return { launcher, root, gamePath, userDataDir, mod, manifest };
}

test("game notes use the shared backend and survive rediscovery and runtime updates", async t => {
  const { launcher, gamePath, userDataDir } = fixture(t);
  const entry = await launcher.resolveEntry(gamePath);
  const result = await launcher.runAction(entry, "setGameNotes", { notes: "Chapter 3\nUse the west exit." });
  assert.equal(result.notes, entry.notes);
  const discovered = await launcher.resolveEntry(gamePath);
  assert.equal(discovered.notes, result.notes);
  const stored = GameStore.readGameRecord(userDataDir, entry.gameId);
  assert.equal(stored.notes, result.notes);
  assert.equal(stored.moduleData.detected, true);
});

test("backend dispatch passes settings and preserves staged state without Electron", async t => {
  let context;
  const child = { pid: 1 };
  const { launcher, gamePath, userDataDir } = fixture(t, { mod: {
    launchRuntime: async (_runtimeId, entry, value) => {
      context = value;
      value.onEntryChange({ contentRootDir: "/staged", moduleData: { ...entry.moduleData, staged: true }, gameId: "hijack" });
      return child;
    }
  } });
  fs.mkdirSync(userDataDir);
  fs.writeFileSync(path.join(userDataDir, "settings.json"), JSON.stringify({ modules: { test: { runtimeSettings: { runner: { flag: false } } } } }));
  const entry = await launcher.resolveEntry(gamePath);
  const result = await launcher.launchEntry(entry);
  assert.equal(result.child, child);
  assert.equal(result.runtimeId, "runner");
  assert.deepEqual(context.runtimeSettings, { flag: false });
  assert.equal(context.ui, undefined);
  const stored = GameStore.readGameRecord(userDataDir, entry.gameId);
  assert.equal(stored.contentRootDir, "/staged");
  assert.equal(stored.gameId, entry.gameId);
  assert.equal(stored.moduleData.staged, true);
});

test("already signalled children release the save-editing guard", async t => {
  const { EventEmitter } = require("node:events");
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: "SIGTERM" });
  const { launcher, gamePath } = fixture(t, { mod: { launchRuntime: async () => child } });
  const entry = await launcher.resolveEntry(gamePath);
  await launcher.launchEntry(entry);
  assert.doesNotThrow(() => launcher.getLaunchContext(entry).assertSaveWriteAllowed());
});

test("module tools launch through the independent backend with transient options and tracked ownership", async t => {
  const { EventEmitter } = require("node:events");
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null });
  let launchContext, notifications = 0;
  const { launcher, gamePath, userDataDir } = fixture(t, { mod: {
    launchRuntime: async (_runtime, _entry, context) => { launchContext = context; return child; },
    actions: { openTool: (entry, _payload, context) => context.launchForTools({ runtimeId: "runner", moduleOptions: { mode: "debugger" } }) }
  }, launcher: { onToolLaunch: (entry, result) => { assert.equal(entry.gamePath, gamePath); assert.equal(result.child, child); notifications++; } } });
  const entry = await launcher.resolveEntry(gamePath);
  const result = await launcher.runAction(entry, "openTool");
  assert.equal(result.child, child);
  assert.deepEqual(launchContext.moduleLaunchOptions, { mode: "debugger" });
  assert.equal(launcher.getLaunchContext(entry).isGameRunning(), true);
  await assert.rejects(launcher.runAction(entry, "openTool"), /Quit the game/);
  assert.equal(notifications, 1);
  assert.equal(GameStore.readGameRecord(userDataDir, entry.gameId).moduleOptions, undefined);
  child.exitCode = 0; child.emit("exit", 0);
  assert.equal(launcher.getLaunchContext(entry).isGameRunning(), false);
});

test("read-only resolution neither invokes import hooks nor writes files", async t => {
  let imports = 0;
  const { launcher, gamePath, userDataDir } = fixture(t, { mod: {
    onImport: async () => { imports++; }
  } });
  const detected = await launcher.resolveEntry(gamePath, { persist: false });
  assert.equal(detected.runtimeId, "runner");
  assert.equal(imports, 0);
  assert.equal(fs.existsSync(userDataDir), false);
  await launcher.resolveEntry(gamePath);
  assert.equal(imports, 1);
  await launcher.resolveEntry(gamePath);
  assert.equal(imports, 1);
});

test("Play prepares a compatible runtime once without changing global defaults or concurrent notes", async t => {
  let installs = 0, launches = 0, release;
  const installation = new Promise(resolve => { release = resolve; });
  const events = [], child = { pid: 123 };
  const manager = { id: "test-runtime", label: "Test runtime",
    installRuntime: async payload => { installs++; assert.equal(payload.version, "2.0"); assert.equal(payload.variant, "arm64"); await installation; return { version: "2.0" }; },
    updateSettingsAfterInstall: () => { throw new Error("Automatic installation must preserve global preferences"); }
  };
  const { launcher, gamePath, userDataDir } = fixture(t, { launcher: { onPreparationChange: event => events.push(event.phase) }, mod: {
    runtimeManagers: [manager],
    ensureRuntime: async (entry, context) => {
      assert.equal(context.runtimeId, "runner"); assert.equal(context.autoInstallRuntime, true);
      assert.equal(context.ui, undefined);
      entry.runtimeData = { runner: { version: "2.0" } };
      return { managerId: manager.id, version: "2.0", installOptions: { variant: "arm64" } };
    },
    prepareLaunch: async entry => { entry.moduleData.prepared = true; },
    launchRuntime: async (_id, entry) => { assert.equal(entry.moduleData.prepared, true); launches++; return child; }
  } });
  const entry = await launcher.resolveEntry(gamePath);
  const first = launcher.launchEntry(entry), second = launcher.launchEntry(entry);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(installs, 1);
  GameStore.setGameNotes(userDataDir, entry.gameId, "Notes edited while installing");
  release();
  assert.equal((await first).child, child); assert.equal((await second).child, child);
  assert.equal(launches, 1);
  const stored = GameStore.readGameRecord(userDataDir, entry.gameId);
  assert.equal(stored.notes, "Notes edited while installing");
  assert.equal(stored.runtimeData.runner.version, "2.0");
  assert.deepEqual(events, ["check", "install", "prepare", "launch", "done"]);
  assert.equal(fs.existsSync(path.join(userDataDir, "settings.json")), false);
});

test("module compatibility preflight rejects before a download and offline launch can skip preparation", async t => {
  let downloads = 0, launches = 0;
  const { launcher, gamePath } = fixture(t, { mod: {
    runtimeManagers: [{ id: "test-runtime", installRuntime: () => { downloads++; } }],
    ensureRuntime: () => { throw new Error("Unsupported game format"); },
    launchRuntime: () => { launches++; return { pid: 123 }; }
  } });
  const entry = await launcher.resolveEntry(gamePath);
  await assert.rejects(launcher.launchEntry(entry), /Unsupported game format/);
  assert.equal(downloads, 0); assert.equal(launches, 0);
  await launcher.launchEntry(entry, { autoInstallRuntime: false });
  assert.equal(launches, 1); assert.equal(downloads, 0);
});

test("declining a missing runtime cancels before installation, preparation, or launch", async t => {
  const events = [];
  const manager = { id: "test-runtime", label: "Test runtime", installRuntime: () => assert.fail("cancelled download") };
  const { launcher, gamePath, userDataDir } = fixture(t, { launcher: {
    confirmRuntimeInstall: (plan, entry) => {
      assert.equal(plan.managerId, manager.id); assert.equal(plan.version, "2.0"); assert.equal(entry.gamePath, gamePath);
      events.push("prompt"); return false;
    }, onPreparationChange: event => events.push(event.phase)
  }, mod: { runtimeManagers: [manager],
    ensureRuntime: entry => { entry.runtimeData = { runner: { version: "2.0" } }; return { managerId: manager.id, version: "2.0" }; },
    prepareLaunch: () => assert.fail("cancelled preparation"), launchRuntime: () => assert.fail("cancelled launch")
  } });
  const entry = await launcher.resolveEntry(gamePath);
  assert.equal((await launcher.launchEntry(entry)).kind, "cancelled");
  assert.deepEqual(events, ["check", "prompt", "done"]);
  assert.equal(GameStore.readGameRecord(userDataDir, entry.gameId).runtimeData?.runner?.version, undefined);
});

test("required download consent precedes installation and all preparation", async t => {
  const calls = [];
  const manager = { id: "test-runtime", installRuntime: () => { calls.push("install"); return { version: "2.0" }; } };
  const { launcher, gamePath } = fixture(t, { launcher: {
    confirmRuntimeInstall: () => { calls.push("confirm"); return true; }
  }, mod: { runtimeManagers: [manager], ensureRuntime: () => ({ managerId: manager.id, version: "2.0" }),
    prepareLaunch: () => calls.push("prepare"), launchRuntime: () => { calls.push("launch"); return { pid: 1 }; }
  } });
  await launcher.launchEntry(await launcher.resolveEntry(gamePath));
  assert.deepEqual(calls, ["confirm", "install", "prepare", "launch"]);
});

test("bundled runtimes install offline without a download prompt", async t => {
  let installed = false; const events = [];
  const manager = { id: "test-runtime", label: "Test runtime", getState: () => ({ catalog: { versionRequirements: { "2.0": { requiresDownload: false } } } }),
    installRuntime: ({ onProgress }) => {
      onProgress({ phase: "copy", percent: 37.25 });
      onProgress({ phase: "copy", percent: 37.4 });
      onProgress({ phase: "copy", percent: NaN });
      onProgress({ phase: "ready", percent: 100 });
      installed = true; return { version: "2.0", source: "bundled" };
    } };
  const { launcher, gamePath } = fixture(t, { launcher: {
      confirmRuntimeInstall: () => assert.fail("offline bundle has no download"),
      onPreparationChange: event => events.push(event)
    },
    mod: { runtimeManagers: [manager], ensureRuntime: () => ({ managerId: manager.id, version: "2.0" }),
      launchRuntime: () => { assert.equal(installed, true); return { pid: 1 }; } }
  });
  await launcher.launchEntry(await launcher.resolveEntry(gamePath));
  const progress = events.filter(event => event.phase === "install");
  assert.equal(progress.length, 3);
  assert.deepEqual(progress.map(event => event.percent), [undefined, 37, 100]);
  for (const event of progress) {
    assert.equal(event.managerId, manager.id);
    assert.equal(event.version, "2.0");
    assert.equal(event.gamePath, gamePath);
    assert.equal(event.label, "Installing Test runtime…");
  }
  assert.equal(events.at(-1).phase, "done");
});

test("manual tool progress cannot leave the game stuck preparing after success or failure", async t => {
  const preparation = [];
  const { launcher, gamePath } = fixture(t, { launcher: { onPreparationChange: event => preparation.push(event) }, mod: {
    actions: {
      buildTool: (_entry, _payload, context) => { context.onProgress({ phase: "copy", percent: 100 }); return { ready: true }; },
      failedTool: (_entry, _payload, context) => { context.onProgress({ phase: "build", percent: 20 }); throw new Error("tool build failed"); }
    }
  } });
  const entry = await launcher.resolveEntry(gamePath);
  assert.deepEqual(await launcher.runAction(entry, "buildTool"), { ready: true });
  await assert.rejects(launcher.runAction(entry, "failedTool"), /tool build failed/);
  assert.deepEqual(preparation, []);
  const progress = [];
  launcher.getLaunchContext(entry, undefined, { onProgress: value => progress.push(value) }).onProgress({ percent: 25 });
  assert.deepEqual(progress, [{ percent: 25 }]);
  assert.deepEqual(preparation, []);
});

test("aborted library preparation cancels the launch without starting an incomplete game", async t => {
  const { launcher, gamePath } = fixture(t, { mod: {
    prepareLaunch: () => { throw Object.assign(new Error("Cancelled"), { name: "AbortError" }); },
    launchRuntime: () => assert.fail("required library is absent")
  } });
  assert.equal((await launcher.launchEntry(await launcher.resolveEntry(gamePath))).kind, "cancelled");
});

test("native process prerequisites receive this game's consent callback before spawning", async t => {
  const { EventEmitter } = require("node:events");
  const events = [], child = new EventEmitter();
  child.unref = () => {};
  let available = false;
  const rosetta = {
    requiresForExecutable: () => true, isAvailable: () => available,
    ensure: async context => {
      assert.equal(context.userDataDir, userDataDir);
      const consent = await context.confirmRuntimeInstall({ label: "Rosetta", licenseRequired: true });
      assert.deepEqual(consent, { approved: true, licenseAccepted: true });
      available = true; events.push("install");
    }
  };
  const { launcher, gamePath, userDataDir } = fixture(t, { launcher: {
    rosetta, confirmRuntimeInstall: (plan, entry) => {
      assert.equal(entry.gamePath, gamePath); assert.equal(plan.label, "Rosetta");
      events.push("confirm"); return { approved: true, licenseAccepted: true };
    }, spawn: () => { events.push("spawn"); process.nextTick(() => child.emit("spawn")); return child; }
  }, mod: { launchRuntime: (_id, _entry, context) => context.spawnDetachedChecked("/intel/runner", []) } });
  const result = await launcher.launchEntry(await launcher.resolveEntry(gamePath));
  assert.equal(result.child, child);
  assert.deepEqual(events, ["confirm", "install", "spawn"]);
});

test("module native API requirements are prepared automatically before process spawn", async t => {
  const { EventEmitter } = require("node:events");
  const events = [], child = new EventEmitter(); child.unref = () => {};
  const { launcher, gamePath, userDataDir } = fixture(t, { launcher: {
    rosetta: { requiresForExecutable: () => false },
    steamApiService: async (request, context) => {
      events.push("api");
      assert.equal(request.appId, 480);
      assert.ok(request.ownedDirectory.startsWith(path.join(userDataDir, "games") + path.sep));
      assert.equal(context.baseEnvironment.DYLD_INSERT_LIBRARIES, "/graphics.dylib");
      return { environment: { ...context.baseEnvironment, SteamAppId: "480" }, libraryPath: "/shared/libsteam_api.dylib" };
    },
    spawn: (cmd, args, options) => {
      events.push("spawn"); assert.equal(cmd, "/native/runner");
      assert.equal(options.env.SteamAppId, "480"); assert.equal(options.env.DYLD_INSERT_LIBRARIES, "/graphics.dylib");
      assert.deepEqual(args, ["game", "--mapped"]);
      process.nextTick(() => child.emit("spawn")); return child;
    }
  }, mod: {
    getSteamApiRequirement: (_entry, _context, plan) => {
      events.push("inspect"); assert.equal(plan.cmd, "/native/runner");
      return { required: true, appId: 480, arch: "arm64", symbols: ["SteamAPI_Init"] };
    },
    applySteamApi: (_entry, prepared, _context, plan) => {
      events.push("map"); assert.equal(prepared.libraryPath, "/shared/libsteam_api.dylib");
      return { ...plan, args: [...plan.args, "--mapped"] };
    },
    launchRuntime: (_id, _entry, context) => context.spawnDetachedChecked("/native/runner", ["game"], {
      env: { DYLD_INSERT_LIBRARIES: "/graphics.dylib" }
    })
  } });
  await launcher.launchEntry(await launcher.resolveEntry(gamePath));
  assert.deepEqual(events, ["inspect", "api", "map", "spawn"]);
});

test("non-Steam consumers and auxiliary tool processes skip API preparation", async t => {
  const { EventEmitter } = require("node:events");
  const child = new EventEmitter(); child.unref = () => {};
  const { launcher, gamePath } = fixture(t, { launcher: {
    rosetta: { requiresForExecutable: () => false },
    steamApiService: () => assert.fail("no actual Steam consumer"),
    spawn: (_cmd, _args, options) => {
      assert.equal(options.env.SteamAppId, undefined);
      process.nextTick(() => child.emit("spawn")); return child;
    }
  }, mod: {
    getSteamApiRequirement: (_entry, _context, plan) => plan.cmd === "/tools/decompiler" ? null : { required: false },
    launchRuntime: (_id, _entry, context) => context.spawnDetachedChecked("/tools/decompiler", [], { env: {} })
  } });
  await launcher.launchEntry(await launcher.resolveEntry(gamePath));
});

test("declining a native prerequisite cancels before spawning", async t => {
  const rosetta = { requiresForExecutable: () => true, isAvailable: () => false,
    ensure: async context => {
      assert.equal(await context.confirmRuntimeInstall({ label: "Rosetta" }), false);
      throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
    }
  };
  const { launcher, gamePath } = fixture(t, { launcher: {
    rosetta, confirmRuntimeInstall: () => false, spawn: () => assert.fail("declined prerequisite")
  }, mod: { launchRuntime: (_id, _entry, context) => context.spawnDetachedChecked("/intel/runner", []) } });
  assert.equal((await launcher.launchEntry(await launcher.resolveEntry(gamePath))).kind, "cancelled");
});

test("explicit unsupported or unlaunchable runtime fails without switching engines", async t => {
  let launches = 0;
  const { launcher, gamePath, userDataDir, mod } = fixture(t, { mod: {
    launchRuntime: () => { launches++; }
  } });
  await assert.rejects(launcher.resolveEntry(gamePath, { runtimeId: "wine" }), /not supported/);
  assert.equal(fs.existsSync(userDataDir), false);
  mod.canLaunchRuntime = runtimeId => runtimeId !== "runner";
  await assert.rejects(launcher.resolveEntry(gamePath, { runtimeId: "runner" }), /cannot launch/);
  assert.equal(launches, 0);
});

test("same backend dispatches a hosted game through its supplied adapter", async t => {
  let calls = 0;
  const win = {};
  const { launcher, gamePath, manifest } = fixture(t, { launcher: {
    launchHosted: async (entry, runtimeId, context) => {
      calls++;
      assert.equal(runtimeId, "host");
      assert.equal(context.runtimeId, "host");
      assert.ok(entry.indexHtml);
      return { win };
    }
  } });
  manifest.gameType = "web";
  manifest.runtime = { supported: ["host"], default: "host", hosted: { id: "host" } };
  manifest.settingsDefaults.defaultRuntime = "host";
  const entry = await launcher.resolveEntry(gamePath);
  entry.indexHtml = path.join(gamePath, "index.html");
  assert.equal((await launcher.launchEntry(entry)).win, win);
  assert.equal(calls, 1);
  entry.indexHtml = null;
  await assert.rejects(launcher.launchEntry(entry), /Missing index.html/);
  assert.equal(calls, 1);
});

test("running games protect a shared save folder across different library records", async t => {
  const { EventEmitter } = require("node:events");
  const child = new EventEmitter();
  const { launcher, gamePath, root } = fixture(t, { mod: { launchRuntime: () => child } });
  const entry = await launcher.resolveEntry(gamePath);
  entry.defaultSaveDir = path.join(root, "shared-saves");
  fs.mkdirSync(entry.defaultSaveDir);
  await launcher.launchEntry(entry);
  const other = { ...entry, gameId: "different-game", gamePath: path.join(root, "other-game") };
  assert.throws(() => launcher.saveService.assertWriteAllowed(other), /Stop the game/);
  child.emit("exit", 0);
  child.emit("close", 0);
  assert.doesNotThrow(() => launcher.saveService.assertWriteAllowed(other));
});

test("existing saved entry identity, per-game overrides, and module merge hook survive detection", async t => {
  const { launcher, gamePath, userDataDir } = fixture(t, { mod: {
    mergeEntry: (existing, merged) => ({ ...merged, defaultSaveDir: existing?.defaultSaveDir || "/new" })
  } });
  GameStore.writeGameRecord(userDataDir, {
    gameId: "stable-id", moduleId: "test", gamePath, importPath: gamePath,
    defaultSaveDir: "/saves", saveDirOverride: "/custom-saves", runtimeId: "runner",
    runtimeSettings: { runner: { flag: false } }, moduleData: { kept: true }
  });
  const entry = await launcher.resolveEntry(gamePath);
  assert.equal(entry.gameId, "stable-id");
  assert.equal(entry.defaultSaveDir, "/saves");
  assert.equal(entry.saveDirOverride, "/custom-saves");
  assert.equal(entry.moduleData.kept, true);
  assert.deepEqual(launcher.getLaunchContext(entry).runtimeSettings, { flag: false });
});

function runCli(root, ...args) {
  const overrides = args[0] && typeof args[0] === "object" ? args.shift() : {};
  const env = { ...process.env, ...overrides };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const guard = path.join(root, "no-electron.cjs");
  fs.writeFileSync(guard, `const Module=require('node:module'); const load=Module._load; Module._load=function(name,...args){ if(name==='electron') throw Error('Unexpected Electron import'); return load.call(this,name,...args); };`);
  return spawnSync(process.execPath, ["--require", guard,
    path.join(__dirname, "..", "scripts/run-game.mjs"), ...args], { env, encoding: "utf8", timeout: 20000 });
}

test("CLI inspects a web game offline without Electron or creating launcher state", t => {
  const { root, gamePath, userDataDir } = fixture(t);
  fs.writeFileSync(path.join(gamePath, "index.html"), "<title>Web test</title>");
  const result = runCli(root, "--game", gamePath, "--user-data", userDataDir, "--inspect");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).entry.moduleId, "web");
  assert.equal(fs.existsSync(userDataDir), false);
});

test("CLI explicitly selects the standalone hosted entry and waits for its acknowledged child", t => {
  const { root, gamePath, userDataDir } = fixture(t);
  fs.writeFileSync(path.join(gamePath, "index.html"), "<title>Hosted test</title>");
  const host = path.join(root, "host.cjs");
  const reporterPath = require.resolve("../src/core/hosted-startup-reporter");
  fs.writeFileSync(host, `#!/usr/bin/env node
if (!process.argv.includes("--maclauncher-runtime-host")) {
  console.error("Missing standalone runtime entry flag"); process.exit(2);
}
const { createHostedStartupReporter } = require(${JSON.stringify(reporterPath)});
createHostedStartupReporter().ready({ windowId: 1, url: "http://127.0.0.1:1234/index.html" });
setTimeout(() => process.exit(7), 100);
`, { mode: 0o755 });
  const result = runCli(root, { MACLAUNCHER_ELECTRON_PATH: host }, "--game", gamePath,
    "--runtime", "electron", "--user-data", userDataDir, "--wait", "--offline");
  assert.equal(result.status, 7, result.stderr);
  const games = GameStore.loadGames(userDataDir);
  assert.equal(games[0].runtimeId, "electron");
  assert.ok(games[0].lastPlayedAt > 0);
});

test("CLI runs a native app directly and returns its exit status without loading Electron", t => {
  if (process.platform !== "darwin") return t.skip("macOS app fixture");
  const { root, userDataDir } = fixture(t);
  const appPath = path.join(root, "Native Test.app");
  const macos = path.join(appPath, "Contents/MacOS");
  const resources = path.join(appPath, "Contents/Resources/app.nw");
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, "index.html"), "<title>Native fixture</title>");
  const marker = path.join(root, "ran.txt");
  const escaped = marker.replaceAll("'", "'\\''");
  fs.writeFileSync(path.join(macos, "Native Test"), `#!/bin/sh\nprintf native-output\\n\nprintf ran > '${escaped}'\nexit 7\n`, { mode: 0o755 });
  const result = runCli(root, "--game", appPath, "--runtime", "native", "--user-data", userDataDir, "--wait");
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stdout, /native-output/);
  assert.equal(fs.readFileSync(marker, "utf8"), "ran");
  const games = GameStore.loadGames(userDataDir);
  assert.equal(games.length, 1);
  assert.equal(games[0].runtimeId, "native");
  assert.ok(games[0].lastPlayedAt > 0);
});

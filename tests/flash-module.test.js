const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");
const Processes = require("../src/core/processes");

const FlashModule = require("../src/modules/flash/main");

const RuffleManager = FlashModule.runtimeManagers[0];
const RuffleCore = RuffleManager.core;
const ProjectorManager = FlashModule.runtimeManagers.find(manager => manager.id === "flash-projector");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createAppBundle(appPath, executableName) {
  const execPath = path.join(appPath, "Contents", "MacOS", executableName);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"),
    `<plist version="1.0"><dict><key>CFBundleExecutable</key><string>${executableName}</string></dict></plist>`);
  return { execPath };
}

function createRuffleInstall(userDataDir, version, executableName = "Ruffle") {
  const appPath = path.join(userDataDir, "runtimes", "ruffle", version, "Ruffle.app");
  const { execPath } = createAppBundle(appPath, executableName);
  return { appPath, execPath };
}

test("ordinary projector launch uses the included universal executable without Rosetta or runtime copies", async () => {
  const root = makeTempDir("maclauncher-flash-module-");
  try {
    const swfPath = path.join(root, "game $(literal).swf");
    fs.writeFileSync(swfPath, "FWS");

    const selection = ProjectorManager.resolveSelection();
    assert.equal(selection.ready, true);
    assert.equal(selection.version, "35.0.0.60");

    const launches = [];
    let rosetta = 0;
    const result = await FlashModule.launchRuntime("projector", {
      gamePath: swfPath,
      moduleData: { swfPath }
    }, {
      ensureRosetta: async () => { rosetta++; },
      gameArguments: ["--title", "A quoted game", "", "$(literal)"],
      spawnDetachedChecked: async (cmd, args, options, needsRosetta) => {
        launches.push({ cmd, args, options, needsRosetta });
        return { pid: 1234 };
      },
      logger: { info: () => {} }
    });

    assert.ok(result);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].cmd, selection.install.executablePath);
    assert.deepEqual(launches[0].args, [swfPath, "--title", "A quoted game", "", "$(literal)"]);
    assert.equal(launches[0].options.cwd, path.dirname(swfPath));
    assert.equal(launches[0].needsRosetta, false);
    assert.equal(rosetta, 0);
    assert.deepEqual(fs.readdirSync(root), [path.basename(swfPath)]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ruffle runtime launch resolves installed runtime version", async () => {
  const root = makeTempDir("maclauncher-flash-module-");
  try {
    const userDataDir = path.join(root, "userData");
    const version = "nightly-2026-03-06";
    const { appPath, execPath } = createRuffleInstall(userDataDir, version);

    const swfPath = path.join(root, "game.swf");
    fs.writeFileSync(swfPath, "FWS");

    const launches = [];
    const result = await FlashModule.launchRuntime("ruffle", {
      gamePath: swfPath,
      moduleData: { swfPath },
      runtimeData: {
        ruffle: {
          version
        }
      }
    }, {
      userDataDir,
      gameArguments: ["--title", "A quoted game", "", "$(literal)"],
      settings: {
        runtimes: {
          ruffle: {
            defaultVersion: version
          }
        }
      },
      spawnDetachedChecked: async (cmd, args, options) => {
        launches.push({ cmd, args, options });
        return { pid: 2345 };
      },
      logger: { info: () => {} }
    });

    assert.ok(result);
    assert.equal(launches.length, 1);
    const expected = FlashModule.__test.ruffleLaunchCommand(appPath, execPath, swfPath, ["--title", "A quoted game", "", "$(literal)"]);
    assert.equal(launches[0].cmd, expected.command);
    assert.deepEqual(launches[0].args, expected.args);
    assert.equal(launches[0].options.cwd, process.platform === "darwin" ? appPath : path.dirname(swfPath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtimeStatus reports ruffle readiness from installed runtimes", () => {
  const root = makeTempDir("maclauncher-flash-module-");
  try {
    const userDataDir = path.join(root, "userData");
    const entry = {
      gamePath: path.join(root, "game.swf"),
      moduleData: {
        swfPath: path.join(root, "game.swf")
      },
      runtimeData: {}
    };

    const missing = FlashModule.actions.runtimeStatus(entry, {}, {
      settings: { runtimes: { ruffle: {} } },
      userDataDir
    });
    assert.equal(missing.ready, false);
    assert.equal(missing.installed, false);

    const version = "nightly-2026-03-06";
    createRuffleInstall(userDataDir, version);
    const installed = FlashModule.actions.runtimeStatus(entry, {}, {
      settings: {
        runtimes: {
          ruffle: {
            defaultVersion: version
          }
        }
      },
      userDataDir
    });
    assert.equal(installed.ready, true);
    assert.equal(installed.installed, true);
    assert.equal(installed.resolvedVersion, version);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed Ruffle tracks its contained executable and keeps the literal SWF argument", t => {
  const root = makeTempDir("maclauncher-flash-module-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "nightly version", "Ruffle.app");
  const { execPath } = createAppBundle(app, "ruffle");
  const swf = "/games/name $(literal).swf";
  assert.deepEqual(FlashModule.__test.ruffleLaunchCommand(app, execPath, swf), {
    command: execPath, args: [swf]
  });
});

test("stopping a managed Flash app terminates the tracked native process", async t => {
  const root = makeTempDir("maclauncher-flash-module-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "userData");
  const version = "nightly-2026-03-06";
  const { execPath } = createRuffleInstall(userDataDir, version);
  fs.writeFileSync(execPath, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
  const swfPath = path.join(root, "game.swf");
  fs.writeFileSync(swfPath, "FWS");
  const child = await FlashModule.launchRuntime("ruffle", {
    gamePath: swfPath, moduleData: { swfPath }, runtimeData: { ruffle: { version } }
  }, { userDataDir, settings: {}, spawnDetachedChecked: Processes.spawnDetachedChecked });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  assert.ok(child.pid > 0);
  process.kill(child.pid, 0);
  const exit = once(child, "exit");
  assert.equal(child.kill("SIGTERM"), true);
  await exit;
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("installRuntime persists per-game version only when explicitly requested", async t => {
  const root = makeTempDir("maclauncher-flash-module-");
  const originalResolveInstalled = RuffleCore.resolveInstalled;
  const originalInstallRuntime = RuffleManager.installRuntime;

  try {
    const userDataDir = path.join(root, "userData");
    const installedVersion = "nightly-2026-03-06";
    t.mock.method(RuffleManager, "getState", () => ({sections: [{catalog: {versions: [installedVersion]}}]}));
    t.mock.method(RuffleManager, "refreshCatalog", () => assert.fail("cached release metadata needs no network"));

    RuffleCore.resolveInstalled = () => null;
    RuffleManager.installRuntime = async () => ({ version: installedVersion });

    const noOverrideEntry = {
      gamePath: path.join(root, "game.swf"),
      moduleData: {
        swfPath: path.join(root, "game.swf")
      },
      runtimeData: {}
    };

    const noOverride = await FlashModule.actions.installRuntime(noOverrideEntry, {}, {
      settings: {
        runtimes: {
          ruffle: {
            defaultVersion: installedVersion
          }
        }
      },
      userDataDir,
      logger: { info: () => {} },
      downloads: null
    });

    assert.equal(noOverride.version, installedVersion);
    assert.equal(noOverrideEntry.runtimeData.ruffle, undefined);

    const explicitEntry = {
      gamePath: path.join(root, "game.swf"),
      moduleData: {
        swfPath: path.join(root, "game.swf")
      },
      runtimeData: {}
    };

    const explicit = await FlashModule.actions.installRuntime(
      explicitEntry,
      { version: installedVersion },
      {
        settings: {
          runtimes: {
            ruffle: {
              defaultVersion: installedVersion
            }
          }
        },
        userDataDir,
        logger: { info: () => {} },
        downloads: null
      }
    );

    assert.equal(explicit.version, installedVersion);
    assert.equal(explicitEntry.runtimeData.ruffle.version, installedVersion);
  } finally {
    RuffleCore.resolveInstalled = originalResolveInstalled;
    RuffleManager.installRuntime = originalInstallRuntime;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("projector runtime reports a missing app repair without a download or backend switch", async t => {
  const root = makeTempDir("maclauncher-flash-module-");
  try {
    const swfPath = path.join(root, "game.swf");
    fs.writeFileSync(swfPath, "FWS");

    t.mock.method(ProjectorManager, "resolveSelection", () => ({ ready: false, version: "35.0.0.60", reason: "Included Flash Player is missing. Reinstall MacLauncher." }));

    await assert.rejects(
      () =>
        FlashModule.launchRuntime("projector", {
          gamePath: swfPath,
          moduleData: { swfPath }
        }, {
          spawnDetachedChecked: async () => ({ pid: 1 }),
          logger: { info: () => {} }
        }),
      err => {
        const message = String(err?.message || "");
        return (
          message.includes("Included Flash Player is missing") &&
          message.includes("Reinstall MacLauncher")
        );
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

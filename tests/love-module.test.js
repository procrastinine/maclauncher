const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const LoveModule = require("../src/modules/love/main");
const LoveManager = LoveModule.runtimeManagers[0];
const SevenZip = require("../src/modules/shared/runtime/sevenzip");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, contents, options) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, options);
}

function createRuntimeInstall(
  userDataDir,
  channel,
  version,
  { bundleVersion = version, headSha = null, runStartedAt = null } = {}
) {
  const installDir = path.join(userDataDir, "runtimes", "love", channel, version);
  const appPath = path.join(installDir, "love.app");
  const execPath = path.join(appPath, "Contents", "MacOS", "love");
  writeFile(execPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\"",
      "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
      "<plist version=\"1.0\">",
      "<dict>",
      "  <key>CFBundleExecutable</key>",
      "  <string>love</string>",
      "  <key>CFBundleShortVersionString</key>",
      `  <string>${bundleVersion}</string>`,
      "</dict>",
      "</plist>",
      ""
    ].join("\n")
  );
  writeFile(
    path.join(installDir, ".maclauncher-love.json"),
    JSON.stringify(
      {
        channel,
        version,
        buildKey: channel === "nightly" ? version : null,
        source: channel === "nightly" ? "GitHub Actions" : "GitHub Releases",
        bundleVersionRaw: bundleVersion,
        bundleVersionNormalized: bundleVersion,
        headSha,
        runStartedAt
      },
      null,
      2
    )
  );
  return { installDir, appPath, execPath };
}

test("filterRuntimeSupport hides native outside app bundles", () => {
  const supported = ["love", "native"];
  assert.deepEqual(
    LoveModule.filterRuntimeSupport({ moduleData: { sourceKind: "love-archive" } }, supported),
    ["love"]
  );
  assert.deepEqual(
    LoveModule.filterRuntimeSupport({ moduleData: { sourceKind: "app-bundle" } }, supported),
    supported
  );
});

test("launchRuntime launches .love archives with an installed matching release", async () => {
  const root = makeTempDir("maclauncher-love-launch-");
  try {
    const archivePath = path.join(root, "Game.love");
    writeFile(archivePath, "zip");
    const userDataDir = path.join(root, "userData");
    const install = createRuntimeInstall(userDataDir, "stable", "11.5");

    const launches = [];
    const result = await LoveModule.launchRuntime(
      "love",
      {
        gameId: "game-love",
        gamePath: archivePath,
        moduleData: {
          sourceKind: "love-archive",
          launchTargetPath: archivePath,
          detectedVersion: "11.5"
        },
        runtimeData: {}
      },
      {
        userDataDir,
        settings: { runtimes: { love: {} } },
        logger: { info: () => {} },
        spawnDetachedChecked: async (cmd, args, options, needsRosetta) => {
          launches.push({ cmd, args, options, needsRosetta });
          return { pid: 1234 };
        }
      }
    );

    assert.ok(result);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].cmd, install.execPath);
    assert.deepEqual(launches[0].args, [archivePath]);
    assert.equal(launches[0].options.cwd, root);
    assert.equal(launches[0].needsRosetta, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launchRuntime extracts AppImages into per-game module data before launch", async () => {
  const root = makeTempDir("maclauncher-love-appimage-launch-");
  const originalExtract = SevenZip.extractArchive;
  try {
    const userDataDir = path.join(root, "userData");
    createRuntimeInstall(userDataDir, "stable", "11.5");
    const appImagePath = path.join(root, "example-game.AppImage");
    writeFile(appImagePath, "appimage");

    SevenZip.extractArchive = async (_archivePath, destDir) => {
      const binaryPath = path.join(destDir, "bin", "example-game");
      writeFile(binaryPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      return true;
    };

    const launches = [];
    const entry = {
      gameId: "game-love-appimage",
      gamePath: appImagePath,
      moduleData: {
        sourceKind: "appimage",
        packagedPath: appImagePath,
        detectedVersion: "11.5",
        appImageLaunchRelativePath: "bin/example-game",
        appImageReady: false
      },
      runtimeData: {}
    };

    await LoveModule.launchRuntime("love", entry, {
      userDataDir,
      settings: { runtimes: { love: {} } },
      logger: { info: () => {} },
      spawnDetachedChecked: async (cmd, args, options) => {
        launches.push({ cmd, args, options });
        return { pid: 4321 };
      }
    });

    assert.equal(launches.length, 1);
    assert.ok(String(entry.moduleData.appImageExtractRoot || "").includes("appimage"));
    assert.equal(entry.moduleData.appImageReady, true);
    assert.ok(String(entry.moduleData.launchTargetPath || "").endsWith(path.join("bin", "example-game")));
    assert.deepEqual(launches[0].args, [entry.moduleData.launchTargetPath]);
  } finally {
    SevenZip.extractArchive = originalExtract;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtimeStatus prefers installed nightlies that match the detected bundle version", () => {
  const root = makeTempDir("maclauncher-love-status-");
  try {
    const userDataDir = path.join(root, "userData");
    const buildKey = "2026-03-01T15-25-27Z_7d41f3ad30f4a171140f8b2ff53e534add018bb4";
    createRuntimeInstall(userDataDir, "nightly", buildKey, {
      bundleVersion: "12.0",
      headSha: "7d41f3ad30f4a171140f8b2ff53e534add018bb4",
      runStartedAt: "2026-03-01T15:25:27Z"
    });

    const entry = {
      gameId: "game-love-status",
      gamePath: path.join(root, "Game.love"),
      moduleData: {
        sourceKind: "love-archive",
        launchTargetPath: path.join(root, "Game.love"),
        detectedVersion: "12.0"
      },
      runtimeData: {}
    };

    const status = LoveModule.actions.runtimeStatus(entry, {}, {
      settings: { runtimes: { love: {} } },
      userDataDir
    });

    assert.equal(status.ready, true);
    assert.equal(status.installed, true);
    assert.equal(status.resolvedChannel, "nightly");
    assert.equal(status.resolvedVersion, buildKey);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtimeStatus ignores detected stable versions when nightly is explicitly selected", () => {
  const root = makeTempDir("maclauncher-love-explicit-nightly-");
  try {
    const buildKey = "2026-03-01T15-25-27Z_7d41f3ad30f4a171140f8b2ff53e534add018bb4";
    const entry = {
      gameId: "game-love-explicit-nightly",
      gamePath: path.join(root, "Example.exe"),
      moduleData: {
        sourceKind: "windows-fused",
        launchTargetPath: path.join(root, "Example.exe"),
        detectedVersion: "0.8"
      },
      runtimeData: {
        love: {
          channel: "nightly"
        }
      }
    };

    const status = LoveModule.actions.runtimeStatus(entry, {}, {
      settings: {
        runtimes: {
          love: {
            nightly: {
              defaultVersion: buildKey
            }
          }
        }
      },
      userDataDir: path.join(root, "userData")
    });

    assert.equal(status.ready, false);
    assert.equal(status.installed, false);
    assert.equal(status.installChannel, "nightly");
    assert.equal(status.installVersion, buildKey);
    assert.equal(status.requiredVersion, null);
    assert.equal(status.promptKey, `nightly:${buildKey}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launchRuntime reports a missing selected nightly instead of a detected stable version", async () => {
  const root = makeTempDir("maclauncher-love-explicit-nightly-launch-");
  try {
    const buildKey = "2026-03-01T15-25-27Z_deadbeef";
    await assert.rejects(
      () =>
        LoveModule.launchRuntime(
          "love",
          {
            gameId: "game-love-explicit-nightly-launch",
            gamePath: path.join(root, "Example.exe"),
            moduleData: {
              sourceKind: "windows-fused",
              packagedPath: path.join(root, "Example.exe"),
              launchTargetPath: path.join(root, "Example.exe"),
              detectedVersion: "0.8"
            },
            runtimeData: {
              love: {
                channel: "nightly"
              }
            }
          },
          {
            settings: {
              runtimes: {
                love: {
                  nightly: {
                    defaultVersion: buildKey
                  }
                }
              }
            },
            userDataDir: path.join(root, "userData"),
            logger: { info: () => {} },
            spawnDetachedChecked: async () => {
              throw new Error("should not launch");
            }
          }
        ),
      new RegExp(`Selected LÖVE nightly runtime ${buildKey} is not installed\\.`)
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installRuntime falls back to the configured nightly channel for unreleased detected versions", async () => {
  const root = makeTempDir("maclauncher-love-install-");
  const originalInstallRuntime = LoveManager.installRuntime;
  const originalRefreshCatalog = LoveManager.refreshCatalog;
  try {
    const buildKey = "2026-03-01T15-25-27Z_7d41f3ad30f4a171140f8b2ff53e534add018bb4";
    const calls = [];
    LoveManager.installRuntime = async payload => {
      calls.push({ sectionId: payload.sectionId, version: payload.version });
      return {
        channel: payload.sectionId,
        version: payload.version,
        buildKey: payload.sectionId === "nightly" ? payload.version : null
      };
    };
    LoveManager.refreshCatalog = async () => true;

    const entry = {
      gameId: "game-love-install",
      gamePath: path.join(root, "Game.love"),
      moduleData: {
        sourceKind: "love-archive",
        launchTargetPath: path.join(root, "Game.love"),
        detectedVersion: "12.0"
      },
      runtimeData: {}
    };

    const result = await LoveModule.actions.installRuntime(
      entry,
      {
        status: {
          installChannel: "stable",
          requiredVersion: "12.0"
        }
      },
      {
        settings: {
          runtimes: {
            love: {
              nightly: {
                defaultVersion: buildKey
              }
            }
          }
        },
        userDataDir: path.join(root, "userData"),
        logger: { info: () => {} },
        downloads: null
      }
    );

    assert.deepEqual(calls, [{ sectionId: "nightly", version: buildKey }]);
    assert.equal(result.channel, "nightly");
    assert.equal(entry.runtimeData.love.channel, "nightly");
    assert.equal(entry.runtimeData.love.version, buildKey);
  } finally {
    LoveManager.installRuntime = originalInstallRuntime;
    LoveManager.refreshCatalog = originalRefreshCatalog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

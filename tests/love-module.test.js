const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const LoveModule = require("../src/modules/love/main");
const LoveManager = LoveModule.runtimeManagers[0];
const SevenZip = require("../src/modules/shared/runtime/sevenzip");
const Zip = require("../src/modules/shared/runtime/zip");
const Archive = require("../src/modules/love/archive");
const Detect = require("../src/modules/love/detect");
const { writeZipArchive } = require("./helpers/zip-fixture");

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
        gameArguments: ["--windowed", "A name", ""],
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
    assert.deepEqual(launches[0].args, [archivePath, "--windowed", "A name", ""]);
    assert.equal(launches[0].options.cwd, root);
    assert.equal(launches[0].needsRosetta, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nested archives launch their unique game root with original cwd, arguments and save basename", async t => {
  const root = makeTempDir("maclauncher-love-nested-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "A Game.love"), userDataDir = path.join(root, "profile");
  const entries = [{ name: "package/game/main.lua", data: "return 'actual game'", deflate: true },
    { name: "package/game/conf.lua", data: 'function love.conf(t) t.version = "11.5" end' },
    { name: "package/game/images/sprite.png", data: Buffer.from([0, 1, 2, 255]) },
    { name: "package/game/vendor/demo/main.lua", data: "nested library" },
    { name: "README.md", data: "outside game root" }];
  writeZipArchive(file, entries);
  fs.chmodSync(file, 0o444);
  writeFile(path.join(root, "sibling-library.dylib"), "original sibling");
  const before = fs.readFileSync(file), beforeMode = fs.statSync(file).mode;
  const detected = Detect.detectGame({ inputPath: file, rootDir: root, stat: fs.statSync(file) });
  assert.equal(detected.moduleData.archiveRoot, "package/game");
  const entry = { ...detected, gameId: "nested-love", runtimeData: {} }, launches = [];
  createRuntimeInstall(userDataDir, "stable", "11.5");
  const context = { userDataDir, settings: { runtimes: { love: {} } },
    gameArguments: ["--windowed", "name with spaces", ""],
    spawnDetachedChecked: async (command, args, options) => { launches.push({ command, args, options }); return { pid: 123 }; } };
  await LoveModule.launchRuntime("love", entry, context);
  const target = launches[0].args[0];
  assert.notEqual(target, file);
  assert.equal(path.basename(target), path.basename(file), "stock LÖVE derives the same default save identity");
  assert.equal(fs.readFileSync(path.join(target, "main.lua"), "utf8"), "return 'actual game'");
  assert.deepEqual(fs.readFileSync(path.join(target, "images/sprite.png")), Buffer.from([0, 1, 2, 255]));
  assert.equal(fs.existsSync(path.join(target, "README.md")), false);
  assert.equal(launches[0].options.cwd, root);
  assert.deepEqual(launches[0].args.slice(1), context.gameArguments);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.statSync(file).mode, beforeMode);
  t.mock.method(Zip, "extractZipEntry", () => assert.fail("Warm launch must reuse prepared assets"));
  await LoveModule.launchRuntime("love", entry, context);
  assert.equal(launches[1].args[0], target);
});

test("root archives and fused exports retain their direct target without preparation", async t => {
  const root = makeTempDir("maclauncher-love-root-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, prefix] of [["Root.love", Buffer.alloc(0)], ["Root.exe", Buffer.from("MZpublisher")]]) {
    const file = path.join(root, name);
    writeZipArchive(file, [{ name: "main.lua", data: "root" }, { name: "examples/main.lua", data: "example" }], { prefix });
    const detected = Detect.detectGame({ inputPath: file, rootDir: root, stat: fs.statSync(file) });
    assert.equal(detected.moduleData.archiveRoot, "");
    assert.equal(await Archive.prepare(file, detected, {}), file);
  }
  const confOnly = path.join(root, "Conf.love");
  writeZipArchive(confOnly, [{ name: "conf.lua", data: 'function love.conf(t) t.version = "11.5" end' },
    { name: "examples/main.lua", data: "auxiliary example" }]);
  const detected = Detect.detectGame({ inputPath: confOnly, rootDir: root, stat: fs.statSync(confOnly) });
  assert.equal(detected.moduleData.archiveRoot, "");
  assert.equal(detected.moduleData.detectedVersion, "11.5");
  assert.equal(await Archive.prepare(confOnly, detected, {}), confOnly);
  assert.equal(fs.readdirSync(root).length, 3, "No owned preparation directory is needed");
});

test("independent nested games are rejected instead of launching the shortest root", async t => {
  const root = makeTempDir("maclauncher-love-ambiguous-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "Bundle.love");
  writeZipArchive(file, [{ name: "one/main.lua", data: "one" }, { name: "other/game/main.lua", data: "two" }]);
  const detected = Detect.detectGame({ inputPath: file, rootDir: root, stat: fs.statSync(file) });
  assert.equal(detected.moduleData.archiveAmbiguous, true);
  await assert.rejects(Archive.prepare(file, detected, {}), /multiple games/);
});

test("nested preparation rejects traversal, conflicting resources, aliases and cancellation", async t => {
  const root = makeTempDir("maclauncher-love-unsafe-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = { userDataDir: path.join(root, "profile") }, entry = { gameId: "unsafe", moduleData: { archiveRoot: "game" } };
  const file = path.join(root, "Unsafe.love");
  for (const extra of [[{ name: "game/../escape", data: "bad" }],
    [{ name: "game/asset", data: "one" }, { name: "game/ASSET", data: "two" }]]) {
    writeZipArchive(file, [{ name: "game/main.lua", data: "actual" }, ...extra]);
    await assert.rejects(Archive.prepare(file, entry, context), /unsafe|conflicting/);
    assert.equal(fs.existsSync(context.userDataDir), false);
  }
  writeZipArchive(file, [{ name: "game/main.lua", data: "actual" }]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(Archive.prepare(file, entry, { ...context, signal: controller.signal }), { name: "AbortError" });
  assert.equal(fs.existsSync(context.userDataDir), false);
  fs.mkdirSync(context.userDataDir); fs.mkdirSync(path.join(root, "outside"));
  fs.symlinkSync(path.join(root, "outside"), path.join(context.userDataDir, "games"));
  await assert.rejects(Archive.prepare(file, entry, context), /aliases/);
  assert.deepEqual(fs.readdirSync(path.join(root, "outside")), []);
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
    assert.equal(status.installVersion, null);
    assert.equal(status.requiredVersion, null);
    assert.equal(status.promptKey, "nightly:latest");
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
                channel: "nightly", version: buildKey
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

test("installRuntime uses a catalogued nightly for unreleased detected versions without creating a game pin", async t => {
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
    t.mock.method(LoveManager, "getState", () => ({ sections: [
      { id: "stable", installed: [], catalog: { versions: ["11.5"], status: "success" } },
      { id: "nightly", installed: [], catalog: { versions: [buildKey], status: "success" } }
    ] }));

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
    assert.deepEqual(entry.runtimeData, {});
  } finally {
    LoveManager.installRuntime = originalInstallRuntime;
    LoveManager.refreshCatalog = originalRefreshCatalog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("LÖVE Auto reuses the newest ready installed release and version-only overrides remain exact", async t => {
  const root = makeTempDir("maclauncher-love-auto-"); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "data"); createRuntimeInstall(userDataDir, "stable", "11.4"); createRuntimeInstall(userDataDir, "stable", "11.5");
  const partial = createRuntimeInstall(userDataDir, "stable", "11.6"); fs.rmSync(partial.execPath);
  t.mock.method(LoveManager, "refreshCatalog", () => assert.fail("Ready LÖVE Auto must stay offline"));
  t.mock.method(LoveManager, "installRuntime", () => assert.fail("Ready LÖVE Auto must not install"));
  const context = { runtimeId: "love", userDataDir, settings: { runtimes: { love: { stable: { defaultVersion: "11.4" } } } } };
  const entry = { moduleData: { resolvedChannel: "nightly" }, runtimeData: {} };
  assert.equal(LoveModule.actions.runtimeStatus(entry, {}, context).resolvedVersion, "11.5");
  assert.equal(await LoveModule.ensureRuntime(entry, context), null);
  assert.deepEqual(entry.runtimeData, {});
  entry.runtimeData.love = { version: "11.4" };
  assert.equal(LoveModule.actions.runtimeStatus(entry, {}, context).resolvedVersion, "11.4");
  assert.equal(await LoveModule.ensureRuntime(entry, context), null);
  entry.runtimeData.love.version = "11.3";
  assert.equal(LoveModule.actions.runtimeStatus(entry, {}, context).ready, false);
});

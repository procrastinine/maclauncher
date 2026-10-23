const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const Helper = require("../src/modules/rgss/runtime/mkxpz-config-helper");

test("the helper supplemental conforms to the shared distribution declaration", () => {
  assert.doesNotThrow(() => require("../scripts/native-supplementals.cjs").validateDeclaration(Helper.declaration()));
});

test("native config helper isolates old and parent layouts through original Foundation calls", { skip: process.platform !== "darwin", timeout: 30000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mkxpz-native-config-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "publisher", "Fixture.app"), executable = path.join(app, "Contents", "MacOS", "fixture");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIdentifier</key><string>org.maclauncher.config-fixture</string><key>CFBundleName</key><string>Publisher runtime</string></dict></plist>');
  execFileSync("/usr/bin/xcrun", ["clang++", "-fobjc-arc", "-framework", "Foundation", path.join(__dirname, "fixtures/mkxpz-config-layout.mm"), "-o", executable], { stdio: "pipe" });
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", executable], { stdio: "pipe" });
  const library = process.env.MACLAUNCHER_TEST_MKXPZ_HELPER_ROOT
    ? path.join(fs.realpathSync(process.env.MACLAUNCHER_TEST_MKXPZ_HELPER_ROOT), "mkxpz-config.dylib")
    : (await Helper.resolveConfigHelper()).dylibPath;
  const game = path.join(root, "game"), target = path.join(root, "private-config"), bundleGame = path.join(app, "Contents", "Game"), parent = path.dirname(app);
  for (const dir of [game, target, bundleGame]) fs.mkdirSync(dir, { recursive: true });
  const value = '{"private":"retained"}'; fs.writeFileSync(path.join(target, "mkxp.json"), value);
  fs.writeFileSync(path.join(bundleGame, "mkxp.json"), '{"publisher":"old"}');
  const invoke = (source, expected = target, expectedValue = value, selected = executable, gameName, expectedName = "Publisher runtime",
    expectedProcessName = "fixture", expectedBundleIdentifier = "org.maclauncher.config-fixture") => spawnSync(executable, [source, expected, game, expectedValue], { encoding: "utf8", timeout: 10000,
    env: { ...process.env, DYLD_INSERT_LIBRARIES: library, MACLAUNCHER_MKXPZ_CONFIG_EXECUTABLE: selected, MACLAUNCHER_MKXPZ_CONFIG_SOURCE: source, MACLAUNCHER_MKXPZ_CONFIG_TARGET: target,
      MACLAUNCHER_MKXPZ_CONFIG_GAME_NAME: gameName, MACLAUNCHER_TEST_EXPECT_DISPLAY_NAME: expectedName,
      MACLAUNCHER_TEST_EXPECT_PROCESS_NAME: expectedProcessName, MACLAUNCHER_TEST_EXPECT_BUNDLE_IDENTIFIER: expectedBundleIdentifier } });
  const old = invoke(bundleGame); assert.equal(old.status, 0, old.stderr);
  fs.rmSync(bundleGame, { recursive: true });
  const absent = invoke(bundleGame); assert.equal(absent.status, 0, absent.stderr);
  const original = '{"publisher":"new"}'; fs.writeFileSync(path.join(parent, "mkxp.json"), original);
  const current = invoke(parent); assert.equal(current.status, 0, current.stderr);
  const identity = invoke(parent, target, value, executable, "Test game 日本語"); assert.equal(identity.status, 0, identity.stderr);
  const plist = path.join(app, "Contents", "Info.plist"), originalPlist = fs.readFileSync(plist, "utf8");
  fs.writeFileSync(plist, originalPlist.replace('<key>CFBundleIdentifier</key><string>org.maclauncher.config-fixture</string>', ''));
  const noIdentifier = invoke(parent, target, value, executable, "Test game", "Publisher runtime", "fixture", "");
  assert.equal(noIdentifier.status, 0, noIdentifier.stderr);
  fs.writeFileSync(plist, originalPlist);
  const foreign = invoke(parent, parent, original, path.join(root, "different-executable"), "Unrelated game"); assert.equal(foreign.status, 0, foreign.stderr);
  const wrong = invoke(game); assert.equal(wrong.status, 78); assert.match(wrong.stderr, /config source does not match/);
  assert.equal(fs.readFileSync(path.join(parent, "mkxp.json"), "utf8"), original);

  const GameRuntime = require("../src/modules/rgss/runtime/mkxpz-game-runtime"), Native = require("../src/modules/shared/runtime/local-native");
  const Application = require("../src/modules/shared/native-application");
  const userDataDir = path.join(root, "userdata"), title = "Native game 日本語", before = Native.hashFile(executable);
  const resources = path.join(app, "Contents", "Resources", "Ruby"); fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, "runtime.rb"), "unchanged runtime resource");
  fs.writeFileSync(plist, originalPlist.replace("</dict>", "<key>NSHighResolutionCapable</key><false/><key>NSMainNibFile</key><string>RuntimeNib</string><key>CFBundleVersion</key><string>42</string></dict>"));
  const helper = { version: "fixture-v7", architectures: ["arm64", "x86_64"], dylibPath: library,
    binarySha256: Native.hashFile(library), sourceSha256: "b".repeat(64), manifestSha256: "c".repeat(64) };
  const source = { version: "fixture-v1", appPath: app }, warnings = [], copies = [], signs = [];
  const originalCopy = fs.promises.copyFile, originalPrepare = Application.prepare;
  const execute = require("node:util").promisify(require("node:child_process").execFile);
  t.mock.method(fs.promises, "copyFile", async (...args) => { copies.push(args); return originalCopy(...args); });
  t.mock.method(Application, "prepare", opts => originalPrepare(opts, async (command, args, options) => {
    if (command === "/usr/bin/codesign") signs.push(args); return execute(command, args, options);
  }));
  let hashReads = 0; const originalHash = Native.hashFile;
  t.mock.method(Native, "hashFile", file => { hashReads++; return originalHash(file); });
  const firstBase = GameRuntime.prepareGameRuntime({ userDataDir, gameId: "native-game", source, helper });
  const first = await GameRuntime.prepareApplication({ prepared: firstBase, userDataDir, gameName: title, logger: { warn: (...args) => warnings.push(args) } });
  assert.equal(first.executableCloned, true, JSON.stringify(warnings));
  const coldHashReads = hashReads;
  const secondBase = GameRuntime.prepareGameRuntime({ userDataDir, gameId: "native-game", source, helper });
  const second = await GameRuntime.prepareApplication({ prepared: secondBase, userDataDir, gameName: title });
  assert.equal(second.executablePath, first.executablePath); assert.equal(hashReads, coldHashReads, "Warm launch must not hash the source or cloned native entry again");
  assert.equal(copies.length, 1); assert.equal(copies[0][2], fs.constants.COPYFILE_FICLONE_FORCE | fs.constants.COPYFILE_EXCL);
  assert.equal(signs.length, 1, "Warm launch must reuse the signed entry");
  assert.notEqual(first.configDir, second.configDir);
  assert.equal(fs.lstatSync(first.sourceConfigDir).isDirectory(), true, "The actual engine's existence check must choose Contents/Game");
  assert.equal(fs.lstatSync(first.sourceConfigDir).isSymbolicLink(), false);
  assert.deepEqual(fs.readdirSync(first.sourceConfigDir), [], "No shared config file or session link is installed");
  assert.notEqual(fs.statSync(first.executablePath).ino, fs.statSync(executable).ino);
  assert.equal(Native.hashFile(executable), before, "The selected source executable remains unchanged");
  const info = require("../src/modules/shared/runtime/app-bundle").readInfoPlist(first.appPath);
  assert.equal(info.CFBundleIdentifier, "org.maclauncher.config-fixture"); assert.equal(info.CFBundleName, title);
  assert.equal(info.NSHighResolutionCapable, false); assert.equal(info.NSMainNibFile, "RuntimeNib"); assert.equal(info.CFBundleVersion, "42");
  assert.equal(fs.realpathSync(path.join(first.appPath, "Contents/Resources/Ruby")), resources);
  for (const [index, prepared] of [first, second].entries()) {
    GameRuntime.writeGameConfig(prepared, { gameFolder: game, session: index });
    const expectedValue = fs.readFileSync(prepared.configPath, "utf8");
    const env = { ...Helper.launchEnvironment({ prepared, helper, gameName: title }),
      MACLAUNCHER_TEST_EXPECT_DISPLAY_NAME: title, MACLAUNCHER_TEST_EXPECT_PROCESS_NAME: "fixture",
      MACLAUNCHER_TEST_EXPECT_BUNDLE_IDENTIFIER: "org.maclauncher.config-fixture" };
    const graphicsLibrary = index === 1 && process.env.MACLAUNCHER_TEST_MKXPZ_GRAPHICS_LIBRARY;
    if (graphicsLibrary) {
      env.DYLD_INSERT_LIBRARIES += ":" + fs.realpathSync(graphicsLibrary);
      env.MACLAUNCHER_TEST_EXPECT_GRAPHICS_LIBRARY = fs.realpathSync(graphicsLibrary);
    }
    const result = spawnSync(prepared.executablePath, [prepared.sourceConfigDir, prepared.configDir, game, expectedValue], { cwd: prepared.configDir, env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    if (graphicsLibrary) assert.match(result.stdout, /actual graphics library and config helper coexist/);
  }
  console.log(JSON.stringify({ scope: "Foundation-only native app/config entry", coldCopies: copies.length, warmAdditionalCopies: 0, coldSigns: signs.length,
    warmAdditionalHashReads: 0, executableBytes: fs.statSync(first.executablePath).size, resourcesShared: true, physicalExclusiveBytes: "Not inferred from logical size; APFS clone-force used" }));
});

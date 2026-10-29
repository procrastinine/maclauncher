const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { writeGameCommand } = require("../src/main/game-command");
const { createLauncher } = require("../src/core/launcher");
const GameStore = require("../src/core/game-store");

const repoRoot = path.join(__dirname, "..");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-command-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}
function runCommand(command, env = {}) {
  const environment = { ...process.env, ...env };
  delete environment.NODE_TEST_CONTEXT;
  return spawnSync("/bin/zsh", [command], { env: environment, encoding: "utf8", timeout: 20000 });
}
async function readLaunchedFile(file, expected) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const value = await fs.promises.readFile(file, "utf8");
      if (value === expected || Date.now() >= deadline) return value;
    }
    catch (error) {
      if (error.code !== "ENOENT" || Date.now() >= deadline) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("custom command names, executable mode and shell arguments survive special characters", t => {
  if (process.platform !== "darwin") return t.skip("macOS command scripts");
  const root = fixture(t), source = path.join(root, "Source ' $() ` ✨\nfolder");
  fs.mkdirSync(path.join(source, "src/core"), { recursive: true });
  const capture = path.join(root, "captured.json");
  fs.writeFileSync(path.join(source, "src/core/game-cli.js"),
    'require("node:fs").writeFileSync(process.env.CAPTURE, JSON.stringify({args:process.argv.slice(2),nodeMode:process.env.ELECTRON_RUN_AS_NODE}));');
  const gamePath = path.join(root, "Game ' $(touch INJECTION) ` ✨\nstart.sh");
  const userDataDir = path.join(root, "Data ' $() ` ✨\nprofile");
  const command = writeGameCommand(path.join(root, "Custom ✨ Game"), {
    gamePath, userDataDir, executablePath: process.execPath, repoRoot: source, packaged: false
  });
  assert.equal(command, path.join(root, "Custom ✨ Game.command"));
  assert.equal(fs.statSync(command).mode & 0o777, 0o755);
  const result = runCommand(command, { CAPTURE: capture });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture)), {
    args: ["--game", gamePath, "--user-data", userDataDir], nodeMode: "1"
  });
  assert.equal(fs.existsSync(path.join(root, "INJECTION")), false);
  fs.chmodSync(command, 0o644);
  assert.equal(writeGameCommand(command, { gamePath, userDataDir, executablePath: process.execPath,
    repoRoot: source, packaged: false }), command);
  assert.equal(fs.statSync(command).mode & 0o777, 0o755);
});

test("packaged commands run the archived Node entry point through the included executable", async t => {
  if (process.platform !== "darwin") return t.skip("macOS Electron binary");
  let executable;
  try { executable = require("../src/core/electron-binary").resolveElectronBinary(); }
  catch { return t.skip("installed Electron required"); }
  const root = fixture(t), app = path.join(root, "MacLauncher ' ✨.app");
  const binary = path.join(app, "Contents/MacOS/MacLauncher");
  const resources = path.join(app, "Contents/Resources");
  const source = path.join(root, "archive-source");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.mkdirSync(resources);
  fs.mkdirSync(path.join(source, "src/core"), { recursive: true });
  fs.symlinkSync(executable, binary);
  fs.copyFileSync(require.resolve("../src/core/game-cli-environment"), path.join(source, "src/core/game-cli-environment.js"));
  const python = path.join(resources, "python/bin/python3");
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const graphicsRoot = path.join(resources, "native-runtimes",
    require("../src/modules/shared/reshade/distribution-supplementals.json")[0].directoryRelative);
  fs.mkdirSync(graphicsRoot, { recursive: true });
  fs.writeFileSync(path.join(graphicsRoot, "runtime.json"), "{}");
  const capture = path.join(root, "captured.json");
  fs.writeFileSync(path.join(source, "src/core/game-cli.js"), `
const path = require('node:path');
const environment = require('./game-cli-environment').initializeCommandEnvironment({appPath:path.resolve(__dirname,'../..')});
const app = environment.createApp(process.argv[5]);
const {resolveElectronBinary} = require(${JSON.stringify(require.resolve("../src/core/electron-binary"))});
require('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify({
  args: process.argv.slice(2), electron: process.versions.electron, type: process.type,
  entry: __filename, executable: process.execPath, hostBinary: resolveElectronBinary(),
  packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData'), resourcesPath: process.resourcesPath,
  python: require(${JSON.stringify(require.resolve("../src/modules/shared/runtime/python"))}).resolvePythonBinary().pythonPath,
  graphicsRoot: require(${JSON.stringify(require.resolve("../src/modules/shared/reshade"))}).runtimeRoot(app)
}));
`);
  const asar = await import("@electron/asar");
  await asar.createPackage(source, path.join(resources, "app.asar"));
  const options = { gamePath: path.join(root, "A game ' ✨"), userDataDir: path.join(root, "Data ' ✨"),
    executablePath: binary, appBundlePath: app, packaged: true };
  const command = writeGameCommand(path.join(root, "Custom.COMMAND"), options);
  assert.equal(command, path.join(root, "Custom.COMMAND"));
  const result = runCommand(command, { CAPTURE: capture, MACLAUNCHER_ELECTRON_PATH: "" });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(fs.readFileSync(capture));
  assert.deepEqual(observed.args, ["--game", options.gamePath, "--user-data", options.userDataDir]);
  assert.ok(observed.electron);
  assert.equal(observed.type, undefined, "Node mode does not start Electron main");
  assert.equal(observed.entry, path.join(resources, "app.asar/src/core/game-cli.js"));
  assert.equal(observed.hostBinary, observed.executable, "hosted games reuse the included binary without the electron npm package");
  assert.equal(observed.packaged, true);
  assert.equal(observed.appPath, path.join(resources, "app.asar"));
  assert.equal(observed.userData, options.userDataDir);
  assert.equal(observed.resourcesPath, resources);
  assert.equal(observed.python, python);
  assert.equal(observed.graphicsRoot, graphicsRoot);
});

test("a custom named command launches a registered shell script with its saved library profile", async t => {
  if (process.platform !== "darwin") return t.skip("macOS command scripts");
  let executable;
  try { executable = require("../src/core/electron-binary").resolveElectronBinary(); }
  catch { return t.skip("installed Electron required"); }
  const root = fixture(t), gamePath = path.join(root, "Developer game ' ✨.sh");
  const marker = path.join(root, "script-ran.txt");
  fs.writeFileSync(gamePath, 'printf "%s" "${ELECTRON_RUN_AS_NODE-unset}" > "$SCRIPT_MARKER"\n', { mode: 0o644 });
  const userDataDir = path.join(root, "Custom library ' ✨");
  const launcher = createLauncher({ userDataDir });
  const entry = await launcher.resolveEntry(gamePath, { runtimeId: "native" });
  // These commands are about launch routing, not network policy.
  GameStore.writeGameRecord(userDataDir, { ...entry, networkAccess: true });
  const command = writeGameCommand(path.join(root, "A different shortcut name"), {
    gamePath: entry.gamePath, userDataDir, executablePath: executable, repoRoot, packaged: false
  });
  const result = runCommand(command, { SCRIPT_MARKER: marker });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readLaunchedFile(marker, "unset"), "unset");
  const stored = GameStore.readGameRecord(userDataDir, entry.gameId);
  assert.equal(stored.runtimeId, "native");
  assert.equal(stored.importPath, gamePath);
  assert.ok(stored.lastPlayedAt);
});

test("one saved command follows the registered game's native and hosted runtime choices without the launcher UI", async t => {
  if (process.platform !== "darwin") return t.skip("macOS native app fixture");
  const root = fixture(t), app = path.join(root, "Game ' ✨.app");
  const macos = path.join(app, "Contents/MacOS"), web = path.join(app, "Contents/Resources/app.nw");
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, "index.html"), "<title>Shortcut fixture</title>");
  const marker = path.join(root, "native-marker.json");
  fs.writeFileSync(path.join(macos, "fixture"), `#!/bin/sh
printf '%s' "\${ELECTRON_RUN_AS_NODE-unset}" > "$NATIVE_MARKER"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(app, "Contents/Info.plist"), '<plist><dict><key>CFBundleExecutable</key><string>fixture</string></dict></plist>');
  const userDataDir = path.join(root, "Library ' ✨");
  const launcher = createLauncher({ userDataDir });
  const entry = await launcher.resolveEntry(app);
  entry.runtimeId = "native";
  entry.saveDirOverride = path.join(root, "Saved games");
  entry.networkAccess = true; // launch routing, not network policy, is under test
  GameStore.writeGameRecord(userDataDir, entry);
  const guard = path.join(root, "no-electron.cjs");
  fs.writeFileSync(guard, "const Module=require('node:module'),load=Module._load;Module._load=function(name,...args){if(name==='electron')throw Error('Unexpected launcher UI import');return load.call(this,name,...args)};");
  const command = writeGameCommand(path.join(root, "Play custom game.command"), {
    gamePath: entry.gamePath, userDataDir, executablePath: process.execPath, repoRoot, packaged: false
  });
  const native = runCommand(command, { NATIVE_MARKER: marker, NODE_OPTIONS: `--require=${guard}` });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(await readLaunchedFile(marker, "unset"), "unset");
  let stored = GameStore.readGameRecord(userDataDir, entry.gameId);
  assert.equal(stored.runtimeId, "native");
  assert.equal(stored.saveDirOverride, entry.saveDirOverride);
  assert.ok(stored.lastPlayedAt);

  const host = path.join(root, "host.cjs"), hostMarker = path.join(root, "host.json");
  fs.writeFileSync(host, `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.HOST_MARKER, JSON.stringify({args:process.argv.slice(2),nodeMode:process.env.ELECTRON_RUN_AS_NODE}));
require(${JSON.stringify(require.resolve("../src/core/hosted-startup-reporter"))}).createHostedStartupReporter().ready({windowId:1,url:'http://127.0.0.1:1/index.html'});
setTimeout(() => process.exit(0), 10);
`, { mode: 0o755 });
  GameStore.writeGameRecord(userDataDir, { ...stored, runtimeId: "electron" });
  const hosted = runCommand(command, { HOST_MARKER: hostMarker, MACLAUNCHER_ELECTRON_PATH: host,
    NODE_OPTIONS: `--require=${guard}`, ELECTRON_START_URL: "http://127.0.0.1:9999/" });
  assert.equal(hosted.status, 0, hosted.stderr);
  const observed = JSON.parse(fs.readFileSync(hostMarker));
  assert.deepEqual(observed.args, [path.join(repoRoot, "src/runtime/electron-game.js"),
    "--maclauncher-runtime-host", `--game=${app}`, "--runtime=electron", `--user-data=${userDataDir}`]);
  assert.equal(observed.nodeMode, undefined);
  stored = GameStore.readGameRecord(userDataDir, entry.gameId);
  assert.equal(stored.runtimeId, "electron");
  assert.equal(stored.saveDirOverride, entry.saveDirOverride);
});

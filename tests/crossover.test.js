const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { stopProcessTree } = require("../src/core/process-stop");
const Detection = require("../src/modules/crossover/detect");
const Module = require("../src/modules/crossover/main");
const Manager = require("../src/modules/crossover/runtime/manager");
const Launch = require("../src/modules/crossover/runtime/launch");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-crossover-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function pe(file, { machine = 0x14c, subsystem = 2, dll = false, signature = 0x4550 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.alloc(1024);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(signature, 128); bytes.writeUInt16LE(machine, 132); bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(2 | (dll ? 0x2000 : 0), 150);
  bytes.writeUInt16LE(machine === 0x14c ? 0x10b : 0x20b, 152); bytes.writeUInt16LE(subsystem, 220);
  fs.writeFileSync(file, bytes);
  return file;
}
function app(directory, version = "26.3", architecture = "arm64") {
  const root = path.join(directory, "Contents", "SharedSupport", "CrossOver");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "share", "crossover", "bottle_templates", "win10_64"), { recursive: true });
  fs.writeFileSync(path.join(directory, "Contents", "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  const macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf, 0);
  macho.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4); macho.writeUInt32LE(2, 12);
  for (const command of ["wineloader", "wineserver"]) fs.writeFileSync(path.join(root, "bin", command), macho, { mode: 0o755 });
  for (const command of ["wine", "cxbottle"]) fs.writeFileSync(path.join(root, "bin", command), "#!/usr/bin/perl\n", { mode: 0o755 });
  return directory;
}

test("CrossOver validates actual Windows PE executables and ignores DLLs, DOS stubs and other platforms", t => {
  const directory = fixture(t);
  assert.equal(Detection.readWindowsExecutable(pe(path.join(directory, "Game.exe"))).executableArchitecture, "x86");
  assert.equal(Detection.readWindowsExecutable(pe(path.join(directory, "Game64.exe"), { machine: 0x8664 })).executableArchitecture, "x86_64");
  const arm64 = pe(path.join(directory, "GameArm.exe"), { machine: 0xaa64 });
  assert.equal(Detection.readWindowsExecutable(arm64).executableArchitecture, "arm64");
  assert.equal(Module.__test.supportsEntry(Detection.decorateEntry({ gamePath: directory, importPath: arm64 }), {}, {}), false);
  for (const [name, options] of [["Library.exe", { dll: true }], ["Driver.exe", { subsystem: 1 }], ["DOS.exe", { signature: 0 }]]) {
    assert.equal(Detection.readWindowsExecutable(pe(path.join(directory, name), options)), null);
  }
  fs.writeFileSync(path.join(directory, "Linux.exe"), Buffer.from([0x7f, 69, 76, 70]));
  assert.equal(Detection.readWindowsExecutable(path.join(directory, "Linux.exe")), null);
});

test("CrossOver finds nested game executables, respects deliberate selections and skips native app content", t => {
  const directory = fixture(t), game = path.join(directory, "Quest");
  const nested = pe(path.join(game, "bin", "Quest.exe"));
  const helper = pe(path.join(game, "uninstall.exe"));
  assert.equal(Detection.findWindowsExecutable({ gamePath: game }).windowsExecutablePath, nested);
  assert.equal(Detection.findWindowsExecutable({ gamePath: game, importPath: helper }).windowsExecutablePath, helper);
  const bundle = path.join(directory, "Native.app");
  pe(path.join(bundle, "Contents", "Resources", "helper.exe"));
  assert.equal(Detection.findWindowsExecutable({ gamePath: bundle }), null);
  assert.equal(Detection.findWindowsExecutable({ gamePath: directory }).windowsExecutablePath, nested);
  assert.equal(Detection.detectGame({ rootDir: game, inputPath: game, stat: fs.statSync(game) }).moduleData.executablePath, helper);
  pe(path.join(game, "Quest.exe"));
  assert.throws(() => Detection.detectGame({ rootDir: game, inputPath: game, stat: fs.statSync(game) }), { code: "DETECTION_CONFLICT" });
  assert.equal(Detection.detectGame({ rootDir: game, inputPath: nested, stat: fs.statSync(nested) }).moduleData.executablePath, nested);
});

test("CrossOver generic Windows fallback checks only top-level valid executables and never guesses among them", t => {
  const directory = fixture(t), game = path.join(directory, "Unknown");
  const nested = pe(path.join(game, "bin", "Game.exe"));
  const context = { rootDir: game, inputPath: game, stat: fs.statSync(game) };
  assert.equal(Detection.detectGame(context), null, "nested executables do not classify an unknown folder");
  fs.writeFileSync(path.join(game, "Invalid.exe"), "not a PE executable");
  pe(path.join(game, "Library.exe"), { dll: true });
  const selected = pe(path.join(game, "Game.exe"));
  assert.equal(Detection.detectGame(context).moduleData.executablePath, selected);
  pe(path.join(game, "Config.exe"));
  assert.throws(() => Detection.detectGame(context), error => error.code === "DETECTION_CONFLICT" && /Select one \.exe/.test(error.message));
  assert.equal(Detection.detectGame({ ...context, inputPath: selected, stat: fs.statSync(selected) }).moduleData.executablePath, selected);
  assert.equal(Detection.detectGame({ ...context, inputPath: path.join(game, "Invalid.exe"), stat: fs.statSync(path.join(game, "Invalid.exe")) }), null);
  assert.equal(Detection.detectGame({ ...context, inputPath: nested, stat: fs.statSync(nested) }).moduleData.executablePath, nested);
});

test("CrossOver excludes native app imports even beside unrelated Windows executables", t => {
  const directory = fixture(t), gamePath = path.join(directory, "Native.app");
  fs.mkdirSync(gamePath);
  const unrelated = pe(path.join(directory, "Unrelated.exe"));
  const entry = { gamePath, importPath: gamePath, contentRootDir: directory, moduleId: "generic-app" };
  assert.equal(Detection.findWindowsExecutable(entry), null);
  assert.equal(Detection.decorateEntry(entry).runtimeData.crossover.windowsExecutablePath, null);
  assert.equal(Module.__test.hasWindowsExecutable({ ...entry,
    runtimeData: { crossover: { windowsExecutablePath: unrelated, detectionComplete: true } } }), false);
});

test("CrossOver records negative Windows evidence and does not inspect Linux trees when resolving support", t => {
  const directory = fixture(t);
  const entry = Detection.decorateEntry({ gamePath: directory, moduleId: "love" });
  assert.equal(entry.runtimeData.crossover.detectionComplete, true);
  assert.equal(entry.runtimeData.crossover.windowsExecutablePath, null);
  fs.renameSync(directory, directory + "-moved");
  t.after(() => fs.rmSync(directory + "-moved", { recursive: true, force: true }));
  assert.equal(Module.__test.hasWindowsExecutable(entry), false);
});

test("CrossOver registers multiple local application paths and removal leaves each application installed", t => {
  const directory = fixture(t), userDataDir = path.join(directory, "data");
  Manager.__test.writeRegistry(userDataDir, { applications: [], ignoredPaths: Manager.__test.AUTOMATIC_PATHS });
  const first = Manager.importRuntime({ userDataDir, runtimePath: app(path.join(directory, "stable", "CrossOver.app")) });
  const second = Manager.importRuntime({ userDataDir, runtimePath: app(path.join(directory, "patched", "CrossOver.app")) });
  assert.notEqual(first.version, second.version);
  const state = Manager.getState({ userDataDir, settings: { defaultVersion: second.version } });
  assert.equal(state.installed.length, 2);
  assert.equal(state.catalog.delivery, "local");
  assert.equal(state.catalog.installable, false);
  assert.notEqual(state.versionLabels[first.version], state.versionLabels[second.version]);
  assert.equal(state.defaultVersion, second.version);
  const entry = { moduleId: "rgss", runtimeData: { crossover: { version: first.version } } };
  assert.equal(Manager.resolveSelection(entry, { runtimes: { crossover: { defaultVersion: second.version } } }, userDataDir).version, first.version);
  Manager.uninstallRuntime({ userDataDir, version: first.version });
  assert.equal(fs.existsSync(first.appPath), true);
  assert.equal(Manager.getState({ userDataDir }).installed.length, 1);
  assert.equal(Manager.resolveSelection(entry, {}, userDataDir).ready, false);
});

test("CrossOver automatic discovery is read-only and application updates retain their registered identity", t => {
  const directory = fixture(t), userDataDir = path.join(directory, "data"), runtimePath = app(path.join(directory, "CrossOver.app"), "25.0");
  const first = Manager.core.listInstalled(userDataDir, { automaticPaths: [runtimePath] })[0];
  assert.equal(first.automatic, true);
  assert.equal(fs.existsSync(userDataDir), false);
  app(runtimePath, "26.3");
  const next = Manager.core.listInstalled(userDataDir, { automaticPaths: [runtimePath] })[0];
  assert.equal(next.version, first.version);
  assert.equal(next.upstreamVersion, "26.3");
  const wine = path.join(runtimePath, "Contents", "SharedSupport", "CrossOver", "bin", "wine");
  fs.rmSync(wine); fs.symlinkSync("/usr/bin/perl", wine);
  assert.throws(() => Manager.core.inspectApplication(runtimePath), /inside the selected application/);
});

test("CrossOver environment settings are launch-scoped, quoted as data and keep bottle paths owned", () => {
  const installation = { crossoverRoot: "/Applications/CrossOver.app/Contents/SharedSupport/CrossOver" };
  const settings = { graphicsBackend: "dxmt", synchronization: "msync", locale: "ja_JP.UTF-8", bepInExWinhttp: true,
    environment: ["DXMT_CONFIG=d3d11.preferredMaxFrameRate=60", "CUSTOM_TITLE=it's a game; $(echo nope)"] };
  const launch = Launch.buildEnvironment(settings, installation, "/data/game", "/data/game/bottle", { baseEnvironment: { WINEPREFIX: "/original", WINEDLLOVERRIDES: "bad=n", PATH: "/usr/bin" } });
  assert.equal(launch.environment.WINEPREFIX, "/data/game/bottle");
  assert.equal(launch.overrides.CX_GRAPHICS_BACKEND, "dxmt");
  assert.equal(launch.overrides.WINEMSYNC, "1");
  assert.equal(launch.overrides.LC_ALL, "ja_JP.UTF-8");
  assert.equal(launch.dll, "winhttp=n,b");
  assert.match(Launch.wineEnvironmentString(launch.overrides), /'CUSTOM_TITLE=it'"'"'s a game; \$\(echo nope\)'/);
  assert.throws(() => Launch.parseEnvironment(["WINEPREFIX=/elsewhere"]), /cannot replace/);
  assert.throws(() => Launch.parseEnvironment(["MISSING_EQUALS"]), /NAME=value/);
  assert.equal(Launch.dllOverrides({}), "");
  assert.equal(Launch.dllOverrides({ dllOverrides: ["winhttp=b"], bepInExWinhttp: true }), "winhttp=b");
  assert.throws(() => Launch.dllOverrides({ dllOverrides: ["winhttp=n;anything"] }), /library=order/);
});

test("CrossOver private files preserve original files, relaunch changes and saves across changed input roots", async t => {
  const directory = fixture(t), source = path.join(directory, "source"), managed = path.join(directory, "managed");
  pe(path.join(source, "Game.exe")); fs.writeFileSync(path.join(source, "settings.ini"), "original");
  const gameRoot = await Launch.stageGameFiles(source, managed);
  fs.writeFileSync(path.join(gameRoot, "settings.ini"), "private settings");
  fs.writeFileSync(path.join(gameRoot, "Save01.dat"), "save");
  assert.equal(await Launch.stageGameFiles(source, managed), gameRoot);
  assert.equal(fs.readFileSync(path.join(source, "settings.ini"), "utf8"), "original");
  const updated = path.join(directory, "updated"); fs.cpSync(source, updated, { recursive: true });
  fs.writeFileSync(path.join(updated, "new-file.dat"), "new");
  await Launch.stageGameFiles(updated, managed);
  assert.equal(fs.readFileSync(path.join(gameRoot, "settings.ini"), "utf8"), "private settings");
  assert.equal(fs.readFileSync(path.join(gameRoot, "Save01.dat"), "utf8"), "save");
  assert.equal(fs.readFileSync(path.join(gameRoot, "new-file.dat"), "utf8"), "new");
  fs.rmSync(gameRoot, { recursive: true }); fs.symlinkSync(source, gameRoot);
  await assert.rejects(Launch.stageGameFiles(updated, managed), /must not be aliases/);
});

test("CrossOver rejects escaping source aliases before staging game files", async t => {
  const directory = fixture(t), source = path.join(directory, "source"), managed = path.join(directory, "managed");
  pe(path.join(source, "Game.exe"));
  fs.symlinkSync("/etc/hosts", path.join(source, "escape.dat"));
  await assert.rejects(Launch.stageGameFiles(source, managed), /alias outside/);
  await assert.rejects(Launch.stageGameFiles(source, path.join(source, "private")), /outside the original/);
});

test("CrossOver updates unchanged private assets in the same source folder while preserving saves and same-size mod edits", async t => {
  const directory = fixture(t), source = path.join(directory, "source"), managed = path.join(directory, "managed");
  pe(path.join(source, "Game.exe"));
  fs.writeFileSync(path.join(source, "asset.dat"), "version one");
  fs.writeFileSync(path.join(source, "settings.ini"), "source");
  fs.writeFileSync(path.join(source, "removed.dat"), "keep this file");
  const gameRoot = await Launch.stageGameFiles(source, managed);
  const originalTimes = fs.statSync(path.join(source, "settings.ini"));
  fs.writeFileSync(path.join(gameRoot, "settings.ini"), "edited");
  fs.utimesSync(path.join(gameRoot, "settings.ini"), originalTimes.atime, originalTimes.mtime);
  fs.writeFileSync(path.join(gameRoot, "Save01.dat"), "private save");
  fs.writeFileSync(path.join(source, "asset.dat"), "version two");
  fs.writeFileSync(path.join(source, "settings.ini"), "update");
  fs.utimesSync(path.join(source, "settings.ini"), originalTimes.atime, originalTimes.mtime);
  fs.unlinkSync(path.join(source, "removed.dat"));
  fs.writeFileSync(path.join(source, "new.dat"), "new asset");
  await Launch.stageGameFiles(source, managed);
  assert.equal(fs.readFileSync(path.join(gameRoot, "asset.dat"), "utf8"), "version two");
  assert.equal(fs.readFileSync(path.join(gameRoot, "settings.ini"), "utf8"), "edited");
  assert.equal(fs.readFileSync(path.join(gameRoot, "Save01.dat"), "utf8"), "private save");
  assert.equal(fs.readFileSync(path.join(gameRoot, "removed.dat"), "utf8"), "keep this file");
  assert.equal(fs.readFileSync(path.join(gameRoot, "new.dat"), "utf8"), "new asset");
  let reads = 0;
  await Launch.stageGameFiles(source, managed, { onProgress: value => { if (value.bytesRead != null) reads++; } });
  assert.equal(reads, 0, "unchanged assets are checked without reading or hashing their contents");
});

test("CrossOver preserves differing private files when upgrading an older no-hash record", async t => {
  const directory = fixture(t), source = path.join(directory, "source"), managed = path.join(directory, "managed");
  pe(path.join(source, "Game.exe")); fs.writeFileSync(path.join(source, "settings.ini"), "original");
  const gameRoot = await Launch.stageGameFiles(source, managed);
  fs.writeFileSync(path.join(gameRoot, "settings.ini"), "private settings");
  fs.writeFileSync(path.join(managed, "game-files.json"), JSON.stringify({ sourceRoot: fs.realpathSync(source), files: 2, layoutVersion: 1 }));
  await Launch.stageGameFiles(source, managed);
  fs.writeFileSync(path.join(source, "settings.ini"), "new settings");
  await Launch.stageGameFiles(source, managed);
  assert.equal(fs.readFileSync(path.join(gameRoot, "settings.ini"), "utf8"), "private settings");
  const receipt = JSON.parse(fs.readFileSync(path.join(managed, "game-files.json")));
  assert.equal(receipt.layoutVersion, 2);
  assert.equal(receipt.files["settings.ini"].baseline, null);
});

test("CrossOver cancellation and source races leave a pending asset update retryable", async t => {
  const directory = fixture(t), source = path.join(directory, "source"), managed = path.join(directory, "managed");
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, "asset.dat"), "old asset");
  const gameRoot = await Launch.stageGameFiles(source, managed);
  fs.writeFileSync(path.join(source, "asset.dat"), "new asset");
  const controller = new AbortController();
  await assert.rejects(Launch.stageGameFiles(source, managed, { signal: controller.signal, onProgress: () => controller.abort() }), { name: "AbortError" });
  assert.equal(fs.readFileSync(path.join(gameRoot, "asset.dat"), "utf8"), "old asset");
  let changed = false;
  await assert.rejects(Launch.stageGameFiles(source, managed, { onProgress: () => {
    if (!changed) { changed = true; fs.writeFileSync(path.join(source, "asset.dat"), "raced update"); }
  } }), /original Windows game changed/);
  assert.equal(fs.readFileSync(path.join(gameRoot, "asset.dat"), "utf8"), "old asset");
  await Launch.stageGameFiles(source, managed);
  assert.equal(fs.readFileSync(path.join(gameRoot, "asset.dat"), "utf8"), "raced update");
  assert.deepEqual(fs.readdirSync(gameRoot), ["asset.dat"]);
});

test("CrossOver Play automatically creates a private bottle and launches the selected PE with explicit BepInEx overrides", async t => {
  const directory = fixture(t), userDataDir = path.join(directory, "data"), game = path.join(directory, "game");
  const original = pe(path.join(game, "Game.exe"));
  const installed = Manager.importRuntime({ userDataDir, runtimePath: app(path.join(directory, "CrossOver.app")) });
  const entry = { ...Detection.decorateEntry({ gameId: "testgame", gamePath: game, moduleId: "rgss" }), runtimeId: "crossover" };
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    const bottle = args[args.indexOf("--bottle") + 1];
    fs.mkdirSync(bottle, { recursive: true });
    fs.writeFileSync(path.join(bottle, "cxbottle.conf"), "[Bottle]\n");
    fs.writeFileSync(path.join(bottle, "system.reg"), "registry");
    return { stdout: "", stderr: "" };
  };
  const context = { userDataDir, settings: { runtimes: { crossover: { defaultVersion: installed.version } } },
    runtimeSettings: { graphicsBackend: "dxvk", locale: "en_US.UTF-8", bepInExWinhttp: true, arguments: ["-windowed"] } };
  const launch = await Launch.prepareLaunch(entry, context, { run });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, installed.bottleToolPath);
  assert.equal(calls[0].options.env.WINEPREFIX, launch.bottlePath);
  assert.equal(launch.args[launch.args.indexOf("--dll") + 1], "winhttp=n,b");
  assert.ok(launch.args.includes("--wait-children"));
  assert.equal(launch.args.at(-1), "-windowed");
  assert.notEqual(launch.executablePath, original);
  assert.equal(entry.runtimeData.crossover.gameRoot, launch.gameRoot);
  assert.equal(Launch.runtimeDirectory(entry, context), path.join(userDataDir, "games", "testgame", "runtimes", "crossover"));
  await Launch.prepareLaunch(entry, context, { run });
  assert.equal(calls.length, 1);
  assert.deepEqual(Module.resolveSaveLocations(entry, context), { primaryDirectory: null, directories: [] });
  pe(path.join(game, "ArmGame.exe"), { machine: 0xaa64 });
  await assert.rejects(Launch.prepareLaunch(entry, { ...context, runtimeSettings: { executable: "ArmGame.exe" } }, { run }), /Windows ARM64/);
  assert.equal(calls.length, 1);
});

test("CrossOver Stop terminates an independently grouped Windows process before its tracked supervisor exits", async t => {
  if (process.platform === "win32") return t.skip("POSIX process groups are required");
  const directory = fixture(t), pidFile = path.join(directory, "game-pid"), stoppedFile = path.join(directory, "bottle-stopped");
  const fakeWine = path.join(directory, "wine"), fakeServer = path.join(directory, "wineserver");
  fs.writeFileSync(fakeWine, `#!${process.execPath}\nconst fs=require('fs'),{spawn}=require('child_process');const game=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(process.env.GAME_PID,String(game.pid));setInterval(()=>{},1000);`, { mode: 0o755 });
  fs.writeFileSync(fakeServer, `#!${process.execPath}\nconst fs=require('fs');if(process.argv[2]==='-k'){const pid=Number(fs.readFileSync(process.env.GAME_PID,'utf8'));try{process.kill(pid,'SIGTERM')}catch{}fs.writeFileSync(process.env.STOPPED,'stopped');}`, { mode: 0o755 });
  const child = spawn("/bin/sh", ["-c", Launch.SUPERVISOR, "test-crossover", fakeWine, fakeServer, "literal;$()"],
    { detached: true, stdio: "ignore", env: { ...process.env, GAME_PID: pidFile, STOPPED: stoppedFile } });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  const finished = once(child, "exit");
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(pidFile));
  const gamePid = Number(fs.readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(gamePid, "SIGKILL"); } catch {} });
  assert.equal(stopProcessTree(child.pid), true);
  const outcome = await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error("CrossOver supervisor did not stop")), 5000).unref())]);
  assert.equal(outcome[0], 143);
  assert.equal(fs.readFileSync(stoppedFile, "utf8"), "stopped");
  const exitDeadline = Date.now() + 3000;
  while (Date.now() < exitDeadline) {
    try { process.kill(gamePid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Windows process survived CrossOver Stop");
});

test("CrossOver removes failed initial environments and retries without deleting completed bottles", async t => {
  const directory = fixture(t), runtimePath = app(path.join(directory, "CrossOver.app"));
  const install = Manager.core.inspectApplication(runtimePath), bottle = path.join(directory, "bottles", "game");
  let calls = 0;
  const run = async () => {
    calls++;
    fs.mkdirSync(bottle, { recursive: true });
    fs.writeFileSync(path.join(bottle, "cxbottle.conf"), "config");
    fs.writeFileSync(path.join(bottle, "system.reg"), "registry");
    if (calls === 1) throw new Error("interrupted creation");
    return { stdout: "", stderr: "" };
  };
  await assert.rejects(Launch.ensureBottle(install, bottle, directory, {}, {}, { run }), /could not create/);
  assert.equal(fs.existsSync(bottle), false);
  await Launch.ensureBottle(install, bottle, directory, {}, {}, { run });
  fs.writeFileSync(path.join(bottle, "saved-game.dat"), "save");
  await Launch.ensureBottle(install, bottle, directory, {}, {}, { run });
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(path.join(bottle, "saved-game.dat"), "utf8"), "save");
});

test("CrossOver cancelled preparation waits until independently grouped Wine children have stopped", async t => {
  if (process.platform === "win32") return t.skip("POSIX process groups are required");
  const directory = fixture(t), pidFile = path.join(directory, "child-pid"), stopped = path.join(directory, "stopped");
  const command = path.join(directory, "cxbottle"), server = path.join(directory, "wineserver");
  fs.writeFileSync(command, `#!${process.execPath}\nconst fs=require('fs'),{spawn}=require('child_process');let c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(process.env.CHILD_PID,String(c.pid));setInterval(()=>{},1000);`, { mode: 0o755 });
  fs.writeFileSync(server, `#!${process.execPath}\nconst fs=require('fs');if(process.argv[2]==='-k'){try{process.kill(Number(fs.readFileSync(process.env.CHILD_PID,'utf8')),'SIGTERM')}catch{}fs.writeFileSync(process.env.STOPPED,'yes');}`, { mode: 0o755 });
  const controller = new AbortController();
  const preparing = Launch.runSupervised(command, server, [], { cwd: directory, env: { ...process.env, CHILD_PID: pidFile, STOPPED: stopped }, signal: controller.signal, timeout: 5000 });
  const rejected = assert.rejects(preparing, { name: "AbortError" });
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(pidFile));
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
  controller.abort(); await rejected;
  assert.equal(fs.readFileSync(stopped, "utf8"), "yes");
  const exited = Date.now() + 3000;
  while (Date.now() < exited) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Wine child survived cancelled preparation");
});

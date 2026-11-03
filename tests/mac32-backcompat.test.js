// Released v0.5.1 home/work recovery; runs only on owned scratch paths.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events");
const Provider = require("../src/modules/mac32/provider");
const Backcompat = require("../src/modules/mac32/backcompat");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac32-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function binary(architecture, fileType = 2, minimum = 26 << 16) {
  const wide = architecture !== "i386", size = wide ? 32 : 28;
  const bytes = Buffer.alloc(size + 24);
  bytes.writeUInt32LE(wide ? 0xfeedfacf : 0xfeedface);
  bytes.writeUInt32LE({ i386: 7, x86_64: 0x01000007, arm64: 0x0100000c }[architecture], 4);
  bytes.writeUInt32LE(fileType, 12); bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0x32, size); bytes.writeUInt32LE(24, size + 4); bytes.writeUInt32LE(1, size + 8);
  bytes.writeUInt32LE(minimum, size + 12); bytes.writeUInt32LE(minimum, size + 16);
  return bytes;
}
function appEntry(root, architecture = "i386") {
  const appPath = path.join(root, "Example app.app"), executablePath = path.join(appPath, "Contents", "MacOS", "Example");
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(executablePath, binary(architecture), { mode: 0o755 });
  fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleExecutable</key><string>Example</string></dict></plist>');
  return { gameId: "fixture-app", nativeAppPath: appPath, runtimeData: { mac32: {
    detectionComplete: true, appPath, executablePath, executableArchitectures: [architecture]
  } } };
}
test("released v0.5.1 mac32 home and work bytes recover at normal launch paths with conflicts preserved", async t => {
  const root = fs.realpathSync(temporary(t)), entry = appEntry(path.join(root, "original-games"));
  const userDataDir = path.join(root, "profile"), home = path.join(root, "normal-home");
  fs.mkdirSync(userDataDir); fs.mkdirSync(home);
  t.mock.method(os, "homedir", () => home);
  const previousHome = process.env.HOME; process.env.HOME = home;
  t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; });
  // v0.5.1 provider.js:39-61,71-73; released GameData runtime layout.
  const releasedRoot = path.join(userDataDir, "games", entry.gameId, "runtimes", "mac32");
  const homeFile = path.join("Library", "Application Support", "example-game", "slot.json");
  const configFile = path.join("Library", "Preferences", "example-game.plist");
  const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  write(path.join(releasedRoot, "home", homeFile), "released home slot");
  write(path.join(releasedRoot, "home", configFile), "released private preference");
  write(path.join(home, configFile), "original preference");
  write(path.join(releasedRoot, "work", "relative-slot.dat"), "released working slot");
  write(path.join(releasedRoot, "work", "config.ini"), "released private config");
  write(path.join(path.dirname(entry.nativeAppPath), "config.ini"), "original config");
  const context = { userDataDir, settings: {}, runtimeSettings: {} };
  const descriptors = Backcompat.legacyGameMirrors(entry, context);
  assert.deepEqual(descriptors.map(item => item.mirrorRoot), [path.join(releasedRoot, "home"), path.join(releasedRoot, "work")]);
  const retire = require("../src/core/backcompat/legacy-game-mirrors").retireLegacyGameMirror;
  for (const descriptor of descriptors) {
    const result = await retire(descriptor, context);
    assert.equal(result.complete, true, result.reason);
  }
  const manager = { resolveSelection: () => ({ ready: true, version: "fixture", install: { executablePath: "/fixture/mac32", installDir: root } }) };
  const child = new EventEmitter(); child.pid = 789;
  const provider = Provider.createProvider({ manager, platform: "darwin", spawn: async invocation => {
    assert.equal(invocation.options.env.HOME, home);
    assert.equal(fs.readFileSync(path.join(invocation.options.env.HOME, homeFile), "utf8"), "released home slot");
    assert.equal(invocation.options.cwd, path.dirname(entry.nativeAppPath));
    assert.equal(fs.readFileSync(path.join(invocation.options.cwd, "relative-slot.dat"), "utf8"), "released working slot");
    return child;
  } });
  await provider.launchRuntime("mac32", entry, context); child.emit("close", 0, null);
  for (const [directory, name, expected, privateBytes] of [
    [path.join(home, "Library", "Preferences"), "example-game.plist", "original preference", "released private preference"],
    [path.dirname(entry.nativeAppPath), "config.ini", "original config", "released private config"]
  ]) {
    assert.equal(fs.readFileSync(path.join(directory, name), "utf8"), expected);
    const conflicts = fs.readdirSync(directory).filter(value => value.startsWith(name + ".MacLauncher-conflict-"));
    assert.equal(conflicts.length, 1); assert.equal(fs.readFileSync(path.join(directory, conflicts[0]), "utf8"), privateBytes);
  }
  assert.equal(fs.existsSync(path.join(releasedRoot, "home")), false);
  assert.equal(fs.existsSync(path.join(releasedRoot, "work")), false);
});

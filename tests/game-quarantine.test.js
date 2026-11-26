const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const GameQuarantine = require("../src/modules/shared/runtime/game-quarantine");
const { appRoots, removeGameQuarantine } = GameQuarantine;

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "game-quarantine-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function release(root, { appRelative = path.join("resources", "app") } = {}) {
  const releaseDir = path.join(root, "game"), appDir = path.join(releaseDir, ...appRelative.split(path.sep));
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "package.json"), "{}");
  fs.writeFileSync(path.join(releaseDir, "launcher.exe"), "windows launcher");
  return { releaseDir, appDir };
}
const real = value => fs.realpathSync(value);

test("app roots are the game's app folder and the folder that holds it, inside its release", t => {
  const root = temporary(t), { releaseDir, appDir } = release(root);
  assert.deepEqual(appRoots({ appRoot: appDir, gameRoot: releaseDir }), [real(appDir), real(path.join(releaseDir, "resources"))]);
  // A release whose app sits directly in its root clears the app folder and the release folder that holds it.
  const plain = release(root, { appRelative: "app" });
  assert.deepEqual(appRoots({ appRoot: plain.appDir, gameRoot: plain.releaseDir }), [real(plain.appDir), real(plain.releaseDir)]);
  // An app.asar archive clears the archive and its resources folder.
  const archive = path.join(releaseDir, "resources", "app.asar");
  fs.writeFileSync(archive, "asar bytes");
  assert.deepEqual(appRoots({ appRoot: archive, gameRoot: releaseDir }), [real(archive), real(path.join(releaseDir, "resources"))]);
  // Paths that are not part of the release, or no release at all, clear nothing.
  assert.deepEqual(appRoots({ appRoot: path.join(root, "other", "app"), gameRoot: releaseDir }), []);
  assert.deepEqual(appRoots({ appRoot: appDir }), []);
  assert.deepEqual(appRoots({ appRoot: "relative/app", gameRoot: releaseDir }), []);
  assert.deepEqual(appRoots({ appRoot: appDir, gameRoot: path.join(appDir, "missing") }), []);
});

test("app roots stay inside the release and never follow links out of it", t => {
  const root = temporary(t), external = path.join(root, "outside"); fs.mkdirSync(external);
  const { releaseDir, appDir } = release(root);
  fs.symlinkSync(external, path.join(appDir, "alias"));
  fs.symlinkSync(external, path.join(releaseDir, "resources", "steamworks"), "dir");
  assert.deepEqual(appRoots({ appRoot: appDir, gameRoot: releaseDir }), [real(appDir), real(path.join(releaseDir, "resources"))]);
  // A linked app folder outside the release is not the game's app; its real
  // parent inside the release still is.
  assert.deepEqual(appRoots({ appRoot: path.join(appDir, "alias"), gameRoot: releaseDir }), [real(appDir)]);
});

test("clearing uses exact xattr argv on the app's own folders only", async t => {
  const root = temporary(t), { releaseDir, appDir } = release(root), calls = [];
  const execute = (command, args, options, callback) => { calls.push({ command, args, options }); callback(null, "", ""); };
  const cleared = await removeGameQuarantine({ appRoot: appDir, gameRoot: releaseDir }, { platform: "darwin", execute });
  assert.deepEqual(cleared, [real(appDir), real(path.join(releaseDir, "resources"))]);
  assert.deepEqual(calls.map(call => [call.command, call.args]),
    [["/usr/bin/xattr", ["-drs", "com.apple.quarantine", real(appDir)]],
     ["/usr/bin/xattr", ["-drs", "com.apple.quarantine", real(path.join(releaseDir, "resources"))]]]);
  for (const call of calls) assert.equal(call.options.shell, false);
});

test("clearing skips other platforms, apps outside a release and apps without folders", async t => {
  const root = temporary(t), { releaseDir, appDir } = release(root);
  const execute = () => assert.fail("Nothing is executed outside macOS");
  assert.deepEqual(await removeGameQuarantine({ appRoot: appDir, gameRoot: releaseDir }, { platform: "linux", execute }), []);
  assert.deepEqual(await removeGameQuarantine({ appRoot: appDir, gameRoot: releaseDir },
    { platform: "win32", execute }), []);
  assert.deepEqual(await removeGameQuarantine({ appRoot: path.join(root, "other", "app"), gameRoot: releaseDir },
    { platform: "darwin", execute }), []);
  assert.deepEqual(await removeGameQuarantine({ appRoot: appDir }, { platform: "darwin", execute }), []);
  assert.deepEqual(await removeGameQuarantine({ appRoot: appDir, gameRoot: path.join(appDir, "missing") },
    { platform: "darwin", execute }), []);
});

test("a removal failure fails the clear only while quarantine really remains", async t => {
  const root = temporary(t), { releaseDir, appDir } = release(root);
  // xattr -d fails while the quarantine attribute still lists, and is accepted once it does not.
  const failing = (_command, args, _options, callback) => {
    execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Brave;test", args.at(-1)]);
    callback(new Error("removexattr failed"), "", "Operation not permitted");
  };
  await assert.rejects(removeGameQuarantine({ appRoot: appDir, gameRoot: releaseDir }, { platform: "darwin", execute: failing }),
    /Operation not permitted/);
  const partial = (_command, args, _options, callback) => {
    const target = args.at(-1);
    if (args[0] === "-drs") execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Brave;test", target]);
    callback(args[0] === "-drs" ? new Error("removexattr failed") : null,
      args[0] === "-drs" ? "" : `${target}: com.apple.quarantine\n`, "");
  };
  await assert.rejects(removeGameQuarantine({ appRoot: appDir, gameRoot: releaseDir }, { platform: "darwin", execute: partial }),
    /Could not prepare/);
  const readonly = (_command, _args, _options, callback) => callback(null, "", "");
  assert.deepEqual(await removeGameQuarantine({ appRoot: appDir, gameRoot: releaseDir }, { platform: "darwin", execute: readonly }),
    [real(appDir), real(path.join(releaseDir, "resources"))]);
});

test("clearing removes quarantine from the app's folders and keeps other attributes", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), { releaseDir, appDir } = release(root);
  for (const target of [appDir, path.join(releaseDir, "resources")]) {
    execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Brave;test", target]);
    execFileSync("/usr/bin/xattr", ["-w", "com.maclauncher.test", "preserved", target]);
  }
  const external = path.join(root, "shared"); fs.writeFileSync(external, "shared data");
  fs.mkdirSync(path.join(releaseDir, "resources", "steamworks"));
  fs.symlinkSync(external, path.join(releaseDir, "resources", "steamworks", "shared-library"));
  execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Brave;external", external]);
  const logged = [];
  await removeGameQuarantine({ appRoot: appDir, gameRoot: releaseDir }, { logger: { info: message => logged.push(message) } });
  for (const target of [appDir, path.join(releaseDir, "resources")]) {
    assert.equal(execFileSync("/usr/bin/xattr", ["-rs", target], { encoding: "utf8" }).includes("com.apple.quarantine"), false);
    assert.equal(execFileSync("/usr/bin/xattr", ["-p", "com.maclauncher.test", target], { encoding: "utf8" }).trim(), "preserved");
  }
  // A linked folder inside the resources tree is cleared as a link; its target outside stays untouched.
  assert.equal(execFileSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", external], { encoding: "utf8" }).trim(),
    "0081;00000000;Brave;external");
  assert.equal(logged.length, 1);
});
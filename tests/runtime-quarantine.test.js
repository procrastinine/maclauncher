const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { removeManagedRuntimeQuarantine } = require("../src/modules/shared/runtime/managed-quarantine");
const { instrumentRuntimeManagers, withRuntimeCoordinator } = require("../src/core/coordinated-runtime-managers");
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-quarantine-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function installAt(root, suffix = "runtime/1.0") {
  const installDir = path.join(root, "runtimes", suffix);
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, "payload"), "runtime data");
  return { version: "1.0", installDir, ready: true, source: "download" };
}

test("managed quarantine uses exact xattr argv on only the installed runtime root", async t => {
  const root = temporary(t), install = installAt(root, "name with spaces/1.0"), calls = [];
  const execute = (command, args, options, callback) => { calls.push({ command, args, options }); callback(null, "", ""); };
  assert.equal(await removeManagedRuntimeQuarantine(install, { userDataDir: root }, { platform: "darwin", execute }), true);
  assert.equal(calls[0].command, "/usr/bin/xattr");
  assert.deepEqual(calls[0].args, ["-drs", "com.apple.quarantine", fs.realpathSync(install.installDir)]);
  assert.equal(calls[0].options.shell, false);
});

test("managed quarantine skips included/external/local registrations, games and other platforms", async t => {
  const root = temporary(t), install = installAt(root), external = path.join(root, "external.app"), game = path.join(root, "games", "one");
  fs.mkdirSync(external); fs.mkdirSync(game, { recursive: true });
  const dependencies = { platform: "darwin", execute: () => assert.fail("No external mutation") };
  for (const value of [{ ...install, readOnly: true }, { ...install, removable: false }, { ...install, source: "local" },
    { installDir: external }, { installDir: game }, { installDir: root }, { installDir: path.join(root, "runtimes") }, { version: "1.0" }])
    assert.equal(await removeManagedRuntimeQuarantine(value, { userDataDir: root }, dependencies), false);
  assert.equal(await removeManagedRuntimeQuarantine(install, { userDataDir: root }, { ...dependencies, platform: "linux" }), false);
});

test("recursive quarantine preserves shared dependency aliases and refuses a redirected installation root", async t => {
  const root = temporary(t), install = installAt(root), external = path.join(root, "game"); fs.mkdirSync(external);
  const dependencies = { platform: "darwin", execute: (_command, _args, _options, callback) => callback(null, "", "") };
  const alias = path.join(install.installDir, "alias"); fs.symlinkSync(path.join(install.installDir, "payload"), alias);
  assert.equal(await removeManagedRuntimeQuarantine(install, { userDataDir: root }, dependencies), true);
  fs.unlinkSync(alias); fs.symlinkSync(external, alias);
  assert.equal(await removeManagedRuntimeQuarantine(install, { userDataDir: root }, dependencies), true);
  fs.unlinkSync(alias);
  const redirected = path.join(root, "runtimes", "redirected"); fs.symlinkSync(external, redirected, "dir");
  await assert.rejects(removeManagedRuntimeQuarantine({ installDir: redirected }, { userDataDir: root }, dependencies), /aliases/);
});

test("runtime quarantine reports xattr failures before installation can be accepted", async t => {
  const root = temporary(t), install = installAt(root);
  await assert.rejects(removeManagedRuntimeQuarantine(install, { userDataDir: root }, { platform: "darwin",
    execute: (_command, _args, _options, callback) => callback(new Error("xattr failed"), "", "permission denied") }), /permission denied/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(removeManagedRuntimeQuarantine(install, { userDataDir: root, signal: controller.signal }), { name: "AbortError" });
});

test("failed removal is accepted only after a successful quarantine-free recursive inspection", async t => {
  const root = temporary(t), install = installAt(root);
  for (const remaining of ["/runtime/payload: com.apple.quarantine\n", "inspection failed"]) {
    const calls = [];
    await assert.rejects(removeManagedRuntimeQuarantine(install, { userDataDir: root }, { platform: "darwin",
      execute: (_command, args, _options, callback) => {
        calls.push(args);
        if (args[0] === "-drs") callback(new Error("permission denied"), "", "permission denied");
        else if (remaining === "inspection failed") callback(new Error("cannot inspect"), "", "cannot inspect");
        else callback(null, remaining, "");
      } }), /permission denied/);
    assert.deepEqual(calls, [["-drs", "com.apple.quarantine", fs.realpathSync(install.installDir)], ["-rs", fs.realpathSync(install.installDir)]]);
  }
});

test("physical read-only unquarantined publisher files do not prevent runtime preparation", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), install = installAt(root), payload = path.join(install.installDir, "payload"), license = path.join(install.installDir, "LICENSE");
  fs.writeFileSync(license, "publisher license");
  execFileSync("/usr/bin/xattr", ["-w", "com.maclauncher.test", "preserved", license]);
  fs.chmodSync(license, 0o444);
  t.after(() => { try { fs.chmodSync(license, 0o644); } catch {} });
  execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;MacLauncher;test", payload]);
  await removeManagedRuntimeQuarantine(install, { userDataDir: root });
  assert.equal(fs.statSync(license).mode & 0o777, 0o444);
  assert.equal(fs.readFileSync(license, "utf8"), "publisher license");
  assert.equal(execFileSync("/usr/bin/xattr", ["-p", "com.maclauncher.test", license], { encoding: "utf8" }).trim(), "preserved");
  assert.equal(execFileSync("/usr/bin/xattr", ["-rs", install.installDir], { encoding: "utf8" }).includes("com.apple.quarantine"), false);
});

test("physical managed install removes only quarantine and retains unrelated attributes", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), install = installAt(root), payload = path.join(install.installDir, "payload");
  const external = path.join(root, "external-resource"); fs.writeFileSync(external, "shared external data");
  fs.symlinkSync(external, path.join(install.installDir, "external-alias"));
  execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;MacLauncher;external", external]);
  execFileSync("/usr/bin/xattr", ["-w", "com.maclauncher.test", "external preserved", external]);
  for (const file of [install.installDir, payload]) {
    execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;MacLauncher;test", file]);
    execFileSync("/usr/bin/xattr", ["-w", "com.maclauncher.test", "preserved", file]);
  }
  await removeManagedRuntimeQuarantine(install, { userDataDir: root });
  for (const file of [install.installDir, payload]) {
    const attributes = execFileSync("/usr/bin/xattr", [file], { encoding: "utf8" });
    assert.equal(attributes.includes("com.apple.quarantine"), false);
    assert.equal(execFileSync("/usr/bin/xattr", ["-p", "com.maclauncher.test", file], { encoding: "utf8" }).trim(), "preserved");
  }
  assert.equal(execFileSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", external], { encoding: "utf8" }).trim(), "0081;00000000;MacLauncher;external");
  assert.equal(execFileSync("/usr/bin/xattr", ["-p", "com.maclauncher.test", external], { encoding: "utf8" }).trim(), "external preserved");
  await removeManagedRuntimeQuarantine(install, { userDataDir: root });
});

test("UI and automatic Play install mutations clear quarantine before returning and settings persistence", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), events = [], installed = [];
  const coordinator = { acquireMutation: async () => { events.push("acquire"); return "lease"; }, release: async () => { events.push("release"); } };
  const manager = { id: "quarantine-fixture", getState: () => ({ installed }), installRuntime: async data => {
    const result = installAt(root, "fixture/" + data.version); result.version = data.version;
    execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;MacLauncher;test", result.installDir]);
    installed.push(result); return result;
  }, updateSettingsAfterInstall: (_settings, install) => {
    assert.equal(execFileSync("/usr/bin/xattr", [install.installDir], { encoding: "utf8" }).includes("com.apple.quarantine"), false);
    events.push("persist"); return { defaultVersion: install.version };
  } };
  const first = await runRuntimeManagerAction({ manager, action: "install", userDataDir: root, runtimeCoordinator: coordinator,
    payload: { version: "1.0" }, saveSettings: () => {} });
  assert.equal(first.version, "1.0"); assert.deepEqual(events, ["acquire", "release", "persist"]);
  instrumentRuntimeManagers([manager]);
  const second = await withRuntimeCoordinator(coordinator, root, () => manager.installRuntime({ userDataDir: root, version: "2.0" }));
  assert.equal(execFileSync("/usr/bin/xattr", [second.installDir], { encoding: "utf8" }).includes("com.apple.quarantine"), false);
});

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Rosetta = require("../src/modules/shared/runtime/rosetta");
const { createProcessLauncher } = require("../src/core/processes");

const LICENSED = { approved: true, licenseAccepted: true };
function fixture({ present = false, platform = "darwin", arch = "arm64", install, architectures = ["x86_64"] } = {}) {
  const state = { present, clock: 0, files: 0, installs: 0, commands: [] };
  const service = Rosetta.createRosettaService({ platform, arch, now: () => state.clock,
    fileSystem: {
      statSync(file) { state.files += 1; assert.equal(file, Rosetta.RUNTIME_PATH); if (!state.present) throw Error("missing"); return { isFile: () => true }; },
      readFileSync() { state.files += 1; return Buffer.from('<plist><dict><key>ProductVersion</key><string>13.6.4</string><key>ProductBuildVersion</key><string>22G513</string></dict></plist>'); }
    },
    readArchitectures: () => architectures,
    spawnSync(command, args, options) {
      state.commands.push({ command, args, options });
      if (command === "/usr/bin/arch") return { status: state.present ? 0 : 1 };
      assert.equal(command, "/usr/sbin/pkgutil");
      assert.deepEqual(args, ["--pkg-info", Rosetta.PACKAGE_ID]);
      return { status: 0, stdout: `package-id: ${Rosetta.PACKAGE_ID}\nversion: 1.0.0.0.1700000000\ninstall-time: 1700000001\n` };
    },
    runInstaller: async context => { state.installs += 1; assert.equal(context.licenseAccepted, true);
      if (install) return install(state, context); state.present = true; }
  });
  return { service, state };
}

test("Rosetta service import/construction performs no system probe or network operation", () => {
  const f = fixture();
  assert.equal(f.state.files, 0);
  assert.equal(f.state.commands.length, 0);
  assert.equal(f.state.installs, 0);
});

test("installed Rosetta status records exact package/system evidence and warm checks stay cached", async () => {
  const f = fixture({ present: true });
  const status = f.service.getStatus();
  assert.equal(status.available, true);
  assert.equal(status.version, "1.0.0.0.1700000000");
  assert.equal(status.packageId, Rosetta.PACKAGE_ID);
  assert.equal(status.systemVersion, "13.6.4");
  assert.equal(status.systemBuild, "22G513");
  assert.equal(status.installedAt, "2023-11-14T22:13:21.000Z");
  const before = { files: f.state.files, commands: f.state.commands.length };
  for (let index = 0; index < 20; index += 1) assert.equal(f.service.isAvailable(), true);
  assert.equal((await f.service.ensure({ confirmRuntimeInstall: () => assert.fail("No installed prompt") })).version, status.version);
  assert.deepEqual({ files: f.state.files, commands: f.state.commands.length }, before);
  assert.equal(f.state.installs, 0);
});

test("fast installed availability reads package evidence only when details are requested", () => {
  const f = fixture({ present: true });
  assert.equal(f.service.isAvailable(), true);
  assert.equal(f.state.commands.length, 0);
  assert.equal(f.service.getStatus().version, "1.0.0.0.1700000000");
  assert.equal(f.state.commands.length, 1);
  f.service.getStatus();
  assert.equal(f.state.commands.length, 1);
});

test("Intel and non-macOS hosts never inspect or install Rosetta", async () => {
  for (const options of [{ arch: "x64" }, { platform: "linux" }]) {
    const f = fixture(options);
    assert.equal((await f.service.ensure()).available, true);
    assert.equal(f.service.requiresForExecutable("/intel"), false);
    assert.equal(f.state.files, 0);
    assert.equal(f.state.commands.length, 0);
    assert.equal(f.state.installs, 0);
  }
});

test("missing status is briefly cached but notices an installation by another app", () => {
  const f = fixture();
  assert.equal(f.service.isAvailable(), false);
  const probes = f.state.commands.length;
  assert.equal(f.service.isAvailable(), false);
  assert.equal(f.state.commands.length, probes);
  f.state.clock = 2100; f.state.present = true;
  assert.equal(f.service.isAvailable(), true);
});

test("a missing prerequisite without a consent adapter fails with the exact supported install path", async () => {
  const f = fixture();
  await assert.rejects(f.service.ensure(), error => error.code === "ROSETTA_REQUIRED" &&
    error.message.includes("/System/Applications/Utilities/Terminal.app") && error.message.includes("/usr/sbin/softwareupdate --install-rosetta") &&
    error.installLocation === "/Library/Apple/");
  assert.equal(f.state.installs, 0);
});

test("plain download approval cannot silently accept Apple's license", async () => {
  const f = fixture();
  await assert.rejects(f.service.ensure({ confirmRuntimeInstall: async () => true }), { code: "ROSETTA_LICENSE_REQUIRED" });
  assert.equal(f.state.installs, 0);
});

test("declining consent cancels before running Apple's installer", async () => {
  const f = fixture();
  await assert.rejects(f.service.ensure({ confirmRuntimeInstall: async () => false }), { code: "ABORT_ERR" });
  assert.equal(f.state.installs, 0);
});

test("licensed consent uses the genuine installer and verifies the resulting runtime", async () => {
  const f = fixture(), plans = [];
  const status = await f.service.ensure({ confirmRuntimeInstall: async plan => { plans.push(plan); return LICENSED; } });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, "prerequisite");
  assert.equal(plans[0].version, null, "macOS version must not masquerade as a Rosetta package version");
  assert.equal(plans[0].systemVersion, "13.6.4");
  assert.equal(plans[0].licenseRequired, true);
  assert.equal(plans[0].licenseUrl, "https://www.apple.com/legal/sla/");
  assert.equal(plans[0].confirmLabel, "Agree and Install");
  assert.equal(f.state.installs, 1);
  assert.equal(status.available, true);
  assert.equal(status.version, "1.0.0.0.1700000000");
  assert.ok(f.state.commands.some(command => command.command === "/usr/bin/arch"));
});

test("concurrent Intel launches share one consent and one system installation", async () => {
  const f = fixture();
  let finishConsent, approvals = 0;
  const first = f.service.ensure({ confirmRuntimeInstall: () => { approvals += 1; return new Promise(resolve => { finishConsent = resolve; }); } });
  const second = f.service.ensure({ confirmRuntimeInstall: () => assert.fail("Concurrent work must share consent") });
  finishConsent(LICENSED);
  const results = await Promise.all([first, second]);
  assert.equal(approvals, 1);
  assert.equal(f.state.installs, 1);
  assert.ok(results.every(status => status.available));
});

test("an installation completed during the consent dialog is reused without reinstalling", async () => {
  const f = fixture();
  const status = await f.service.ensure({ confirmRuntimeInstall: async () => { f.state.present = true; return LICENSED; } });
  assert.equal(status.available, true);
  assert.equal(f.state.installs, 0);
});

test("failed installers retain actionable errors and successful exit alone does not prove readiness", async () => {
  for (const install of [async () => { throw Error("network unavailable"); }, async () => {}]) {
    const f = fixture({ install });
    await assert.rejects(f.service.ensure({ confirmRuntimeInstall: async () => LICENSED }), error =>
      error.code === "ROSETTA_INSTALL_FAILED" && error.message.includes("/System/Applications/Utilities/Terminal.app") && Boolean(error.cause));
    assert.equal(f.state.installs, 1);
  }
});

test("native and universal executables skip prerequisite work unless Intel execution is requested", async () => {
  const f = fixture({ architectures: ["arm64", "x86_64"] });
  assert.equal(await f.service.ensureForExecutable("/universal"), null);
  assert.equal(f.state.files, 0);
  await f.service.ensureForExecutable("/universal", { confirmRuntimeInstall: async () => LICENSED }, { forceIntel: true });
  assert.equal(f.state.installs, 1);
});

test("checked process launch waits for consent/install before spawning an unflagged Intel binary", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-intel-prerequisite-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "intel"), header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0); header.writeUInt32LE(0x01000007, 4); header.writeUInt32LE(2, 12);
  fs.writeFileSync(executable, header);
  const f = fixture(), calls = [], child = new EventEmitter();
  child.unref = () => child.emit("spawn");
  const launcher = createProcessLauncher({ rosetta: f.service, spawn: (...args) => { assert.equal(f.state.installs, 1); calls.push(args); return child; } });
  assert.equal(await launcher.spawnDetachedChecked(executable, [], {}, false, { confirmRuntimeInstall: async () => LICENSED }), child);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], executable, "Thin Intel binaries still preserve their direct DYLD launch path");
});

test("unchecked launches fail clearly without attempting asynchronous system installation", () => {
  const f = fixture();
  const launcher = createProcessLauncher({ rosetta: f.service, spawn: () => assert.fail("Missing prerequisite must precede spawn") });
  assert.throws(() => launcher.spawnDetachedProcess("/intel"), { code: "ROSETTA_REQUIRED" });
  assert.equal(f.state.installs, 0);
});

test("installed checked launches preserve their immediate spawn behavior without a consent promise", async () => {
  const f = fixture({ present: true }), child = new EventEmitter();
  child.unref = () => child.emit("spawn");
  let calls = 0;
  const launcher = createProcessLauncher({ rosetta: f.service, spawn: () => { calls += 1; return child; } });
  const pending = launcher.spawnDetachedChecked("/intel", [], {}, true);
  assert.equal(calls, 1);
  assert.equal(await pending, child);
  assert.equal(f.state.installs, 0);
  assert.equal(f.state.commands.length, 0);
});

function installerStub(replies) {
  const calls = [];
  const installer = Rosetta.createAppleInstaller({ execFile(command, args, options, callback) {
    calls.push({ command, args, options });
    const reply = replies[calls.length - 1] || {};
    queueMicrotask(() => callback(reply.error || null, reply.stdout || "", reply.stderr || ""));
    return { stdin: { end() {} } };
  } });
  return { installer, calls };
}

test("Apple installer is fixed to softwareupdate and never accepts the license without consent", async () => {
  const f = installerStub([{}]);
  await assert.rejects(f.installer({}), /license has not been accepted/);
  assert.equal(f.calls.length, 0);
  await f.installer({ licenseAccepted: true });
  assert.equal(f.calls[0].command, "/usr/sbin/softwareupdate");
  assert.deepEqual(f.calls[0].args, ["--install-rosetta", "--agree-to-license"]);
  assert.equal(f.calls[0].options.env.LC_ALL, "C");
});

test("installer permission errors route through macOS authorization without collecting credentials", async () => {
  const f = installerStub([{ error: Error("permission"), stderr: "Must be run as root" }, {}]);
  await f.installer({ licenseAccepted: true });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].command, "/usr/bin/osascript");
  assert.deepEqual(f.calls[1].args, ["-e", 'do shell script "/usr/sbin/softwareupdate --install-rosetta --agree-to-license" with administrator privileges']);
});

test("canceling macOS authorization stays a canceled launch", async () => {
  const f = installerStub([{ error: Error("permission"), stderr: "Must be run as root" }, { error: Error("canceled"), stderr: "User canceled. (-128)" }]);
  await assert.rejects(f.installer({ licenseAccepted: true }), { code: "ABORT_ERR" });
});

test("network errors do not trigger an unrelated administrator prompt", async () => {
  const f = installerStub([{ error: Error("offline"), stderr: "Internet connection unavailable" }]);
  await assert.rejects(f.installer({ licenseAccepted: true }), /offline/);
  assert.equal(f.calls.length, 1);
});

test("package evidence never assigns another package's version to Rosetta", () => {
  assert.deepEqual(Rosetta.parsePackageInfo("package-id: unrelated\nversion: 99\n"), { packageId: null, version: null, installedAt: null });
});

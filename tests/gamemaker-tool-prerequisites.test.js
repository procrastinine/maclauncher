const assert = require("node:assert/strict");
const test = require("node:test");
const Rosetta = require("../src/modules/shared/runtime/rosetta");
const { createToolRunner } = require("../src/modules/gamemaker/tools");

test("runner-only Studio 1.4 records do not break Igor inventory or launcher state", t => {
  const Official = require("../src/modules/gamemaker/runtime/official");
  const Tools = require("../src/modules/gamemaker/runtime/official-tools");
  t.mock.method(Official.manager.core, "listInstalled", () => [
    { version: "1.4.9999", source: "vendor-legacy-package", launchReady: true },
    { version: "2.2.5.378", runtimeRoot: null },
    { version: "2026.0.0.23", runtimeRoot: "/missing/native/runtime" }
  ]);
  assert.deepEqual(Tools.listLocalIgors({ userDataDir: "/missing/launcher-data" }), []);
  assert.doesNotThrow(() => Official.manager.getState({ userDataDir: "/missing/launcher-data" }));
});

function fixture({ present = false, architectures = ["x86_64"] } = {}) {
  const state = { present, installs: 0, reads: 0, packageReads: 0, executions: [], order: [] };
  const rosetta = Rosetta.createRosettaService({ platform: "darwin", arch: "arm64",
    fileSystem: {
      statSync() { state.reads += 1; if (!state.present) throw Error("missing"); return { isFile: () => true }; },
      readFileSync() { state.reads += 1; return Buffer.from("<plist/>"); }
    },
    readArchitectures: () => architectures,
    spawnSync(command) {
      if (command === "/usr/bin/arch") return { status: state.present ? 0 : 1 };
      assert.equal(command, "/usr/sbin/pkgutil"); state.packageReads += 1;
      return { status: 0, stdout: `package-id: ${Rosetta.PACKAGE_ID}\nversion: 1.0.0.0.1700000000\n` };
    },
    runInstaller: async context => {
      state.order.push("install"); state.installs += 1;
      assert.equal(context.licenseAccepted, true); state.present = true;
    }
  });
  const execFile = (executable, args, options, callback) => {
    state.order.push("execute"); state.executions.push({ executable, args, options, stdinClosed: false });
    queueMicrotask(() => callback(null, "tool output", ""));
    return { stdin: { end() { state.executions.at(-1).stdinClosed = true; } } };
  };
  return { state, rosetta, execFile };
}

test("creating the GameMaker tool runner performs no probe or execution", () => {
  const f = fixture();
  createToolRunner(f);
  assert.equal(f.state.reads, 0); assert.equal(f.state.executions.length, 0); assert.equal(f.state.installs, 0);
});

test("Intel Igor waits for licensed installation and keeps consent services out of execFile options", async () => {
  const f = fixture(), controller = new AbortController();
  const runner = createToolRunner({ ...f, prerequisiteContext: {
    confirmRuntimeInstall: () => assert.fail("Per-call context should select its own consent adapter")
  } });
  const result = await runner("/owned/tools/Igor", ["Runtime", "Install", "2024.0.0.32"], {
    cwd: "/owned/tools", timeout: 5000, signal: controller.signal,
    prerequisiteContext: { confirmRuntimeInstall: async plan => {
      f.state.order.push("consent"); assert.equal(plan.prerequisiteId, "rosetta");
      assert.equal(plan.licenseRequired, true); return { approved: true, licenseAccepted: true };
    } }
  });
  assert.deepEqual(f.state.order, ["consent", "install", "execute"]);
  assert.equal(f.state.installs, 1); assert.deepEqual(result, { stdout: "tool output", stderr: "" });
  const execution = f.state.executions[0];
  assert.equal(execution.executable, "/owned/tools/Igor"); assert.equal(execution.stdinClosed, true);
  assert.equal(execution.options.signal, controller.signal); assert.equal(execution.options.cwd, "/owned/tools");
  assert.equal(execution.options.timeout, 5000); assert.equal("prerequisiteContext" in execution.options, false);
  assert.equal("confirmRuntimeInstall" in execution.options, false);
});

test("declining the prerequisite prevents Igor execution", async () => {
  const f = fixture(), runner = createToolRunner({ ...f,
    prerequisiteContext: { confirmRuntimeInstall: async () => false } });
  await assert.rejects(runner("/owned/tools/Igor", []), { code: "ABORT_ERR" });
  assert.equal(f.state.installs, 0); assert.equal(f.state.executions.length, 0);
});

test("native ARM tools and system copy tools skip the prerequisite", async () => {
  const f = fixture({ architectures: ["arm64", "x86_64"] });
  const runner = createToolRunner({ ...f, prerequisiteContext: {
    confirmRuntimeInstall: () => assert.fail("No consent for a native executable")
  } });
  await runner("/usr/bin/ditto", ["source", "destination"]);
  assert.equal(f.state.reads, 0); assert.equal(f.state.installs, 0); assert.equal(f.state.executions.length, 1);
});

test("installed Intel tools reuse Rosetta package evidence without another prompt or probe", async () => {
  const f = fixture({ present: true }), runner = createToolRunner({ ...f, prerequisiteContext: {
    confirmRuntimeInstall: () => assert.fail("No consent for installed Rosetta")
  } });
  await runner("/owned/tools/Igor", ["--help"]);
  const reads = f.state.reads, packageReads = f.state.packageReads;
  await runner("/owned/tools/Igor", ["--version"]);
  assert.equal(f.state.reads, reads); assert.equal(f.state.packageReads, packageReads);
  assert.equal(f.state.installs, 0); assert.equal(f.state.executions.length, 2);
});

test("Igor setup actions retain the manager's injected prerequisite context", async t => {
  const Installer = require("../src/modules/gamemaker/runtime/official-installer");
  const Official = require("../src/modules/gamemaker/runtime/official");
  const context = { confirmRuntimeInstall: async () => ({ approved: true, licenseAccepted: true }) };
  const logger = { info() {} };
  let received;
  t.mock.method(Installer, "ensureIgor", async options => { received = options; return { version: "2024.0.0.32", ready: true }; });
  await Official.manager.performSetupAction({ setupActionId: "installIgor", userDataDir: "/owned/data",
    prerequisiteContext: context, confirmRuntimeInstall: context.confirmRuntimeInstall, logger });
  assert.equal(received.prerequisiteContext, context); assert.equal(received.confirmRuntimeInstall, context.confirmRuntimeInstall);
  assert.equal(received.logger, logger);
});

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events"), { spawnSync } = require("./helpers/android-java");
const Library = require("../src/modules/android/play-library");

test("Google Play acquisition requires explicit account, network and an inactive game", () => {
  const entry = { runtimeSettings: { klepton: { googleIntegration: true, googleAccount: "a".repeat(64) } } };
  assert.equal(Library.policy(entry, {}).accountId, "a".repeat(64));
  assert.throws(() => Library.policy({}, {}), /select a Google account/);
  assert.throws(() => Library.policy({ runtimeSettings: { klepton: { googleIntegration: true } } }, {}), /select a Google account/);
  for (const context of [{ networkAllowed: false }, { runtimeSettings: { networkIsolation: true } }])
    assert.throws(() => Library.policy(entry, context), /Enable network access/);
  assert.throws(() => Library.policy(entry, { isGameRunning: () => true }), /Close the game/);
});

test("A launch-scoped Google Play reply retires observers and cancellation cannot become success", async () => {
  const child = new EventEmitter(); child.exitCode = child.signalCode = null;
  let reply = Library.waitForResult(child);
  child.emit("androidOperationResult", { status: "not-licensed", code: 1 });
  assert.deepEqual(await reply.promise, { status: "not-licensed", code: 1 });
  assert.equal(child.listenerCount("exit"), 0); assert.equal(child.listenerCount("androidOperationResult"), 0);
  const controller = new AbortController(); reply = Library.waitForResult(child, controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(reply.promise, /cancelled/);
  assert.equal(child.listenerCount("androidOperationResult"), 0);
  reply = Library.waitForResult(child); child.emit("exit", 0);
  await assert.rejects(reply.promise, /without a license response/);
});

test("Google Play acquisition keeps the game-selected managed runtime and profile identities", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "play-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const Host = require("../src/modules/android/host"), Storage = require("../src/modules/android/storage");
  const Preparation = require("../src/modules/android/prepare"), Google = require("../src/modules/android/google-accounts");
  const identity = { version: "managed-old", manifestSha256: "a".repeat(64) };
  const declaration = { version: identity.version, manifestSha256: identity.manifestSha256 };
  const payload = { root: "/managed/old", runtimeIdentity: identity,
    profile: { playLibraryVersion: 1, systemServicesVersion: 1, processIdentityVersion: 1, lazyProfileServicesVersion: 1 } };
  const entry = { gameId: "selected-game", runtimeData: { klepton: { version: "managed-old" } },
    runtimeSettings: { klepton: { googleIntegration: true, googleAccount: "b".repeat(64) } } };
  const settings = { runtimes: { android: { defaultVersion: "managed-new" } } }, used = [], resolutions = [];
  const context = { userDataDir: root, settings, useRuntime: async value => used.push(value) };
  const prepared = { metadata: { packageName: "example.library" }, filesRoot: root };
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  t.mock.method(Google, "selected", () => ({ name: "fixture", type: "com.google" }));
  t.mock.method(Storage, "prepareStorage", async () => ({ root }));
  t.mock.method(Host, "ensureJava", async () => ({ javaPath: "/selected/java" }));
  t.mock.method(Host, "presentationEnvironment", () => ({}));
  t.mock.method(Host, "launchConfig", () => ({}));
  t.mock.method(Host, "serviceLauncher", (_context, actual) => { assert.equal(actual, payload);return async () => child; });
  t.mock.method(Preparation, "retainPrepared", async () => async () => {});
  let connections;
  const dependencies = {
    manager: { id: "android", resolveSelection: (actualEntry, actualSettings, profile) => {
      assert.equal(actualEntry, entry);assert.equal(actualSettings, settings);assert.equal(profile, root);
      return { ready: true, version: identity.version, install: { root: payload.root, installDir: "/managed/install", declaration } };
    } },
    resolveRuntime: async (options, record) => { resolutions.push({ options, record });return payload; },
    prepare: async () => prepared,
    prepareInstalled: async () => ({ services: ["com.android.vending", "com.google.android.gms"].map(packageName => ({ record: { packageName } })), release: async () => {} }),
    prepareConnections: async options => {
      connections = options;
      return { stdio: value => value, connect: async () => child.emit("androidOperationResult", { status: "licensed", code: 0 }),
        close: async () => { child.exitCode = 0;child.emit("exit", 0); } };
    }
  };
  assert.equal((await Library.acquire(entry, {}, context, dependencies)).status, "Licensed");
  assert.deepEqual(resolutions, [{ options: { root: payload.root, signal: undefined }, record: declaration }]);
  assert.deepEqual(used, [{ managerId: "android", version: "managed-old", sourcePath: "/managed/install" }]);
  for (const options of [connections.accountOptions, connections.platformOptions]) {
    assert.equal(options.runtimeRoot, payload.root);assert.equal(options.runtimeIdentity, identity);
  }
  assert.equal(connections.userDataDir, root);
  assert.equal(connections.processIdentityVersion, 1);assert.equal(connections.lazyProfileServicesVersion, 1);
});

test("an unavailable explicitly selected Google Play runtime never falls back or starts preparation", async t => {
  t.mock.method(require("../src/modules/android/google-accounts"), "selected", () => ({ name: "fixture", type: "com.google" }));
  const entry = { runtimeSettings: { klepton: { googleIntegration: true, googleAccount: "b".repeat(64) } } };
  await assert.rejects(Library.acquire(entry, {}, {}, {
    manager: { resolveSelection: () => ({ ready: false, reason: "Pinned version is unavailable" }) },
    resolveRuntime: () => assert.fail("No fallback resolver"),prepare: () => assert.fail("No preparation")
  }), /Pinned version is unavailable/);
});

test("Supervisor accepts operation results only for its exact supervised request", { timeout: 5000 }, async () => {
  const { spawn } = require("node:child_process"), { once } = require("node:events");
  const { prepareConnections } = require("../src/modules/android/service-processes");
  for (const accepted of [true, false]) {
    const config = { packageName: "example.library", serviceOperation: "play-library", operationId: "request-fixture" };
    let warning;
    const connections = await prepareConnections({ config,
      game: { metadata: { packageName: config.packageName }, sourceApk: "/fixture.apk", nativeRoot: "/fixture", filesRoot: "/fixture/files" },
      installed: { uid: 10000, services: [], release: async () => {} }, logger: { warn: value => { warning = value; } } });
    const child = spawn(process.execPath, ["-e", `
      const net=require('node:net'),{frame,receive}=require(${JSON.stringify(path.resolve("src/modules/android/process-channel"))});
      const channel=new net.Socket({fd:5});channel.on('end',()=>process.exit(0));
      receive(channel,()=>channel.write(frame({op:'operation-result',id:${JSON.stringify(accepted ? config.operationId : "different-request")},status:'licensed',code:0,ignored:'must-not-forward'})));
    `], { stdio: connections.stdio(["ignore", "ignore", "pipe"]) });
    const observed = []; child.on("androidOperationResult", value => observed.push(value));
    try {
      const exited = once(child, "exit");
      const reply = accepted ? once(child, "androidOperationResult") : exited;
      await connections.connect(child); await reply;
      if (accepted) assert.deepEqual(observed, [{ status: "licensed", code: 0 }]);
      else { assert.deepEqual(observed, []); assert.match(warning, /Invalid Android operation result/); }
      await connections.close(); if (child.exitCode == null) await exited;
    } finally { await connections.close(); if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL"); }
  }
});

test("Original LVL wire responses and durable original SharedPreferences restoration", { timeout: 30000 }, t => {
  const runtime = process.env.KLEPTON_NATIVE_RUNTIME, home = process.env.JAVA_HOME;
  if (process.platform !== "darwin" || !runtime || !home) return t.skip("Requires Android runtime and Java21");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "play-library-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cp = ["android-host.jar", "android-framework.jar"].map(name => path.resolve(runtime, name)).join(path.delimiter);
  function run(binary, args) { const result = spawnSync(path.join(home, "bin", binary), args, { encoding: "utf8", timeout: 25000 });
    assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout; }
  const source = path.resolve("src/modules/android/native/java/maclauncher/android"), fixture = path.resolve("tests/fixtures/android-framework-services");
  run("javac", ["--release", "21", "-cp", cp, "-d", root, ...["PlayLibraryOperation", "ProcessAuthority"].map(name => path.join(source, name + ".java")),
    path.join(source, "framework/ProviderPreferenceLease.java"), ...["PlayLibraryProbe", "PreferenceLeaseProbe"].map(name => path.join(fixture, name + ".java")),
    path.resolve("tests/fixtures/android-window-session/RuntimeFixture.java")]);
  assert.match(run("java", ["-Xverify:all", "-cp", root + path.delimiter + cp, "maclauncher.android.PlayLibraryProbe", path.resolve(runtime), root]), /PASS original LVL Binder protocol and provider preference recovery/);
});

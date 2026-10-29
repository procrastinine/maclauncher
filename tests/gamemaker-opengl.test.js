const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Fallback = require("../src/modules/gamemaker/runtime/opengl-fallback");
const Native = require("../src/modules/shared/runtime/local-native");
const { ARM64, X64, image, universal } = require("./fixtures/macho-image");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-opengl-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function ownedHelper(userDataDir, version, changes = {}) {
  const directory = Fallback.__test.installDirectory(userDataDir, version);
  fs.mkdirSync(directory, { recursive: true });
  const dylibPath = path.join(directory, "software-opengl.dylib");
  fs.writeFileSync(dylibPath, universal([ARM64, X64].map(cpu => ({ cpu, bytes: image({ cpu }) }))));
  const record = { version, sourceSha256: "7b9e4779af97a2bd7d5f2dd5c1a643ebc9eabc864e649940b294b05d0724c994",
    architecture: "universal", binarySha256: Native.hashFile(dylibPath), testedVendorSha256: Fallback.TESTED_VENDOR_SHA256,
    supportedRunnerVersions: [...Fallback.SUPPORTED_RUNNER_VERSIONS], ...changes };
  const recordPath = path.join(directory, "helper.json");
  fs.writeFileSync(recordPath, JSON.stringify(record));
  return { directory, dylibPath, recordPath, record };
}
function managerWith(resolve) {
  return { id: "gamemaker-opengl-helper", resolveSelection: resolve };
}
const emptyManager = managerWith((_entry, _settings, _root, options = {}) => ({ ready: false,
  version: options.version || "catalog-choice", discoveryRequired: true }));

test("OpenGL status is read-only and leaves installation to the ordinary managed selection", t => {
  const userDataDir = temporary(t);
  const status = Fallback.getFallbackStatus({ userDataDir, manager: emptyManager });
  assert.equal(status.ready, false);
  assert.equal(status.version, "catalog-choice");
  assert.deepEqual(fs.readdirSync(userDataDir), []);
  assert.throws(() => Fallback.__test.installDirectory("relative", "saved-helper"), /absolute/);
  assert.throws(() => Fallback.__test.installDirectory(userDataDir, "../escape"), /Unsupported/);
  const requirements = Fallback.runtimeRequirements({}, { userDataDir, runtimeSettings: { softwareOpenGLFallback: "enabled" } },
    { version: "2099.1.2", install: { binarySha256: "a".repeat(64) } }, emptyManager);
  assert.equal(requirements[0].managerId, emptyManager.id);
  assert.equal(requirements[0].version, "catalog-choice");
  assert.equal(requirements[0].requiresDownload, true);
});

test("saved owned helper receipts remain usable offline with their exact CPU, source and binary identity", t => {
  const userDataDir = temporary(t), owned = ownedHelper(userDataDir, "saved-helper-7");
  const options = { userDataDir, helperVersion: owned.record.version, runnerVersion: "1.4.9999",
    runnerSha256: Fallback.TESTED_VENDOR_BUILDS["1.4.9999"], manager: emptyManager };
  const before = fs.readFileSync(owned.recordPath), goodBinary = fs.readFileSync(owned.dylibPath);
  const selected = Fallback.resolveFallback(options);
  assert.equal(selected.ready, true);
  assert.equal(selected.version, owned.record.version);
  assert.equal(selected.environment.DYLD_INSERT_LIBRARIES, owned.dylibPath);
  assert.equal(selected.environment.MACLAUNCHER_LEGACY_LOGICAL_OPENGL, "1", "older receipts recover their source's actual coordinate ABI");
  assert.deepEqual(fs.readFileSync(owned.recordPath), before);
  fs.appendFileSync(owned.dylibPath, "changed");
  assert.equal(Fallback.resolveFallback(options).ready, false);
  fs.writeFileSync(owned.dylibPath, goodBinary);
  for (const change of [{ version: "other" }, { sourceSha256: "0".repeat(64) }, { testedVendorSha256: "0".repeat(64) },
    { architecture: "arm64" }, { supportedRunnerVersions: ["unknown"] }, { legacyLogicalRunnerVersions: [] }]) {
    fs.writeFileSync(owned.recordPath, JSON.stringify({ ...owned.record, ...change }));
    assert.equal(Fallback.resolveFallback(options).ready, false);
  }
  fs.writeFileSync(owned.recordPath, before);
  fs.writeFileSync(owned.dylibPath, image({ cpu: ARM64 }));
  fs.writeFileSync(owned.recordPath, JSON.stringify({ ...owned.record, binarySha256: Native.hashFile(owned.dylibPath) }));
  assert.equal(Fallback.resolveFallback(options).ready, false, "a matching receipt cannot admit a missing CPU slice");
});

test("explicit missing legacy choices stay exact and never map to a different managed package", t => {
  const userDataDir = temporary(t), installed = ownedHelper(userDataDir, "other-installed-helper");
  const requests = [], manager = managerWith((_entry, _settings, _root, options = {}) => {
    requests.push(options); return { ready: false, version: options.version || "catalog-choice" };
  });
  const selected = Fallback.selection({}, { userDataDir, runtimeSettings: { graphicsHelperVersion: "saved-missing-helper" } }, manager);
  assert.equal(selected.ready, false);
  assert.equal(selected.version, "saved-missing-helper");
  assert.deepEqual(requests, [{ version: "saved-missing-helper" }]);
  const exact = Fallback.selection({}, { userDataDir, runtimeSettings: { graphicsHelperVersion: installed.record.version } }, manager);
  assert.equal(exact.ready, true);
  assert.equal(exact.version, installed.record.version);
  for (const [entry, settings] of [[{ runtimeData: { [manager.id]: { version: installed.record.version } } }, {}],
    [{ runtimeData: { [manager.id]: { version: "auto" } } }, { runtimes: { [manager.id]: { defaultVersion: installed.record.version } } }]]) {
    const retained = Fallback.selection(entry, { userDataDir, settings }, manager);
    assert.equal(retained.ready, true); assert.equal(retained.version, installed.record.version);
  }
});

test("verified owned helper receipts supply a manager default only without a listed choice", t => {
  const emptyManager = managerWith(() => ({ ready: false, version: null, discoveryRequired: true }));
  const userDataDir = temporary(t), earlier = ownedHelper(userDataDir, "owned-2"), newer = ownedHelper(userDataDir, "owned-10");
  const selected = Fallback.selection({}, { userDataDir }, emptyManager);
  assert.equal(selected.ready, true);
  assert.equal(selected.version, newer.record.version);
  fs.appendFileSync(newer.dylibPath, "changed");
  assert.equal(Fallback.selection({}, { userDataDir }, emptyManager).version, earlier.record.version, "A damaged automatic donor is never admitted");
  const cleared = Fallback.selection({}, {userDataDir,settings:{runtimes:{[emptyManager.id]:{defaultVersion:null}}}}, emptyManager);
  assert.equal(cleared.ready, true);
  assert.equal(cleared.version, earlier.record.version, "A cleared global restores the ready installed manager default");
  const exact = Fallback.selection({}, { userDataDir, runtimeSettings: { graphicsHelperVersion: earlier.record.version } }, emptyManager);
  assert.equal(exact.ready, true); assert.equal(exact.version, earlier.record.version);
  assert.equal(Fallback.selection({}, { userDataDir, runtimeSettings: { graphicsHelperVersion: newer.record.version } }, emptyManager).ready, false);
  const explicit = managerWith(() => ({ ready: false, version: "user-exact-choice" }));
  assert.equal(Fallback.selection({ runtimeData: { [explicit.id]: { version: "user-exact-choice" } } }, { userDataDir }, explicit).version, "user-exact-choice");
  assert.equal(Fallback.selection({}, { userDataDir, settings: { runtimes: { [explicit.id]: { defaultVersion: "user-exact-choice" } } } }, explicit).version, "user-exact-choice");
});

test("selected managed manifest runner checksums govern eligibility without a launcher runner-version admission", t => {
  const runnerVersion = "2099.1.2", runnerSha256 = "a".repeat(64), checksums = { [runnerVersion]: runnerSha256 };
  const status = { ready: true, version: "selected-package", dylibPath: "/fixture/software-opengl.dylib",
    runnerChecksums: checksums, legacyLogicalRunnerVersions: [] };
  const install = { manifest: { runnerChecksums: checksums } }, manager = managerWith(() => ({ ready: true, version: status.version, install }));
  t.mock.method(Fallback.manager, "verifyInstall", () => status);
  assert.equal(Fallback.supportsRunner(install, runnerVersion, runnerSha256), true);
  assert.equal(Fallback.supportsRunner(install, "2026.0.0.23", Fallback.TESTED_VENDOR_SHA256), false);
  assert.equal(Fallback.resolveFallback({ runnerVersion, runnerSha256, manager }).ready, true);
  const wrong = Fallback.resolveFallback({ runnerVersion, runnerSha256: "b".repeat(64), manager });
  assert.equal(wrong.ready, false);
  assert.equal(wrong.environment, undefined);
  assert.match(wrong.reason, /checksum/);
});

test("legacy runner hash guards remain exact and modern coordinates remain unchanged", t => {
  const userDataDir = temporary(t), owned = ownedHelper(userDataDir, "saved-helper");
  const modern = Fallback.resolveFallback({ userDataDir, helperVersion: owned.record.version, runnerVersion: "2026.0.0.23",
    runnerSha256: Fallback.TESTED_VENDOR_SHA256, manager: emptyManager });
  assert.equal(modern.ready, true);
  assert.equal(modern.environment.MACLAUNCHER_LEGACY_LOGICAL_OPENGL, "0");
  for (const runnerSha256 of [undefined, "", "0".repeat(64)]) {
    const wrong = Fallback.resolveFallback({ userDataDir, helperVersion: owned.record.version,
      runnerVersion: "2026.0.0.23", runnerSha256, manager: emptyManager });
    assert.equal(wrong.ready, false);
    assert.equal(wrong.environment, undefined);
  }
});

test("the application exposes no compiler, producer-source lookup or helper version table", () => {
  assert.equal(Fallback.buildFallback, undefined);
  assert.equal(Fallback.__test.sourceIdentity, undefined);
  assert.equal(Fallback.__test.SOURCE_PATH, undefined);
  assert.equal(Fallback.HELPER_BUILDS, undefined);
});

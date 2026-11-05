const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Fallback = require("../src/modules/gamemaker/runtime/opengl-fallback");
const Native = require("../src/modules/shared/runtime/local-native");
const { ARM64, X64, image, universal } = require("./fixtures/macho-image");

test("managed OpenGL helpers omit runner catalogs while retaining logical mode, integrity and native CPU requirements", {skip: process.platform !== "darwin"}, t => {
  const {execFileSync} = require("node:child_process");
  const Bundled = require("../src/modules/shared/runtime/bundled-native");
  const Manager = require("../src/modules/gamemaker/runtime/opengl-helper-manager");
  const root = temporary(t), source = path.join(root, "helper.c"), file = path.join(root, "software-opengl.dylib");
  fs.writeFileSync(source, "int helper_fixture(void) { return 1; }\n");
  execFileSync("clang", ["-dynamiclib", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=13.0",
    "-Wl,-install_name,@rpath/software-opengl.dylib", source, "-o", file], {stdio: "pipe"});
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", file], {stdio: "pipe"});
  const binary = fs.readFileSync(file), payload = path.join(root, "payload"); fs.mkdirSync(payload);
  function install(runnerChecksums, supportedRunnerVersions, bytes = binary, architectures = ["arm64", "x86_64"]) {
    const helper = {version: "future-helper", sourceSha256: "a".repeat(64), binarySha256: Bundled.digest(bytes), architecture: "universal",
      ...(supportedRunnerVersions === undefined ? {} : {supportedRunnerVersions})};
    fs.writeFileSync(path.join(payload, "software-opengl.dylib"), bytes, {mode: 0o755});
    fs.writeFileSync(path.join(payload, "helper.json"), JSON.stringify(helper), {mode: 0o644});
    const files = ["software-opengl.dylib", "helper.json"].map(name => {
      const {bytes, ...record} = Bundled.readRegular(path.join(payload, name));
      return {path: name, ...record, ...(name.endsWith(".dylib") ? {architectures} : {})};
    });
    const manifest = {managerId: "gamemaker-opengl-helper", version: helper.version, helperABI: 1, arch: "universal", files,
      source: {sourceSha256: helper.sourceSha256}, legacyLogicalRunnerVersions: ["1.4.9999"],
      ...(runnerChecksums === undefined ? {} : {runnerChecksums})};
    return {root: payload, payloadRoot: payload, installDir: root, manifest, declaration: {minimumMacOS: "13.0", files}};
  }
  for (const [checksums, versions] of [[undefined, undefined], [{}, []], [{"2026.0.0.23": "b".repeat(64)}, undefined],
    [undefined, ["2099.1.2"]], [{"2026.0.0.23": "b".repeat(64)}, ["2099.1.2"]]]) {
    const selected = install(checksums, versions), status = Manager.verifyInstall(selected);
    assert.equal(status.ready, true);
    assert.deepEqual(status.legacyLogicalRunnerVersions, ["1.4.9999"]);
    const manager = managerWith(() => ({ready: true, version: "future-helper", install: selected}));
    assert.equal(Fallback.resolveFallback({manager, runnerVersion: "1.4.9999"}).environment.MACLAUNCHER_LEGACY_LOGICAL_OPENGL, "1");
    assert.equal(Fallback.resolveFallback({manager, runnerVersion: "2099.1.2"}).environment.MACLAUNCHER_LEGACY_LOGICAL_OPENGL, "0");
  }
  const intact = install(); fs.appendFileSync(path.join(payload, "software-opengl.dylib"), "changed");
  assert.throws(() => Manager.verifyInstall(intact), /checksum|limit|inventory/i);
  const thin = path.join(root, "thin.dylib");
  execFileSync("/usr/bin/lipo", [file, "-thin", "arm64", "-output", thin]);
  assert.throws(() => Manager.verifyInstall(install(undefined, undefined, fs.readFileSync(thin), ["arm64"])), /both Mac CPU architectures/);
});

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
    architecture: "universal", binarySha256: Native.hashFile(dylibPath), testedVendorSha256: "d".repeat(64),
    supportedRunnerVersions: ["2026.0.0.23", "1.4.9999"], ...changes };
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

test("saved helper receipts remain usable offline without source and byte admission pins", t => {
  const userDataDir = temporary(t), owned = ownedHelper(userDataDir, "saved-helper-7");
  const options = { userDataDir, helperVersion: owned.record.version, runnerVersion: "1.4.9999", manager: emptyManager };
  const before = fs.readFileSync(owned.recordPath), goodBinary = fs.readFileSync(owned.dylibPath);
  const selected = Fallback.resolveFallback(options);
  assert.equal(selected.ready, true);
  assert.equal(selected.version, owned.record.version);
  assert.equal(selected.environment.DYLD_INSERT_LIBRARIES, owned.dylibPath);
  assert.equal(selected.environment.MACLAUNCHER_LEGACY_LOGICAL_OPENGL, "1", "older receipts recover their source's actual coordinate ABI");
  assert.deepEqual(fs.readFileSync(owned.recordPath), before);
  fs.appendFileSync(owned.dylibPath, "changed");
  assert.equal(Fallback.resolveFallback(options).ready, true);
  fs.writeFileSync(owned.dylibPath, goodBinary);
  for (const change of [{ version: "other" }, { sourceSha256: "0".repeat(64) }, { architecture: "arm64" }, { legacyLogicalRunnerVersions: [] }]) {
    fs.writeFileSync(owned.recordPath, JSON.stringify({ ...owned.record, ...change }));
    assert.equal(Fallback.resolveFallback(options).ready, true);
  }
  fs.writeFileSync(owned.recordPath, before);
  fs.writeFileSync(owned.dylibPath, image({ cpu: ARM64 }));
  fs.writeFileSync(owned.recordPath, JSON.stringify({ ...owned.record, binarySha256: Native.hashFile(owned.dylibPath) }));
  assert.equal(Fallback.resolveFallback(options).ready, process.arch === "arm64", "Actual native slices determine host support independently of metadata");
  fs.writeFileSync(owned.dylibPath, "not a native image");assert.equal(Fallback.resolveFallback(options).ready, false);
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
  fs.writeFileSync(newer.dylibPath, "not a Mach-O image");
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

test("the helper serves every runner that draws through OpenGL, read from the runner's own load commands", t => {
  const root = temporary(t), runner = name => path.join(root, name);
  fs.writeFileSync(runner("opengl"), universal([ARM64, X64].map(cpu => ({ cpu, bytes: image({ cpu, fileType: 2, installName: null,
    dependencies: ["/usr/lib/libSystem.B.dylib", "/System/Library/Frameworks/OpenGL.framework/Versions/A/OpenGL"] }) }))));
  fs.writeFileSync(runner("metal"), image({ fileType: 2, installName: null,
    dependencies: ["/usr/lib/libSystem.B.dylib", "/System/Library/Frameworks/Metal.framework/Versions/A/Metal"] }));
  assert.equal(Fallback.drawsWithOpenGL(runner("opengl")), true);
  assert.equal(Fallback.drawsWithOpenGL(runner("metal")), false);
  assert.equal(Fallback.drawsWithOpenGL(runner("missing")), false);
  const auto = { userDataDir: root, runtimeSettings: {} };
  assert.equal(Fallback.runtimeRequirements({}, auto, { version: "2099.1.2", install: { executablePath: runner("opengl") } }, emptyManager).length, 1);
  assert.deepEqual(Fallback.runtimeRequirements({}, auto, { version: "2099.1.2", install: { executablePath: runner("metal") } }, emptyManager), []);
  assert.equal(Fallback.runtimeRequirements({}, auto, { version: "2099.1.2" }, emptyManager).length, 1, "a runner not yet installed plans the helper with it");
  const status = { ready: true, version: "selected-package", dylibPath: "/fixture/software-opengl.dylib", legacyLogicalRunnerVersions: ["1.4.9999"] };
  const manager = managerWith(() => ({ ready: true, version: status.version, install: {} }));
  t.mock.method(Fallback.manager, "verifyInstall", () => status);
  const future = Fallback.resolveFallback({ runnerVersion: "2099.1.2", manager });
  assert.equal(future.ready, true, "a runner released after the helper uses it");
  assert.equal(future.environment.DYLD_INSERT_LIBRARIES, status.dylibPath);
  assert.equal(future.environment.MACLAUNCHER_LEGACY_LOGICAL_OPENGL, "0");
  assert.equal(Fallback.resolveFallback({ runnerVersion: "1.4.9999", manager }).environment.MACLAUNCHER_LEGACY_LOGICAL_OPENGL, "1");
});

test("owned helper receipts keep modern runner coordinates unchanged", t => {
  const userDataDir = temporary(t), owned = ownedHelper(userDataDir, "saved-helper");
  for (const runnerVersion of ["2026.0.0.23", "2099.1.2"]) {
    const modern = Fallback.resolveFallback({ userDataDir, helperVersion: owned.record.version, runnerVersion, manager: emptyManager });
    assert.equal(modern.ready, true);
    assert.equal(modern.environment.MACLAUNCHER_LEGACY_LOGICAL_OPENGL, "0");
  }
});

test("the application exposes no compiler, producer-source lookup or helper version table", () => {
  assert.equal(Fallback.buildFallback, undefined);
  assert.equal(Fallback.__test.sourceIdentity, undefined);
  assert.equal(Fallback.__test.SOURCE_PATH, undefined);
  assert.equal(Fallback.HELPER_BUILDS, undefined);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {execFileSync} = require("node:child_process");
const test = require("node:test");
const Fna = require("../src/modules/fna/main");
const Manager = require("../src/modules/fna/runtime/manager");
const Profile = require("../src/modules/fna/runtime/profile");
const Bundled = require("../src/modules/shared/runtime/bundled-native");
const {prepareForLaunch} = require("../src/core/runtime-preparation");
const {writeAssembly} = require("./helpers/fna-assembly");
const arch = process.arch, revision = "a".repeat(40), dotnetVersion = "8.0.42";
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fna-requirements-")));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, userDataDir: path.join(root, "profile")};
}
function runtimeFiles(root, capabilities) {
  const files = {};
  for (const name of Profile.requiredFiles(dotnetVersion)) {
    const file = path.join(root, name);fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, "fixture " + name);files[name] = digest(fs.readFileSync(file));
  }
  // Structural Mach-O fixture only: no compiler, codesign or execution.
  const binary = Buffer.alloc(32);binary.writeUInt32LE(0xfeedfacf);binary.writeUInt32LE(arch === "x64" ? 0x01000007 : 0x0100000c, 4);binary.writeUInt32LE(2, 12);
  fs.writeFileSync(path.join(root, "dotnet"), binary, {mode: 0o755});
  fs.writeFileSync(path.join(root, "LICENSE.txt"), "Fixture license\n");
  const profile = {profile: "fixture-host", architecture: arch, frameworkVersion: "26.10.0.0", dotnetVersion,
    upstreamRevision: revision, files, ...(capabilities === undefined ? {} : {capabilities})};
  fs.writeFileSync(path.join(root, "fna-runtime.json"), JSON.stringify(profile));
  return profile;
}
function register(runtime, f, version, capabilities) {
  const root = path.join(f.root, version);runtimeFiles(root, capabilities);
  runtime.core.rememberResolvedVersion({userDataDir: f.userDataDir, entry: {version, upstreamRevision: revision, architecture: arch,
    ...(capabilities === undefined ? {} : {capabilities})}});
  return runtime.core.registerLocal({userDataDir: f.userDataDir, version, runtimePath: path.join(root, "dotnet")});
}
function packageRecord(version, capabilities) {
  const tag = "fna/v" + version + "/" + arch, filename = "fna-" + version + "-" + arch + ".tar.gz";
  return {schemaVersion: 2, id: "fna", version, arch, launcherArchitectures: [arch], minimumMacOS: "13.0",
    manifestRelative: "manifest.json", manifestSha256: "b".repeat(64), sourceSha256: "b".repeat(64), updatePolicy: "manual", tag,
    source: {repository: "procrastinine/maclauncher-builds", revision},
    ...(capabilities === undefined ? {} : {capabilities}),
    asset: {filename, bytes: 1, sha256: "c".repeat(64), url: `https://github.com/procrastinine/maclauncher-builds/releases/download/${encodeURIComponent(tag)}/${filename}`}};
}
function packageArchive(f, version, profileCapabilities, catalogCapabilities = profileCapabilities) {
  const stage = path.join(f.root, "archive-" + version), payload = path.join(stage, "files", "files", "fna");
  runtimeFiles(payload, profileCapabilities);
  const files = Bundled.fileInventory(path.dirname(payload)).map(name => {
    const file = path.join(path.dirname(payload), name), stat = fs.statSync(file);
    return {path: name, size: stat.size, mode: stat.mode & 0o777, sha256: digest(fs.readFileSync(file)),
      ...(name === "fna/dotnet" ? {architectures: [arch === "x64" ? "x86_64" : arch]} : {})};
  });
  const manifest = {schemaVersion: 1, managerId: "fna", version, arch, platform: "darwin", minimumMacOS: "13.0",
    upstreamRevision: revision, executableRelative: "fna/dotnet", files, dependencies: [], provenance: {sourceRevision: revision},
    notices: [{name: "Fixture", license: "MIT", sourceUrl: "https://example.com/source", path: "fna/LICENSE.txt"}]};
  const bytes = Buffer.from(JSON.stringify(manifest)), record = packageRecord(version, catalogCapabilities);
  record.manifestSha256 = record.sourceSha256 = digest(bytes);
  fs.writeFileSync(path.join(stage, "files", "manifest.json"), bytes);
  fs.writeFileSync(path.join(stage, "runtime-package.json"), JSON.stringify({...record, files: [
    ...files.map(file => ({...file, path: "files/" + file.path})),
    {path: "manifest.json", size: bytes.length, mode: 0o644, sha256: digest(bytes)}]}));
  const archive = path.join(f.root, record.asset.filename);
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", stage, "runtime-package.json", "files"]);
  record.asset.sha256 = digest(fs.readFileSync(archive));record.asset.bytes = fs.statSync(archive).size;
  return {record, archive};
}
function createRuntime(f, packages, events = []) {
  return Manager.createManager({dependencies: {manager: {
    systemVersionSync: () => "26.0", hostArch: arch,
    projectBuilds: {fetchUrlBuffer: async () => {
      events.push("catalog");
      return {status: 200, body: Buffer.from(JSON.stringify({schemaVersion: 2, projectId: "fna", updatePolicy: "manual", packages: packages.map(item => item.record || item)}))};
    }, verifySignatures: async () => {events.push("signature");}},
    downloadToFile: async (url, destination) => {
      const item = packages.find(item => item.record?.asset.url === url);assert.ok(item, "only the selected fixture archive may download");
      events.push("download:" + item.record.version);fs.copyFileSync(item.archive, destination);
    }
  }}});
}
function playFixture(t, f, runtime, version, events, approve = true) {
  const source = path.join(f.root, "Game");fs.mkdirSync(source);
  const assembly = writeAssembly(path.join(source, "Game.exe"));
  writeAssembly(path.join(source, "FNA.dll"), {name: "FNA", references: [], entryPoint: false});
  const entry = {gameId: "fixture-game", moduleId: "fna", gamePath: assembly, runtimeData: {fna: {version}}};
  const settings = {runtimes: {fna: {defaultVersion: version}}};
  t.mock.method(Manager, "resolveSelection", (...args) => runtime.resolveSelection(...args));
  t.mock.method(Manager, "getState", (...args) => runtime.getState(...args));
  const mod = {...Fna, runtimeManagers: [runtime]};
  const context = {runtimeId: "fna", userDataDir: f.userDataDir, settings, confirmRuntimeInstall: async () => {events.push("consent");return approve;}};
  return {entry, settings, prepare: () => prepareForLaunch({entry, mod, info: Fna.manifest, context,
    registry: {listModuleIds: () => ["fna"], getModule: () => mod},
    runAction: () => assert.fail("No game process or action should run"),
    install: async (manager, options) => {events.push("install:" + options.version);return manager.installRuntime({...options, userDataDir: f.userDataDir});}})};
}

test("FNA requires the actual profile capability while keeping profile integrity checks", t => {
  const f = fixture(t), root = path.join(f.root, "runtime");runtimeFiles(root);
  const install = {executablePath: path.join(root, "dotnet")};
  assert.throws(() => Profile.requireOriginalGamePaths(Profile.verifyRuntime(install)), {code: "FNA_RUNTIME_UPDATE_REQUIRED"});
  for (const value of [false, "true", 1, null]) {
    runtimeFiles(root, {originalGamePaths: value});
    assert.throws(() => Profile.requireOriginalGamePaths(Profile.verifyRuntime(install)), {code: "FNA_RUNTIME_UPDATE_REQUIRED"});
  }
  runtimeFiles(root, {originalGamePaths: true});
  assert.equal(Profile.requireOriginalGamePaths(Profile.verifyRuntime(install)).capabilities.originalGamePaths, true);
  fs.writeFileSync(path.join(root, "FNA.dll"), "changed bytes");assert.throws(() => Profile.verifyRuntime(install), /integrity/);
});

test("FNA installed old hosts resolve unready and capable local hosts remain usable offline", t => {
  const f = fixture(t), events = [], runtime = createRuntime(f, [], events);
  register(runtime, f, "1.0.0");
  const requested = {runtimeData: {fna: {version: "1.0.0"}}}, saved = {runtimes: {fna: {defaultVersion: "1.0.0"}}};
  const pending = runtime.resolveSelection(requested, saved, f.userDataDir);
  assert.equal(pending.ready, false);assert.equal(pending.version, null);assert.equal(pending.discoveryRequired, true);
  assert.equal(pending.requestedVersion, "1.0.0");assert.equal(runtime.getState({userDataDir: f.userDataDir}).installed[0].ready, false);
  register(runtime, f, "2.0.0", {originalGamePaths: true});
  const selected = runtime.resolveSelection(requested, saved, f.userDataDir);
  assert.equal(selected.version, "2.0.0");assert.equal(selected.ready, true);assert.equal(selected.requestedVersion, "1.0.0");
  assert.deepEqual(requested.runtimeData, {fna: {version: "1.0.0"}});assert.equal(saved.runtimes.fna.defaultVersion, "1.0.0");
  assert.deepEqual(events, []);
});

test("consented FNA Play discovers and installs a capable future package then reuses it offline", async t => {
  const f = fixture(t), events = [], current = packageArchive(f, "2.0.0", {originalGamePaths: true});
  const runtime = createRuntime(f, [packageRecord("1.0.0"), current], events);
  const old = register(runtime, f, "1.0.0"), oldReceipt = fs.readFileSync(path.join(old.installDir, "runtime.json"));
  const play = playFixture(t, f, runtime, "1.0.0", events), snapshot = JSON.stringify([play.entry, play.settings]);
  assert.equal(await play.prepare(), true);
  assert.equal(events[0], "consent");assert.equal(events.filter(event => event === "catalog").length, 1);
  assert.deepEqual(events.filter(event => event.startsWith("install:") || event.startsWith("download:")), ["install:2.0.0", "download:2.0.0"]);
  const selected = runtime.resolveSelection(play.entry, play.settings, f.userDataDir);
  assert.equal(selected.ready, true);assert.equal(selected.version, "2.0.0");assert.equal(selected.profile.capabilities.originalGamePaths, true);
  assert.deepEqual(fs.readFileSync(path.join(old.installDir, "runtime.json")), oldReceipt);
  assert.equal(JSON.stringify([play.entry, play.settings]), snapshot);
  events.length = 0;assert.equal(await play.prepare(), true);assert.deepEqual(events, []);
});

test("declining FNA runtime replacement performs no discovery or installation", async t => {
  const f = fixture(t), events = [], runtime = createRuntime(f, [packageRecord("2.0.0", {originalGamePaths: true})], events);
  register(runtime, f, "1.0.0");const play = playFixture(t, f, runtime, "1.0.0", events, false);
  assert.equal(await play.prepare(), false);assert.deepEqual(events, ["consent"]);
});

test("a refreshed incapable FNA catalog never reinstalls the old host", async t => {
  const f = fixture(t), events = [], runtime = createRuntime(f, [packageRecord("1.0.0")], events);
  register(runtime, f, "1.0.0");const play = playFixture(t, f, runtime, "1.0.0", events);
  await assert.rejects(play.prepare(), /No FNA native host versions are available/);
  assert.deepEqual(events, ["consent", "catalog"]);
  assert.equal(runtime.resolveSelection(play.entry, play.settings, f.userDataDir).ready, false);
});

test("catalog feature claims do not override an installed FNA profile missing the capability", async t => {
  const f = fixture(t), events = [], runtime = createRuntime(f, [packageRecord("1.0.0", {originalGamePaths: true})], events);
  register(runtime, f, "1.0.0");await runtime.refreshCatalog({userDataDir: f.userDataDir});
  assert.equal(events.filter(event => event === "catalog").length, 1);
  assert.equal(runtime.core.listDiscoveredCatalog({userDataDir: f.userDataDir})[0].projectPackage.capabilities.originalGamePaths, true);
  events.length = 0;
  const selected = runtime.resolveSelection({runtimeData: {fna: {version: "1.0.0"}}}, {}, f.userDataDir);
  assert.equal(selected.ready, false);assert.equal(selected.version, null);assert.equal(selected.discoveryRequired, true);
  assert.deepEqual(events, []);
});

test('FNA verifies expanded runtime profiles above 128 files', t => {
  const f = fixture(t), root = path.join(f.root, 'runtime'), profile = runtimeFiles(root, {originalGamePaths: true});
  for (let i=0; i<130; i++) { const name = 'extra-' + i + '.dll'; fs.writeFileSync(path.join(root,name),'assembly'); profile.files[name]=digest('assembly'); }
  fs.writeFileSync(path.join(root,'fna-runtime.json'),JSON.stringify(profile));
  assert.equal(Object.keys(Profile.verifyRuntime({executablePath:path.join(root,'dotnet')}).files).length,140);
  assert.equal(Object.keys(Profile.verifyRuntime({source:'download',executablePath:path.join(root,'dotnet')}).files).length,140);
  fs.writeFileSync(path.join(root,'extra-129.dll'),'modified');
  assert.throws(()=>Profile.verifyRuntime({executablePath:path.join(root,'dotnet')}),/integrity/);
});

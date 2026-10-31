// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Catalog = require("../src/modules/unity/runtime/catalog");
const Package = require("../src/modules/unity/runtime/package");
const Launch = require("../src/modules/unity/launch");
const Native = require("../src/modules/shared/runtime/local-native");
const { createManager } = require("../src/modules/unity/runtime/manager").__test;
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");
const { readRuntimeCatalog } = require("../src/modules/shared/runtime/runtime-catalog");
const { prepareForLaunch } = require("../src/core/runtime-preparation");
const Unity = require("../src/modules/unity/main");
const { game } = require("./helpers/unity-assets");
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-runtime-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function release(version = "2020.1.17f1", id = "mac-mono", { integrity } = {}) {
  const revision = version === "5.3.2p3" ? "b6c1a63227dc" : "9957aee8edc2";
  const md5 = version === "5.3.2p3" ? "90d81f8230257409b3ddbd8e347cc312" : "8d4a4a27d54b5ac6203bf353c2275954";
  return { version, shortRevision: revision, downloads: [{ platform: "LINUX", modules: [{ id, type: "PKG",
    url: `https://download.unity3d.com/download_unity/${revision}/MacEditorTargetInstaller/UnitySetup-Mac-${id === "mac" ? "" : "Mono-"}Support-for-Editor-${version}.pkg`,
    integrity: integrity || "md5-" + Buffer.from(md5).toString("base64"), downloadSize: { value: 142522361, unit: "BYTE" } }] }] };
}
// Unity's API answers each query; `answer` receives its parameters.
function api(t, answer) {
  Harness.network.routes = { [Catalog.API]: url => answer(new URL(url).searchParams) };
  t.after(() => { Harness.network.routes = null; });
}
const lookups = () => Harness.network.requests.filter(url => url.startsWith(Catalog.API)).length;
const page = (results, extra = {}) => ({ total: results.length, results, ...extra });

test("Unity reads the publisher's digest in both of its representations and only from its own hosts", async t => {
  const md5 = "8d4a4a27d54b5ac6203bf353c2275954";
  const forged = release("2020.1.20f1"); forged.downloads[0].modules[0].url = forged.downloads[0].modules[0].url.replace("download.unity3d.com", "untrusted.example");
  api(t, () => page([release("2020.1.18f1"), release("2020.1.19f1", "mac-mono", { integrity: "md5-" + Buffer.from(md5, "hex").toString("base64") }),
    release("5.3.2p3", "mac"), forged]));
  const rows = await Catalog.source.discover();
  const row = version => rows.find(item => item.version === version);
  assert.equal(row("2020.1.18f1").revision, "9957aee8edc2");
  assert.deepEqual(row("2020.1.18f1").files[0].digest, { algorithm: "md5", value: md5 });
  assert.deepEqual(row("2020.1.19f1").files[0].digest, { algorithm: "md5", value: md5 });
  assert.equal(row("2020.1.18f1").files[0].bytes, 142522361);
  assert.equal(row("5.3.2p3").files[0].name, "UnitySetup-Mac-Support-for-Editor-5.3.2p3.pkg");
  assert.deepEqual(row("2020.1.20f1").files, []);
});
test("Unity history is bounded while exact older game versions retain a separate lookup", async t => {
  const userDataDir = temporary(t), manager = createManager(), before = lookups();
  api(t, query => {
    if (query.get("version")) { assert.equal(query.get("version"), "5.3.2p3"); return page([release("5.3.2p3", "mac")]); }
    const offset = Number(query.get("offset"));
    assert.equal(query.get("limit"), "25"); assert.equal(query.get("order"), "RELEASE_DATE_DESC");
    return { total: 1582, offset, results: Array.from({ length: 25 }, (_, i) => release(`2020.1.${offset + i}f1`)) };
  });
  await manager.refreshCatalog({ userDataDir, force: true });
  assert.equal(lookups() - before, 20);
  const versions = manager.getState({ userDataDir }).catalog.versions;
  assert.equal(versions.length, 500); assert.equal(versions[0], "2020.1.499f1");
  assert.equal((await Catalog.discoverVersion("5.3.2p3")).revision, "b6c1a63227dc");
});
test("Unity rejects invalid exact versions and cancelled lookups before requesting releases", async t => {
  api(t, () => assert.fail("Invalid queries must not reach the API"));
  const before = lookups();
  await assert.rejects(Catalog.discoverVersion("2020.1"), /Invalid exact Unity version/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(Catalog.source.discover({ signal: controller.signal }), { name: "AbortError" });
  assert.equal(lookups(), before);
});
test("Unity validates API page identity and does not commit an internal-error empty page", async t => {
  for (const data of [{ total: 25, results: [] }, { total: 1, results: [release()], offset: 10 }, { total: -1, results: [] }, { results: [] }]) {
    api(t, () => data);
    await assert.rejects(Catalog.source.discover(), /metadata is invalid/);
  }
  // Extra results are cut at the page size, and a missing total is read as published.
  api(t, query => query.get("offset") === "0" ? { limit: 100, results: Array.from({ length: 30 }, (_, i) => release(`2020.1.${i}f1`)) } : { results: [] });
  assert.equal((await Catalog.source.discover()).length, 25);
  api(t, () => ({ status: 400, body: Buffer.from("{}") }));
  await assert.rejects(Catalog.source.discover(), /400/);
});
test("Unity exact release search paginates full-text matches and never substitutes a partial version", async t => {
  const offsets = [];
  api(t, query => {
    const offset = Number(query.get("offset")); offsets.push(offset);
    assert.equal(query.get("version"), "2020.1.18f1"); assert.equal(query.get("limit"), "25");
    const results = offset ? [release("2020.1.18f1")] : Array.from({ length: 25 }, (_, index) => release(`2020.1.${180 + index}f1`));
    return { total: 26, offset, limit: 25, results };
  });
  assert.equal((await Catalog.discoverVersion("2020.1.18f1")).version, "2020.1.18f1"); assert.deepEqual(offsets, [0, 25]);
  api(t, () => page([release("2020.1.180f1")]));
  await assert.rejects(Catalog.discoverVersion("2020.1.18f1"), /no published Mac Mono player component/);
});
test("Unity old installers carry the publisher's MD5 and no fixed checksum", async t => {
  const userDataDir = temporary(t), manager = createManager();
  api(t, () => page([release("5.3.2p3", "mac")]));
  const pin = await manager.ensureCatalogVersion({ userDataDir, version: "5.3.2p3" });
  assert.equal(pin.upstreamRevision, "b6c1a63227dc"); assert.equal(pin.asset.sha256, undefined);
  assert.deepEqual(pin.asset.digest, { algorithm: "md5", value: "90d81f8230257409b3ddbd8e347cc312" });
  assert.equal(pin.asset.bytes, 142522361);
});
test("Unity starts with an empty catalog and local state/default selection never queries releases", t => {
  const userDataDir = temporary(t), manager = createManager(), before = lookups();
  for (let index = 0; index < 3; index++) {
    const state = manager.getState({ userDataDir });
    assert.deepEqual(state.catalog.versions, []); assert.deepEqual(state.installed, []);
    assert.equal(state.catalog.status, "idle"); assert.equal(state.catalog.recommendedVersion ?? null, null);
    assert.equal(state.catalog.installable, false);
    const selection = manager.resolveSelection({ moduleData: { detectedVersion: "2020.1.17f1" } }, {}, userDataDir);
    assert.equal(selection.version, "2020.1.17f1"); assert.equal(selection.ready, false);
    assert.deepEqual(manager.applySettingsUpdate("setDefault", {}, {}), { defaultVersion: null }, "Empty preferences normalize without choosing a runtime");
  }
  assert.equal(lookups(), before);
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes", "unity", "catalog.json")), false);
});
test("Unity explicit Refresh stores actual releases, replaces old rows and restarts from the cache offline", async t => {
  const userDataDir = temporary(t), manager = createManager(); let calls = 0;
  api(t, query => { calls++; assert.equal(query.get("limit"), "25"); return page([release(calls === 1 ? "2020.1.18f1" : "2020.1.19f1")]); });
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []); assert.equal(calls, 0);
  await runRuntimeManagerAction({ manager, action: "refreshCatalog", userDataDir });
  assert.equal(calls, 1); assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["2020.1.18f1"]);
  assert.deepEqual(readRuntimeCatalog({ userDataDir, managerId: "unity" }).entries.map(entry => entry.version), ["2020.1.18f1"]);
  await runRuntimeManagerAction({ manager, action: "refreshCatalog", userDataDir });
  assert.equal(calls, 2); assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["2020.1.19f1"]);
  Harness.network.routes = null;
  const restarted = createManager();
  assert.deepEqual(restarted.getState({ userDataDir }).catalog.versions, ["2020.1.19f1"]);
  restarted.resolveSelection({ moduleData: { detectedVersion: "2020.1.19f1" } }, {}, userDataDir);
  assert.equal(calls, 2);
});
test("Unity exact-version acquisition is remembered offline without becoming a listed download", async t => {
  const userDataDir = temporary(t), manager = createManager(); let calls = 0;
  api(t, () => { calls++; return page([release("5.3.2p3", "mac")]); });
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []);
  const exact = await manager.ensureCatalogVersion({ userDataDir, version: "5.3.2p3" });
  assert.equal(calls, 1);
  // An exact lookup stays resolvable and offline, but is not a displayed download row.
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []);
  assert.ok(manager.core.catalog.some(pin => pin.version === "5.3.2p3"));
  Harness.network.routes = null;
  const restarted = createManager();
  assert.deepEqual((await restarted.ensureCatalogVersion({ userDataDir, version: "5.3.2p3" })).asset, exact.asset);
  assert.deepEqual(restarted.getState({ userDataDir }).catalog.versions, []);
  assert.equal(calls, 1);
});
test("Unity an explicit unresolved exact acquisition performs one lookup, without applying a newer default", async t => {
  const userDataDir = temporary(t), manager = createManager(); let calls = 0;
  api(t, query => { calls++; assert.equal(query.get("version"), "2020.1.18f1"); return page([release("2020.1.18f1")]); });
  manager.resolveSelection({ moduleData: { detectedVersion: "2020.1.18f1" } }, { defaultVersion: "6000.3.26f1" }, userDataDir);
  assert.equal(calls, 0);
  const exact = await manager.ensureCatalogVersion({ userDataDir, version: "2020.1.18f1" });
  assert.equal(exact.version, "2020.1.18f1"); assert.equal(calls, 1);
  assert.equal((await manager.ensureCatalogVersion({ userDataDir, version: "2020.1.18f1" })).version, exact.version);
  assert.equal(calls, 1);
  const mismatch = manager.resolveSelection({ moduleData: { detectedVersion: "2020.1.18f1" }, runtimeData: { unity: { version: "2020.1.19f1" } } }, {}, userDataDir);
  assert.equal(mismatch.ready, false); assert.match(mismatch.reason, /different player version/); assert.equal(calls, 1);
});
test("Unity Play plans the exact player and declining consent does not download or prepare a game", async t => {
  const root = temporary(t), original = path.join(root, "original"); fs.mkdirSync(original);
  const source = game(original, { linux: true, version: "5.3.2p3" }), before = Native.hashFile(path.join(source.data, "globalgamemanagers"));
  const entry = { gameId: "exact-player", moduleData: { dataRoot: source.data } }, consents = [];
  t.mock.method(Catalog, "discoverVersion", () => assert.fail("The exact release is looked up only after consent"));
  const result = await prepareForLaunch({ entry, mod: Unity, info: Unity.manifest,
    context: { runtimeId: "unity", userDataDir: path.join(root, "data"), settings: { runtimes: { unity: { defaultVersion: "6000.3.26f1" } } },
      confirmRuntimeInstall: async plan => { consents.push(plan); return false; } },
    registry: { listModuleIds: () => ["unity"], getModule: () => Unity },
    runAction: () => assert.fail("Declined Play must not prepare or launch"), install: () => assert.fail("Declined Play must not install") });
  assert.equal(result, false); assert.equal(consents.length, 1);
  assert.equal(consents[0].managerId, "unity"); assert.equal(consents[0].version, "5.3.2p3");
  assert.equal(consents[0].requiresDownload, true);
  assert.equal(Native.hashFile(path.join(source.data, "globalgamemanagers")), before);
});
test("Unity unsupported IL2CPP and Direct3D-only games fail before resolving any component", async t => {
  const root = temporary(t);
  t.mock.method(Unity.runtimeManagers[0], "ensureCatalogVersion", () => assert.fail("Unsupported games must not acquire release metadata"));
  for (const [name, options, error] of [["il2cpp", { il2cpp: true }, /IL2CPP compiled this game's code/], ["direct3d", { apis: [2, 18] }, /shaders only for Direct3D 11 and Direct3D 12/]]) {
    const original = path.join(root, name); fs.mkdirSync(original); const source = game(original, options);
    await assert.rejects(Unity.ensureRuntime({ moduleData: { dataRoot: source.data } }, {
      runtimeId: "unity", userDataDir: path.join(root, "data"), settings: {}
    }), error);
  }
});
function signature(identity, fingerprint) {
  return `Status: signed by a developer certificate issued by Apple for distribution\nSigned with a trusted timestamp on: 2016-02-09 22:06:26 +0000\nCertificate Chain:\n 1. Developer ID Installer: ${identity}\n SHA256 Fingerprint:\n ${fingerprint.match(/../g).join(" ")}\n 2. Developer ID Certification Authority\n 3. Apple Root CA\n`;
}
test("Unity installers are accepted by Unity's Developer ID signature, with or without the team identifier", async () => {
  const fingerprint = "b5b1c5b631c1d95d089ac28b8a8a899fdeacf730c562c10d54954680f7c2369e";
  for (const identity of ["Unity Technologies ApS", "Unity Technologies ApS (BVPN9UFA9B)", "Unity Technologies SF", "Unity Technologies SF (9QW8UQUTAA)"]) {
    const result = await Package.verifyArtifact({ archivePath: "/native.pkg", archiveSha256: "a".repeat(64) }, { run: async () => ({ stdout: signature(identity, fingerprint) }) });
    assert.equal(result.identity, identity); assert.equal(result.certificateSha256, fingerprint);
  }
  for (const identity of ["Another Company (ABCDE12345)", "Unity Technologies SF (ABCDE12345)", "Unity Technologies SFX"]) {
    await assert.rejects(Package.verifyArtifact({ archivePath: "/native.pkg" }, { run: async () => ({ stdout: signature(identity, fingerprint) }) }),
      /not a trusted Unity Technologies package/);
  }
  await assert.rejects(Package.verifyArtifact({ archivePath: "/native.pkg" }, { run: async () => ({ stdout: signature("Unity Technologies ApS", fingerprint).replace("Apple Root CA", "Other Root") }) }),
    /not a trusted Unity Technologies package/);
});
test("native engine identity rejects mismatched versions rather than trusting the installer filename", t => {
  const root = temporary(t), file = path.join(root, "UnityPlayer"), bytes = Buffer.alloc(2048);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x01000007, 4); bytes.writeUInt32LE(2, 12);
  bytes.write("5.3.2p3 (b6c1a63227dc)\0", 128); fs.writeFileSync(file, bytes);
  assert.deepEqual(Package.engineIdentity(file), { version: "5.3.2p3", revision: "b6c1a63227dc" });
  bytes.write("2020.1.17f1 (9957aee8edc2)\0", 512); fs.writeFileSync(file, bytes);
  assert.throws(() => Package.engineIdentity(file), /one exact editor version/);
});
test("legacy player staging supplies native Mono configuration while linking original game assets", async t => {
  const root = temporary(t), original = path.join(root, "original"), template = path.join(root, "player", "UnityPlayer.app"), userDataDir = path.join(root, "data");
  fs.mkdirSync(original); const source = game(original, { linux: true, version: "5.3.2p3" });
  const contents = path.join(template, "Contents");
  for (const directory of ["MacOS", "Resources", "Frameworks", "Data/Managed/etc/mono"]) fs.mkdirSync(path.join(contents, directory), { recursive: true });
  fs.writeFileSync(path.join(contents, "MacOS", "UnityPlayer"), "native-player");
  fs.writeFileSync(path.join(contents, "Resources", "unity default resources"), "native-shaders");
  fs.writeFileSync(path.join(contents, "Data", "Managed", "etc", "mono", "config"), "native-config");
  fs.writeFileSync(path.join(contents, "Info.plist"), "replaced privately");
  const before = Native.hashFile(path.join(source.data, "globalgamemanagers")), originalManaged = Native.hashFile(path.join(source.data, "Managed", "Assembly-CSharp.dll"));
  const entry = { gameId: "linux-unity", name: "Story", moduleData: { dataRoot: source.data } };
  const selection = { ready: true, version: "5.3.2p3", install: { upstreamRevision: "b6c1a63227dc", archiveSha256: "a".repeat(64) },
    profile: { templatePath: template, playerLayout: "fused-mono", dataDirectory: "Data" } };
  const run = async (command, args) => { assert.equal(command, "/usr/bin/codesign"); assert.equal(args.includes("--deep"), false); };
  const prepared = await Launch.prepareLaunch(entry, { userDataDir }, selection, { run });
  const data = path.join(prepared.appPath, "Contents", "Data");
  assert(fs.lstatSync(path.join(data, "globalgamemanagers")).isSymbolicLink());
  assert(fs.lstatSync(path.join(data, "Managed", "Assembly-CSharp.dll")).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(data, "Managed", "etc", "mono", "config"), "utf8"), "native-config");
  assert.equal(fs.readFileSync(path.join(contents, "Info.plist"), "utf8"), "replaced privately");
  assert.equal(Native.hashFile(path.join(source.data, "globalgamemanagers")), before); assert.equal(Native.hashFile(path.join(source.data, "Managed", "Assembly-CSharp.dll")), originalManaged);
});

test("player template selection follows each naming scheme and the player's own CPU", t => {
  const root = temporary(t);
  const slices = new Map();
  function variations(name, templates) {
    const directory = path.join(root, name);
    for (const [template, architectures] of Object.entries(templates)) {
      const executable = path.join(directory, template, "UnityPlayer.app", "Contents", "MacOS", "UnityPlayer");
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, "");
      slices.set(executable, architectures);
    }
    fs.mkdirSync(path.join(directory, "macos_arm64_il2cpp_nondevelopment_mono_unused"), { recursive: true });
    return directory;
  }
  const readArchitectures = file => slices.get(file) || [];
  const select = (directory, version, arch) => Package.selectPlayerTemplate(directory, { version, arch, readArchitectures }).name;

  const legacy = variations("2019", { macosx64_nondevelopment_mono: ["x86_64"], macosx64_development_mono: ["x86_64"] });
  assert.equal(select(legacy, "2019.4.41f2", "arm64"), "macosx64_nondevelopment_mono");
  assert.equal(select(legacy, "2019.4.41f2", "x64"), "macosx64_nondevelopment_mono");

  const current = variations("2022", { macos_arm64_player_nondevelopment_mono: ["arm64"], macos_x64_player_nondevelopment_mono: ["x86_64"],
    macos_x64arm64_player_nondevelopment_mono: ["x86_64", "arm64"], macos_arm64_player_development_mono: ["arm64"] });
  assert.equal(select(current, "2022.3.62f3", "arm64"), "macos_arm64_player_nondevelopment_mono");
  assert.equal(select(current, "2022.3.62f3", "x64"), "macos_x64_player_nondevelopment_mono");

  const transitional = variations("2020", { macos_x64arm64_nondevelopment_mono: ["x86_64", "arm64"], macos_x64_nondevelopment_mono: ["x86_64"] });
  assert.equal(select(transitional, "2020.2.8f1", "arm64"), "macos_x64arm64_nondevelopment_mono");

  const renamed = variations("future", { mac_universal_runtime_nondevelopment_mono: ["x86_64", "arm64"], mac_universal_runtime_development_mono: ["x86_64", "arm64"] });
  assert.equal(select(renamed, "7000.1.0f1", "x64"), "mac_universal_runtime_nondevelopment_mono");

  const contentOnly = variations("renamed", { desktop_release: ["arm64"] });
  const monoLibrary = path.join(contentOnly, "desktop_release", "UnityPlayer.app", "Contents", "Frameworks", "MonoEmbedRuntime", "osx", "libmono.0.dylib");
  fs.mkdirSync(path.dirname(monoLibrary), { recursive: true });fs.writeFileSync(monoLibrary, "mono");
  assert.equal(select(contentOnly, "7000.2.0f1", "arm64"), "desktop_release");

  const armOnly = variations("arm", { macos_arm64_player_nondevelopment_mono: ["arm64"] });
  assert.throws(() => select(armOnly, "6000.6.7f1", "x64"), /Unity 6000\.6\.7f1 has no nondevelopment Mono player template for this Mac/);
  const ambiguous = variations("ambiguous", { macos_arm64_nondevelopment_mono: ["arm64"], macos_arm64_player_nondevelopment_mono: ["arm64"] });
  assert.throws(() => select(ambiguous, "2021.3.45f2", "arm64"), /Unity 2021\.3\.45f2 has more than one/);
});

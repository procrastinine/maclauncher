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
function release(version = "2020.1.17f1", id = "mac-mono") {
  const revision = version === "5.3.2p3" ? "b6c1a63227dc" : "9957aee8edc2";
  const md5 = version === "5.3.2p3" ? "90d81f8230257409b3ddbd8e347cc312" : "8d4a4a27d54b5ac6203bf353c2275954";
  return { version, shortRevision: revision, downloads: [{ platform: "LINUX", modules: [{ id, type: "PKG",
    url: `https://download.unity3d.com/download_unity/${revision}/MacEditorTargetInstaller/UnitySetup-Mac-${id === "mac" ? "" : "Mono-"}Support-for-Editor-${version}.pkg`,
    integrity: "md5-" + Buffer.from(md5).toString("base64"), downloadSize: { value: 142522361, unit: "BYTE" } }] }] };
}
test("Unity preserves exact component identities and old/new publisher digest representations", () => {
  const md5 = "8d4a4a27d54b5ac6203bf353c2275954";
  assert.deepEqual(Catalog.parseIntegrity("md5-" + Buffer.from(md5).toString("base64")), { algorithm: "md5", digest: md5 });
  assert.deepEqual(Catalog.parseIntegrity("md5-" + Buffer.from(md5, "hex").toString("base64")), { algorithm: "md5", digest: md5 });
  assert.equal(Catalog.parseIntegrity("sha1-invalid"), null); assert.equal(Catalog.parseIntegrity("md5-Zm9v"), null);
  const entry = Catalog.releaseEntry(release("2020.1.18f1"));
  assert.equal(entry.version, "2020.1.18f1"); assert.equal(entry.upstreamRevision, "9957aee8edc2");
  assert.equal(entry.asset.integrity, "publisher-md5"); assert.equal(entry.asset.md5, md5);
  assert.equal(Catalog.releaseEntry(release("5.3.2p3", "mac")).asset.filename, "UnitySetup-Mac-Support-for-Editor-5.3.2p3.pkg");
  const forged = release(); forged.downloads[0].modules[0].url = forged.downloads[0].modules[0].url.replace("download.unity3d.com", "untrusted.example");
  assert.equal(Catalog.releaseEntry(forged), null);
});
test("Unity history is bounded while exact older game versions retain a separate lookup", async () => {
  let calls = 0;
  const fetch = async url => {
    calls++; const query = new URL(url).searchParams, offset = Number(query.get("offset"));
    assert.equal(query.get("limit"), "25"); assert.equal(query.get("order"), "RELEASE_DATE_DESC");
    const results = Array.from({ length: 25 }, (_, i) => release(`2020.1.${offset + i}f1`));
    return { status: 200, body: Buffer.from(JSON.stringify({ total: 1582, results })) };
  };
  const catalog = await Catalog.discoverCatalog({ fetch });
  assert.equal(calls, 20); assert.equal(catalog.length, 500); assert.equal(catalog[0].version, "2020.1.499f1");
  const exact = await Catalog.discoverVersion("5.3.2p3", { fetch: async url => {
    assert.equal(new URL(url).searchParams.get("version"), "5.3.2p3");
    return { status: 200, body: Buffer.from(JSON.stringify({ total: 1, results: [release("5.3.2p3", "mac")] })) };
  } });
  assert.equal(exact.upstreamRevision, "b6c1a63227dc");
});
test("Unity rejects invalid API pagination and cancelled lookups before requesting releases", async () => {
  let calls = 0;
  const fetch = async () => { calls++; assert.fail("Invalid queries must not reach the API"); };
  for (const options of [{ limit: 100 }, { limit: 0 }, { limit: 2.5 }, { offset: -1 }, { offset: NaN }, { version: "2020.1" }]) {
    await assert.rejects(Catalog.releasePage({ ...options, fetch }), /pagination|exact Unity version/);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(Catalog.releasePage({ fetch, signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
});
test("Unity validates API page identity and does not commit an internal-error empty page", async () => {
  for (const data of [{ total: 25, results: [] }, { total: 1, results: [release()], offset: 10 },
    { total: 1, results: [release()], limit: 100 }, { total: -1, results: [] }]) {
    await assert.rejects(Catalog.releasePage({ fetch: async () => ({ status: 200, body: Buffer.from(JSON.stringify(data)) }) }), /metadata is invalid/);
  }
  await assert.rejects(Catalog.releasePage({ fetch: async () => ({ status: 400, body: Buffer.from("{}") }) }), /HTTP 400/);
});
test("Unity exact release search paginates full-text matches and never substitutes a partial version", async () => {
  const offsets = [];
  const exact = await Catalog.discoverVersion("2020.1.18f1", { fetch: async url => {
    const query = new URL(url).searchParams, offset = Number(query.get("offset")); offsets.push(offset);
    assert.equal(query.get("version"), "2020.1.18f1"); assert.equal(query.get("limit"), "25");
    const results = offset ? [release("2020.1.18f1")] : Array.from({ length: 25 }, (_, index) => release(`2020.1.${180 + index}f1`));
    return { status: 200, body: Buffer.from(JSON.stringify({ total: 26, offset, limit: 25, results })) };
  } });
  assert.equal(exact.version, "2020.1.18f1"); assert.deepEqual(offsets, [0, 25]);
  await assert.rejects(Catalog.discoverVersion("2020.1.18f1", { fetch: async () => ({ status: 200,
    body: Buffer.from(JSON.stringify({ total: 1, results: [release("2020.1.180f1")] })) }) }), /no published, verifiable/);
});
test("Unity remote metadata retains legacy verification only for an exact component identity", () => {
  for (const pin of Catalog.REVIEWED) {
    const found = Catalog.releaseEntry(release(pin.version, pin.version === "5.3.2p3" ? "mac" : "mac-mono"));
    assert.equal(found.asset.sha256, pin.asset.sha256);
    assert.equal(found.asset.publisherIdentity, pin.asset.publisherIdentity);
    assert.equal(found.asset.publisherCertificateSha256, pin.asset.publisherCertificateSha256);
  }
  const replaced = release("5.3.2p3", "mac");
  replaced.downloads[0].modules[0].integrity = "md5-" + Buffer.alloc(16, 1).toString("base64");
  assert.equal(Catalog.releaseEntry(replaced).asset.sha256, undefined);
  assert.equal(Catalog.releaseEntry(replaced).asset.publisherCertificateSha256, undefined);
});
test("Unity starts with an empty catalog and local state/default selection never queries releases", t => {
  const userDataDir = temporary(t), manager = createManager({ dependencies: { fetch: () => assert.fail("Local state must stay offline") } });
  for (let index = 0; index < 3; index++) {
    const state = manager.getState({ userDataDir });
    assert.deepEqual(state.catalog.versions, []); assert.deepEqual(state.installed, []);
    assert.equal(state.catalog.status, "idle"); assert.equal(state.catalog.recommendedVersion ?? null, null);
    assert.equal(state.catalog.installable, false);
    const selection = manager.resolveSelection({ moduleData: { detectedVersion: "2020.1.17f1" } }, {}, userDataDir);
    assert.equal(selection.version, "2020.1.17f1"); assert.equal(selection.ready, false);
    assert.deepEqual(manager.applySettingsUpdate("setDefault", {}, {}), { defaultVersion: null });
  }
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes", "unity", "catalog.json")), false);
});
test("Unity explicit Refresh stores actual releases, replaces old rows and restarts from the cache offline", async t => {
  const userDataDir = temporary(t); let calls = 0;
  const manager = createManager({ dependencies: { fetch: async url => {
    calls++; const query = new URL(url).searchParams; assert.equal(query.get("limit"), "25");
    return { status: 200, body: Buffer.from(JSON.stringify({ total: 1, results: [release(calls === 1 ? "2020.1.18f1" : "2020.1.19f1")] })) };
  } } });
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []); assert.equal(calls, 0);
  await runRuntimeManagerAction({ manager, action: "refreshCatalog", userDataDir });
  assert.equal(calls, 1); assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["2020.1.18f1"]);
  assert.deepEqual(readRuntimeCatalog({ userDataDir, managerId: "unity" }).entries.map(entry => entry.version), ["2020.1.18f1"]);
  await runRuntimeManagerAction({ manager, action: "refreshCatalog", userDataDir });
  assert.equal(calls, 2); assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["2020.1.19f1"]);
  const restarted = createManager({ dependencies: { fetch: () => assert.fail("Cached state must stay offline") } });
  assert.deepEqual(restarted.getState({ userDataDir }).catalog.versions, ["2020.1.19f1"]);
  restarted.resolveSelection({ moduleData: { detectedVersion: "2020.1.19f1" } }, {}, userDataDir);
  assert.equal(calls, 2);
});
test("Unity explicit exact-version acquisition retains verified older components without seeding other versions", async t => {
  const userDataDir = temporary(t), manager = createManager({ dependencies: { fetch: () => assert.fail("The verified legacy component needs no release lookup") } });
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []);
  const exact = await manager.ensureCatalogVersion({ userDataDir, version: "5.3.2p3" });
  assert.equal(exact.asset.sha256, Catalog.REVIEWED[1].asset.sha256);
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["5.3.2p3"]);
  const restarted = createManager({ dependencies: { fetch: () => assert.fail("Exact cached releases must stay offline") } });
  assert.equal((await restarted.ensureCatalogVersion({ userDataDir, version: "5.3.2p3" })).asset.sha256, exact.asset.sha256);
  assert.deepEqual(restarted.getState({ userDataDir }).catalog.versions, ["5.3.2p3"]);
});
test("Unity an explicit unresolved exact acquisition performs one lookup, without applying a newer default", async t => {
  const userDataDir = temporary(t); let calls = 0;
  const manager = createManager({ dependencies: { fetch: async url => {
    calls++; assert.equal(new URL(url).searchParams.get("version"), "2020.1.18f1");
    return { status: 200, body: Buffer.from(JSON.stringify({ total: 1, results: [release("2020.1.18f1")] })) };
  } } });
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
  t.mock.method(Catalog, "discoverVersion", () => assert.fail("Known exact player metadata is available offline"));
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
  for (const [name, options, error] of [["il2cpp", { il2cpp: true }, /IL2CPP code needs a native port/], ["direct3d", { apis: [2, 18] }, /Direct3D shaders/]]) {
    const original = path.join(root, name); fs.mkdirSync(original); const source = game(original, options);
    await assert.rejects(Unity.ensureRuntime({ moduleData: { dataRoot: source.data } }, {
      runtimeId: "unity", userDataDir: path.join(root, "data"), settings: {}
    }), error);
  }
});
function signature(identity, fingerprint) {
  return `Status: signed by a developer certificate issued by Apple for distribution\nSigned with a trusted timestamp on: 2016-02-09 22:06:26 +0000\nCertificate Chain:\n 1. Developer ID Installer: ${identity}\n SHA256 Fingerprint:\n ${fingerprint.match(/../g).join(" ")}\n 2. Developer ID Certification Authority\n 3. Apple Root CA\n`;
}
test("old Unity packages require the release's pinned signing certificate", async () => {
  const pin = Catalog.REVIEWED.find(entry => entry.version === "5.3.2p3"), expected = pin.asset.publisherCertificateSha256;
  const result = await Package.verifyArtifact({ archivePath: "/native.pkg", archiveSha256: pin.asset.sha256, pin },
    { run: async () => ({ stdout: signature(pin.asset.publisherIdentity, expected) }) });
  assert.equal(result.certificateSha256, expected); assert.equal(result.identity, "Unity Technologies ApS");
  await assert.rejects(Package.verifyArtifact({ archivePath: "/native.pkg", archiveSha256: pin.asset.sha256, pin },
    { run: async () => ({ stdout: signature(pin.asset.publisherIdentity, "a".repeat(64)) }) }), /signing certificate does not match this release/);
  await assert.rejects(Package.verifyArtifact({ archivePath: "/native.pkg", archiveSha256: pin.asset.sha256, pin: { asset: { publisherIdentity: "Unity Technologies ApS" } } },
    { run: async () => ({ stdout: signature("Unity Technologies ApS", expected) }) }), /signing certificate does not match this release/);
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

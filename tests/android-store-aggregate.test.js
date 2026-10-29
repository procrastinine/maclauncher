const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createAndroidStoreDownloads } = require("../src/modules/android/store/aggregate");
const { createRepositoryDownloads, normalizeRepositoryPackage, parseSourceQuery, parseIzzySearch } = require("../src/modules/android/store/repositories");
const hash = crypto.createHash("sha256").update("APK fixture").digest("hex"), otherHash = "e".repeat(64), packageId = "org.example.game";
const item = { metadata: { name: { "en-US": "Example game" }, license: "GPL-3.0-only" }, versions: {
  [hash]: { file: { name: `/${packageId}_31.apk`, sha256: hash, size: 11 }, manifest: { versionCode: 31, versionName: "3.1", nativecode: ["armeabi-v7a"], usesSdk: { minSdkVersion: 23, targetSdkVersion: 34 } } },
  [otherHash]: { file: { name: `/${packageId}_32.apk`, sha256: otherHash, size: 11 }, manifest: { versionCode: 32, versionName: "3.2", nativecode: ["arm64-v8a"], usesSdk: { minSdkVersion: 29 } } }
} };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function until(check) { for (let n = 0; n < 300; n++) { const result = check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error("Timed out"); }
function mockProvider(search, connected = true) { return { snapshot: () => ({ connection: { status: connected ? "connected" : "disconnected" }, library: [], downloads: [] }), search, getVersions: value => ({ appId: value }), download: value => value, cancel() {}, markImported() {}, connect() {}, disconnect() {}, forgetSession() {}, openLogin() {}, submitAuth() {}, loadLibrary() {}, addToLibrary() {}, async dispose() {} }; }
test("Android search streams a fast repository while Google is pending and a failed source stays isolated", async t => {
  const google = deferred(), izzy = deferred(), events = [];
  const service = createAndroidStoreDownloads({ userDataDir: "/fixture", onChange: state => events.push(state), createGooglePlayDownloads: () => mockProvider(() => google.promise),
    createRepositoryDownloads: ({ source }) => mockProvider(() => source === "fdroid" ? Promise.resolve([{ appId: `fdroid:${packageId}`, name: "Example" }]) : izzy.promise) }); t.after(() => service.dispose());
  const final = service.search("example game", { requestId: "stream-one" });
  const early = await until(() => events.find(state => state.search?.sources.find(source => source.id === "fdroid")?.status === "completed"));
  assert.equal(early.search.loading, true); assert.equal(early.search.results[0].source, "fdroid"); assert.equal(early.search.sources.find(source => source.id === "google-play").status, "loading");
  izzy.resolve([{ appId: `izzy:${packageId}`, name: "Another edition" }]); google.reject(Error("network failed"));
  const rows = await final; assert.equal(rows.length, 2); assert.equal(service.snapshot().search.loading, false); assert.equal(service.snapshot().search.sources.find(source => source.id === "google-play").status, "error");
});
test("source-qualified searches stay isolated, plain package IDs use Google only, and stale queries never publish", async t => {
  const pending = deferred(), calls = [], events = [];
  const service = createAndroidStoreDownloads({ userDataDir: "/fixture", onChange: state => events.push(state), createGooglePlayDownloads: () => mockProvider((query, opts) => { calls.push(["google-play", query, opts.signal]); return query === "old query" ? pending.promise : Promise.resolve([{ appId: packageId, name: query }]); }),
    createRepositoryDownloads: ({ source }) => mockProvider(query => { calls.push([source, query]); return Promise.resolve([{ appId: `${source}:${packageId}`, name: query }]); }) }); t.after(() => service.dispose());
  const previous = service.search("old query", { requestId: "old" }); await until(() => calls.length === 3); await service.search("new query", { requestId: "new" }); pending.resolve([{ appId: "org.old.result", name: "Old" }]); await previous;
  assert.equal(calls[0][2].aborted, true); assert.equal(service.snapshot().search.requestId, "new"); assert.ok(service.snapshot().search.results.every(row => row.appId !== "org.old.result"));
  calls.length = 0; await service.search(packageId); assert.deepEqual(calls.map(row => row[0]), ["google-play"]);
  calls.length = 0; await service.search("example game", { sources: ["fdroid"] }); assert.deepEqual(calls.map(row => row[0]), ["fdroid"]);
  calls.length = 0; await service.search("example game", { sources: [] }); assert.deepEqual(calls, []);
  calls.length = 0; await service.search(`https://f-droid.org/en/packages/${packageId}/`); assert.deepEqual(calls.map(row => row[0]), ["fdroid"]);
  assert.equal(service.getVersions(`izzy:${packageId}`).appId, `izzy:${packageId}`);
});
test("FOSS sources remain usable while Google is disconnected", async t => {
  const service = createAndroidStoreDownloads({ userDataDir: "/fixture", createGooglePlayDownloads: () => mockProvider(() => assert.fail("No Google connection"), false), createRepositoryDownloads: ({ source }) => mockProvider(async () => [{ appId: `${source}:${packageId}`, name: "Free app" }]) }); t.after(() => service.dispose());
  const rows = await service.search("free app"); assert.equal(rows.length, 2); assert.equal(service.snapshot().search.sources.find(row => row.id === "google-play").status, "skipped");
});
test("repository metadata preserves exact APK identities, actual ABI variants and SDK requirements", () => {
  const versions = normalizeRepositoryPackage("fdroid", packageId, item, { architecture: "arm64", androidSdk: 25 });
  assert.equal(versions.available, false); assert.equal(versions.deviceProfiles.find(row => row.architecture === "armv7").available, true);
  assert.deepEqual(versions.architectures, ["arm64", "armv7"]); assert.equal(versions.branches[0].id, otherHash); assert.equal(versions.branches[1].minSdk, 23); assert.equal(versions.branches[0].versionCode, "32");
  assert.equal(parseSourceQuery(`izzy:${packageId}`).source, "izzy");
  const rows = parseIzzySearch(`<div class='approw'><img src='repo/org.example.game/en-US/icon.png'><span class='boldname'>Example &amp; Game</span><a href='index/apk/org.example.game'>Details</a></div>`);
  assert.equal(rows[0].appId, `izzy:${packageId}`); assert.equal(rows[0].name, "Example & Game");
});
test("repository index is hash checked once, parsed off the main thread and exact downloads preserve custom content", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repository-test-")); let transfers = 0, indexes = 0, duplicatePrompts = 0;
  const data = Buffer.from(JSON.stringify({ packages: { [packageId]: item } })), digest = crypto.createHash("sha256").update(data).digest("hex");
  const service = createRepositoryDownloads({ source: "fdroid", userDataDir: root, confirmDuplicate: async () => { duplicatePrompts++; return "use-existing"; },
    fetchData: async url => { if (url.endsWith("entry.json")) return Buffer.from(JSON.stringify({ index: { name: "/index-v2.json", size: data.length, sha256: digest } })); indexes++; return data; },
    readApkIdentity: () => ({ packageName: packageId, versionCode: "31", split: null }),
    downloadFile: async (_choice, output, { onBytes }) => { transfers++; fs.writeFileSync(output, "APK fixture"); onBytes(11); return { size: 11, sha256: hash }; } });
  t.after(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const versions = await service.getVersions(`fdroid:${packageId}`, { architecture: "armv7", androidSdk: 25 }); await service.getVersions(`fdroid:${packageId}`, { architecture: "arm64", androidSdk: 34 }); assert.equal(indexes, 1);
  async function finish(selection) { const job = service.download({ appId: `fdroid:${packageId}`, branch: hash, architecture: "armv7", androidSdk: 25, autoImport: false, ...selection }); return until(() => service.snapshot().downloads.find(row => row.id === job.id && ["completed", "error"].includes(row.status))); }
  const wrong = await finish({ architecture: "arm64" }); assert.equal(wrong.status, "error"); assert.equal(transfers, 0);
  const first = await finish({}); assert.equal(first.status, "completed", first.error); const metadata = JSON.parse(fs.readFileSync(path.join(first.path, ".maclauncher-external.json"))); assert.equal(metadata.store, "fdroid"); assert.equal(metadata.appId, packageId); assert.equal(metadata.sha256, hash);
  const duplicate = await finish({}); assert.equal(duplicate.reused, true); assert.equal(transfers, 1); assert.equal(duplicatePrompts, 1);
  const destination = path.join(root, "custom"); fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, "keep.txt"), "keep"); const custom = await finish({ destination }); assert.equal(custom.status, "completed", custom.error); assert.equal(transfers, 2); assert.equal(fs.readFileSync(path.join(destination, "keep.txt"), "utf8"), "keep");
});
test("a damaged installation index is kept beside it and a completed repository download is added", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repository-index-test-")), index = path.join(root, "external/installations.json");
  const data = Buffer.from(JSON.stringify({ packages: { [packageId]: item } })), digest = crypto.createHash("sha256").update(data).digest("hex");
  const service = createRepositoryDownloads({ source: "fdroid", userDataDir: root,
    fetchData: async url => url.endsWith("entry.json") ? Buffer.from(JSON.stringify({ index: { name: "/index-v2.json", size: data.length, sha256: digest } })) : data,
    readApkIdentity: () => ({ packageName: packageId, versionCode: "31", split: null }),
    downloadFile: async (_choice, output, { onBytes }) => { fs.writeFileSync(output, "APK fixture"); onBytes(11); return { size: 11, sha256: hash }; } });
  t.after(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const damaged = '[{"path": "/Games/Kept"}, {"path": "/Games/Trunc';fs.mkdirSync(path.dirname(index), { recursive: true });fs.writeFileSync(index, damaged);
  const job = service.download({ appId: `fdroid:${packageId}`, branch: hash, architecture: "armv7", androidSdk: 25, autoImport: false });
  const result = await until(() => service.snapshot().downloads.find(row => row.id === job.id && ["completed", "error"].includes(row.status)));
  assert.equal(result.status, "completed", result.error);
  const copies = fs.readdirSync(path.dirname(index)).filter(name => /^installations\.unreadable-.+\.json$/.test(name));
  assert.equal(copies.length, 1);assert.equal(fs.readFileSync(path.join(path.dirname(index), copies[0]), "utf8"), damaged);
  assert.deepEqual(JSON.parse(fs.readFileSync(index, "utf8")).map(row => row.path), [result.path]);
});

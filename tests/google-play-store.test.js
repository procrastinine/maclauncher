const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { field: f, message: m, fields, parseApp, parseApps, parseDelivery, createPlayProtocol, packageName, profile } = require("../src/modules/android/store/protocol");
const { createGooglePlayDownloads } = require("../src/modules/android/store/downloads");
const { parseManifestIdentity, readApkIdentity } = require("../src/modules/android/store/apk-identity");
const bytes = Buffer.from("APK transport fixture"), sha256 = crypto.createHash("sha256").update(bytes).digest("hex"), appId = "org.example.game";
const wrapped = (id, data) => m(f(1, m(f(id, data))));
const app = { appId, name: "Example game", platforms: ["android"], versionCode: "41", versionName: "1.4.1", priceMicros: "0", offerType: 1, splits: ["config.arm64_v8a"] };
function delivered(code = "41") { return { appId, versionCode: code, files: [{ filename: "base.apk", type: "base", url: "https://play.googleapis.com/base.apk", size: bytes.length, sha256 }, { filename: "split_config.arm64_v8a.apk", type: "split", url: "https://play.googleapis.com/split.apk", size: bytes.length, sha256 }, { filename: `Android/obb/${appId}/main.${code}.${appId}.obb`, type: "obb", url: "https://play.googleapis.com/game.obb", size: bytes.length, sha256 }] }; }
async function until(check) { for (let index = 0; index < 300; index++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error("Timed out waiting for Google Play state"); }
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "google-play-test-")), calls = [], saves = [], copies = [];
  const protocol = {
    async prepareDevice(args) { calls.push(["checkin", args.architecture, args.androidSdk ?? 34]); return { androidId: "abcdef0123456789", device: { architecture: args.architecture, locale: args.locale, sdk: args.androidSdk ?? 34 } }; },
    async authorize(session, registration) { calls.push(["authorize", session.email]); return { ...registration, authToken: "private-scoped-fixture", expiresAt: Date.now() + 1000000 }; },
    async library() { return { library: [{ ...app, owned: true }], truncated: false }; },
    async search(_auth, query) { calls.push(["search", query]); return [{ ...app, appId: "org.example.free", name: "Free game" }]; },
    async details(_auth, id) { return { ...app, appId: id }; },
    async delivery(_auth, _details, code) { calls.push(["delivery", code]); return delivered(code); }, ...extra.protocol
  };
  const service = createGooglePlayDownloads({ userDataDir: root, protocol, browserLogin: async ({ androidId }) => ({ email: "example@example.test", aasToken: "private-aas-fixture", androidId }),
    saveSession: async value => saves.push(structuredClone(value)), readApkIdentity: file => ({ packageName: appId, versionCode: "31", split: path.basename(file) === "base.apk" ? null : "config.arm64_v8a" }),
    downloadFile: async (item, output, { onBytes }) => { copies.push(item.filename); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, bytes); onBytes?.(bytes.length); return { size: bytes.length, sha256 }; }, ...extra, protocol });
  t.after(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); }); return { root, service, calls, saves, copies };
}
test("Google Play remains offline until explicit connection and search does not invent account ownership", async t => {
  const { service, calls, saves } = fixture(t); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, []);
  assert.equal(service.snapshot().connection.status, "disconnected"); await service.connect({ mode: "browser", remember: true });
  assert.equal(service.snapshot().connection.status, "connected"); assert.equal(service.snapshot().library[0].owned, true);
  const found = await service.search("free game"); assert.equal(found[0].owned, false); assert.equal(service.snapshot().library.length, 1);
  const versions = await service.getVersions(appId); assert.equal(versions.branches[0].versionCode, "41"); assert.equal(versions.supportsVersionCode, true);
  assert.ok(saves.some(value => value.aasToken === "private-aas-fixture")); assert.equal(JSON.stringify(service.snapshot()).includes("private-aas"), false);
  assert.equal(packageName(`https://play.google.com/store/apps/details?id=${appId}`), appId);
});
test("the default sign-in opens the browser and identifies its pending challenge", async t => {
  let complete;
  const { service } = fixture(t, { browserLogin: ({ androidId }) => new Promise(resolve => {
    complete = () => resolve({ email: "example@example.test", aasToken: "private-aas-fixture", androidId });
  }), microgLogin: async () => { throw Error("Provider sign-in must be selected explicitly"); } });
  const pending = service.connect();
  await until(() => complete);
  assert.equal(service.snapshot().connection.status, "connecting");
  assert.equal(service.snapshot().connection.mode, "browser");
  complete(); await pending;
  assert.equal(service.snapshot().connection.mode, "browser");
});
test("search containers with package-shaped IDs are skipped while every nested app remains discoverable", () => {
  const doc = (id, title) => m(f(1, id), f(3, 1), f(4, 3), f(5, title), f(8, m(f(1, 0), f(8, 1))), f(13, m(f(1, m(f(3, 41), f(4, "1.4.1"), f(14, id), f(17, m(f(4, "config.arm64_v8a"))))))));
  const cluster = m(f(1, "apps_mdp_search_results_cluster_com.fgol.HungrySharkEvolution"), f(3, 44), f(4, 3), f(5, "Recommended apps"), f(12, m(f(1, "cluster"))), f(11, doc("com.fgol.HungrySharkEvolution", "Hungry Shark Evolution")), f(11, doc("com.ubisoft.hungrysharkworld", "Hungry Shark World")));
  const rows = parseApps(wrapped(5, m(f(1, cluster))));
  assert.deepEqual(rows.map(row => row.appId), ["com.fgol.HungrySharkEvolution", "com.ubisoft.hungrysharkworld"]);
  assert.ok(rows.every(row => row.canAddToLibrary === true)); assert.deepEqual(rows[0].supportedArchitectures, ["arm64"]);
});
test("architecture and Android SDK are independent and unsupported profiles retain explicit historical requests", async t => {
  assert.equal(profile("armv7").sdk, 34); assert.equal(profile("x86").sdk, 34); assert.equal(profile("arm64", "en-US", 25).sdk, 25);
  const { service, calls } = fixture(t, { protocol: { async details(auth) { if (auth.device.sdk === 25) throw Object.assign(Error("Google Play does not serve this profile."), { playPublic: true, unavailable: true }); return app; } } });
  await service.connect({ mode: "browser" });
  const modern = await service.getVersions(appId, { architecture: "armv7", androidSdk: 34 });
  assert.equal(modern.available, true); assert.equal(modern.profile.androidSdk, 34); assert.deepEqual(modern.architectures, ["armv7"]);
  assert.equal(modern.deviceProfiles.find(row => row.architecture === "x86").available, null);
  const legacy = await service.getVersions(appId, { architecture: "armv7", androidSdk: 25 });
  assert.equal(legacy.available, false); assert.deepEqual(legacy.branches, []); assert.equal(legacy.supportsVersionCode, true); assert.match(legacy.unavailableReason, /does not serve/);
  assert.ok(calls.some(call => call[0] === "checkin" && call[1] === "armv7" && call[2] === 34)); assert.ok(calls.some(call => call[0] === "checkin" && call[1] === "armv7" && call[2] === 25));
  const job = service.download({ appId, versionCode: "31", architecture: "armv7", androidSdk: 25, autoImport: false });
  const result = await until(() => service.snapshot().downloads.find(row => row.id === job.id && ["completed", "error"].includes(row.status)));
  assert.equal(result.status, "completed", result.error); assert.match(result.versionId, /:sdk25:/); assert.equal(result.androidSdk, 25);
});
test("Add to library requires confirmed free pricing and server entitlement without fetching APK bytes", async t => {
  let acquisitions = 0;
  const { service, copies } = fixture(t, { protocol: {
    async details(_auth, id) { return { ...app, appId: id, priceMicros: id === "org.example.paid" ? "5000000" : id === "org.example.unknown" ? null : "0" }; },
    async acquire(_auth, detail) { acquisitions++; return { appId: detail.appId, licensed: true }; }
  } });
  await service.connect({ mode: "browser" });
  await assert.rejects(service.addToLibrary("org.example.paid"), /confirmed free/); await assert.rejects(service.addToLibrary("org.example.unknown"), /confirmed free/); assert.equal(acquisitions, 0);
  const updated = await service.addToLibrary("org.example.free"); assert.equal(acquisitions, 1); assert.equal(updated.library.find(row => row.appId === "org.example.free").owned, true); assert.deepEqual(copies, []);
  await service.loadLibrary({ refresh: true }); assert.ok(service.snapshot().library.some(row => row.appId === "org.example.free"), "confirmed free acquisition remains when purchase history omits free apps");
});
test("microG reuses a real scoped provider token, refreshes through its owner and persists only an account reference", async t => {
  let tokens = 0, browser = 0, operations = 0;
  const { service, saves } = fixture(t, { browserLogin: async () => { browser++; throw Error("Browser must not open"); },
    microgLogin: async ({ accountId }) => { assert.equal(accountId, "macapk:fixture"); tokens++; return { email: "provider@example.test", authToken: "provider-private-token", expirySeconds: 3600 }; },
    protocol: { async authorize(credentials, registration) { assert.equal(credentials.authToken, "provider-private-token"); assert.equal(credentials.aasToken, undefined); return { ...registration, authToken: credentials.authToken, expiresAt: Date.now() + 1000000 }; }, async details() { if (++operations === 1) throw Object.assign(Error("expired"), { authExpired: true }); return app; } } });
  await service.connect({ mode: "microg", accountId: "macapk:fixture" }); await service.getVersions(appId);
  assert.equal(browser, 0); assert.equal(tokens, 2); assert.ok(saves.length > 0);
  assert.ok(saves.every(saved => saved.mode === "microg" && saved.microgAccountId === "macapk:fixture"));
  assert.equal(JSON.stringify(saves).includes("provider-private-token"), false); assert.equal(JSON.stringify(saves).includes("private-aas"), false);
});
test("forgetSession clears browser credentials and cookies and makes saved-session reuse unavailable", async t => {
  const cleared = [], { service, saves } = fixture(t, { clearBrowserAccount: async accountId => cleared.push(accountId) });
  await service.connect({ mode: "browser", remember: true }); assert.equal(service.snapshot().hasSavedSession, true); const browserId = saves.at(-1).browserAccountId;
  const result = await service.forgetSession();
  assert.equal(result.hasSavedSession, false); assert.equal(result.connection.status, "disconnected"); assert.equal(result.library.length, 0);
  assert.equal(saves.at(-1), null); assert.deepEqual(cleared, [browserId]);
  await assert.rejects(service.connect({ mode: "reuse" }), /No saved Google account/);
});
test("choosing browser sign-in without remembering removes the earlier saved account and cookie partition", async t => {
  const cleared = [], { service, saves } = fixture(t, { clearBrowserAccount: async accountId => cleared.push(accountId) });
  await service.connect({ mode: "browser", remember: true }); const previousSaves = saves.length, browserId = saves.at(-1).browserAccountId;
  await service.connect({ mode: "browser", remember: false });
  assert.equal(service.snapshot().connection.status, "connected"); assert.equal(service.snapshot().hasSavedSession, false);
  assert.deepEqual(saves.slice(previousSaves), [null]); assert.deepEqual(cleared, [browserId]);
  assert.equal((await service.getVersions(appId)).appId, appId, "the current unsaved session remains usable");
});
test("forgetting a provider selection leaves the actual provider account and browser partitions untouched", async t => {
  let tokenRequests = 0; const cleared = [], { service, saves } = fixture(t, { clearBrowserAccount: async id => cleared.push(id),
    microgLogin: async () => { tokenRequests++; return { email: "provider@example.test", authToken: "private-provider-scope", expirySeconds: 3600 }; } });
  await service.connect({ mode: "microg", accountId: "macapk:fixture", remember: true }); await service.forgetSession();
  assert.equal(tokenRequests, 1); assert.deepEqual(cleared, []); assert.equal(saves.at(-1), null); assert.equal(service.snapshot().hasSavedSession, false);
  await assert.rejects(service.connect({ mode: "reuse" }), /No saved Google account/);
});
test("Google Play downloads exact historical versions and complete split plus OBB sets into independent custom folders", async t => {
  const { root, service, calls } = fixture(t); await service.connect({ mode: "browser" });
  const destination = path.join(root, "custom"); fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, "keep.txt"), "keep");
  const job = service.download({ appId, versionCode: "31", branch: "41", architecture: "arm64", destination, autoImport: false });
  const result = await until(() => service.snapshot().downloads.find(row => row.id === job.id && ["completed", "error"].includes(row.status)));
  assert.equal(result.status, "completed", result.error); assert.equal(result.versionName, "Version code 31"); assert.equal(result.buildId, "31");
  assert.equal(fs.readFileSync(path.join(destination, "keep.txt"), "utf8"), "keep"); assert.ok(result.importPath.endsWith("base.apk"));
  assert.equal(fs.existsSync(path.join(result.path, `Android/obb/${appId}/main.31.${appId}.obb`)), true);
  assert.deepEqual(calls.find(call => call[0] === "delivery"), ["delivery", "31"]);
  const metadata = JSON.parse(fs.readFileSync(path.join(result.path, ".maclauncher-external.json"))); assert.equal(metadata.files.length, 3); assert.equal(metadata.importPath, result.importPath);
});
test("Play duplicate reuse skips all delivery bytes and device preparation while APK-only choices keep required splits", async t => {
  let decisions = 0; const { service, copies, calls } = fixture(t, { confirmDuplicate: async () => { decisions++; return "use-existing"; } }); await service.connect({ mode: "browser" });
  async function finish(selection) { const job = service.download({ appId, versionCode: "31", autoImport: false, ...selection }); return until(() => service.snapshot().downloads.find(row => row.id === job.id && ["completed", "error"].includes(row.status))); }
  const first = await finish({}); assert.equal(first.status, "completed", first.error); const deliveredBefore = calls.filter(call => call[0] === "delivery").length;
  const second = await finish({}); assert.equal(second.reused, true); assert.equal(second.path, first.path); assert.equal(decisions, 1); assert.equal(copies.length, 3); assert.equal(calls.filter(call => call[0] === "delivery").length, deliveredBefore);
  const apkOnly = await finish({ includeExtras: false }); assert.equal(apkOnly.status, "completed", apkOnly.error); assert.notEqual(apkOnly.path, first.path); assert.equal(copies.length, 5); assert.ok(fs.existsSync(path.join(apkOnly.path, "split_config.arm64_v8a.apk")));
});
test("Google Play cancellation removes partial data before publishing cancelled", async t => {
  let started = false;
  const { service } = fixture(t, { downloadFile: async (_item, output, { signal }) => { fs.writeFileSync(output, "partial"); started = true; await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); } });
  await service.connect({ mode: "browser" }); const job = service.download({ appId, versionCode: "31" }); await until(() => started); service.cancel(job.id);
  const result = await until(() => service.snapshot().downloads.find(row => row.id === job.id && row.status === "cancelled")); assert.equal(fs.existsSync(result.path), false); assert.deepEqual(fs.readdirSync(path.dirname(result.path)), []);
});
test("an APK with a different actual version code never becomes a completed pinned download", async t => {
  const { service } = fixture(t, { readApkIdentity: () => ({ packageName: appId, versionCode: "41", split: null }) });
  await service.connect({ mode: "browser" }); const job = service.download({ appId, versionCode: "31", autoImport: false });
  const result = await until(() => service.snapshot().downloads.find(row => row.id === job.id && row.status === "error"));
  assert.match(result.error, /exact version code/); assert.equal(fs.existsSync(result.path), false); assert.deepEqual(fs.readdirSync(path.dirname(result.path)), []);
});
test("a supplied provider scope authorizes device metadata directly without an AAS exchange", async () => {
  const routes = [], protocol = createPlayProtocol({ request: async (url, args) => { routes.push(new URL(url).pathname); assert.equal(args.headers.Authorization, "Bearer fixture-provider-token"); return { status: 200, body: wrapped(28, m(f(1, "fixture-device-config"))) }; } });
  const auth = await protocol.authorize({ authToken: "fixture-provider-token", expirySeconds: 3600 }, { androidId: "fixture", device: require("../src/modules/android/store/protocol").profile("arm64") });
  assert.deepEqual(routes, ["/fdfe/uploadDeviceConfig"]); assert.equal(auth.deviceConfigToken, "fixture-device-config");
});
test("delivery wire data preserves split hashes, OBB versions and refuses unknown hosts or missing APK hashes", () => {
  const code = "9007199254740993", base = m(f(1, bytes.length), f(3, "https://play.googleapis.com/base"), f(19, Buffer.from(sha256, "hex").toString("base64")),
    f(15, m(f(1, "config.arm64_v8a"), f(2, bytes.length), f(5, "https://play.googleapis.com/split"), f(9, Buffer.from(sha256, "hex").toString("base64")))),
    f(4, m(f(1, 0), f(2, BigInt(code)), f(3, bytes.length), f(4, "https://play.googleapis.com/obb"))));
  const result = parseDelivery(wrapped(21, m(f(1, 1), f(2, base))), appId, code);
  assert.equal(result.files[0].sha256, sha256); assert.equal(result.files[1].filename, "split_config.arm64_v8a.apk"); assert.ok(result.files[2].filename.includes(code));
  assert.throws(() => parseDelivery(wrapped(21, m(f(2, m(f(3, "https://example.test/fake.apk"), f(19, sha256))))), appId, code), /unsupported download address/);
  assert.throws(() => parseDelivery(wrapped(21, m(f(2, m(f(3, "https://play.googleapis.com/base"))))), appId, code), /integrity hash/);
});
test("paid unowned apps cannot enter acquisition; free acquisition preserves the requested exact code", async () => {
  const requests = []; let deliveries = 0;
  const protocol = createPlayProtocol({ request: async (url, args) => { const endpoint = new URL(url); requests.push(endpoint.pathname); let body;
    if (endpoint.pathname.endsWith("delivery")) { assert.equal(endpoint.searchParams.get("vc"), "31"); body = ++deliveries === 1 ? wrapped(21, m(f(1, 3))) : wrapped(21, m(f(1, 1), f(2, m(f(1, bytes.length), f(3, "https://play.googleapis.com/base"), f(19, sha256))))); }
    else if (endpoint.pathname.endsWith("purchase")) body = wrapped(4, m(f(55, "private-delivery-token")));
    else { assert.equal(endpoint.pathname.endsWith("acquire"), true); assert.ok(args.body.length); body = Buffer.alloc(0); }
    return { status: 200, body };
  } });
  const auth = { androidId: "abcdef", authToken: "private-token", device: { sdk: 34, device: "pixel", model: "Pixel", buildId: "build", release: "14", abis: ["arm64-v8a"], locale: "en-US" } };
  await assert.rejects(protocol.delivery(auth, { ...app, priceMicros: "5000000" }, "31"), /not licensed/); assert.deepEqual(requests, ["/fdfe/delivery"]);
  requests.length = 0; deliveries = 0; const result = await protocol.delivery(auth, app, "31"); assert.equal(result.versionCode, "31"); assert.deepEqual(requests, ["/fdfe/delivery", "/fdfe/acquire", "/fdfe/purchase", "/fdfe/delivery"]);
});
function manifest(packageId, code, major = 0) {
  const names = ["manifest", "package", "versionCode", "versionCodeMajor", packageId], strings = names.map(value => Buffer.concat([Buffer.from([value.length, Buffer.byteLength(value)]), Buffer.from(value), Buffer.from([0])])), poolLength = 28 + names.length * 4 + strings.reduce((sum, value) => sum + value.length, 0), pool = Buffer.alloc(poolLength);
  pool.writeUInt16LE(1); pool.writeUInt16LE(28, 2); pool.writeUInt32LE(poolLength, 4); pool.writeUInt32LE(names.length, 8); pool.writeUInt32LE(256, 16); pool.writeUInt32LE(28 + names.length * 4, 20);
  let at = 0; strings.forEach((value, index) => { pool.writeUInt32LE(at, 28 + index * 4); value.copy(pool, 28 + names.length * 4 + at); at += value.length; });
  const start = Buffer.alloc(36 + 3 * 20); start.writeUInt16LE(258); start.writeUInt16LE(16, 2); start.writeUInt32LE(start.length, 4); start.writeUInt32LE(0, 20); start.writeUInt16LE(20, 24); start.writeUInt16LE(20, 26); start.writeUInt16LE(3, 28);
  [[1, 4, 3, 4], [2, 0xffffffff, 16, code], [3, 0xffffffff, 16, major]].forEach(([name, raw, type, value], index) => { const offset = 36 + index * 20; start.writeUInt32LE(name, offset + 4); start.writeUInt32LE(raw, offset + 8); start.writeUInt16LE(8, offset + 12); start[offset + 15] = type; start.writeUInt32LE(value, offset + 16); });
  const header = Buffer.alloc(8); header.writeUInt16LE(3); header.writeUInt16LE(8, 2); header.writeUInt32LE(8 + pool.length + start.length, 4); return Buffer.concat([header, pool, start]);
}
test("bounded binary APK identity reads a 64-bit version code without any Android runtime", t => {
  const xml = manifest(appId, 73, 2097152), identity = parseManifestIdentity(xml); assert.equal(identity.versionCode, "9007199254741065"); assert.equal(identity.packageName, appId);
  const filename = Buffer.from("AndroidManifest.xml"), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt32LE(xml.length, 18); local.writeUInt32LE(xml.length, 22); local.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(xml.length, 20); central.writeUInt32LE(xml.length, 24); central.writeUInt16LE(filename.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + xml.length, 16);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "play-apk-identity-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const file = path.join(root, "base.apk"); fs.writeFileSync(file, Buffer.concat([local, filename, xml, central, filename, end]));
  assert.deepEqual(readApkIdentity(file), identity); assert.throws(() => parseManifestIdentity(xml.subarray(0, 16)), /Incomplete/);
});

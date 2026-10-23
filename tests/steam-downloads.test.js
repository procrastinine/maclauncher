const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { createSteamDownloads, normalizeVersions, protoField, protoFields, containedFile, sharedLibrary } = require("../src/core/steam-downloads");
const bytes = Buffer.from("Steam fixture content\n"), sha = crypto.createHash("sha1").update(bytes).digest("hex");
const info = { common: { name: "Sample game", type: "Game", oslist: "windows,macos,linux" }, depots: {
  branches: { public: { buildid: "73", timeupdated: "1700000000" }, previous: { buildid: "21" }, secret: { pwdrequired: "1" } },
  710001: { name: "Common", manifests: { public: { gid: "9007199254740993", size: "21" }, previous: { gid: "9007199254740991" } } },
  710002: { name: "Windows", config: { oslist: "windows", osarch: "64" }, manifests: { public: { gid: "111" } } },
  710003: { name: "Mac", config: { oslist: "macos" }, manifests: { public: { gid: "222" } } },
  710004: { name: "French", config: { language: "french" }, manifests: { public: { gid: "333" } } }
} };
class Client extends EventEmitter {
  static instances = [];
  constructor(options) { super(); this.options = options; this.calls = []; Client.instances.push(this); this.steamID = { getSteamID64: () => "76561198000000001" }; }
  logOn(details) { this.details = details; setImmediate(() => { this.emit("loggedOn"); this.emit("ownershipCached"); }); }
  logOff() {}
  getOwnedApps() { return [710000]; }
  ownsApp() { return true; }
  async getProductInfo(ids) { return { apps: Object.fromEntries(ids.map(id => [id, { appinfo: structuredClone(info) }])) }; }
  async getManifest(appId, depotId, id) { this.calls.push({ appId, depotId, id }); return { manifest: { files: [{ filename: `${depotId}.txt`, flags: 0, size: String(bytes.length), sha_content: sha, chunks: [{ sha, offset: "0" }] }] } }; }
  async getContentServers() { return { servers: [{ Host: "content.invalid" }] }; }
  async downloadChunk() { return { chunk: bytes }; }
}
class LoginSession extends EventEmitter {
  async startWithCredentials({ accountName }) {
    this.accountName = accountName; this.refreshToken = "fixture-client-session-token";
    setImmediate(() => this.emit("authenticated")); return { actionRequired: false, validActions: [] };
  }
  cancelLoginAttempt() {}
}
async function until(check) { for (let n = 0; n < 200; n++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("Timed out waiting for Steam state"); }
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steam-download-test-"));
  const service = createSteamDownloads({ userDataDir: root, homeDir: root, SteamUser: Client, LoginSession, loadSharedLibrary: async () => [], ...extra });
  t.after(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, service };
}
async function connect(service) { await service.connect({ accountName: "sample", password: "test-only", remember: false }); await until(() => service.snapshot().connection.status === "connected" && !service.snapshot().libraryLoading); }

test("Steam state is offline and versions preserve uint64 manifest IDs and platform metadata", t => {
  const count = Client.instances.length, { service } = fixture(t);
  assert.equal(Client.instances.length, count); assert.equal(service.snapshot().connection.status, "disconnected");
  const version = normalizeVersions(710000, info);
  assert.equal(version.depots[0].manifests.public.id, "9007199254740993");
  assert.equal(version.branches.find(item => item.id === "secret").passwordRequired, true);
  assert.deepEqual(version.depots[1].architectures, ["64"]);
  assert.equal(version.history.length, 5);
});
test("Android automatic selection refreshes old catalogs and keeps Android depots out of PC downloads", async t => {
  const imported = [], { root, service } = fixture(t, { onDownloaded: async job => imported.push({ platform: job.platform, path: job.path }) });
  await connect(service); const client = Client.instances.at(-1), mixed = structuredClone(info);
  mixed.common.oslist = "windows,android";
  mixed.depots[710005] = { name: "Android", config: { oslist: "android", osarch: "arm64" }, manifests: { public: { gid: "444" } } };
  client.getProductInfo = async ids => ({ apps: Object.fromEntries(ids.map(id => [id, { appinfo: structuredClone(mixed) }])) });
  const stale = normalizeVersions(710000, mixed); delete stale.platformSchema;
  stale.depots.find(depot => depot.id === 710005).platforms = [];
  fs.mkdirSync(path.join(root, "steam/catalog"), { recursive: true });
  fs.writeFileSync(path.join(root, "steam/catalog/710000.json"), JSON.stringify(stale));
  const versions = await service.getVersions(710000);
  assert.deepEqual(versions.depots.find(depot => depot.id === 710005).platforms, ["android"]);
  const android = service.download({ appId: 710000, platform: "android", architecture: "arm64" });
  const complete = await until(() => service.snapshot().downloads.find(row => row.id === android.id && ["completed", "error"].includes(row.status)));
  assert.equal(complete.status, "completed", complete.error);
  assert.deepEqual(client.calls.map(call => call.depotId), [710001, 710005]);
  assert.equal(complete.imported, true); assert.equal(imported[0].platform, "android");
  assert.equal(path.dirname(path.dirname(complete.path)), fs.realpathSync(path.join(root, "external/downloads/steam/710000")));
  assert.equal(path.basename(path.dirname(complete.path)), "android");
  client.calls.length = 0;
  const windows = service.download({ appId: 710000, platform: "windows", autoImport: false });
  const pc = await until(() => service.snapshot().downloads.find(row => row.id === windows.id && ["completed", "error"].includes(row.status)));
  assert.equal(pc.status, "completed", pc.error);
  assert.deepEqual(client.calls.map(call => call.depotId), [710001, 710002]);
});
test("Steam connects remembered sessions with an account hint and loads owned plus shared games once", async t => {
  let sharedReads = 0;
  const { service } = fixture(t, { loadSession: () => ({ accountName: "sample", refreshToken: "private-test-only" }), loadSharedLibrary: async () => { sharedReads++; return [{ appId: 710010, name: "Shared game" }]; } });
  await service.connect({ accountName: "sample" }); await until(() => service.snapshot().library.length === 2);
  assert.equal(Client.instances.at(-1).details.refreshToken, "private-test-only");
  assert.equal(service.snapshot().library.find(row => row.appId === 710010).shared, true);
  await service.loadLibrary(); assert.equal(sharedReads, 1);
  assert.equal(JSON.stringify(service.snapshot()).includes("private-test-only"), false);
});
test("automatic architecture selection rejects an unevidenced edition before downloading any depot", async t => {
  const { service } = fixture(t); await connect(service);
  const job = service.download({ appId: 710000, platform: "macos", architecture: "32", autoImport: false });
  const result = await until(() => service.snapshot().downloads.find(row => row.id === job.id && row.status === "error"));
  assert.match(result.error, /does not advertise this architecture/);
  assert.deepEqual(Client.instances.at(-1).calls, []);
  const native = structuredClone(info); native.common.osextended = "macos64,macosapplesilicon"; native.depots[710003].config.osarch = "64";
  Client.instances.at(-1).getProductInfo = async ids => ({ apps: Object.fromEntries(ids.map(id => [id, { appinfo: native }])) });
  await service.getVersions(710000, { refresh: true });
  const apple = service.download({ appId: 710000, platform: "macos", architecture: "arm64", autoImport: false });
  const completed = await until(() => service.snapshot().downloads.find(row => row.id === apple.id && ["completed", "error"].includes(row.status)));
  assert.equal(completed.status, "completed", completed.error);
  assert.deepEqual(Client.instances.at(-1).calls.map(call => call.depotId), [710001, 710003]);
});
test("download selects common and platform depots, checks files and publishes a separate custom folder", async t => {
  let imported = 0; const { root, service } = fixture(t, { onDownloaded: async () => { imported++; } }); await connect(service);
  const destination = path.join(root, "chosen"); fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, "existing.txt"), "preserve");
  const job = service.download({ appId: 710000, platform: "windows", architecture: "64", destination, autoImport: false });
  const result = await until(() => service.snapshot().downloads.find(row => row.id === job.id && ["completed", "error"].includes(row.status)));
  assert.equal(result.status, "completed", result.error); assert.equal(imported, 0);
  assert.deepEqual(Client.instances.at(-1).calls.map(call => call.depotId), [710001, 710002]);
  assert.equal(fs.readFileSync(path.join(destination, "existing.txt"), "utf8"), "preserve");
  assert.ok(result.path.startsWith(fs.realpathSync(destination) + path.sep)); assert.equal(fs.readFileSync(path.join(result.path, "710001.txt"), "utf8"), bytes.toString());
  const metadata = JSON.parse(fs.readFileSync(path.join(result.path, ".maclauncher-steam.json"))); assert.equal(metadata.complete, true);
  assert.equal(metadata.buildId, "73"); assert.equal(metadata.versionName, "Build 73"); assert.equal(metadata.importPath, result.path);
  const index = JSON.parse(fs.readFileSync(path.join(root, "steam/installations.json"))); assert.equal(index[0].path, result.path);
  assert.equal(service.markImported(job.id).downloads[0].imported, true);
});
test("manual historical manifest IDs reach Steam intact and failed import preserves completed download", async t => {
  const { service } = fixture(t, { onDownloaded: async () => { throw new Error("no supported game"); } }); await connect(service);
  const job = service.download({ appId: 710000, platform: "linux", depots: [{ depotId: 710001, manifestId: "18446744073709551614" }] });
  const result = await until(() => service.snapshot().downloads.find(row => row.id === job.id && row.importError));
  assert.equal(result.status, "completed"); assert.equal(result.imported, false);
  assert.equal(Client.instances.at(-1).calls[0].id, "18446744073709551614");
  const metadata = JSON.parse(fs.readFileSync(path.join(result.path, ".maclauncher-steam.json")));
  assert.equal(metadata.buildId, null); assert.equal(metadata.versionName, "Manifest 18446744073709551614");
  assert.match(result.path, /public-manifest-/);
});
test("cancel removes partial content and unsafe Steam paths cannot escape the stage", async t => {
  const { root, service } = fixture(t); await connect(service);
  const client = Client.instances.at(-1); let started = false;
  client.downloadChunk = async () => { started = true; await new Promise(resolve => setTimeout(resolve, 60)); return { chunk: bytes }; };
  const job = service.download({ appId: 710000, platform: "windows" }); await until(() => started); service.cancel(job.id);
  const result = await until(() => service.snapshot().downloads.find(row => row.id === job.id && row.status === "cancelled"));
  assert.equal(fs.existsSync(result.path), false);
  assert.deepEqual(fs.readdirSync(path.dirname(result.path)), []);
  for (const filename of ["../escape", "C:\\escape", "/absolute", "a/../../escape", "a/./b", "a//b"]) assert.throws(() => containedFile(root, filename));
});
test("Steam Families wire adapter decodes modern shared libraries without mutating family state", async () => {
  const methods = [], id = "76561198000000001";
  const client = { steamID: { getSteamID64: () => id }, _send(header, body, callback) {
    methods.push(header.proto.target_job_name); assert.equal(header.msg, 151);
    const payload = methods.length === 1 ? protoField(1, "99") : protoField(1, Buffer.concat([protoField(1, 710010), protoField(2, id, 1), protoField(6, "Shared game", 2)]), 2);
    setImmediate(() => callback(payload, { proto: { eresult: 1 } }));
  } };
  assert.deepEqual(await sharedLibrary(client), [{ appId: 710010, name: "Shared game", owners: [id], iconHash: undefined, excluded: false }]);
  assert.deepEqual(methods, ["FamilyGroups.GetFamilyGroupForUser#1", "FamilyGroups.GetSharedLibraryApps#1"]);
  assert.equal(protoFields(protoField(1, "18446744073709551615", 1)).get(1)[0], "18446744073709551615");
});
test("Steam crypto preserves final AES blocks and validates HMAC and padding", () => {
  const steamCrypto = require("@doctormckay/steam-crypto"), key = crypto.randomBytes(32);
  for (const length of [1, 16, 17, 31, 355992]) {
    const content = Buffer.alloc(length, 0x98);
    assert.deepEqual(steamCrypto.symmetricDecrypt(steamCrypto.symmetricEncrypt(content, key), key), content);
    assert.deepEqual(steamCrypto.symmetricDecrypt(steamCrypto.symmetricEncryptWithHmacIv(content, key), key, true), content);
    const cipher = crypto.createCipheriv("aes-256-ecb", key, null), encrypted = Buffer.concat([cipher.update(content), cipher.final()]);
    assert.deepEqual(steamCrypto.symmetricDecryptECB(encrypted, key), content);
  }
  const bad = steamCrypto.symmetricEncrypt(Buffer.alloc(17), key); bad[bad.length - 1] ^= 1;
  assert.throws(() => steamCrypto.symmetricDecrypt(bad, key));
});
test("manual accounts keep library and catalog caches in separate profile folders", async t => {
  const { root, service } = fixture(t, { accountName: "sample" }); await connect(service); await service.getVersions(710000);
  const accountKey = crypto.createHash("sha256").update("sample").digest("hex").slice(0, 24), metadata = path.join(root, "steam/accounts", accountKey);
  assert.equal(service.snapshot().connection.accountName, "sample");
  assert.equal(fs.existsSync(path.join(metadata, "library.json")), true);
  assert.equal(fs.existsSync(path.join(metadata, "catalog/710000.json")), true);
  assert.equal(fs.existsSync(path.join(root, "steam/library.json")), false);
});
test("password branches decrypt modern manifest IDs and allow historical additional depots", async t => {
  const { service } = fixture(t); await connect(service); const client = Client.instances.at(-1), key = crypto.randomBytes(32);
  const id = Buffer.alloc(8); id.writeBigUInt64LE(8123456789012345678n); const cipher = crypto.createCipheriv("aes-256-ecb", key, null);
  const encrypted = Buffer.concat([cipher.update(id), cipher.final()]).toString("hex");
  client.getProductInfo = async ids => ({ apps: Object.fromEntries(ids.map(appId => { const value = structuredClone(info); value.depots[710001].encryptedmanifests = { secret: { encrypted_gid_2: encrypted } }; return [appId, { appinfo: value }]; })) });
  client.getAppBetaDecryptionKeys = async () => ({ keys: { secret: key } });
  const job = service.download({ appId: 710000, branch: "secret", platform: "windows", branchPassword: "test-only", autoImport: false });
  const result = await until(() => service.snapshot().downloads.find(row => row.id === job.id && ["completed", "error"].includes(row.status)));
  assert.equal(result.status, "completed", result.error); assert.equal(client.calls[0].id, "8123456789012345678");
  const older = service.download({ appId: 710000, platform: "windows", autoImport: false, depots: [{ depotId: 710090, manifestId: "777" }] });
  const previous = await until(() => service.snapshot().downloads.find(row => row.id === older.id && ["completed", "error"].includes(row.status)));
  assert.equal(previous.status, "completed", previous.error); assert.equal(client.calls.at(-1).depotId, 710090);
});
test("default Steam duplicates reuse existing bytes, require a repeat decision and leave custom copies independent", async t => {
  const decisions = ["use-existing", "download-again", "cancel"], prompts = []; let imports = 0;
  const { root, service } = fixture(t, { confirmDuplicate: async existing => { prompts.push(existing); return decisions.shift(); }, onDownloaded: async () => { imports++; } }); await connect(service);
  const selection = { appId: 710000, platform: "windows", architecture: "64", autoImport: false };
  const wait = job => until(() => service.snapshot().downloads.find(row => row.id === job.id && ["completed", "error", "cancelled"].includes(row.status)));
  const first = await wait(service.download(selection)), client = Client.instances.at(-1), calls = client.calls.length;
  assert.equal(first.status, "completed", first.error);
  const reused = await wait(service.download({ ...selection, autoImport: true })); await until(() => service.snapshot().downloads.find(row => row.id === reused.id)?.imported);
  assert.equal(reused.path, first.path); assert.equal(reused.reused, true); assert.equal(reused.downloaded, 0); assert.equal(client.calls.length, calls); assert.equal(imports, 1);
  const custom = await wait(service.download({ ...selection, destination: path.join(root, "custom") }));
  assert.equal(custom.status, "completed", custom.error); assert.notEqual(custom.path, first.path); assert.equal(prompts.length, 1);
  const repeated = await wait(service.download(selection)); assert.equal(repeated.status, "completed", repeated.error); assert.notEqual(repeated.path, first.path);
  const afterRepeat = client.calls.length, cancelled = await wait(service.download(selection));
  assert.equal(cancelled.status, "cancelled"); assert.equal(client.calls.length, afterRepeat); assert.equal(prompts.length, 3);
  assert.equal(fs.readFileSync(path.join(first.path, "710001.txt"), "utf8"), bytes.toString());
});

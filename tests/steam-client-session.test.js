const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { createSteamConsoleRelay, createSteamClientSession, createSteamPublicAppInfoClient, parseClientAppInfo, CANCELLATION_NOTICE } = require("../src/core/steam-client-session");

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "steam-client-session-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const logPath = path.join(homeDir, "Library/Application Support/Steam/logs/console_log.txt");
  fs.mkdirSync(path.dirname(logPath), { recursive: true }); fs.writeFileSync(logPath, "stale console output\n");
  return { homeDir, logPath, userDataDir: path.join(homeDir, "profile"), executable: path.join(homeDir, "Steam.app/Contents/MacOS/steam_osx"),
    getCachedAppInfo: async appId => Number(appId) === 480 ? parseClientAppInfo(info, 480) : null };
}
function append(file, value) { fs.appendFileSync(file, value); }
function markers(file, args) {
  const start = args.find(arg => arg.startsWith("+ML_BEGIN_")).slice(1), end = args.find(arg => arg.startsWith("+ML_END_")).slice(1);
  append(file, `[2026-10-20 18:00:00] ExecCommandLine: ${args.join(" ")}\n`);
  append(file, `[2026-10-20 18:00:00] >>> command not found: ${start}\n[2026-10-20 18:00:00] >>> command not found: ${end}\n`);
}
const info = '"480"\n{ "common" { "name" "Example Game" "oslist" "windows,linux" } "depots" { "481" { "name" "Windows Content" "config" { "oslist" "windows" } "manifests" { "public" { "gid" "100" "size" "4" } } } "branches" { "public" { "buildid" "200" } } } }\n';
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 300; attempt++) { const result = predicate(); if (result) return result; await delay(5); }
  assert.fail("The expected Steam action did not complete.");
}

test("console relay serializes requests and waits for asynchronous app metadata after its dispatch marker", async t => {
  const f = fixture(t), commands = [];
  const relay = createSteamConsoleRelay({ ...f, pollInterval: 2, quietMs: 5, execute: async (_executable, args) => {
    const command = args.find(arg => ["+app_info_print", "+licenses_print"].includes(arg)); commands.push(command);
    assert.equal(args[0], "-silent"); assert.equal(args.includes("-console"), false); markers(f.logPath, args);
    if (command === "+app_info_print") setTimeout(() => append(f.logPath, `[2026-10-20 18:00:00] AppID : 480\n${info}`), 20);
    else append(f.logPath, "License packageID 1:\n - Apps: 480, (1 in total)\n");
  } });
  t.after(() => relay.dispose());
  const first = relay.queryConsole("app_info_print", ["480"], { complete: text => Boolean(parseClientAppInfo(text, "480")) });
  const second = relay.queryConsole("licenses_print");
  await delay(5); assert.deepEqual(commands, ["+app_info_print"]);
  assert.equal(parseClientAppInfo(await first, "480").common.name, "Example Game");
  assert.ok((await second).includes("License packageID")); assert.deepEqual(commands, ["+app_info_print", "+licenses_print"]);
  await assert.rejects(relay.queryConsole("quit"), /request is invalid/);
  await assert.rejects(relay.queryConsole("app_info_print", ["+quit"]), /request is invalid/);
});

test("cancelled client depot downloads retain console ownership until Steam finishes", async t => {
  const f = fixture(t), commands = [];
  const relay = createSteamConsoleRelay({ ...f, pollInterval: 2, quietMs: 3, execute: async (_executable, args) => {
    const command = args.includes("+download_depot") ? "+download_depot" : "+licenses_print";
    commands.push(command); markers(f.logPath, args);
    if (command === "+licenses_print") append(f.logPath, "License packageID 1:\n");
  } });
  t.after(() => relay.dispose());
  const controller = new AbortController();
  const downloading = relay.queryConsole("download_depot", ["480", "481", "100"], { signal: controller.signal, keepLeaseOnAbort: true,
    complete: text => text.includes("Depot download complete") });
  await waitFor(() => commands.length === 1);
  controller.abort(); await assert.rejects(downloading, { name: "AbortError" });
  const next = relay.queryConsole("licenses_print"); await delay(10);
  assert.deepEqual(commands, ["+download_depot"], "A later request cannot consume the cancelled depot's reply");
  append(f.logPath, 'Depot download complete : "/steam/content/depot_481"\n');
  await next; assert.deepEqual(commands, ["+download_depot", "+licenses_print"]);
});

test("client reuse publishes selected historical manifests into managed or custom folders without modifying Steam content", async t => {
  const f = fixture(t), invocations = [], imported = []; let duplicates = 0;
  t.mock.method(globalThis, "fetch", () => assert.fail("Client reuse must not create a separate network session"));
  const source = path.join(f.homeDir, "Library/Application Support/Steam/steamapps/content/app_480/depot_481");
  fs.mkdirSync(source, { recursive: true }); fs.writeFileSync(path.join(source, "game.exe"), "data");
  const session = createSteamClientSession({ ...f, isRunning: () => true, pollInterval: 2, quietMs: 3,
    loadLibrary: async () => [{ appId: 480, name: "Example Game", platforms: ["windows"], shared: false }],
    onDownloaded: async job => { imported.push(job.path); },
    confirmDuplicate: async () => { duplicates++; return "use-existing"; },
    execute: async (_executable, args) => {
      markers(f.logPath, args);
      if (args.includes("+licenses_print")) append(f.logPath, "License packageID 1:\n");
      else if (args.includes("+app_info_print")) append(f.logPath, info);
      else { invocations.push(args.slice(args.indexOf("+download_depot") + 1, -1)); append(f.logPath, `Depot download complete : "${source}"\n`); }
    } });
  t.after(() => session.dispose());
  assert.equal((await session.connect()).connection.status, "connected");
  const initial = session.download({ appId: 480, platform: "windows", depots: [{ depotId: 481, manifestId: "999" }] });
  await waitFor(() => session.snapshot().downloads.find(job => job.id === initial.id)?.status === "completed");
  await waitFor(() => imported.length === 1);
  const completed = session.snapshot().downloads.find(job => job.id === initial.id);
  assert.deepEqual(invocations, [["480", "481", "999"]]);
  assert.equal(fs.readFileSync(path.join(completed.path, "game.exe"), "utf8"), "data");
  assert.equal(fs.readFileSync(path.join(source, "game.exe"), "utf8"), "data");
  assert.notEqual(fs.statSync(path.join(completed.path, "game.exe")).ino, fs.statSync(path.join(source, "game.exe")).ino);
  fs.writeFileSync(path.join(source, "game.exe"), "store update");
  assert.equal(fs.readFileSync(path.join(completed.path, "game.exe"), "utf8"), "data");
  assert.equal(fs.existsSync(path.join(source, ".maclauncher-steam.json")), false);
  const metadata = JSON.parse(fs.readFileSync(path.join(completed.path, ".maclauncher-steam.json"), "utf8"));
  assert.equal(metadata.complete, true); assert.equal(metadata.path, completed.path); assert.equal(metadata.depots[0].manifestId, "999");
  assert.equal(metadata.buildId, null); assert.equal(metadata.versionName, "Manifest 999"); assert.equal(metadata.importPath, completed.path);
  assert.ok(completed.path.startsWith(fs.realpathSync(path.join(f.userDataDir, "external/downloads/steam")) + path.sep));
  const same = session.download({ appId: 480, platform: "windows", depots: [{ depotId: 481, manifestId: "999" }], autoImport: false });
  await waitFor(() => session.snapshot().downloads.find(job => job.id === same.id)?.status === "completed");
  assert.equal(session.snapshot().downloads.find(job => job.id === same.id).path, completed.path); assert.equal(duplicates, 1); assert.equal(invocations.length, 1);
  const customParent = path.join(f.homeDir, "Selected Downloads");
  const custom = session.download({ appId: 480, platform: "windows", autoImport: false, destination: customParent });
  await waitFor(() => session.snapshot().downloads.find(job => job.id === custom.id)?.status === "completed");
  const second = session.snapshot().downloads.find(job => job.id === custom.id);
  assert.equal(path.dirname(second.path), fs.realpathSync(customParent)); assert.notEqual(second.path, completed.path);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.userDataDir, "steam/installations.json"), "utf8")).length, 2);
  assert.deepEqual(imported, [completed.path]);
});

test("cancel and disposal preserve Steam's own download while preventing local publication", async t => {
  const f = fixture(t);
  const session = createSteamClientSession({ ...f, isRunning: () => true, pollInterval: 2, quietMs: 3,
    loadLibrary: async () => [{ appId: 480, name: "Example Game", platforms: ["windows"] }],
    execute: async (_executable, args) => { markers(f.logPath, args); if (args.includes("+licenses_print")) append(f.logPath, "License packageID 1:\n"); else if (args.includes("+app_info_print")) append(f.logPath, info); } });
  await session.connect();
  const job = session.download({ appId: 480, platform: "windows" });
  await waitFor(() => session.snapshot().downloads[0].status === "downloading");
  session.cancel(job.id);
  await waitFor(() => session.snapshot().downloads[0].status === "cancelled");
  assert.equal(session.snapshot().downloads[0].detail, CANCELLATION_NOTICE);
  assert.equal(fs.existsSync(path.join(f.userDataDir, "steam/installations.json")), false);
  await session.dispose();
  const parent = path.join(f.userDataDir, "external/downloads/steam/480/windows");
  assert.deepEqual(fs.readdirSync(parent), []);
});

test("desktop identity hints are exposed safely and an account change invalidates pending versions", async t => {
  const f = fixture(t); let accountName = "example-one", releaseInfo;
  class MetadataClient extends EventEmitter {
    logOn() { queueMicrotask(() => this.emit("loggedOn")); }
    getProductInfo() { return new Promise(resolve => { releaseInfo = () => resolve({ apps: { 480: { appinfo: parseClientAppInfo(info, 480) } } }); }); }
    logOff() {}
  }
  const session = createSteamClientSession({ ...f, isRunning: () => true, pollInterval: 2, quietMs: 3,
    SteamUser: MetadataClient, getCachedAppInfo: async () => null,
    localAccount: () => ({ accountName, displayName: "Example Player" }), loadLibrary: async () => [],
    execute: async (_executable, args) => {
      markers(f.logPath, args);
      if (args.includes("+licenses_print")) append(f.logPath, "License packageID 1:\n");
      else assert.fail("Reading versions must not send a command to the Steam desktop app.");
    } });
  t.after(() => session.dispose());
  assert.equal(session.snapshot().connection.accountName, "example-one");
  await session.connect(); assert.equal(session.snapshot().connection.displayName, "Example Player");
  const pending = session.getVersions(480, { refresh: true }); await waitFor(() => releaseInfo);
  accountName = "example-two"; releaseInfo();
  await assert.rejects(pending, /Steam account changed/);
  assert.equal(session.snapshot().connection.status, "disconnected"); assert.equal(session.snapshot().connection.accountName, "example-two");
  assert.equal(fs.existsSync(path.join(f.userDataDir, "steam/catalog/480.json")), false);
});

test("version metadata uses local appinfo first and anonymous PICS on explicit refresh without opening Steam", async t => {
  const f = fixture(t), launches = [], clients = [], logons = [];
  class MetadataClient extends EventEmitter {
    constructor(options) { super(); clients.push(this); this.options = options; this.requests = []; }
    logOn(details) { logons.push(details); queueMicrotask(() => this.emit("loggedOn")); }
    async getProductInfo(apps, packages, includeTokens) {
      this.requests.push({ apps, packages, includeTokens });
      const appinfo = parseClientAppInfo(info, 480); appinfo.common.name = "Refreshed Game";
      return { apps: { 480: { appinfo } } };
    }
    logOff() { this.loggedOff = true; }
  }
  const session = createSteamClientSession({ ...f, SteamUser: MetadataClient, isRunning: () => true, pollInterval: 2, quietMs: 3,
    loadLibrary: async () => [{ appId: 480, name: "Example Game" }],
    execute: async (_executable, args) => {
      launches.push(args); assert.ok(args.includes("+licenses_print"), "Metadata must not dispatch desktop commands");
      markers(f.logPath, args); append(f.logPath, "License packageID 1:\n");
    } });
  t.after(() => session.dispose());
  assert.equal(clients.length, 0, "Creating a session must stay offline");
  await session.connect(); await session.getVersions(480);
  assert.equal(clients.length, 0, "Cached appinfo must stay offline");
  assert.equal((await session.getVersions(480, { refresh: true })).name, "Refreshed Game");
  await session.getVersions(480, { refresh: true });
  assert.equal(launches.length, 1); assert.deepEqual(logons, [{ anonymous: true }]);
  assert.equal(clients[0].options.dataDirectory, null); assert.equal(clients[0].options.autoRelogin, false);
  assert.equal(clients[0].options.enablePicsCache, false, "Anonymous metadata must not enumerate unrelated server licenses");
  assert.deepEqual(clients[0].requests[0], { apps: [480], packages: [], includeTokens: true });
  await session.dispose(); assert.equal(clients[0].loggedOff, true);
});

test("anonymous metadata timeout and cancellation never fall back to the desktop client", async t => {
  const clients = [];
  class MetadataClient extends EventEmitter {
    constructor() { super(); clients.push(this); }
    logOn() {}
    logOff() { this.loggedOff = true; }
  }
  const metadata = createSteamPublicAppInfoClient({ SteamUser: MetadataClient, timeoutMs: 15 });
  t.after(() => metadata.dispose());
  await assert.rejects(metadata.getAppInfo(480), { code: "STEAM_METADATA_TIMEOUT" });
  assert.equal(clients[0].loggedOff, true);
  const controller = new AbortController(), pending = metadata.getAppInfo(480, { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: "AbortError" });
  metadata.dispose(); assert.equal(clients[1].loggedOff, true);
});

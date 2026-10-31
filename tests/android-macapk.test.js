// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { promisify } = require("node:util");
const execute = promisify(require("node:child_process").execFile);
const Provider = require("../src/modules/android/providers/macapk");
const Manager = Provider.manager;
const crypto = require("node:crypto");

function directory(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "macapk-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function releaseFixture(version, hash = "a".repeat(64)) {
  const sourceUrl = "https://github.com/kksimp/Mac.apk/releases/tag/v" + version;
  return { tag_name: "v" + version, html_url: sourceUrl, assets: [{ name: "macapk.dmg", id: 101,
    size: 128, digest: "sha256:" + hash,
    browser_download_url: "https://github.com/kksimp/Mac.apk/releases/download/v" + version + "/macapk.dmg" }] };
}

const repository = "kksimp/Mac.apk", releasesUrl = `https://api.github.com/repos/${repository}/releases`;
const queries = () => Harness.network.requests.filter(url => url.startsWith(releasesUrl)).length;

test("Mac.apk has no seeded release and keeps missing explicit choices offline", t => {
  const root = directory(t), managed = Manager.createManager(), before = Harness.network.requests.length;
  assert.deepEqual(managed.getState({ userDataDir: root }).catalog.versions, []);
  const automatic = managed.resolveSelection({}, {}, root);
  assert.equal(automatic.version, null); assert.equal(automatic.discoveryRequired, true);
  const explicit = managed.resolveSelection({ runtimeData: { macapk: { version: "7.8.9" } } }, {}, root);
  assert.equal(explicit.version, "7.8.9"); assert.equal(explicit.ready, false);
  assert.equal(Harness.network.requests.length, before, "Status and selection stay offline");
});

test("Mac.apk discovery retains publisher identities and caches choices without source seeds", async t => {
  const release = releaseFixture("8.1.0"), future = releaseFixture("9.2.0", "b".repeat(64));
  const undigested = { ...releaseFixture("10.0.0"), assets: [{ ...release.assets[0], digest: null }] };
  const root = directory(t), managed = Manager.createManager(), start = queries();
  assert.equal(managed.resolveSelection({}, {}, root).discoveryRequired, true);
  assert.equal(queries(), start);
  Harness.network.routes = Harness.githubRoutes(repository, [undigested, future, release]);
  try { await managed.refreshCatalog({ userDataDir: root }); } finally { Harness.network.routes = null; }
  assert.equal(queries(), start + 1);
  const entries = managed.core.listDiscoveredCatalog({ userDataDir: root }), row = version => entries.find(item => item.version === version);
  assert.equal(row("8.1.0").asset.sha256, "a".repeat(64));
  assert.match(row("8.1.0").upstreamRevision, /^[a-f0-9]{40}$/); assert.equal(row("8.1.0").minimumMacOS, undefined, "The application states its requirement");
  assert.equal(row("10.0.0").asset.integrity, "recorded-local", "A download without a publisher digest records its own");
  const cached = Manager.createManager(), before = Harness.network.requests.length;
  assert.deepEqual(cached.getState({ userDataDir: root }).catalog.versions, ["10.0.0", "9.2.0", "8.1.0"]);
  assert.equal(cached.resolveSelection({ runtimeData: { macapk: { version: "8.1.0" } } }, {}, root).version, "8.1.0");
  assert.equal(Harness.network.requests.length, before, "Cached choices stay offline");
});

test("Mac.apk restores an unlisted installed version from its receipt and rejects changed bytes", t => {
  if (process.platform !== "darwin") return t.skip("Native macOS executable inspection");
  const root = directory(t), version = "6.7.8", upstreamRevision = "e".repeat(40);
  const executableRelative = "Mac.apk.app/Contents/Resources/macapk-runtime";
  const installDir = path.join(root, "runtimes/macapk", version), executable = path.join(installDir, executableRelative);
  const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(process.arch === "arm64" ? 0x0100000c : 0x01000007, 4); bytes.writeUInt32LE(2, 12);
  fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, bytes, { mode: 0o755 });
  const archiveSha256 = "f".repeat(64), catalogEntry = { version, upstreamRevision, localBuild: false,
    asset: { filename: "macapk.dmg", url: releaseFixture(version).assets[0].browser_download_url, sha256: archiveSha256 } };
  fs.writeFileSync(path.join(installDir, "runtime.json"), JSON.stringify({ version, upstreamRevision, catalogEntry,
    source: "download", executableRelative, archiveSha256, binarySha256: crypto.createHash("sha256").update(bytes).digest("hex") }));
  const before = Harness.network.requests.length;
  const managed = Manager.createManager(), entry = { runtimeData: { macapk: { version } } };
  const selected = managed.resolveSelection(entry, {}, root);
  assert.equal(selected.ready, true); assert.equal(selected.version, version); assert.equal(selected.install.executablePath, executable);
  assert.ok(managed.getState({ userDataDir: root }).installed.some(row => row.version === version));
  fs.appendFileSync(executable, "changed");
  const rejected = Manager.createManager().resolveSelection(entry, {}, root);
  assert.equal(rejected.ready, false); assert.equal(rejected.version, version);
  assert.equal(Harness.network.requests.length, before, "Receipt reuse stays offline");
});

test("Play requests the selected managed download and launches with private policy and data", async t => {
  const root = directory(t), input = path.join(root, "base.apk"); fs.writeFileSync(input, "package fixture");
  let ready = false;
  const install = { executablePath: path.join(root, "runtime with spaces/Mac.apk.app/Contents/Resources/macapk-runtime"), installDir: path.join(root, "runtime with spaces") };
  t.mock.method(Manager, "resolveSelection", () => ({ version: "7.8.9", ready, install, reason: "Not installed" }));
  t.mock.method(require("../src/modules/android/providers/macapk/executable-identity"), "prepareExecutable", async () => install.executablePath);
  const icon = path.join(root, "game-icon.png"); fs.writeFileSync(icon, "icon fixture");
  t.mock.method(require("../src/modules/shared/dock-icon"), "prepare", async source => source);
  const context = { userDataDir: root, settings: {}, gameArguments: ["--windowed", "A name", ""] }, entry = { gamePath: input, name: "A game & a name", iconPath: icon };
  assert.deepEqual(Provider.ensureRuntime(entry, context), { managerId: "macapk", version: "7.8.9", installOptions: {} });
  ready = true; assert.equal(Provider.ensureRuntime(entry, context), null);
  const storage = Object.fromEntries(["androidRoot", "home", "temporary", "cacheRoot", "runtimeRoot"].map(key => [key, path.join(root, key)]));
  const launch = await Provider.prepareLaunch({ entry, context, storage, packageSet: { base: { file: input }, metadata: { packageName: "fixture.game" } },
    policy: { clipboard: "explicit", location: null, networkAllowed: false, clipboardSocket: "/private/tmp/clipboard.sock" } });
  assert.equal(fs.readlinkSync(launch.command), install.executablePath);
  assert.equal(launch.env.MACAPK_APP_LABEL, entry.name);
  assert.equal(fs.readFileSync(launch.env.MACAPK_APP_ICON, "utf8"), "icon fixture");
  assert.equal(Provider.resolveIcon(storage), launch.env.MACAPK_APP_ICON);
  const info = fs.readFileSync(path.join(launch.application.app, "Contents/Info.plist"), "utf8");
  assert.match(info, /A game &amp; a name/); assert.match(info, /CFBundleIdentifier/);
  assert.deepEqual(launch.args, ["--apk", input, "--android-root", storage.androidRoot, "--width", "1280", "--height", "800", "--orientation", "landscape"]);
  assert.equal(launch.env.MACAPK_OFFLINE, "1"); assert.equal(launch.env.MACAPK_LOCATION_HOST, "0");
  for (const name of ["MACAPK_SHARED_SDCARD", "MACAPK_SHARED_SDCARD_MIGRATE", "MACAPK_STORAGE_ONE_PATH", "MACAPK_USER_FOLDERS", "MACAPK_NOW_PLAYING", "MACAPK_APP_LINKS"])
    assert.equal(launch.env[name], "0", name);
  assert.equal(launch.env.MACAPK_DISPLAY_DENSITY, "320"); assert.equal(launch.env.HOME, storage.home);
  assert.equal(launch.env.MACLAUNCHER_CLIPBOARD_SOCKET, "/private/tmp/clipboard.sock");
  assert.match(launch.env.JAVA_TOOL_OPTIONS, /-javaagent:/); assert.ok(!launch.machServices.some(name => /pasteboard|locationd/.test(name)));
  assert.match(launch.env.JAVA_TOOL_OPTIONS, /=macapk/);
  assert.deepEqual(JSON.parse(launch.env.MACLAUNCHER_GAME_ARGUMENTS),context.gameArguments);
  assert.ok(launch.env.JAVA_TOOL_OPTIONS.includes('-Duser.home="' + storage.home + '"'));
  assert.ok(launch.env.JAVA_TOOL_OPTIONS.includes('-Djava.io.tmpdir="' + storage.temporary + '"'));
  assert.equal(launch.env.MACAPK_GMS_PRESENT, "0");
  assert.equal(launch.expansionDirectory, path.join(storage.androidRoot, "sdcard/Android/obb/fixture.game"));
  const selected = await Provider.prepareLaunch({ entry, context, storage, packageSet: { base: { file: input } },
    policy: { clipboard: "explicit", location: null, networkAllowed: true, width: 960, height: 600, google: { enabled: true, socket: "/private/tmp/google.sock", capability: "a".repeat(64), mode: "account" } } });
  assert.equal(selected.env.MACAPK_GMS_PRESENT, "1"); assert.equal(selected.env.MACLAUNCHER_GOOGLE_SOCKET, "/private/tmp/google.sock");
  assert.equal(selected.env.MACLAUNCHER_GOOGLE_CAPABILITY, "a".repeat(64)); assert.ok(!Object.hasOwn(selected.env, "MACAPK_GMS_HONEST_MISSING"));
  assert.equal(selected.env.MACAPK_APP_LINKS, "1"); assert.equal(selected.env.MACAPK_OFFLINE, "0");
  assert.deepEqual(selected.args.slice(4), ["--width", "960", "--height", "600", "--orientation", "landscape"]);
  const split = path.join(root, "split_config.apk"); fs.writeFileSync(split, "split fixture");
  const cached = fs.readdirSync(storage.cacheRoot);
  assert.equal(await Provider.packageInput({ root, key: "fixture", base: { file: input }, apks: [input, split] }, entry, storage), input);
  assert.deepEqual(fs.readdirSync(storage.cacheRoot), cached);
});

test("The shipped policy JAR contains real adapters without private validation classes", () => {
  const Zip = require("../src/modules/shared/runtime/zip");
  assert.ok(Zip.readZipEntryBuffer(Manager.policyJar, "com/maclauncher/android/macapk/PrivacyAgent.class"));
  assert.ok(Zip.readZipEntryBuffer(Manager.policyJar, "com/maclauncher/android/macapk/PrivacyBridge.class"));
  assert.equal(Zip.readZipEntryBuffer(Manager.policyJar, "com/maclauncher/android/macapk/PrivacyProbe.class"), null);
});

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
const { createCatalogDiscovery } = require("../src/modules/android/providers/macapk/catalog");
const crypto = require("node:crypto");

function directory(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "macapk-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function releaseFixture(version, hash = "a".repeat(64)) {
  const sourceUrl = "https://github.com/kksimp/Mac.apk/releases/tag/v" + version;
  return { tag_name: "v" + version, html_url: sourceUrl, assets: [{ name: "macapk.dmg", id: 101,
    size: 128, digest: "sha256:" + hash,
    browser_download_url: "https://github.com/kksimp/Mac.apk/releases/download/v" + version + "/macapk.dmg" }] };
}

test("Mac.apk has no seeded release and keeps missing explicit choices offline", t => {
  const root = directory(t), managed = Manager.createManager({ catalogDependencies: {
    fetchGithubReleases: async () => assert.fail("Status and selection cannot discover releases"),
    fetchGithubTags: async () => assert.fail("Status and selection cannot resolve tags")
  } });
  assert.deepEqual(managed.getState({ userDataDir: root }).catalog.versions, []);
  const automatic = managed.resolveSelection({}, {}, root);
  assert.equal(automatic.version, null); assert.equal(automatic.discoveryRequired, true);
  const explicit = managed.resolveSelection({ runtimeData: { macapk: { version: "7.8.9" } } }, {}, root);
  assert.equal(explicit.version, "7.8.9"); assert.equal(explicit.ready, false);
});

test("Mac.apk discovery retains publisher identities and caches choices without source seeds", async t => {
  const release = releaseFixture("8.1.0"), future = releaseFixture("9.2.0", "b".repeat(64));
  let requests = 0;
  const dependencies = {
    fetchGithubReleases: async () => { requests++; return [future, release,
      { ...releaseFixture("10.0.0"), assets: [{ ...release.assets[0], digest: null }] }]; },
    fetchGithubTags: async () => [{ name: release.tag_name, commit: { sha: "c".repeat(40) } },
      { name: future.tag_name, commit: { sha: "d".repeat(40) } }]
  };
  const discover = createCatalogDiscovery(dependencies);
  assert.equal(requests, 0);
  const entries = await discover();
  assert.equal(requests, 1); assert.equal(entries.length, 2);
  const current = entries.find(item => item.version === "8.1.0");
  assert.equal(current.asset.sha256, "a".repeat(64));
  assert.equal(current.upstreamRevision, "c".repeat(40)); assert.equal(current.minimumMacOS, "26.4");
  assert.equal(entries.find(item => item.version === "9.2.0").upstreamRevision, "d".repeat(40));
  const root = directory(t), managed = Manager.createManager({ catalogDependencies: dependencies });
  assert.equal(managed.resolveSelection({}, {}, root).discoveryRequired, true);
  assert.equal(requests, 1);
  await managed.refreshCatalog({ userDataDir: root });
  assert.equal(requests, 2);
  const cached = Manager.createManager({ catalogDependencies: {
    fetchGithubReleases: async () => assert.fail("Cached choices stay offline"),
    fetchGithubTags: async () => assert.fail("Cached choices stay offline")
  } });
  assert.deepEqual(cached.getState({ userDataDir: root }).catalog.versions, ["9.2.0", "8.1.0"]);
  assert.equal(cached.resolveSelection({ runtimeData: { macapk: { version: "8.1.0" } } }, {}, root).version, "8.1.0");
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
  const options = { catalogDependencies: { fetchGithubReleases: async () => assert.fail("Receipt reuse stays offline") } };
  const managed = Manager.createManager(options), entry = { runtimeData: { macapk: { version } } };
  const selected = managed.resolveSelection(entry, {}, root);
  assert.equal(selected.ready, true); assert.equal(selected.version, version); assert.equal(selected.install.executablePath, executable);
  assert.ok(managed.getState({ userDataDir: root }).installed.some(row => row.version === version));
  fs.appendFileSync(executable, "changed");
  const rejected = Manager.createManager(options).resolveSelection(entry, {}, root);
  assert.equal(rejected.ready, false); assert.equal(rejected.version, version);
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

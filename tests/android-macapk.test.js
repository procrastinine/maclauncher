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
const { catalog, createCatalogDiscovery } = require("../src/modules/android/providers/macapk/catalog");

function directory(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "macapk-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
test("Mac.apk resolves the current catalog while keeping explicit selections", t => {
  const root = directory(t);
  assert.equal(catalog[0].version, "1.0.2303");
  assert.equal(Manager.resolveSelection({}, {}, root).version, "1.0.2303");
  assert.equal(Manager.resolveSelection({ runtimeData: { macapk: { version: "1.0.2279" } } }, {}, root).version, "1.0.2279");
  assert.ok(catalog.some(item => item.version === "1.0.2237"));
  assert.equal(Manager.resolveSelection({ runtimeData: { macapk: { version: "1.0.2237" } } }, {}, root).version, "1.0.2237");
  assert.equal(Manager.resolveSelection({}, { runtimes: { macapk: { defaultVersion: "1.0.2237" } } }, root).version, "1.0.2237");
  const release = catalog.find(item => item.version === "1.0.2303");
  assert.equal(release.upstreamRevision, "f5338a9dfa901fa78ef0be02d5eb44daaba037e9");
  assert.equal(release.asset.sha256, "af32b4d7e972f761629549818759cf1866d8f7c3a89b6e96b1bc8de585565d39");
  assert.equal(release.asset.bytes, 114163044); assert.equal(release.asset.assetId, 663148267);
  assert.equal(release.asset.url, "https://github.com/kksimp/Mac.apk/releases/download/v1.0.2303/macapk.dmg");
});
test("Mac.apk discovery retains publisher identities and excludes downloads without digests", async t => {
  const release = { tag_name: "v" + catalog[0].version, html_url: catalog[0].sourceUrl, assets: [{ name: "macapk.dmg", id: catalog[0].asset.assetId,
    size: catalog[0].asset.bytes, digest: "sha256:" + catalog[0].asset.sha256, browser_download_url: catalog[0].asset.url }] };
  const future = { ...release, tag_name: "v1.0.2304", html_url: "https://github.com/kksimp/Mac.apk/releases/tag/v1.0.2304",
    assets: [{ ...release.assets[0], digest: "sha256:" + "a".repeat(64), browser_download_url: "https://github.com/kksimp/Mac.apk/releases/download/v1.0.2304/macapk.dmg" }] };
  let requests = 0;
  const dependencies = { fetchGithubReleases: async () => { requests++; return [future, release, { ...release, tag_name: "v1.0.2238", assets: [{ ...release.assets[0], digest: null }] }]; },
    fetchGithubTags: async () => [{ name: release.tag_name, commit: { sha: catalog[0].upstreamRevision } }, { name: future.tag_name, commit: { sha: "b".repeat(40) } }] };
  const discover = createCatalogDiscovery(dependencies);
  assert.equal(requests, 0);
  const entries = await discover();
  assert.equal(requests, 1); assert.equal(entries.length, 2);
  const current = entries.find(item => item.version === catalog[0].version);
  assert.equal(current.asset.sha256, catalog[0].asset.sha256);
  assert.equal(current.upstreamRevision, catalog[0].upstreamRevision); assert.equal(current.minimumMacOS, "26.4");
  assert.equal(entries.find(item => item.version === "1.0.2304").upstreamRevision, "b".repeat(40));
  const root = directory(t), managed = Manager.createManager({ catalogDependencies: dependencies });
  assert.equal(managed.resolveSelection({}, {}, root).version, catalog[0].version);
  assert.equal(requests, 1);
  await managed.refreshCatalog({ userDataDir: root });
  assert.equal(requests, 2);
  assert.equal(managed.resolveSelection({}, {}, root).version, "1.0.2304");
  assert.equal(managed.resolveSelection({ runtimeData: { macapk: { version: "1.0.2237" } } }, {}, root).version, "1.0.2237");
});

test("Play requests the selected managed download and launches with private policy and data", async t => {
  const root = directory(t), input = path.join(root, "base.apk"); fs.writeFileSync(input, "package fixture");
  let ready = false;
  const install = { executablePath: path.join(root, "runtime with spaces/Mac.apk.app/Contents/Resources/macapk-runtime"), installDir: path.join(root, "runtime with spaces") };
  t.mock.method(Manager, "resolveSelection", () => ({ version: "1.0.2237", ready, install, reason: "Not installed" }));
  t.mock.method(require("../src/modules/android/providers/macapk/executable-identity"), "prepareExecutable", async () => install.executablePath);
  const icon = path.join(root, "game-icon.png"); fs.writeFileSync(icon, "icon fixture");
  t.mock.method(require("../src/modules/shared/dock-icon"), "prepare", async source => source);
  const context = { userDataDir: root, settings: {}, gameArguments: ["--windowed", "A name", ""] }, entry = { gamePath: input, name: "A game & a name", iconPath: icon };
  assert.deepEqual(Provider.ensureRuntime(entry, context), { managerId: "macapk", version: "1.0.2237", installOptions: {} });
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

const testApp = process.env.MACAPK_TEST_APP;
test("Actual provider applies private device policy and prevents native Google prompts with network enabled", { skip: !testApp, timeout: 40000 }, async () => {
  assert.deepEqual(await Manager.verifyPolicy(path.join(testApp, "Contents"), {
    run: (command, args, options) => execute(command, ["-Dmaclauncher.test.boundSignIn=true", ...args], { ...options,
      env: { ...options.env, MACAPK_GMS_PRESENT: "0", MACAPK_OFFLINE: "0" } })
  }), { privacyVersion: 1 });
});

test("Plain text crosses only the explicit broker and denied transfers retain private clipboard", { skip: !testApp, timeout: 15000 }, async t => {
  const root = directory(t), socketPath = path.join(root, "clipboard.sock"), requests = [];
  let allow = false;
  const server = net.createServer(socket => {
    socket.setEncoding("utf8"); let input = "";
    socket.on("data", chunk => { input += chunk; if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]); requests.push(request);
      socket.end(JSON.stringify({ allowed: allow, ...(allow && request.operation === "paste" ? { text: "paste\n\"plain\" λ" } : {}) }) + "\n");
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const run = () => execute(path.join(testApp, "Contents/Resources/jre/bin/java"), ["-Duser.home=" + root, "-cp", Manager.policyJar,
    "com.maclauncher.android.macapk.PrivacyProbe", "--clipboard"], { env: { PATH: "/usr/bin:/bin", HOME: root, MACLAUNCHER_CLIPBOARD_SOCKET: socketPath }, timeout: 5000 });
  let result = await run(); assert.equal(Buffer.from(result.stdout.trim(), "base64").toString(), 'copy\n"plain" λ');
  allow = true; result = await run(); assert.equal(Buffer.from(result.stdout.trim(), "base64").toString(), 'paste\n"plain" λ');
  assert.deepEqual(requests.map(item => item.operation), ["copy", "paste", "copy", "paste"]);
  assert.equal(requests[0].text, 'copy\n"plain" λ'); assert.ok(requests.every(item => !Object.hasOwn(item, "pid")));
});

test("Original account futures delegate real scoped-token requests without caller identity or master storage", { skip: !testApp, timeout: 15000 }, async t => {
  const root = directory(t), endpoint = path.join(root, "google.sock"), capability = "a".repeat(64), requests = [];
  const server = net.createServer(socket => {
    socket.setEncoding("utf8"); let input = "";
    socket.on("data", chunk => { input += chunk; if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]); requests.push(request);
      assert.equal(request.capability, capability);
      const result = request.operation === "accounts" ? { accounts: [{ name: "fixture@example.invalid", type: "com.google" }] }
        : request.operation === "token" ? { token: "fixture-scoped-token", expirySeconds: 3600 } : {};
      socket.end(JSON.stringify({ ok: true, ...result }) + "\n");
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const java = path.join(testApp, "Contents/Resources/jre/bin/java"), lib = path.join(testApp, "Contents/lib");
  const reply = await execute(java, ["-Duser.home=" + root, "--add-exports=java.base/jdk.internal.org.objectweb.asm=ALL-UNNAMED", "-javaagent:" + Manager.policyJar,
    "-cp", [Manager.policyJar, path.join(lib, "android-framework.jar"), path.join(lib, "macapk-loader.jar")].join(path.delimiter),
    "com.maclauncher.android.macapk.PrivacyProbe", "--auth"], { timeout: 10000,
    env: { PATH: "/usr/bin:/bin", HOME: root, MACAPK_LOG_LEVEL: "7", MACLAUNCHER_GOOGLE_SOCKET: endpoint, MACLAUNCHER_GOOGLE_CAPABILITY: capability } });
  assert.equal(reply.stdout.trim(), "macapk-auth-1");
  assert.ok(requests.some(item => item.operation === "token"));
  assert.ok(requests.some(item => item.operation === "peekToken"));
  assert.ok(requests.some(item => item.operation === "invalidateToken"));
  assert.ok(!JSON.stringify(requests).includes("untrusted.caller")); assert.ok(!JSON.stringify(requests).includes("untrusted-signer"));
  const entries = fs.readdirSync(root); assert.deepEqual(entries, ["google.sock"]);
});

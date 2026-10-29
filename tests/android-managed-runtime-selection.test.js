const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const Runtime = require("../src/modules/android/runtime"), Manager = require("../src/modules/android/runtime-manager");
const Metadata = require("../src/modules/android/package-metadata");

function installed(t, version, profile = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-managed-selection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, version,
    profile: { id: version, javaMajor: 21, nativeLoadTarget: "maclauncher.android.bridge.GuestNativeLoader", ...profile } }));
  fs.writeFileSync(path.join(root, "runtime.json"), bytes);
  fs.writeFileSync(path.join(root, "android-host.jar"), version);
  return { version, ready: true, install: { root, declaration: { version, minimumMacOS: "13.0",
    manifestSha256: crypto.createHash("sha256").update(bytes).digest("hex") } } };
}

test("Android helper execution retains the selected managed package and refuses a missing pin", async t => {
  const selected = installed(t, "managed-current"), entry = { runtimeData: { klepton: { version: selected.version } } };
  const context = { userDataDir: "/owned/profile", settings: { runtimes: { android: { defaultVersion: "different-global" } } } };
  let selection = selected, verified = 0;
  t.mock.method(Manager, "resolveSelection", (game, settings, userDataDir) => {
    assert.equal(game, entry); assert.equal(settings, context.settings); assert.equal(userDataDir, context.userDataDir); return selection;
  });
  t.mock.method(Runtime, "resolveForLaunch", async (options, declaration) => {
    verified++; assert.equal(options.root, selected.install.root); assert.equal(declaration, selected.install.declaration); return selected;
  });
  assert.equal(Runtime.resolveSelected(entry, context).root, selected.install.root);
  assert.equal(await Runtime.resolveSelectedForLaunch(entry, context), selected);
  selection = { version: "missing-old", ready: false, reason: "The selected build is not installed." };
  assert.equal(Runtime.resolveSelected(entry, context), null);
  await assert.rejects(Runtime.resolveSelectedForLaunch(entry, context), /selected build is not installed/);
  assert.equal(verified, 1, "An absent version cannot verify or execute another package");
});

test("Android import metadata stays available without an installed Android runtime", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-no-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gamePath = path.join(root, "game.apk");
  fs.copyFileSync(path.resolve(__dirname, "fixtures/android-package-metadata/metadata.apk"), gamePath);
  // The included native reader supplies labels; the Android runtime is not involved.
  const Reader = require("../src/modules/android/tools/apk-metadata");
  t.mock.method(Reader, "inspect", async () => ({ schemaVersion: 1, packageName: "org.maclauncher.metadata.fixture", label: "Fixture", activityWindows: {}, iconFile: null }));
  t.mock.method(Manager, "resolveSelection", () => assert.fail("Import metadata does not select a runtime"));
  t.mock.method(Runtime, "resolveForLaunch", () => assert.fail("Import must not start or acquire a runtime"));
  assert.equal((await Metadata.read({ gameId: "game", gamePath }, { userDataDir: root })).label, "Fixture");
  assert.equal(Metadata.metadataCacheKey({ gamePath }, {}).metadata, undefined);
  t.mock.method(Manager, "resolveSelection", () => assert.fail("Package detection does not require an installed runtime"));
  const detected = require("../src/modules/android/detect").detectGame({
    inputPath: path.resolve(__dirname, "fixtures/android-package-metadata/metadata.apk") });
  assert.equal(detected.moduleData.packageName, "org.maclauncher.metadata.fixture");
});

test("Android graphics options follow the selected package while the metadata reader stays included", t => {
  const first = installed(t, "managed-metal", { packageMetadataVersion: 1 });
  const second = installed(t, "managed-vulkan", { packageMetadataVersion: 1, angleVulkanVersion: 1 });
  let selection = first;
  t.mock.method(Manager, "resolveSelection", () => selection);
  const Module = require("../src/modules/android/custom-main");
  const entry = { gamePath: path.join(first.install.root, "android-host.jar") }, context = {};
  const key = Metadata.metadataCacheKey(entry, context);
  assert.deepEqual(Module.actions.listAngleBackends(entry, null, context).angleBackends.map(item => item.value), ["metal"]);
  selection = second;
  assert.deepEqual(Module.actions.listAngleBackends(entry, null, context).angleBackends.map(item => item.value), ["metal", "vulkan"]);
  assert.ok(key.reader, "Metadata results are keyed by the included reader");
  assert.equal(Metadata.metadataCacheKey(entry, context).reader, key.reader, "The included reader does not follow the selected Android package");
  selection = { ready: false };
  assert.deepEqual(Module.settingsActions.listAngleBackends(null, context).angleBackends.map(item => item.value), ["metal"]);
});

test("Android media device listing uses the same selected managed runtime", async t => {
  const Media = require("../src/modules/android/media-inputs"), entry = {}, context = {};
  t.mock.method(Runtime, "resolveSelectedForLaunch", async (actualEntry, actualContext) => {
    assert.equal(actualEntry, entry); assert.equal(actualContext, context);
    return { root: "/managed/android", profile: { mediaInputsVersion: 1 } };
  });
  const java = { normalizeSettings: () => ({ lines: { 21: { defaultVersion: "21.0.9+10" } } }), core: { java: { resolveBestInstalled: options => {
    assert.equal(options.version, "21.0.9+10"); return { javaPath: "/java" };
  } } } };
  const result = await Media.listDevices(entry, null, context, { java, execute: async (_command, args) => {
    assert.ok(args.includes("/managed/android/android-host.jar"));
    return { stdout: JSON.stringify({ audioInputs: [], cameraInputs: [] }) };
  } });
  assert.equal(result.audioInputs[0].value, "");
});

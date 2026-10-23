const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Google = require("../src/modules/android/google-accounts"), Catalog = require("../src/modules/android/service-packages");
const Settings = require("../src/core/runtime-settings"), manifest = require("../src/modules/android/manifest.json");
function directory(t) { const value = fs.mkdtempSync(path.join(os.tmpdir(), "android-google-")); t.after(() => fs.rmSync(value, { recursive: true, force: true })); return value; }

test("Google integration requires a persisted per-game opt-in, independent of global settings", () => {
  const inherited = { modules: { android: { runtimeSettings: { klepton: { googleIntegration: true, googleAccount: "a".repeat(64) } } } } };
  const entry = { moduleId: "android" };
  assert.equal(Settings.resolveRuntimeSettingsForEntry(entry, inherited, manifest, "klepton").googleIntegration, false);
  assert.deepEqual(Google.selections(entry), { enabled: false, accountId: "" });
  entry.runtimeSettings = { klepton: { googleIntegration: true, googleAccount: "" } };
  assert.deepEqual(Google.selections(entry), { enabled: true, accountId: "" });
  entry.runtimeSettings = { klepton: { googleIntegration: true, googleAccount: "a".repeat(64) } };
  assert.deepEqual(Google.selections(entry), { enabled: true, accountId: "a".repeat(64) });
  assert.equal(Settings.resolveRuntimeSettingsForEntry(entry, inherited, manifest, "klepton").googleAccount, "a".repeat(64));
  entry.runtimeSettings.klepton.googleIntegration = false;
  assert.deepEqual(Google.selections(entry), { enabled: false, accountId: "" });
});

test("cached Settings account views read identities without acquiring any Android runtime", async t => {
  const userDataDir = directory(t);
  Google.replaceSnapshot(userDataDir, [{ providerPackage: "com.google.android.gms", type: "com.google", name: "actual@example.invalid" }]);
  t.mock.method(require("../src/modules/android/account-owner"), "acquire", () => { throw new Error("Unexpected runtime acquisition"); });
  const value = await Google.state({ userDataDir }, { refresh: false });
  assert.equal(value.accounts.length, 1); assert.equal(value.cached, true); assert.equal(value.canSignIn, true);
  const Macapk = require("../src/modules/android/providers/macapk/google-accounts"), Manager = require("../src/modules/android/providers/macapk/manager");
  t.mock.method(Manager, "resolveSelection", () => { throw new Error("Unexpected runtime selection"); });
  assert.deepEqual((await Macapk.state({ userDataDir }, { refresh: false })).accounts, []);
});

test("Account metadata contains only actual account identities and never fabricates sign-in", async t => {
  const userDataDir = directory(t), context = { userDataDir };
  t.mock.method(require("../src/modules/android/store/microg-caller"), "ensureGoogleServices", async () => { throw new Error("The Android account service is unavailable."); });
  assert.deepEqual(Google.choices(null, null, context), { googleAccounts: [{ value: "", label: "microG without an account" }] });
  assert.equal((await Google.state(context)).canSignIn, true);
  await assert.rejects(Google.signIn(context), /unavailable/);
  const [record] = Google.replaceSnapshot(userDataDir, [{ providerPackage: "com.google.android.gms", type: "com.google", name: "fixture@example.invalid", authToken: "must-not-persist" }]);
  assert.match(record.id, /^[a-f0-9]{64}$/);
  assert.equal(Google.read(userDataDir)[0].id, record.id);
  assert.equal(Google.choices(null, null, context).googleAccounts[1].value, record.id);
  assert.doesNotMatch(fs.readFileSync(path.join(userDataDir, "android/services/google-accounts.json"), "utf8"), /authToken|must-not-persist/);
  assert.throws(() => Google.replaceSnapshot(userDataDir, [{ providerPackage: "untrusted.app", type: "com.google", name: "fixture" }]), /invalid account/);
});

test("Explicit account actions use the installed provider online and preserve actual identities", async t => {
  const userDataDir = directory(t), calls = [], providerPackage = "com.google.android.gms", type = "com.google";
  t.mock.method(require("../src/modules/android/store/microg-caller"), "ensureGoogleServices", async () => { calls.push(["prepare"]); });
  let removed = false;
  t.mock.method(require("../src/modules/android/account-owner"), "acquire", async (_context, options) => {
    assert.equal(options.blockNetwork, false); assert.equal(options.allowAds, false);
    return { async request(command, payload) {
      calls.push([command, payload]);
      if (command === "removeAccount") { assert.deepEqual(payload, { type, name: "actual@example.invalid" }); removed = true; }
      return { authenticators: [{ providerPackage, type }], accounts: removed ? [] : [{ providerPackage, type, name: "actual@example.invalid" }], canSignIn: true };
    }, release() { calls.push(["release"]); } };
  });
  await Google.signIn({ userDataDir });
  assert.deepEqual(calls.map(item => item[0]), ["prepare", "accounts", "addAccount", "release"]);
  assert.deepEqual(calls[2][1], { type: "com.google" });
  await Google.remove(Google.read(userDataDir)[0].id, { userDataDir });
  assert.equal(Google.read(userDataDir).length, 0);
});

test("Account refresh saves only the real inventory and preserves the last snapshot on failure", async t => {
  const userDataDir = directory(t), context = { userDataDir };
  const providerPackage = "com.google.android.gms", type = "com.google";
  let fail = false, releases = 0;
  t.mock.method(Catalog, "read", () => ({ packages: [{ enabled: true, packageName: providerPackage }] }));
  t.mock.method(require("../src/modules/android/account-owner"), "acquire", async (request, options) => {
    assert.equal(options.blockNetwork, true); assert.equal(options.allowAds, false);
    assert.ok(request.signal instanceof AbortSignal);
    return { async request(command) {
      assert.equal(command, "accounts");
      if (fail) throw new Error("private-provider-token");
      return { authenticators: [{ providerPackage, type }], accounts: [
        { providerPackage, type, name: "actual@example.invalid", authToken: "private-provider-token" }
      ], canSignIn: false };
    }, release() { releases++; } };
  });
  const fresh = await Google.state(context);
  assert.equal(fresh.available, true); assert.equal(fresh.canSignIn, false);
  assert.equal(fresh.accounts[0].canRemove, false);
  assert.equal(Google.read(userDataDir)[0].name, "actual@example.invalid");
  fail = true;
  const stale = await Google.state(context);
  assert.equal(stale.available, false); assert.deepEqual(stale.accounts, fresh.accounts);
  assert.match(stale.message, /unavailable/); assert.doesNotMatch(JSON.stringify(stale), /private-provider-token/);
  assert.doesNotMatch(fs.readFileSync(path.join(userDataDir, "android/services/google-accounts.json"), "utf8"), /private-provider-token|authToken/);
  assert.equal(releases, 2);
});

test("Closing sign-in releases the operation and permits another explicit attempt", async t => {
  const userDataDir = directory(t), providerPackage = "com.google.android.gms", type = "com.google";
  t.mock.method(require("../src/modules/android/store/microg-caller"), "ensureGoogleServices", async () => {});
  let attempts = 0, releases = 0;
  const inventory = { authenticators: [{ providerPackage, type }], accounts: [], canSignIn: true };
  t.mock.method(require("../src/modules/android/account-owner"), "acquire", async (_context, options) => {
    assert.equal(options.blockNetwork, false);
    return { async request(command) {
      if (command === "addAccount" && ++attempts === 1)
        throw Object.assign(new Error("private provider message"), { code: "ACCOUNT_PROVIDER_ERROR", providerCode: 4 });
      return inventory;
    }, release() { releases++; } };
  });
  assert.deepEqual(await Google.signIn({ userDataDir }), { completed: false });
  assert.deepEqual(await Google.signIn({ userDataDir }), { completed: true });
  assert.equal(attempts, 2); assert.equal(releases, 2);
});

test("Google launch gate preserves unrelated installed Android services", async t => {
  const userDataDir = directory(t), context = { userDataDir }, preparedByName = new Map();
  for (const name of ["com.google.android.gms", "example.generic.service"]) {
    const key = (name.startsWith("com.google") ? "a" : "b").repeat(64);
    const source = path.join(userDataDir, "android/apps", Catalog.codeId(name), "prepared", key, "source.apk");
    fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, "service APK fixture");
    const prepared = { key, root: path.dirname(source), metadata: { packageName: name }, sourceApk: source, apkSha256: key };
    preparedByName.set(source, prepared);
    await Catalog.installServicePackage(source, context, {}, {}, { inspect: () => prepared.metadata, prepare: async () => prepared });
  }
  const options = { prepare: async entry => preparedByName.get(entry.gamePath), retain: () => async () => {},
    storage: async entry => ({ root: path.join(userDataDir, entry.gameId), filesRoot: path.join(userDataDir, entry.gameId, "data/files"), cacheRoot: path.join(userDataDir, entry.gameId, "data/cache") }) };
  const entry = { gameId: "caller" }, game = { metadata: { packageName: "example.game" } }, runtime = { profile: { servicePackagesVersion: 1 } };
  const off = await Catalog.prepareInstalled(entry, game, context, runtime, {}, options);
  assert.deepEqual(off.services.map(item => item.record.packageName), ["example.generic.service"]); await off.release();
  entry.runtimeSettings = { klepton: { googleIntegration: true } };
  const on = await Catalog.prepareInstalled(entry, game, context, runtime, {}, options);
  assert.deepEqual(on.services.map(item => item.record.packageName), ["com.google.android.gms", "example.generic.service"]); await on.release();
});

test("Central module settings actions run without a game and cannot dispatch arbitrary module actions", async t => {
  const userDataDir = directory(t), module = { id: "fixture", manifest: { id: "fixture" }, settingsActions: {
    accounts: async (payload, context) => ({ selected: payload.value, directory: context.userDataDir })
  }, actions: { install: () => { throw new Error("Unexpected acquisition"); } } };
  const registry = { listModuleIds: () => [module.id], listModules: () => [module.manifest], getModule: id => id === module.id ? module : null,
    getModuleInfo: () => module.manifest, getModuleDir: () => userDataDir, listSharedRuntimeManagers: () => [] };
  const operations = require("../src/core/backend-operations").createBackendOperations({ userDataDir, registry });
  assert.deepEqual(await operations.moduleSettingsAction("fixture", "accounts", { value: "actual-account" }), { selected: "actual-account", directory: userDataDir });
  await assert.rejects(operations.moduleSettingsAction("fixture", "install"), /unavailable/);
  await assert.rejects(operations.moduleSettingsAction("fixture", "toString"), /unavailable/);
});

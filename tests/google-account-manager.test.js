const test = require("node:test"), assert = require("node:assert/strict");
const { createGoogleAccountManager } = require("../src/modules/android/store/google-account-manager");
const { createModuleHostAccountActions } = require("../src/main/module-host-account-actions");
function vault() {
  const records = new Map();
  return { records, saveSession: async value => { records.set(value.accountName, structuredClone(value)); },
    loadSession: async key => records.get(key), listAccounts: async () => [...records.keys()].map(accountName => ({ accountName })),
    removeSession: async key => records.delete(key) };
}
test("Settings and External share browser registration, save before provider setup and never return secrets to Settings", async () => {
  const storage = vault(), calls = [], email = "account@example.invalid";
  let fail = true;
  const manager = createGoogleAccountManager({ vault: storage, browserAuth: { signIn: async options => {
    calls.push(options); return { email, aasToken: "private-master-token" };
  } }, microg: {
    importBrowserSession: async () => { assert.equal(storage.records.has("google-play"), true); if (fail) throw Error("provider setup"); return { id: "klepton:actual" }; },
    list: async options => { assert.equal(options.refresh, false); return { accounts: [{ id: "klepton:actual", accountId: "actual", provider: "klepton", label: email, cached: true }], providers: [] }; }
  } });
  await storage.saveSession({ accountName: "google-play", session: { email: "previous@example.invalid", mode: "browser", aasToken: "previous-private-token", browserAccountId: "previous-browser" } });
  await assert.rejects(manager.browserLogin({ email: "previous@example.invalid" }), /sign-in was saved/);
  assert.equal(storage.records.get("google-play").session.aasToken, "private-master-token");
  assert.equal(calls[0].email, undefined);
  assert.equal([...storage.records.values()].some(record => record.session.email === "previous@example.invalid"), true);
  fail = false;
  const result = await manager.signIn();
  assert.deepEqual(result, { completed: true, accountId: "klepton:actual" });
  assert.doesNotMatch(JSON.stringify(result), /private-master-token|aasToken|email/);
  assert.notEqual(calls[0].accountId, calls[1].accountId);
  const state = await manager.state(); assert.equal(state.accounts[0].id, "klepton:actual"); assert.equal(state.accounts[0].canRemove, true);
});
test("removing a real shared account clears matching saved credentials and preserves other providers", async () => {
  const storage = vault(), removed = [], cleared = [], account = { id: "klepton:one", accountId: "one", provider: "klepton", label: "same@example.invalid" };
  await storage.saveSession({ accountName: "first", session: { email: account.label, aasToken: "private", sharedAccountId: account.id, browserAccountId: "browser-one" } });
  await storage.saveSession({ accountName: "other", session: { mode: "microg", email: account.label, microgAccountId: "macapk:two" } });
  const manager = createGoogleAccountManager({ vault: storage, browserAuth: { clearAccount: async id => cleared.push(id) },
    microg: { list: async () => ({ accounts: [account] }), remove: async value => { removed.push(value.id); return { completed: true }; } },
    onRemoved: async value => removed.push(value.id) });
  await manager.remove({ provider: "klepton", accountId: "one" });
  assert.deepEqual(removed, ["klepton:one", "klepton:one"]); assert.deepEqual(cleared, ["browser-one"]);
  assert.deepEqual([...storage.records.keys()], ["other"]);
});
test("module metadata routes only declared host account actions", async () => {
  const calls = [], router = createModuleHostAccountActions({ getModule: () => ({ settingsHostAccountActions: {
    listAccounts: { manager: "fixture", action: "state", provider: "actual" }
  } }), managers: { fixture: { state: options => { calls.push(options); return { accounts: [] }; } } } });
  assert.equal(router.handles("fixture", "toString"), false);
  assert.deepEqual(router.run("fixture", "listAccounts", { refresh: false, provider: "other" }), { accounts: [] });
  assert.deepEqual(calls, [{ refresh: false, provider: "actual" }]);
  assert.throws(() => router.run("fixture", "toString"), /unavailable/);
});
test("Mac.apk browser sessions retain their provider when restored and same-email microG removal preserves them", async () => {
  const storage = vault(), imported = [], cleared = [], email = "shared@example.invalid";
  const manager = createGoogleAccountManager({ vault: storage,
    browserAuth: { signIn: async () => ({ email, aasToken: "fixture-private-token" }), clearAccount: async id => cleared.push(id) },
    microg: { importBrowserSession: async (_session, options) => { imported.push(options.provider); return { id: "macapk:actual" }; },
      list: async () => ({ accounts: [{ id: "klepton:other", accountId: "other", provider: "klepton", label: email }], providers: [] }),
      remove: async () => ({ completed: true }) }
  });
  assert.deepEqual(await manager.signIn({ provider: "macapk" }), { completed: true, accountId: "macapk:actual" });
  assert.equal(storage.records.get("google-play").session.accountProvider, "macapk");
  await manager.prepareSavedSession(); assert.deepEqual(imported, ["macapk", "macapk"]);
  await manager.remove({ provider: "klepton", accountId: "other" });
  assert.equal(storage.records.get("google-play").session.sharedAccountId, "macapk:actual"); assert.deepEqual(cleared, []);
});
test("both Settings panels expose the shared qualified account list and removal follows the chosen account provider", async () => {
  const storage = vault(), removed = [], accounts = [
    { id: "klepton:one", accountId: "one", provider: "klepton", source: "microG", label: "same@example.invalid" },
    { id: "macapk:two", accountId: "two", provider: "macapk", source: "Mac.apk", label: "same@example.invalid" }
  ];
  await storage.saveSession({ accountName: "first", session: { email: accounts[0].label, sharedAccountId: accounts[0].id, aasToken: "fixture-one" } });
  await storage.saveSession({ accountName: "second", session: { email: accounts[1].label, sharedAccountId: accounts[1].id, aasToken: "fixture-two" } });
  const manager = createGoogleAccountManager({ vault: storage, browserAuth: {}, microg: {
    list: async () => ({ accounts, providers: [{ id: "klepton", available: true }, { id: "macapk", available: true }] }),
    remove: async value => { removed.push(value.id); return { completed: true }; }
  } });
  const klepton = await manager.state({ provider: "klepton" }), macapk = await manager.state({ provider: "macapk" });
  assert.deepEqual(klepton.accounts, macapk.accounts); assert.deepEqual(klepton.accounts.map(account => account.id), ["klepton:one", "macapk:two"]);
  assert.deepEqual(klepton.accounts.map(account => account.label), ["same@example.invalid (microG)", "same@example.invalid (Mac.apk)"]);
  await manager.remove({ provider: "klepton", accountId: "macapk:two" });
  assert.deepEqual(removed, ["macapk:two"]); assert.deepEqual([...storage.records.keys()], ["first"]);
});

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createMicrogAccounts, PLAY_SCOPE } = require("../src/modules/android/store/microg-accounts");
const { materializeControl } = require("../src/modules/android/store/custom-account-token");
const Google = require("../src/modules/android/google-accounts");
const id = "a".repeat(64), token = "private-provider-scoped-token";
function fixture(t) { const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "google-play-microg-")); t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true })); return { userDataDir }; }

test("cached account listing stays offline and setup remains available before provider acquisition", async t => {
  const context = fixture(t); let states = 0, tokens = 0;
  const adapter = createMicrogAccounts({ context, dependencies: { providers: [{ id: "klepton", label: "microG",
    read: () => [{ id, name: "account@example.invalid", masterToken: "must-not-leave-provider" }],
    state: async context => { states++; assert.equal(context.networkAllowed, false); return { available: false, providerInstalled: false }; },
    token: async () => { tokens++; return { token }; }, signIn() {} }] } });
  t.after(() => adapter.dispose());
  const cached = await adapter.list(); assert.equal(states, 0); assert.equal(tokens, 0); assert.equal(cached.accounts.length, 1);
  assert.equal(cached.accounts[0].id, "klepton:" + id); assert.equal(JSON.stringify(cached).includes("must-not-leave-provider"), false);
  const fresh = await adapter.list({ refresh: true }); assert.equal(states, 1); assert.equal(tokens, 0);
  assert.equal(fresh.accounts[0].available, true); assert.equal(fresh.accounts[0].needsSetup, true);
  const authorization = await adapter.getToken({ id: "klepton:" + id }); assert.equal(authorization.authToken, token); assert.equal(tokens, 1);
  assert.equal(JSON.stringify(await adapter.list()).includes(token), false);
});

test("Mac.apk account reuse passes a real caller APK to signature verification and refreshes through its provider", async t => {
  const context = fixture(t), calls = []; let releases = 0, callerReleases = 0;
  const account = { id, name: "account@example.invalid", type: "com.google" };
  const adapter = createMicrogAccounts({ context, dependencies: {
    klepton: { read: () => [] },
    resolveCaller: async () => ({ apks: ["/published/companion.apk"], release() { callerReleases++; } }),
    macapk: { snapshot: () => [account], state: async () => ({ available: true }),
      acquire: async (_context, options) => {
        assert.equal(options.networkAllowed, true); assert.equal(options.install, true);
        assert.deepEqual(options.packageSet, { apks: ["/published/companion.apk"], metadata: { packageName: "com.android.vending" } });
        return { accounts: async () => ({ accounts: [account] }), token: async (operation, selected, data) => {
          calls.push({ operation, selected, data }); return { token, expirySeconds: 1800 };
        }, release() { releases++; } };
      } } } });
  t.after(() => adapter.dispose());
  const first = await adapter.getToken({ id: "macapk:" + id }); assert.equal(first.authToken, token); assert.equal(first.expirySeconds, 1800);
  assert.equal(calls[0].data.service, PLAY_SCOPE); assert.equal(calls[0].selected.name, account.name);
  await adapter.getToken({ id: "macapk:" + id, refresh: true });
  assert.deepEqual(calls.map(call => call.operation), ["token", "invalidateToken", "token"]); assert.equal(calls[1].data.token, token);
  assert.equal(releases, 2); assert.equal(callerReleases, 2);
});

test("custom microG reuse keeps master storage private and disposal cancels active authorization", async t => {
  const context = fixture(t); const [account] = Google.replaceSnapshot(context.userDataDir, [{ providerPackage: "com.google.android.gms", type: "com.google", name: "account@example.invalid" }]);
  let started, cancelled = false;
  const adapter = createMicrogAccounts({ context, dependencies: { macapk: { snapshot: () => [] }, customToken: async (current, selected, { signal }) => {
    assert.equal(current.networkAllowed, true); assert.equal(selected.accountId, account.id); started = true;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { cancelled = true; reject(Object.assign(new Error("cancelled"), { name: "AbortError" })); }, { once: true }));
  } } });
  const request = adapter.getToken({ id: "klepton:" + account.id }); request.catch(() => {});
  while (!started) await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.hasPending(), true); await adapter.dispose(); await assert.rejects(request, { name: "AbortError" });
  assert.equal(cancelled, true); assert.equal(adapter.hasPending(), false);
  assert.doesNotMatch(fs.readFileSync(path.join(context.userDataDir, "android/services/google-accounts.json"), "utf8"), /Token|master|private/);
});

test("the included account-control overlay is hash verified and needs no Java compiler at runtime", async t => {
  const context = fixture(t), cache = path.join(context.userDataDir, "cache"); fs.mkdirSync(cache);
  const output = await materializeControl(context, {}, { javaPath: "/no-compiler-required/java" }, cache);
  const record = require("../src/modules/android/store/resources/account-control.json");
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(output)).digest("hex"), record.sha256);
  assert.equal(path.extname(output), ".jar"); assert.equal(fs.statSync(output).mode & 0o777, 0o400);
});

test("browser sign-in registers with the actual provider before exposing a shared account reference", async t => {
  const context = fixture(t), session = { email: "account@example.invalid", aasToken: "private-browser-master-token", androidId: "1234567890abcdef" };
  let imported = false, inventoried = false;
  const adapter = createMicrogAccounts({ context, dependencies: {
    importSession: async (current, value, { signal }) => {
      assert.equal(current.userDataDir, context.userDataDir); assert.deepEqual(value, session); assert.equal(signal.aborted, false);
      imported = true;
    }, providers: [{ id: "klepton", label: "microG",
      state: async current => { assert.equal(imported, true); assert.equal(current.networkAllowed, false); inventoried = true; return { available: true }; },
      read: () => inventoried ? [{ id, name: session.email }] : [], token: async () => ({ token }) }]
  } });
  t.after(() => adapter.dispose());
  assert.equal((await adapter.list()).accounts.length, 0);
  const account = await adapter.importBrowserSession(session);
  assert.equal(account.id, "klepton:" + id); assert.equal(account.provider, "klepton"); assert.equal(account.cached, false);
  assert.doesNotMatch(JSON.stringify(account), /master-token|aasToken|androidId/);
  assert.equal((await adapter.list()).accounts[0].id, account.id);
});

test("a provider registration without a real returned account cannot manufacture shared account metadata", async t => {
  const context = fixture(t), adapter = createMicrogAccounts({ context, dependencies: {
    importSession: async () => ({ imported: true }), providers: [{ id: "klepton", label: "microG",
      state: async () => ({ available: true }), read: () => [] }]
  } });
  t.after(() => adapter.dispose());
  await assert.rejects(adapter.importBrowserSession({ email: "account@example.invalid", aasToken: "private-token" }), /not returned by the Android account manager/);
  assert.equal((await adapter.list()).accounts.length, 0);
});
test("browser registration targets Mac.apk alone and retains its separate account identity", async t => {
  const context = fixture(t), session = { email: "browser@example.invalid", aasToken: "fixture-master-token" }, calls = [];
  let imported = false;
  const adapter = createMicrogAccounts({ context, dependencies: {
    klepton: { read: () => [], state: () => { throw Error("Other provider must remain untouched"); } },
    macapk: { snapshot: () => imported ? [{ id, name: session.email }] : [],
      importBrowserSession: async (current, value) => { assert.equal(current.userDataDir, context.userDataDir); assert.deepEqual(value, session); calls.push("import"); imported = true; },
      state: async current => { assert.equal(current.networkAllowed, false); calls.push("state"); return { available: true }; } }
  } });
  t.after(() => adapter.dispose());
  const account = await adapter.importBrowserSession(session, { provider: "macapk" });
  assert.equal(account.id, "macapk:" + id); assert.equal(account.provider, "macapk"); assert.deepEqual(calls, ["import", "state"]);
  assert.doesNotMatch(JSON.stringify(account), /master-token|aasToken/);
});

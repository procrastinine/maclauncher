const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const Google = require("../src/modules/android/providers/macapk/google-accounts");
const Manager = require("../src/modules/android/providers/macapk/manager");
const app = process.env.MACAPK_TEST_APP, apk = process.env.MACAPK_TEST_APK;
function directory(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "macapk-google-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function control(root, request, { verifier = false } = {}) {
  const classpath = [Manager.policyJar, path.join(app, "Contents/lib/android-framework.jar"), path.join(app, "Contents/lib/macapk-loader.jar")];
  if (verifier) classpath.push(Google.signatureVerifier());
  const output = execFileSync(path.join(app, "Contents/Resources/jre/bin/java"), ["-Djava.awt.headless=true", "-Duser.home=" + root,
    "--add-exports=java.base/jdk.internal.org.objectweb.asm=ALL-UNNAMED", "-javaagent:" + Manager.policyJar + "=account-owner",
    "-cp", classpath.join(path.delimiter), "com.maclauncher.android.macapk.AccountControl"], {
    input: JSON.stringify(request) + "\n", encoding: "utf8", timeout: 15000,
    env: { PATH: "/usr/bin:/bin", HOME: root, MACAPK_GMS_DIR: path.join(root, "gms"), MACAPK_GMS_KEYCHAIN: "0", MACAPK_LOG_LEVEL: "7", MACAPK_OFFLINE: "1" },
    stdio: ["pipe", "pipe", "pipe"] });
  return JSON.parse(output);
}
test("Mac.apk Google access defaults off without preparing accounts or packages", async t => {
  const root = directory(t);
  t.mock.method(Manager, "resolveSelection", () => { throw new Error("No account runtime should be queried"); });
  assert.deepEqual(Google.selections({ runtimeSettings: {} }), { enabled: false, id: "" });
  assert.equal(await Google.prepareLaunch({ entry: {}, context: { userDataDir: root, runtimeSettings: {} }, policy: { networkAllowed: true } }), null);
  assert.deepEqual(fs.readdirSync(root), []);
});
test("Original Mac.apk account store remains private and offline; app token peeks do not expose its shared cache", { skip: !app }, t => {
  const root = directory(t), gms = path.join(root, "gms"), store = path.join(gms, "gms_state.properties"); fs.mkdirSync(gms, { mode: 0o700 });
  fs.writeFileSync(store, "account.fixture@example.invalid.masterToken=fixture-not-a-credential\ncheckin.androidId=123\ntoken.fixture@example.invalid.oauth2:test.value=another-app-cache\n", { mode: 0o600 });
  const reply = control(root, { operation: "accounts" });
  assert.deepEqual(reply, { ok: true, accounts: [{ name: "fixture@example.invalid", type: "com.google" }] });
  const selected = { account: "fixture@example.invalid", service: "oauth2:test", packageName: "example.fixture", certificateSha1: "a".repeat(40) };
  assert.deepEqual(control(root, { operation: "peekToken", ...selected }), { ok: true });
  assert.deepEqual(control(root, { operation: "token", ...selected, networkAllowed: false }), { ok: false, error: { code: 3 } });
  assert.deepEqual(control(root, { operation: "remove", account: selected.account }), { ok: true, completed: true });
  assert.deepEqual(control(root, { operation: "accounts" }), { ok: true, accounts: [] });
  const remaining = fs.readFileSync(store, "utf8"); assert.ok(!remaining.includes("fixture-not-a-credential")); assert.match(remaining, /checkin\.androidId=123/);
  assert.equal(fs.statSync(store).mode & 0o777, 0o600);
});
test("Browser registration uses the original Mac.apk public account API without a sign-in window or token output", { skip: !app }, t => {
  const root = directory(t), email = "browser@example.invalid", aasToken = "fixture-browser-token";
  assert.deepEqual(control(root, { operation: "register", account: email, aasToken, networkAllowed: false }), { ok: true, completed: true });
  assert.deepEqual(control(root, { operation: "accounts" }), { ok: true, accounts: [{ name: email, type: "com.google" }] });
  const store = path.join(root, "gms/gms_state.properties");
  assert.equal(fs.statSync(store).mode & 0o777, 0o600);
  assert.deepEqual(control(root, { operation: "register", account: email, aasToken: "invalid token" }), { ok: false, error: { code: 9 } });
  assert.deepEqual(control(root, { operation: "remove", account: email }), { ok: true, completed: true });
});
test("Mac.apk browser import passes credentials only through the trusted request and verifies the resulting account", async t => {
  const context = { userDataDir: directory(t) }, session = { email: "browser@example.invalid", aasToken: "fixture-browser-token" }, calls = [];
  let released = 0;
  const result = await Google.importBrowserSession(context, session, {}, { acquire: async (_current, options) => {
    assert.deepEqual(options, { networkAllowed: false, install: true });
    return { run: async request => { calls.push(request); return { completed: true }; },
      accounts: async () => ({ accounts: [{ name: session.email, id: "a".repeat(64) }] }), release: async () => { released++; } };
  } });
  assert.deepEqual(calls, [{ operation: "register", account: session.email, aasToken: session.aasToken }]);
  assert.deepEqual(result, { completed: true, accountId: "a".repeat(64) }); assert.equal(released, 1);
  assert.doesNotMatch(JSON.stringify(result), /token|aasToken|email/);
  await assert.rejects(Google.importBrowserSession(context, { ...session, aasToken: "invalid token" }), { code: "AUTHORIZATION_FAILED" });
});
test("Publisher APK verifier binds real package and SHA1 identity and rejects changed signed content", { skip: !app || !apk }, t => {
  const root = directory(t), verified = control(root, { operation: "verify", apks: [apk] }, { verifier: true });
  assert.equal(verified.ok, true); assert.ok(verified.packageName); assert.ok(verified.signers.length);
  assert.ok(verified.signers.every(value => /^[a-f0-9]{64}$/.test(value.sha256) && /^[a-f0-9]{40}$/.test(value.sha1)));
  const changed = path.join(root, "changed.apk"); fs.copyFileSync(apk, changed, fs.constants.COPYFILE_FICLONE || 0);
  const entry = require("../src/modules/android/apk").withApk(changed, value => value.entries.find(item => item.name === "classes.dex"));
  assert.ok(entry && entry.compressedSize > 100);
  const fd = fs.openSync(changed, "r+"), header = Buffer.alloc(30), byte = Buffer.alloc(1);
  try {
    fs.readSync(fd, header, 0, header.length, entry.absoluteLocalHeaderOffset);
    const offset = entry.absoluteLocalHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28) + Math.min(4096, Math.floor(entry.compressedSize / 2));
    fs.readSync(fd, byte, 0, 1, offset); byte[0] ^= 1; fs.writeSync(fd, byte, 0, 1, offset);
  } finally { fs.closeSync(fd); }
  assert.equal(control(root, { operation: "verify", apks: [changed] }, { verifier: true }).ok, false);
});

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), net = require("node:net");
const Accounts = require("../src/modules/android/provider-google-accounts");
const Profile = require("../src/modules/android/google/profile");
const Packages = require("../src/modules/android/google/packages");
const Owner = require("../src/modules/android/google/owner");
const Broker = require("../src/modules/android/google/broker");
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-google-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function exchange(socketPath, value) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath); let pending = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Broker reply timed out")); }, 5000);
    socket.once("connect", () => socket.write(JSON.stringify(value) + "\n"));
    socket.once("error", reject); socket.on("data", data => {
      pending += data; const at = pending.indexOf("\n");
      if (at >= 0) { clearTimeout(timer); socket.end(); resolve(JSON.parse(pending.slice(0, at))); }
    });
  });
}
test("Google selections retain off, anonymous and one account independently of provider", () => {
  for (const preferredRuntime of ["aim", "macapk"]) {
    const id = "a".repeat(64);
    assert.deepEqual(Accounts.selections({ preferredRuntime, runtimeSettings: { [preferredRuntime]: { googleIntegration: false, googleAccount: id } } }),
      { enabled: false, accountId: "", mode: "off" });
    assert.equal(Accounts.selections({ googleIntegration: true }).mode, "anonymous");
    assert.equal(Accounts.selections({ googleIntegration: true, googleAccount: id }).accountId, id);
  }
  assert.throws(() => Accounts.selections({ googleIntegration: true, googleAccount: "unverified-name" }), /invalid/);
});
test("Google profile snapshots contain actual identity metadata without credential fields", t => {
  const root = directory(t), stored = Profile.saveSnapshot(root, [{ type: "com.google", name: "fixture@example.invalid", password: "private-password", token: "private-token" }]);
  assert.equal(stored.length, 1); assert.equal(Profile.readSnapshot(root)[0].id, stored[0].id);
  const paths = Profile.profilePaths(root), data = fs.readFileSync(paths.metadataFile, "utf8");
  assert.doesNotMatch(data, /password|private-token|private-password/);
  assert.equal(fs.statSync(paths.metadataFile).mode & 0o777, 0o600);
  assert.throws(() => Profile.saveSnapshot(root, [{ type: "unrelated", name: "fixture" }]), /invalid identity/);
});
test("declining microG acquisition creates no package download or service", async t => {
  const root = directory(t); let downloaded = false;
  await assert.rejects(Packages.ensurePackages({ userDataDir: root }, {
    confirmToolInstall: async () => { throw Object.assign(new Error("Canceled"), { name: "AbortError" }); },
    downloadToFile: async () => { downloaded = true; }, withRuntimeMutation: () => assert.fail("No install after cancellation")
  }), /Canceled/);
  assert.equal(downloaded, false); assert.equal(fs.existsSync(path.join(root, "android")), false);
});
test("account token requests use the verified canonical package identity", async t => {
  const root = directory(t), calls = [], signers = ["a".repeat(64)], account = { name: "fixture@example.invalid", type: "com.google" };
  const owner = await Owner.acquire({ userDataDir: root }, { networkAllowed: true, packages: {},
    caller: { packageName: "example.original", signers, apks: ["/fixture.apk"] } }, { aim: {
    acquireGoogleSystem: async () => ({ installCaller: async apks => calls.push(["install", apks]), release: async () => {},
      request: async request => { calls.push(request); return { ok: true, result: request.operation === "verifyCaller"
        ? { packageName: "example.original", uid: 10042 } : { token: "fixture-scope-token" } }; } })
  } });
  await owner.token("token", account, { packageName: "example.impersonated", signers: ["b".repeat(64)], service: "oauth2:fixture" });
  assert.equal(calls[2].packageName, "example.original"); assert.deepEqual(calls[2].signers, signers);
  await owner.release();
});
test("Google broker authenticates the kernel peer and filters account/network grants", { skip: process.platform !== "darwin" }, async t => {
  const account = { name: "fixture@example.invalid", type: "com.google" }; let tokenCalls = 0;
  const broker = await Broker.create({ networkAllowed: false, account, owner: { caller: { packageName: "example.original" },
    accounts: async () => ({ accounts: [account] }), token: async () => { tokenCalls++; return { token: "must-not-return" }; } } });
  t.after(() => broker.close()); broker.enroll(process.pid);
  const base = { capability: broker.capability, pid: 1, callerUid: 0 };
  const accounts = await exchange(broker.socket, { ...base, operation: "accounts" });
  assert.deepEqual(accounts, { ok: true, accounts: [account] });
  const denied = await exchange(broker.socket, { ...base, operation: "token", account, service: "oauth2:fixture" });
  assert.equal(denied.error.code, 3); assert.equal(tokenCalls, 0);
  const wrongAccount = await exchange(broker.socket, { ...base, operation: "token", account: { ...account, name: "other@example.invalid" }, service: "oauth2:fixture" });
  assert.equal(wrongAccount.error.code, 9);
  const wrongSecret = await exchange(broker.socket, { ...base, capability: "b".repeat(64), operation: "accounts" });
  assert.equal(wrongSecret.error.code, 9);
});
test("a guest-supplied process ID cannot replace the authenticated peer", async t => {
  const broker = await Broker.create({ account: null, owner: { caller: { packageName: "example.original" }, token: async () => assert.fail("No token delegation") } },
    { resolvePeerPid: async () => 6789, isDescendant: async (pid, enrolled) => { assert.equal(pid, 6789); assert.equal(enrolled, 1234); return false; } });
  t.after(() => broker.close()); broker.enroll(1234);
  const reply = await exchange(broker.socket, { capability: broker.capability, pid: 1234, operation: "accounts" });
  assert.equal(reply.error.code, 9);
});
test("official microG artifacts match manifest, published digest and signer", { skip: !process.env.MACLAUNCHER_MICROG_TEST_PACKAGES }, () => {
  const { verifyPublishedApk } = require("../src/modules/android/google/apk-identity");
  for (const pin of Packages.catalog.packages) {
    const identity = verifyPublishedApk(path.join(process.env.MACLAUNCHER_MICROG_TEST_PACKAGES, pin.filename), pin);
    assert.equal(identity.packageName, pin.packageName); assert.deepEqual(identity.signers, pin.signers);
  }
});

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { EventEmitter } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { createSteamDownloads } = require("../src/core/steam-downloads");
const { EAuthSessionGuardType: Guards, EAuthTokenPlatformType: Platforms } = require("steam-session");

class Client extends EventEmitter {
  constructor() { super(); this.logins = []; }
  logOn(details) { this.logins.push(details); setImmediate(() => { this.emit("loggedOn"); this.emit("ownershipCached"); }); }
  logOff() { this.loggedOff = true; }
  async getContentServers() { return { servers: [] }; }
  getOwnedApps() { return []; }
}
function fixture(t, actions, extra = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "steam-authentication-"));
  const clients = [], sessions = [], saves = [];
  class TestClient extends Client { constructor(...args) { super(...args); clients.push(this); } }
  class Login extends EventEmitter {
    constructor(platform) { super(); this.platform = platform; this.submissions = []; sessions.push(this); }
    async startWithCredentials(details) { this.details = details; return { actionRequired: true, validActions: actions }; }
    async startWithQR() { return { actionRequired: true, validActions: [{ type: Guards.DeviceConfirmation }], qrChallengeUrl: "https://s.team/q/1/123456789/EXAMPLE" }; }
    async submitSteamGuardCode(code) {
      this.submissions.push(code);
      if (this.rejectNext) { this.rejectNext = false; throw Object.assign(new Error("secret internal details"), { eresult: 88 }); }
      this.approve();
    }
    approve(accountName = "example") { this.accountName = accountName; this.refreshToken = "private-refresh-token"; this.emit("authenticated"); }
    cancelLoginAttempt() { this.cancelled = true; }
  }
  const service = createSteamDownloads({ userDataDir, homeDir: userDataDir, accountName: "example", SteamUser: TestClient, LoginSession: Login,
    loadSharedLibrary: async () => [], saveSession: session => saves.push(session), ...extra });
  t.after(async () => { await service.dispose(); fs.rmSync(userDataDir, { recursive: true, force: true }); });
  return { service, clients, sessions, saves, userDataDir };
}
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) { const value = predicate(); if (value) return value; await delay(5); }
  assert.fail("Steam authentication did not reach the expected state.");
}

test("mobile approval remains active and authenticated client tokens reach SteamUser after account verification", async t => {
  const f = fixture(t, [{ type: Guards.DeviceConfirmation }, { type: Guards.DeviceCode }]);
  await f.service.connect({ accountName: "example", password: "private-password", remember: true });
  const login = f.sessions[0], guard = f.service.snapshot().connection.guard;
  assert.equal(login.platform, Platforms.SteamClient); assert.equal(guard.kind, "mobile"); assert.deepEqual(guard.codeKinds, ["totp"]);
  assert.equal(login.cancelled, undefined, "An approval challenge must keep polling"); assert.equal(f.clients[0].logins.length, 0);
  login.emit("remoteInteraction"); assert.equal(f.service.snapshot().connection.guard.remoteInteraction, true);
  login.approve(); await until(() => f.service.snapshot().connection.status === "connected");
  assert.equal(f.clients[0].logins[0].refreshToken, "private-refresh-token"); assert.equal(f.clients[0].logins[0].password, undefined);
  await until(() => f.saves.length === 1); assert.deepEqual(f.saves[0], { accountName: "example", refreshToken: "private-refresh-token" });
  assert.equal(JSON.stringify(f.service.snapshot()).includes("private-"), false);
});

test("email and authenticator codes stay in the same session and rejected codes can be retried", async t => {
  const f = fixture(t, [{ type: Guards.EmailCode, detail: "example.invalid" }]);
  await f.service.connect({ accountName: "example", password: "private-password", remember: false });
  const login = f.sessions[0]; login.rejectNext = true;
  assert.equal(f.service.snapshot().connection.guard.kind, "email"); assert.equal(f.service.snapshot().connection.guard.domain, "example.invalid");
  await f.service.submitAuth({ code: "ABCDE" }); assert.equal(f.service.snapshot().connection.guard.lastCodeWrong, true);
  assert.equal(login.cancelled, undefined); assert.equal(f.sessions.length, 1); assert.equal(JSON.stringify(f.service.snapshot()).includes("secret internal"), false);
  await f.service.submitAuth({ code: "FGHIJ" }); await until(() => f.service.snapshot().connection.status === "connected");
  assert.deepEqual(login.submissions, ["ABCDE", "FGHIJ"]); assert.equal(f.saves.length, 0);
});

test("email confirmation supports approval without inventing a code requirement", async t => {
  const f = fixture(t, [{ type: Guards.EmailConfirmation, detail: "example.invalid" }]);
  await f.service.connect({ accountName: "example", password: "private-password" });
  assert.equal(f.service.snapshot().connection.guard.kind, "email-approval"); assert.deepEqual(f.service.snapshot().connection.guard.codeKinds, []);
  await assert.rejects(f.service.submitAuth({ code: "ABCDE" }), /Approve the Steam sign-in request/);
  f.sessions[0].approve(); await until(() => f.service.snapshot().connection.status === "connected");
});

test("QR challenges encode the actual issued URL and reject approval by another account", async t => {
  const f = fixture(t, []);
  await f.service.connect({ accountName: "example", authMethod: "qr", remember: true });
  const guard = f.service.snapshot().connection.guard;
  assert.equal(guard.kind, "qr"); assert.equal(guard.qrChallengeUrl, "https://s.team/q/1/123456789/EXAMPLE");
  assert.ok(guard.qrImageUrl.startsWith("data:image/svg+xml")); assert.match(decodeURIComponent(guard.qrImageUrl), /<svg/);
  f.sessions[0].approve("other-account");
  assert.equal(f.service.snapshot().connection.status, "error"); assert.match(f.service.snapshot().connection.error, /different account/);
  assert.equal(f.clients[0].logins.length, 0); assert.deepEqual(f.saves, []);
});

test("cancelling one authentication attempt stops polling and ignores late approval without deleting saved accounts", async t => {
  const saved = { accountName: "example", refreshToken: "older-saved-session" };
  const f = fixture(t, [{ type: Guards.DeviceConfirmation }], { loadSession: () => saved });
  await f.service.connect({ accountName: "example", password: "private-password" }); const login = f.sessions[0];
  f.service.disconnect(); assert.equal(login.cancelled, true); login.approve(); await delay(5);
  assert.equal(f.service.snapshot().connection.status, "disconnected"); assert.equal(f.clients[0].logins.length, 0); assert.deepEqual(f.saves, []);
  assert.equal(saved.refreshToken, "older-saved-session");
  await f.service.connect({ accountName: "example" }); await until(() => f.service.snapshot().connection.status === "connected");
  assert.equal(f.clients[1].logins[0].refreshToken, "older-saved-session");
});

test("challenge timeout reports an actionable failure and cancels session polling", async t => {
  const f = fixture(t, [{ type: Guards.DeviceConfirmation }]); await f.service.connect({ accountName: "example", password: "private-password" });
  f.sessions[0].emit("timeout"); assert.equal(f.service.snapshot().connection.status, "error"); assert.match(f.service.snapshot().connection.error, /timed out/);
  assert.equal(f.sessions[0].cancelled, true); assert.equal(f.clients[0].logins.length, 0);
});

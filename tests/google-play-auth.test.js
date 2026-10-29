const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createGooglePlayAuth, exchangeGoogleOAuthToken, GOOGLE_SIGN_IN_URL, GOOGLE_AUTH_URL } = require("../src/modules/android/store/google-play-auth");

const EMAIL = "example@gmail.com", OAUTH = "oauth2_4/example-private-browser-token", AAS = "oauth2rt_example-private-master-token==";
const tick = () => new Promise(resolve => setImmediate(resolve));
class Cookies extends EventEmitter {
  constructor() { super(); this.values = []; this.removed = []; }
  async get(filter) { assert.equal(filter.url, "https://accounts.google.com/"); assert.equal(filter.name, "oauth_token"); return this.values; }
  async remove(url, name) { this.removed.push({ url, name }); this.values = []; }
  async flushStore() {}
  token(domain = ".google.com") { const value = { name: "oauth_token", domain, path: "/", secure: true, value: OAUTH }; this.values = [value]; this.emit("changed", {}, value, "explicit", false); }
}
class Contents extends EventEmitter {
  constructor() { super(); this.url = "about:blank"; this.email = EMAIL; this.scripts = []; }
  getURL() { return this.url; }
  async executeJavaScript(source) { this.scripts.push(source); return this.email; }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
}
class Window extends EventEmitter {
  constructor(options) { super(); this.options = options; this.webContents = new Contents(); this.closed = false; this.focusCount = 0; }
  loadURL(url) { this.webContents.url = url; return Promise.resolve(); }
  isDestroyed() { return this.closed; }
  show() { this.shown = true; }
  focus() { this.focusCount++; }
  close() { this.closed = true; this.emit("closed"); }
}
function fixture(t, settings = {}) {
  const sessions = new Map(), windows = [], exchanges = [];
  const auth = createGooglePlayAuth({ userDataDir: "/tmp/maclauncher-google-play-auth-profile", createWindow: options => { const window = new Window(options); windows.push(window); return window; },
    getSession: partition => {
      const session = { partition, cookies: new Cookies(), async clearStorageData() { this.cleared = true; }, async clearCache() { this.cacheCleared = true; },
        setPermissionRequestHandler(handler) { this.permissionRequest = handler; }, setPermissionCheckHandler(handler) { this.permissionCheck = handler; }, setDevicePermissionHandler(handler) { this.devicePermission = handler; } };
      sessions.set(partition, session); return session;
    }, exchangeToken: async details => { exchanges.push(details); return { email: EMAIL, aasToken: AAS, androidId: details.androidId }; }, ...settings });
  t.after(() => auth.dispose()); return { auth, sessions, windows, exchanges };
}

test("Google browser sign-in stays isolated and returns only the verified exchanged session", async t => {
  const f = fixture(t); assert.equal(f.sessions.size, 0); assert.equal(f.windows.length, 0);
  const pending = f.auth.signIn({ accountId: "one", androidId: "abcdef123456", remember: true }); await tick();
  const window = f.windows[0], browserSession = [...f.sessions.values()][0], preferences = window.options.webPreferences;
  assert.equal(window.webContents.getURL(), GOOGLE_SIGN_IN_URL); assert.ok(browserSession.partition.startsWith("persist:external-google-play-"));
  assert.equal(window.shown, true); assert.ok(window.focusCount > 0, "Sign-in opens and focuses before ready-to-show");
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.webSecurity, true); assert.equal(Object.hasOwn(preferences, "preload"), false); assert.equal(preferences.webviewTag, false);
  assert.equal(browserSession.permissionCheck(), false); let permission; browserSession.permissionRequest(null, "media", result => { permission = result; }); assert.equal(permission, false);
  assert.equal(f.auth.signIn({ accountId: "one" }), pending); assert.equal(f.windows.length, 1); assert.equal(f.auth.focus("one"), true);
  browserSession.cookies.token(); const session = await pending;
  assert.equal(session.email, EMAIL); assert.equal(session.aasToken, AAS); assert.equal(session.androidId, "abcdef123456");
  assert.equal(f.exchanges.length, 1); assert.equal(f.exchanges[0].oauthToken, OAUTH); assert.equal(f.exchanges[0].email, EMAIL);
  assert.ok(window.webContents.scripts.every(source => !/password|\.value\b/.test(source)));
  assert.equal(window.closed, true); assert.equal(browserSession.cookies.values.length, 0); assert.equal(browserSession.cleared, undefined);
  assert.equal(f.auth.focus("one"), false);
});

test("Google sign-in cancellation and Forget affect only the selected account partition", async t => {
  const f = fixture(t), controller = new AbortController();
  const first = f.auth.signIn({ accountId: "one", signal: controller.signal }); await tick();
  const second = f.auth.signIn({ accountId: "two" }); await tick();
  controller.abort(); await assert.rejects(first, { name: "AbortError", code: "ABORT_ERR" });
  assert.equal(f.windows[0].closed, true); assert.equal(f.windows[1].closed, false); assert.equal(f.exchanges.length, 0);
  await f.auth.clearAccount("one");
  for (const [partition, session] of f.sessions) if (partition === f.auth.partitionFor("two")) assert.equal(session.cleared, undefined); else assert.equal(session.cleared, true);
  f.auth.cancel("two"); await assert.rejects(second, { name: "AbortError" });
  const temporary = f.auth.signIn({ accountId: "temporary", remember: false }); await tick();
  const session = f.sessions.get(f.auth.partitionFor("temporary", false)); assert.ok(session); assert.equal(session.partition.startsWith("persist:"), false);
  session.cookies.token(); await temporary; assert.equal(session.cleared, true);
});

test("Google browser auth rejects foreign origins and mismatched account identities", async t => {
  const f = fixture(t); const pending = f.auth.signIn({ email: "selected@gmail.com" }); await tick();
  const window = f.windows[0], session = [...f.sessions.values()][0]; let blocked = false;
  window.webContents.emit("will-navigate", { preventDefault: () => { blocked = true; } }, "https://accounts.google.com.attacker.invalid/signin"); assert.equal(blocked, true);
  assert.deepEqual(window.webContents.openHandler({ url: "file:///tmp/escape" }), { action: "deny" });
  session.cookies.token(".attacker.invalid"); await tick(); assert.equal(f.exchanges.length, 0);
  session.cookies.token(); await assert.rejects(pending, /different Google account/); assert.equal(f.exchanges.length, 0);
});

test("Google OAuth exchange pins the endpoint, preserves tokens privately and validates server identity", async () => {
  const result = await exchangeGoogleOAuthToken({ email: EMAIL, oauthToken: OAUTH, androidId: "abcdef", fetch: async (url, options) => {
    assert.equal(url, GOOGLE_AUTH_URL); assert.equal(options.redirect, "error"); assert.equal(options.method, "POST");
    const body = new URLSearchParams(options.body); assert.equal(body.get("Token"), OAUTH); assert.equal(body.get("Email"), EMAIL);
    assert.equal(body.get("ACCESS_TOKEN"), "1"); assert.equal(body.get("service"), "ac2dm"); assert.equal(body.get("androidId"), "abcdef");
    assert.equal(String(url).includes(OAUTH), false); return new Response(`Email=${EMAIL}\nToken=${AAS}\nAuth=unused-scoped-token\n`);
  } });
  assert.deepEqual(result, { email: EMAIL, aasToken: AAS, androidId: "abcdef" });
  await assert.rejects(exchangeGoogleOAuthToken({ email: EMAIL, oauthToken: OAUTH, fetch: async () => new Response(`Email=other@gmail.com\nToken=${AAS}\n`) }), /different Google account/);
  await assert.rejects(exchangeGoogleOAuthToken({ oauthToken: OAUTH, fetch: async () => new Response(`Error=BadAuthentication\nUrl=https://accounts.google.com?token=${OAUTH}\n`) }), error => error.googlePlayPublic && !error.message.includes(OAUTH));
});

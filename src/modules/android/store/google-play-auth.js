const crypto = require("node:crypto");
const path = require("node:path");

const GOOGLE_SIGN_IN_URL = "https://accounts.google.com/EmbeddedSetup";
const GOOGLE_AUTH_URL = "https://android.clients.google.com/auth";
const GOOGLE_CLIENT_SIGNATURE = "38918a453d07199354f8b19af05ec6562ced5788";
const publicError = message => Object.assign(new Error(message), { googlePlayPublic: true, playPublic: true });
const cancelled = () => Object.assign(new Error("Google sign-in cancelled."), { name: "AbortError", code: "ABORT_ERR" });
const emailAddress = value => typeof value === "string" && value.length <= 320 && /^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(value.trim()) ? value.trim() : "";
function isAccountsOrigin(value) { try { const url = new URL(value); return url.origin === "https://accounts.google.com"; } catch { return false; } }
function permittedNavigation(value) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.port &&
    ["accounts.google.com", "myaccount.google.com", "gds.google.com", "www.google.com"].includes(url.hostname); } catch { return false; }
}
function oauthCookie(cookie) {
  return cookie?.name === "oauth_token" && cookie.secure === true && ["accounts.google.com", ".accounts.google.com", ".google.com", "google.com"].includes(cookie.domain) &&
    typeof cookie.value === "string" && cookie.value.length >= 16 && cookie.value.length <= 16384 && !/[\s\x00-\x1f\x7f]/.test(cookie.value);
}

// The Google account page supplies a short-lived OAuth token after its normal
// sign-in and verification steps. Only Google's token endpoint receives it.
async function exchangeGoogleOAuthToken({ email, oauthToken, androidId, signal, fetch: request = globalThis.fetch } = {}) {
  const expectedEmail = emailAddress(email);
  if (typeof oauthToken !== "string" || oauthToken.length < 16 || oauthToken.length > 16384 || /[\s\x00-\x1f\x7f]/.test(oauthToken)) throw publicError("Google did not return a valid sign-in authorization.");
  if (androidId !== undefined && !/^[a-f0-9]{1,16}$/i.test(String(androidId))) throw publicError("The Google Play device identity is invalid.");
  signal?.throwIfAborted();
  const body = new URLSearchParams({ accountType: "HOSTED_OR_GOOGLE", has_permission: "1", add_account: "1", ACCESS_TOKEN: "1", Token: oauthToken,
    service: "ac2dm", source: "android", callerPkg: "com.google.android.gms", callerSig: GOOGLE_CLIENT_SIGNATURE, client_sig: GOOGLE_CLIENT_SIGNATURE,
    get_accountid: "1", device_country: "us", operatorCountry: "us", lang: "en", sdk_version: "28", google_play_services_version: "19629032", droidguard_results: "null",
    ...(expectedEmail ? { Email: expectedEmail } : {}), ...(androidId === undefined ? {} : { androidId: String(androidId) }) });
  let response;
  try {
    response = await request(GOOGLE_AUTH_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "GoogleAuth/1.4", app: "com.google.android.gms" },
      body: body.toString(), redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  } catch (error) { if (signal?.aborted) throw cancelled(); throw publicError("Google account authorization could not be completed. Try signing in again."); }
  if (!response.ok || Number(response.headers.get("content-length")) > 128 * 1024) throw publicError("Google did not authorize this account for Google Play. Try signing in again.");
  const text = await response.text(); if (Buffer.byteLength(text) > 128 * 1024) throw publicError("Google returned too much account information.");
  const values = Object.fromEntries(text.split(/\r?\n/).filter(line => line.includes("=")).map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
  const accountEmail = emailAddress(values.Email), aasToken = values.Token;
  if (values.Error || !accountEmail || typeof aasToken !== "string" || aasToken.length < 16 || aasToken.length > 16384 || /[\s\x00-\x1f\x7f]/.test(aasToken))
    throw publicError(values.Error === "DeviceManagementRequired" ? "This Google account requires device management that the downloader cannot provide." : "Google did not complete account authorization. Finish Google sign-in and try again.");
  if (expectedEmail && accountEmail.toLowerCase() !== expectedEmail.toLowerCase()) throw publicError("A different Google account was signed in. Choose the selected account or add it as a separate account.");
  return { email: accountEmail, aasToken, ...(androidId === undefined ? {} : { androidId: String(androidId) }) };
}

function createGooglePlayAuth({ userDataDir, createWindow, getSession, fetch, exchangeToken = exchangeGoogleOAuthToken } = {}) {
  if (!path.isAbsolute(userDataDir || "")) throw publicError("A MacLauncher profile directory is required for Google sign-in.");
  if (typeof createWindow !== "function" || typeof getSession !== "function") throw publicError("The Google sign-in window is unavailable.");
  const active = new Map(), sessions = new Map(); let disposed = false;
  const keyFor = value => String(value || "default");
  function partitionFor(accountId, persistent = true) {
    const hash = crypto.createHash("sha256").update(userDataDir + "\0" + keyFor(accountId)).digest("hex");
    return `${persistent ? "persist:" : ""}external-google-play-${hash}`;
  }
  function accountSession(accountId, persistent = true) {
    const partition = partitionFor(accountId, persistent);
    if (!sessions.has(partition)) sessions.set(partition, getSession(partition));
    return sessions.get(partition);
  }
  async function removeOAuthCookie(browserSession) {
    const cookies = await browserSession.cookies.get({ url: "https://accounts.google.com/", name: "oauth_token" });
    await Promise.all(cookies.filter(cookie => cookie.name === "oauth_token").map(cookie => browserSession.cookies.remove(`https://accounts.google.com${cookie.path?.startsWith("/") ? cookie.path : "/"}`, "oauth_token")));
    await browserSession.cookies.flushStore?.();
  }
  function focus(accountId) {
    const job = accountId ? active.get(keyFor(accountId)) : [...active.values()][0];
    if (!job?.window || job.window.isDestroyed()) return false;
    if (job.window.isMinimized?.()) job.window.restore(); job.window.show(); job.window.focus(); return true;
  }
  function signIn({ signal, accountId, email, androidId, remember = true } = {}) {
    if (disposed) return Promise.reject(cancelled());
    if (signal?.aborted) return Promise.reject(cancelled());
    const key = keyFor(accountId), prior = active.get(key); if (prior) { focus(key); return prior.promise; }
    const browserSession = accountSession(key, remember !== false), controller = new AbortController();
    const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const job = { controller, promise: null, window: null }; active.set(key, job);
    job.promise = (async () => {
      await removeOAuthCookie(browserSession); operationSignal.throwIfAborted();
      browserSession.setPermissionRequestHandler?.((_contents, _permission, callback) => callback(false));
      browserSession.setPermissionCheckHandler?.(() => false); browserSession.setDevicePermissionHandler?.(() => false);
      const window = job.window = createWindow({ title: "Google Play sign-in", width: 540, height: 740, minWidth: 440, minHeight: 560, show: false,
        autoHideMenuBar: true, backgroundColor: "#ffffff", webPreferences: { session: browserSession, contextIsolation: true, sandbox: true, nodeIntegration: false,
          nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false,
          spellcheck: false, devTools: false, safeDialogs: true } });
      const contents = window.webContents;
      return new Promise((resolve, reject) => {
        let settled = false, checking = false, exchanging = false, retry, candidate = "";
        const timeout = setTimeout(() => finish(publicError("Google sign-in timed out. Open the sign-in window again to continue.")), 15 * 60 * 1000); timeout.unref?.();
        const listeners = [];
        function listen(target, name, listener) { target.on(name, listener); listeners.push(() => target.removeListener(name, listener)); }
        async function finish(error, result) {
          if (settled) return; settled = true; clearTimeout(timeout); clearTimeout(retry); candidate = "";
          for (const remove of listeners) remove(); operationSignal.removeEventListener("abort", abort);
          controller.abort();
          if (!window.isDestroyed()) window.close();
          try { await removeOAuthCookie(browserSession); if (remember === false) await browserSession.clearStorageData(); }
          catch { if (!error) error = publicError("Google sign-in could not clear temporary authorization data. Try signing in again."); }
          error ? reject(error) : resolve(result);
        }
        const abort = () => finish(cancelled()); operationSignal.addEventListener("abort", abort, { once: true });
        async function inspect() {
          if (settled || checking || exchanging || !isAccountsOrigin(contents.getURL())) return;
          checking = true;
          try {
            if (!candidate) { const cookies = await browserSession.cookies.get({ url: "https://accounts.google.com/", name: "oauth_token" }); candidate = cookies.find(oauthCookie)?.value || ""; }
            if (!candidate || settled || !isAccountsOrigin(contents.getURL())) return;
            // Read only the account identity rendered by Google's own page.
            // Password fields and page contents never cross this boundary.
            const accountEmail = emailAddress(await contents.executeJavaScript(`(() => { const account = document.querySelector('[data-profile-identifier][data-email]'); return account?.getAttribute('data-email') || document.getElementById('profileIdentifier')?.textContent || ''; })()`, false));
            if (!accountEmail) { clearTimeout(retry); retry = setTimeout(inspect, 400); return; }
            if (settled || !isAccountsOrigin(contents.getURL())) return;
            const expectedEmail = emailAddress(email);
            if (expectedEmail && expectedEmail.toLowerCase() !== accountEmail.toLowerCase()) throw publicError("A different Google account was signed in. Choose the selected account or add it as a separate account.");
            exchanging = true;
            const result = await exchangeToken({ email: accountEmail, oauthToken: candidate, androidId, signal: operationSignal, fetch });
            if (settled || operationSignal.aborted) return;
            if (emailAddress(result.email).toLowerCase() !== accountEmail.toLowerCase()) throw publicError("Google returned a different account identity. Sign in again to continue.");
            await finish(null, result);
          } catch (error) { if (!settled) await finish(operationSignal.aborted ? cancelled() : error.googlePlayPublic ? error : publicError("Google sign-in could not be completed. Try again.")); }
          finally { checking = false; }
        }
        listen(browserSession.cookies, "changed", (_event, cookie, _cause, removed) => { if (!removed && oauthCookie(cookie)) { candidate = cookie.value; inspect(); } });
        for (const event of ["did-finish-load", "did-navigate", "did-navigate-in-page", "dom-ready"]) listen(contents, event, inspect);
        const navigation = (event, url) => { if (!permittedNavigation(url)) event.preventDefault(); };
        listen(contents, "will-navigate", navigation); listen(contents, "will-redirect", navigation);
        listen(contents, "will-attach-webview", event => event.preventDefault());
        listen(window, "closed", () => finish(cancelled()));
        listen(contents, "render-process-gone", () => finish(publicError("The Google sign-in window closed unexpectedly. Try signing in again.")));
        listen(contents, "did-fail-load", (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== -3) finish(publicError("The Google sign-in page could not load. Check the connection and try again.")); });
        contents.setWindowOpenHandler?.(({ url }) => { if (permittedNavigation(url)) Promise.resolve(window.loadURL(url)).catch(() => {}); return { action: "deny" }; });
        window.once("ready-to-show", () => { if (!settled) { window.show(); window.focus(); } });
        if (operationSignal.aborted) { abort(); return; }
        Promise.resolve(window.loadURL(GOOGLE_SIGN_IN_URL)).then(inspect, () => finish(publicError("The Google sign-in page could not load. Check the connection and try again.")));
        window.show(); window.focus();
      });
    })().finally(() => { if (active.get(key) === job) active.delete(key); });
    return job.promise;
  }
  function cancel(accountId) { for (const [key, job] of active) if (accountId === undefined || key === keyFor(accountId)) job.controller.abort(); }
  async function clearAccount(accountId) {
    const key = keyFor(accountId), running = active.get(key); running?.controller.abort(); if (running) await running.promise.catch(() => {});
    for (const persistent of [true, false]) {
      const browserSession = accountSession(key, persistent);
      await browserSession.clearStorageData(); await browserSession.clearCache(); await browserSession.cookies.flushStore?.(); await browserSession.closeAllConnections?.();
    }
  }
  async function dispose() { disposed = true; const pending = [...active.values()].map(job => job.promise); cancel(); await Promise.allSettled(pending); }
  return { signIn, focus, cancel, clearAccount, dispose, partitionFor };
}

module.exports = { createGooglePlayAuth, exchangeGoogleOAuthToken, GOOGLE_SIGN_IN_URL, GOOGLE_AUTH_URL };

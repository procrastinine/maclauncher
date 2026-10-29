const crypto = require("node:crypto");
const publicError = message => Object.assign(new Error(message), { playPublic: true, googlePlayPublic: true });
const savedKey = session => "google-play:" + crypto.createHash("sha256").update(
  (session.sharedAccountId || session.microgAccountId || session.browserAccountId || "browser") + "\0" + session.email.toLowerCase()).digest("hex");

/** One host entry point for Google browser sign-in and the real Android account manager. */
function createGoogleAccountManager({ browserAuth, microg, vault, onChanged = async () => {}, onRemoved = async () => {} } = {}) {
  async function persist(session, { active = true } = {}) {
    if (session.remember === false) return;
    if (active) {
      const previous = (await vault.loadSession("google-play"))?.session;
      if (previous?.email) await vault.saveSession({ accountName: savedKey(previous), session: previous });
    }
    await vault.saveSession({ accountName: savedKey(session), session });
    if (active) await vault.saveSession({ accountName: "google-play", session });
  }
  async function register(session, { signal, provider = session.accountProvider || session.sharedAccountId?.split(":")[0] || "klepton" } = {}) {
    const account = await microg.importBrowserSession(session, { signal, provider });
    const registered = { ...session, accountProvider: provider, sharedAccountId: account.id };
    await persist(registered);
    if (!session.sharedAccountId && session.remember !== false) await vault.removeSession(savedKey(session));
    await onChanged(); return registered;
  }
  async function browserLogin(options = {}) {
    const provider = options.provider || "klepton";
    if (!["klepton", "macapk"].includes(provider)) throw publicError("Choose a supported Google account provider.");
    const browserAccountId = options.accountId || crypto.randomUUID();
    const login = await browserAuth.signIn({ ...options, email: undefined, accountId: browserAccountId });
    options.onAuthenticated?.();
    const session = { ...login, mode: "browser", accountProvider: provider, browserAccountId, remember: options.remember !== false };
    // A completed Google challenge must remain recoverable if provider setup fails.
    await persist(session);
    try { return await register(session, options); }
    catch (error) {
      if (error.name === "AbortError") throw error;
      throw publicError(session.remember ? "Google sign-in was saved, but Android account registration could not finish. Reconnect the saved sign-in to continue."
        : "Google sign-in completed, but Android account registration could not finish. Retry sign-in to continue.");
    }
  }
  async function prepareSavedSession({ signal } = {}) {
    const saved = (await vault.loadSession("google-play"))?.session;
    if (!saved?.aasToken || !saved.email) return saved;
    if (saved.sharedAccountId) {
      const result = await microg.list({ refresh: true, signal });
      if (result.accounts.some(account => account.id === saved.sharedAccountId && !account.cached)) return saved;
    }
    return register(saved, { signal });
  }
  async function state({ provider = "klepton", signal, refresh = false } = {}) {
    const result = await microg.list({ refresh: refresh === true, signal });
    return { accounts: result.accounts.map(account => ({
      id: account.id, label: `${account.label} (${account.source || (account.provider === "macapk" ? "Mac.apk" : "microG")})`,
      source: account.source || (account.provider === "macapk" ? "Mac.apk" : "microG"), provider: account.provider, canRemove: true
    })), available: result.providers.some(value => value.available === true), providerInstalled: result.providers.some(value => value.providerInstalled === true), canSignIn: true,
    message: "Google accounts are shared with External." };
  }
  async function remove({ provider = "klepton", accountId, signal } = {}) {
    const id = /^(klepton|macapk):/.test(accountId || "") ? accountId : `${provider}:${accountId}`, inventory = await microg.list({ refresh: true, signal });
    const account = inventory.accounts.find(value => value.id === id);
    if (!account) throw publicError("The selected Google account is unavailable. Refresh accounts.");
    const actualProvider = account.provider || id.split(":")[0];
    const result = await microg.remove({ id, signal });
    if (result?.completed === false) return result;
    for (const record of await vault.listAccounts()) {
      const session = (await vault.loadSession(record.accountName))?.session;
      if (session?.sharedAccountId === id || session?.mode === "microg" && session.microgAccountId === id ||
          !session?.sharedAccountId && (session?.accountProvider || "klepton") === actualProvider && session?.aasToken && session.email?.toLowerCase() === account.label.toLowerCase()) {
        await vault.removeSession(record.accountName);
        if (session.browserAccountId) await browserAuth.clearAccount(session.browserAccountId);
      }
    }
    await onRemoved(account); await onChanged(); return result;
  }
  async function clearBrowserAccount(accountId) {
    await browserAuth.clearAccount(accountId);
    for (const record of await vault.listAccounts()) {
      const session = (await vault.loadSession(record.accountName))?.session;
      if (session?.browserAccountId === accountId) await vault.removeSession(record.accountName);
    }
  }
  return { browserLogin, prepareSavedSession, state, remove, clearBrowserAccount,
    loadActiveSession: async () => (await vault.loadSession("google-play"))?.session || null,
    saveActiveSession: session => session ? persist(session) : vault.removeSession("google-play"),
    signIn: async options => { const result = await browserLogin({ remember: true, ...options }); return { completed: true, accountId: result.sharedAccountId }; },
    focus: accountId => browserAuth.focus(accountId) };
}
module.exports = { createGoogleAccountManager };

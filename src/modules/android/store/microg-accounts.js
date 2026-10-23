const fs = require("node:fs");
const path = require("node:path");

const PLAY_SCOPE = "oauth2:https://www.googleapis.com/auth/googleplay";
const publicError = message => Object.assign(new Error(message), { playPublic: true });
const cancelled = () => Object.assign(new Error("Google account operation cancelled."), { name: "AbortError", code: "ABORT_ERR" });
const identity = (provider, value) => ({ id: `${provider.id}:${value.id}`, accountId: value.id, provider: provider.id,
  label: value.name || value.label, source: provider.label });

function defaultProviders(dependencies) {
  const legacy = dependencies.klepton || require("../google-accounts"), macapk = dependencies.macapk || require("../providers/macapk/google-accounts");
  return [
    { id: "klepton", label: "microG", read: context => fs.existsSync(path.join(context.userDataDir, "android/services/google-accounts.json")) ? legacy.read(context.userDataDir) : [],
      state: context => legacy.state(context), signIn: context => legacy.signIn(context),
      importSession: (context, session, options) => (dependencies.importSession || require("./custom-account-token").importBrowserSession)(context, session, options),
      remove: (context, account) => legacy.remove(account.accountId, context),
      token: async (context, account, options) => (dependencies.customToken || require("./custom-account-token").requestToken)(context, account, options) },
    { id: "macapk", label: "Mac.apk", read: context => macapk.snapshot(context), state: context => macapk.state(context), signIn: context => macapk.signIn(context),
      importSession: (context, session, options) => macapk.importBrowserSession(context, session, options),
      remove: (context, account) => macapk.remove(account.accountId, context),
      token: async (context, account, { signal, refresh, previousToken }) => {
        const caller = await (dependencies.resolveCaller || require("./microg-caller").resolveCaller)(context, { signal });
        let owner;
        try {
          owner = await macapk.acquire(context, { networkAllowed: true, install: true, packageSet: { apks: caller.apks, metadata: { packageName: "com.android.vending" } } });
          const current = (await owner.accounts()).accounts.find(value => value.id === account.accountId);
          if (!current) throw publicError("The selected Google account is no longer available. Refresh accounts and choose again.");
          if (refresh && previousToken) await owner.token("invalidateToken", current, { token: previousToken }, { signal });
          return await owner.token("token", current, { service: PLAY_SCOPE, options: {} }, { signal });
        } finally { await owner?.release(); await caller.release?.(); }
      } }
  ];
}

function createMicrogAccounts({ getContext, context, dependencies = {} } = {}) {
  if (typeof getContext !== "function" && !context) throw publicError("The Google account manager is unavailable.");
  let disposed = false, providers;
  const pending = new Set(), controllers = new Set(), previousTokens = new Map();
  const configured = () => providers ||= dependencies.providers || defaultProviders(dependencies);
  function run(options, action) {
    if (disposed) return Promise.reject(cancelled());
    const controller = new AbortController(), signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    controllers.add(controller);
    const task = (async () => {
      signal.throwIfAborted(); const current = await (getContext ? getContext({ signal }) : context);
      if (!path.isAbsolute(current?.userDataDir || "")) throw publicError("A MacLauncher profile directory is required for Google accounts.");
      signal.throwIfAborted(); return action({ ...current, signal }, signal);
    })().finally(() => { pending.delete(task); controllers.delete(controller); });
    pending.add(task); return task;
  }
  function list({ refresh = false, signal } = {}) {
    return run({ signal }, async context => {
      const accounts = [], sources = [];
      for (const provider of configured()) {
        let saved = [], live, error;
        try { saved = await provider.read(context); } catch { error = "Saved account information could not be read."; }
        if (refresh) {
          try { live = await provider.state({ ...context, networkAllowed: false, runtimeSettings: { ...context.runtimeSettings, networkIsolation: true } }); }
          catch { context.signal.throwIfAborted(); error = "The Google account provider is unavailable. Open Android account settings to continue."; }
        }
        if (live?.available || live?.providerInstalled) {
          try { saved = await provider.read(context); } catch {}
        }
        const available = live ? live.available === true : !error;
        for (const value of saved) if (/^[a-f0-9]{64}$/.test(value.id || "") && typeof (value.name || value.label) === "string")
          accounts.push({ ...identity(provider, value), available: typeof provider.token === "function", needsSetup: refresh && !available,
            cached: !refresh || !live?.available });
        sources.push({ id: provider.id, label: provider.label, available, providerInstalled: live?.providerInstalled,
          canSignIn: typeof provider.signIn === "function", ...(error ? { message: error } : {}) });
      }
      return { accounts: accounts.sort((a, b) => a.label.localeCompare(b.label) || a.source.localeCompare(b.source)), providers: sources };
    });
  }
  function getToken({ id, signal, refresh = false } = {}) {
    return run({ signal }, async (context, operationSignal) => {
      const choices = [];
      for (const provider of configured()) for (const value of await provider.read(context)) if (/^[a-f0-9]{64}$/.test(value.id || "")) choices.push({ provider, account: identity(provider, value) });
      const selected = id ? choices.find(value => value.account.id === id) : choices.length === 1 ? choices[0] : null;
      if (!selected) throw publicError("Choose a Google account from the account manager. Refresh accounts if it is missing.");
      const { account, provider } = selected;
      if (typeof provider.token !== "function") throw publicError("Google Play account access is unavailable for this account provider.");
      let result;
      try { result = await provider.token({ ...context, networkAllowed: true }, account, { signal: operationSignal, refresh, previousToken: previousTokens.get(account.id) }); }
      catch (error) {
        if (operationSignal.aborted || error.name === "AbortError") throw cancelled();
        if (error.playPublic) throw error;
        if (error.interactiveRequired || error.code === "AUTHORIZATION_REQUIRED" || error.providerCode === 4)
          throw publicError("Google account authorization requires an action in Android account settings. Complete it and reconnect.");
        throw publicError("The Google account provider could not authorize Google Play. Open Android account settings and try again.");
      }
      operationSignal.throwIfAborted();
      if (typeof result?.token !== "string" || !result.token || result.token.length > 16384 || /[\x00-\x1f\x7f]/.test(result.token)) throw publicError("The Google account provider did not return Google Play authorization.");
      previousTokens.set(account.id, result.token);
      return { email: account.label, authToken: result.token, expirySeconds: Number(result.expirySeconds) > 0 ? Number(result.expirySeconds) : null,
        provider: provider.id, accountId: account.accountId };
    });
  }
  function signIn({ provider = "klepton", signal } = {}) {
    return run({ signal }, async context => {
      const selected = configured().find(value => value.id === provider); if (!selected?.signIn) throw publicError("The selected Google account provider cannot open sign-in.");
      return selected.signIn(context);
    });
  }
  function importBrowserSession(session, { signal, provider = "klepton" } = {}) {
    return run({ signal }, async (context, operationSignal) => {
      const selected = configured().find(value => value.id === provider);
      if (!selected) throw publicError("The Android Google account manager is unavailable.");
      const importer = selected.importSession || (provider === "klepton" ? dependencies.importSession || require("./custom-account-token").importBrowserSession : null);
      if (!importer) throw publicError("Browser sign-in is unavailable for this Google account provider.");
      await importer(context, session, { signal: operationSignal });
      operationSignal.throwIfAborted();
      const result = await selected.state({ ...context, networkAllowed: false, runtimeSettings: { ...context.runtimeSettings, networkIsolation: true } });
      if (!result.available) throw publicError("Google sign-in was saved, but the Android account list could not be refreshed. Refresh accounts in Android settings.");
      const account = (await selected.read(context)).find(value => value.name?.toLowerCase() === session.email?.toLowerCase());
      if (!account || !/^[a-f0-9]{64}$/.test(account.id || "")) throw publicError("The signed-in Google account was not returned by the Android account manager. Refresh accounts in Android settings.");
      return { ...identity(selected, account), available: true, cached: false };
    });
  }
  function remove({ id, signal } = {}) {
    return run({ signal }, async context => {
      for (const provider of configured()) {
        const value = (await provider.read(context)).find(account => `${provider.id}:${account.id}` === id);
        if (!value) continue;
        if (!provider.remove) throw publicError("The selected Google account cannot be removed from this provider.");
        const account = identity(provider, value), result = await provider.remove(context, account);
        if (result?.completed !== false) previousTokens.delete(id);
        return result;
      }
      throw publicError("The selected Google account is unavailable. Refresh accounts.");
    });
  }
  async function dispose() { disposed = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...pending]); previousTokens.clear(); }
  return { list, getToken, signIn, importBrowserSession, remove, dispose, hasPending: () => pending.size > 0 };
}

module.exports = { createMicrogAccounts, PLAY_SCOPE };

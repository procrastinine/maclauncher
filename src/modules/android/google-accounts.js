const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../shared/writable-input");

// Package identities select installed Google services, never Android API access.
const packages = new Set(["com.google.android.gms", "com.google.android.gsf", "com.android.vending"]);
function isGooglePackage(packageName) { return packages.has(packageName); }
function selections(entry) {
  const settings = entry?.runtimeSettings?.klepton || {};
  const enabled = settings.googleIntegration === true;
  const accountId = typeof settings.googleAccount === "string" ? settings.googleAccount : "";
  if (enabled && accountId && !/^[a-f0-9]{64}$/.test(accountId)) throw new Error("The selected Google account is invalid. Choose an account in game Settings.");
  return { enabled, accountId: enabled ? accountId : "" };
}
function location(userDataDir) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("Google accounts require private launcher storage.");
  const root = path.join(userDataDir, "android", "services");
  Writable.assertOwnDirectory(userDataDir, root);
  return { root, file: path.join(root, "google-accounts.json") };
}
function account(value) {
  if (!value || !isGooglePackage(value.providerPackage) || typeof value.name !== "string" || !value.name ||
      typeof value.type !== "string" || !value.type || /[\x00-\x1f\x7f]/.test(value.name + value.type))
    throw new Error("The Android service returned invalid account information.");
  const id = crypto.createHash("sha256").update(value.providerPackage + "\0" + value.type + "\0" + value.name).digest("hex");
  return { id, providerPackage: value.providerPackage, type: value.type, name: value.name };
}
function read(userDataDir) {
  const { file } = location(userDataDir);
  let saved;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { if (!fs.fstatSync(fd).isFile()) throw new Error("Google account metadata is invalid."); saved = JSON.parse(fs.readFileSync(fd, "utf8")); }
    finally { fs.closeSync(fd); }
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (saved.schemaVersion !== 1 || !Array.isArray(saved.accounts)) throw new Error("Google account metadata is invalid.");
  const result = saved.accounts.map(account);
  if (new Set(result.map(item => item.id)).size !== result.length) throw new Error("Google account metadata contains duplicate accounts.");
  return result;
}
/** Called only with accounts returned by the installed service's real account owner.
 * This profile metadata never stores passwords, tokens, cookies or credentials. */
function replaceSnapshot(userDataDir, values) {
  const accounts = values.map(account), { root, file } = location(userDataDir);
  Writable.atomicWrite(file, JSON.stringify({ schemaVersion: 1, accounts }) + "\n", { root });
  return accounts;
}
function inventory(userDataDir, result) {
  if (!result || !Array.isArray(result.authenticators) || !Array.isArray(result.accounts) || typeof result.canSignIn !== "boolean")
    throw new Error("Invalid account inventory.");
  const providers = new Map();
  for (const provider of result.authenticators) {
    if (!provider || typeof provider.type !== "string" || !provider.type || typeof provider.providerPackage !== "string" || providers.has(provider.type))
      throw new Error("Invalid account authenticator.");
    providers.set(provider.type, provider.providerPackage);
  }
  const values = [];
  for (const value of result.accounts) {
    if (!value || typeof value.name !== "string" || !value.name || typeof value.type !== "string" || !value.type ||
        (value.providerPackage !== null && typeof value.providerPackage !== "string")) throw new Error("Invalid account identity.");
    if (!isGooglePackage(value.providerPackage)) continue;
    if (providers.get(value.type) !== value.providerPackage) throw new Error("Invalid account provider.");
    values.push(account(value));
  }
  if (new Set(values.map(value => value.id)).size !== values.length) throw new Error("Duplicate account identity.");
  return { accounts: replaceSnapshot(userDataDir, values), canSignIn: result.canSignIn && providers.get("com.google") === "com.google.android.gms" };
}
async function state(context, { refresh = true } = {}) {
  const installed = require("./service-packages").read(context.userDataDir).packages.some(item => item.enabled && item.packageName === "com.google.android.gms");
  let accounts = read(context.userDataDir), available = false, canSignIn = false, lease;
  if (!refresh) return { accounts: accounts.map(item => ({ id: item.id, label: item.name, canRemove: true })),
    canSignIn: true, providerInstalled: installed, available: false, cached: true,
    message: "Google accounts are shared with External." };
  if (installed) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 30000);
    timer.unref?.();
    const signal = context.signal ? AbortSignal.any([context.signal, deadline.signal]) : deadline.signal;
    try {
      // Enumeration cannot authorize network traffic or sign-in. The service's
      // AccountManager owns credentials; only its returned identities are saved.
      lease = await require("./account-owner").acquire({ ...context, signal }, { blockNetwork: true, allowAds: false });
      const result = await lease.request("accounts", null, { signal });
      ({ accounts, canSignIn } = inventory(context.userDataDir, result));
      available = true;
    } catch {
      context.signal?.throwIfAborted();
      // Preserve the last real inventory without presenting it as a fresh reply.
      // Provider/parser exception text may contain credentials and is not logged.
    } finally { clearTimeout(timer); lease?.release(); }
  }
  return { accounts: accounts.map(item => ({ id: item.id, label: item.name, canRemove: available && canSignIn })),
    canSignIn: !installed || canSignIn, providerInstalled: installed, available,
    message: !installed ? "Sign in downloads and prepares the Android account runtime and microG after confirmation. Integration is off for each game until enabled."
      : available ? (canSignIn ? "Sign-in opens the installed Android account provider. Integration is off for each game until enabled in game Settings." : "Account list refreshed. This Android runtime does not support account sign-in.")
      : "The Android account service is unavailable. Saved account information may be out of date." };
}
async function operate(context, command, payload) {
  let lease;
  try {
    // Only an explicit account operation enables network access and Android UI.
    lease = await require("./account-owner").acquire(context, { blockNetwork: false, allowAds: false });
    const ready = inventory(context.userDataDir, await lease.request("accounts"));
    if (!ready.canSignIn) throw new Error("Account sign-in is not available in this Android runtime.");
    const result = await lease.request(command, payload);
    inventory(context.userDataDir, result);
    return { completed: result.completed !== false };
  } catch (error) {
    // Android's original authenticator reports closing its window as cancellation.
    // It ends this operation without making the installed provider unavailable.
    if (error.code === "ACCOUNT_PROVIDER_ERROR" && error.providerCode === 4) return { completed: false };
    throw error;
  } finally { lease?.release(); }
}
async function signIn(context) {
  await require("./store/microg-caller").ensureGoogleServices(context);
  return operate(context, "addAccount", { type: "com.google" });
}
async function remove(accountId, context) {
  const selected = read(context.userDataDir).find(item => item.id === accountId);
  if (!selected) throw new Error("The selected Google account is unavailable. Refresh accounts.");
  return operate(context, "removeAccount", { type: selected.type, name: selected.name });
}
function selected(userDataDir, id) {
  if (!id) return null;
  const value = read(userDataDir).find(item => item.id === id);
  if (!value) throw new Error("The selected Google account is unavailable. Refresh accounts.");
  return { name: value.name, type: value.type };
}
function choices(_entry, _payload, context) {
  return { googleAccounts: [{ value: "", label: "microG without an account" }, ...read(context.userDataDir).map(item => ({ value: item.id, label: item.name }))] };
}
module.exports = { isGooglePackage, selections, selected, read, replaceSnapshot, state, signIn, remove, choices };

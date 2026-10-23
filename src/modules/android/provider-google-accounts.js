const Packages = require("./google/packages");
const Profile = require("./google/profile");
const Owner = require("./google/owner");
const Broker = require("./google/broker");

function selections(value = {}) {
  const settings = value.runtimeSettings && !Object.hasOwn(value, "googleIntegration")
    ? value.runtimeSettings[value.preferredRuntime || "macapk"] || {} : value;
  const enabled = settings.googleIntegration === true;
  const accountId = typeof settings.googleAccount === "string" ? settings.googleAccount : "";
  if (enabled && accountId && !/^[a-f0-9]{64}$/.test(accountId)) throw new Error("The selected Google account is invalid. Choose an account in Settings.");
  return { enabled, accountId: enabled ? accountId : "", mode: !enabled ? "off" : accountId ? "account" : "anonymous" };
}
function selected(userDataDir, id) {
  if (!id) return null;
  const value = Profile.readSnapshot(userDataDir).find(item => item.id === id);
  if (!value) throw new Error("The selected Google account is unavailable. Refresh accounts.");
  return value;
}
async function state(context, dependencies = {}) {
  const packages = (dependencies.resolvePackages || Packages.resolvePackages)(context.userDataDir, { verification: "status" });
  const saved = Profile.readSnapshot(context.userDataDir);
  if (!packages) return { accounts: [], providerInstalled: false, available: false, canSignIn: false,
    message: "Sign in downloads and prepares microG after confirmation. Google integration is off for each game until enabled." };
  let owner;
  try {
    owner = await (dependencies.acquire || Owner.acquire)(context, { networkAllowed: false });
    const result = await owner.accounts();
    return { accounts: result.accounts.map(account => ({ id: account.id, label: account.name, canRemove: true })),
      canSignIn: result.canSignIn, providerInstalled: true, available: true,
      message: "Accounts are managed by the shared Android microG service. Each game selects anonymous access or one signed-in account." };
  } catch (error) {
    context.signal?.throwIfAborted();
    return { accounts: saved.map(account => ({ id: account.id, label: account.name, canRemove: false })),
      canSignIn: false, providerInstalled: true, available: false,
      message: "The Android account service is unavailable. Saved account information may be out of date." };
  } finally { await owner?.release(); }
}
async function signIn(context, dependencies = {}) {
  const owner = await (dependencies.acquire || Owner.acquire)(context, { networkAllowed: true, install: true });
  try {
    await owner.accounts();
    const result = await owner.request("addAccount");
    // Starting Android's real account activity is not a successful sign-in.
    return { completed: result.completed === true, interactionStarted: result.interactionStarted === true };
  } finally { await owner.release({ retainInteractive: true }); }
}
async function remove(accountId, context, dependencies = {}) {
  const account = selected(context.userDataDir, accountId);
  const owner = await (dependencies.acquire || Owner.acquire)(context, { networkAllowed: true });
  try {
    const current = await owner.accounts();
    if (!current.accounts.some(value => value.id === account.id)) throw new Error("The selected Google account is unavailable. Refresh accounts.");
    const result = await owner.request("removeAccount", { account: { name: account.name, type: account.type } });
    if (result.completed === true) await owner.accounts();
    return { completed: result.completed === true };
  } finally { await owner.release(); }
}
function choices(_entry, _payload, context) {
  return { googleAccounts: [{ value: "", label: "microG without an account" }, ...Profile.readSnapshot(context.userDataDir)
    .map(account => ({ value: account.id, label: account.name }))] };
}
async function prepareLaunch({ entry, context, packageSet, policy }, dependencies = {}) {
  const selection = selections(context.runtimeSettings);
  if (!selection.enabled) return null;
  const owner = await (dependencies.acquire || Owner.acquire)(context, { networkAllowed: policy.networkAllowed, install: true,
    caller: (dependencies.inspectCaller || Owner.inspectCaller)(packageSet) });
  try {
    const inventory = await owner.accounts();
    const account = selection.accountId ? inventory.accounts.find(value => value.id === selection.accountId) : null;
    if (selection.accountId && !account) throw new Error("The selected Google account is unavailable. Refresh accounts.");
    const broker = await (dependencies.createBroker || Broker.create)({ owner, account, networkAllowed: policy.networkAllowed, signal: context.signal });
    let closed = false;
    return { enabled: true, mode: selection.mode, socket: broker.socket, capability: broker.capability, packages: owner.packages,
      profile: owner.storage, account: account ? { name: account.name, type: account.type } : null,
      enroll: broker.enroll, async close() { if (closed) return; closed = true; await broker.close(); await owner.release(); } };
  } catch (error) { await owner.release(); throw error; }
}
module.exports = { selections, selected, read: Profile.readSnapshot, state, signIn, remove, choices, prepareLaunch };

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const Manager = require("./manager"), Policy = require("../../policy");
const Writable = require("../../../shared/writable-input");
const Sandbox = require("../../../shared/runtime/macos-sandbox");
const Broker = require("../../google/broker");
const { confirmToolInstall } = require("../../../shared/runtime/tool-install");
const { withRuntimeMutation, withRuntimeUse } = require("../../../../core/coordinated-runtime-managers");
const PROFILE = "macapk-google-v1";

function profilePaths(userDataDir, { create = true } = {}) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("Google accounts require private launcher storage.");
  const root = path.join(userDataDir, "android/profiles", PROFILE), home = path.join(root, "home");
  const storage = { root, providerRoot: root, androidRoot: path.join(root, "android"), home,
    cacheRoot: path.join(root, "cache"), temporary: path.join(root, "cache/tmp"), runtimeRoot: path.join(root, "runtime"),
    packagesRoot: path.join(root, "packages"), gms: path.join(root, "gms"), metadataFile: path.join(root, "accounts.json") };
  for (const name of ["root", "androidRoot", "home", "cacheRoot", "temporary", "runtimeRoot", "packagesRoot", "gms"])
    Writable.assertOwnDirectory(userDataDir, storage[name], { create });
  return storage;
}
function account(value) {
  if (value?.type !== "com.google" || typeof value.name !== "string" || !value.name || value.name.length > 1024 || /[\x00-\x1f\x7f]/.test(value.name))
    throw new Error("The Google account provider returned an invalid account.");
  return { id: crypto.createHash("sha256").update(PROFILE + "\0" + value.name).digest("hex"), name: value.name, type: "com.google" };
}
function snapshot(context) {
  try {
    const storage = profilePaths(context.userDataDir, { create: false }), stat = fs.lstatSync(storage.metadataFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error("The Google account metadata is invalid.");
    const stored = JSON.parse(fs.readFileSync(storage.metadataFile, "utf8"));
    if (stored.schemaVersion !== 1 || !Array.isArray(stored.accounts)) throw new Error("The Google account metadata is invalid.");
    return stored.accounts.map(account);
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
function saveSnapshot(storage, values) {
  if (!Array.isArray(values) || values.length > 100) throw new Error("The Google account metadata is invalid.");
  const accounts = values.map(account);
  if (new Set(accounts.map(value => value.id)).size !== accounts.length) throw new Error("The Google account metadata is invalid.");
  Writable.atomicWrite(storage.metadataFile, JSON.stringify({ schemaVersion: 1, accounts }) + "\n", { root: storage.root });
  return accounts;
}
function providerError(code = "ACCOUNT_PROVIDER_ERROR", providerCode = 5) {
  const error = new Error(code === "NETWORK_DISABLED" ? "Network access is disabled for this game."
    : code === "AUTHORIZATION_REQUIRED" ? "Google account authorization is required."
      : "The Google account provider could not complete the request.");
  error.code = code; error.providerCode = providerCode; error.interactiveRequired = code === "AUTHORIZATION_REQUIRED"; return error;
}
async function runtimeSelection(context, entry, install = false) {
  let selected = Manager.resolveSelection(entry, context.settings, context.userDataDir);
  if (selected.ready || !install) return selected;
  await confirmToolInstall(context, { manager: Manager, version: selected.version, detail: "Required for Mac.apk Google account management." });
  await withRuntimeMutation({ managerId: Manager.id, version: selected.version }, () => Manager.installRuntime({ userDataDir: context.userDataDir,
    version: selected.version, downloads: context.downloads, logger: context.logger, signal: context.signal }), { userDataDir: context.userDataDir });
  context.onRuntimeStateChange?.(); selected = Manager.resolveSelection(entry, context.settings, context.userDataDir);
  if (!selected.ready) throw new Error(selected.reason); return selected;
}
function signatureVerifier(userDataDir) { return require("../../tools/apk-signature").resolve(userDataDir); }
function descriptor(runtime, storage, policyJar, networkAllowed) {
  return { command: runtime.java, args: [], cwd: storage.root,
    env: { ...Sandbox.environment(), HOME: storage.home, CFFIXED_USER_HOME: storage.home, TMPDIR: storage.temporary + path.sep,
      JAVA_TOOL_OPTIONS: '--add-exports=java.base/jdk.internal.org.objectweb.asm=ALL-UNNAMED -javaagent:"' + policyJar.replaceAll('"', '\\"') + '"=account-owner',
      MACAPK_ANDROID_ROOT: storage.androidRoot, MACAPK_APP_CACHE_DIR: path.join(storage.cacheRoot, "applications"),
      MACAPK_GMS_DIR: storage.gms, MACAPK_GMS_KEYCHAIN: "0", MACAPK_GMS_PRESENT: "1", MACAPK_GMS_FCM: "0",
      MACAPK_OFFLINE: networkAllowed ? "0" : "1", MACAPK_CLIPBOARD_HOST: "0", MACAPK_LOCATION_HOST: "0",
      MACAPK_DISPLAY_DENSITY: "320", MACAPK_GUEST_TOTALRAM: String(8 * 1024 ** 3), MACAPK_SELF_CAPTURE: "0", MACAPK_LOG_LEVEL: "7",
      MACAPK_CANONICAL_APP: runtime.app },
    readDirectories: [runtime.app], readFiles: [policyJar],
    executables: [runtime.executable, runtime.java, path.join(path.dirname(runtime.java), "../lib/jspawnhelper")],
    machServices: ["com.apple.WebKit.WebContent", "com.apple.WebKit.Networking", "com.apple.WebKit.GPU", "com.apple.nsurlsessiond"] };
}
function captureProcess(command, args, { env, cwd, input = "", signal, timeout = 60000 }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "ignore"] });
    let output = "", settled = false, abortTimer;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(result); };
    const abort = () => {
      child.kill("SIGTERM"); abortTimer = setTimeout(() => child.kill("SIGKILL"), 2000); abortTimer.unref?.();
      finish(signal.reason || new Error("Google account action canceled."));
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(providerError()); }, timeout);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8"); child.stdout.on("data", bytes => { output += bytes; if (Buffer.byteLength(output) > 1024 * 1024) { child.kill("SIGKILL"); finish(providerError()); } });
    child.stdin.on("error", () => {}); child.stdin.end(input);
    child.once("error", () => finish(providerError()));
    child.once("close", (code, signal) => { clearTimeout(abortTimer); finish(null, { code, signal, output }); });
  });
}
async function acquire(context, { entry, networkAllowed = false, install = false, packageSet } = {}) {
  const selection = await runtimeSelection(context, entry, install);
  if (!selection.ready) throw new Error(selection.reason);
  const runtime = Manager.runtimePaths(selection.install), storage = profilePaths(context.userDataDir), policyJar = Manager.materializePolicy(context.userDataDir);
  let caller = null;
  async function run(request, { signal = context.signal } = {}) {
    const d = descriptor(runtime, storage, policyJar, networkAllowed), classpath = [policyJar, runtime.framework, runtime.loader];
    if (request.operation === "verify") { const verifier = signatureVerifier(context.userDataDir); classpath.push(verifier); d.readFiles.push(verifier, ...request.apks); }
    d.args = ["-Djava.awt.headless=true", "-Duser.home=" + storage.home, "-Djava.io.tmpdir=" + storage.temporary,
      "-cp", classpath.join(path.delimiter), "com.maclauncher.android.macapk.AccountControl"];
    const policy = { ...Policy.resolvePolicy(), networkAllowed };
    const result = await withRuntimeUse({ managerId: Manager.id, version: selection.version, sourcePath: selection.install.installDir }, () =>
      withRuntimeMutation({ managerId: "android-macapk-google", sourcePath: storage.root }, async () => {
        const isolation = await Policy.prepareIsolation(d, storage, policy, { signal });
        return captureProcess(isolation.command, isolation.args,
          { env: isolation.environment, cwd: storage.root, input: JSON.stringify({ ...request, networkAllowed }) + "\n", signal });
      }, { userDataDir: context.userDataDir }), { userDataDir: context.userDataDir });
    let reply; try { reply = JSON.parse(result.output); } catch { throw providerError(); }
    if (result.code !== 0 || reply?.ok !== true) {
      const code = Number.isSafeInteger(reply?.error?.code) ? reply.error.code : 5;
      throw providerError(code === 3 ? "NETWORK_DISABLED" : code === 4 ? "AUTHORIZATION_REQUIRED" : code === 9 ? "AUTHORIZATION_FAILED" : "ACCOUNT_PROVIDER_ERROR", code);
    }
    return reply;
  }
  if (packageSet) {
    const apks = packageSet.apks || packageSet.selected?.map(value => value.file);
    if (!Array.isArray(apks) || !apks.length || apks.some(file => !path.isAbsolute(file || ""))) throw providerError("AUTHORIZATION_FAILED", 9);
    const verified = await run({ operation: "verify", apks });
    if (verified.packageName !== packageSet.metadata?.packageName || !Array.isArray(verified.signers) || !verified.signers.length ||
      verified.signers.some(s => !/^[a-f0-9]{64}$/.test(s.sha256 || "") || !/^[a-f0-9]{40}$/.test(s.sha1 || ""))) throw providerError("AUTHORIZATION_FAILED", 9);
    caller = { packageName: verified.packageName, signers: verified.signers.map(value => value.sha256), certificateSha1: verified.signers[0].sha1 };
  }
  return { storage, runtime, selection, caller, run,
    async accounts() { const reply = await run({ operation: "accounts" }); return { accounts: saveSnapshot(storage, reply.accounts), canSignIn: true }; },
    async token(operation, selected, data, options) {
      if (!caller) throw providerError("AUTHORIZATION_FAILED", 9);
      if (operation === "token" && !networkAllowed) throw providerError("NETWORK_DISABLED", 3);
      return run({ operation, account: selected.name, ...data, packageName: caller.packageName, certificateSha1: caller.certificateSha1 }, options);
    },
    async release() {} };
}
function selections(context) {
  const settings = context.runtimeSettings || {}, enabled = settings.googleIntegration === true, id = enabled ? settings.googleAccount || "" : "";
  if (id && !/^[a-f0-9]{64}$/.test(id)) throw new Error("Choose a Google account in Settings.");
  return { enabled, id };
}
async function state(context, { refresh = true } = {}) {
  if (!refresh) return { accounts: snapshot(context).map(value => ({ id: value.id, label: value.name, canRemove: true })),
    providerInstalled: false, available: false, cached: true, canSignIn: true, message: "Mac.apk accounts are available in External." };
  const selected = await runtimeSelection(context, null, false);
  if (!selected.ready) return { accounts: snapshot(context).map(value => ({ id: value.id, label: value.name, canRemove: false })),
    providerInstalled: false, available: false, canSignIn: true, message: "Sign in downloads Mac.apk after confirmation. Google integration is off for each game until enabled." };
  const owner = await acquire(context), result = await owner.accounts();
  return { accounts: result.accounts.map(value => ({ id: value.id, label: value.name, canRemove: true })),
    providerInstalled: true, available: true, canSignIn: true, message: "Mac.apk Google accounts are stored separately from the other Android runtimes. Each game selects one account or anonymous access." };
}
async function signIn(context) {
  const owner = await acquire(context, { networkAllowed: true, install: true }), policyJar = Manager.materializePolicy(context.userDataDir);
  const d = descriptor(owner.runtime, owner.storage, policyJar, true); d.command = owner.runtime.executable; d.args = ["--gms", "signin-window"];
  d.env.MACAPK_APP_LABEL = "Google accounts";
  const policy = { ...Policy.resolvePolicy(), networkAllowed: true };
  const result = await withRuntimeUse({ managerId: Manager.id, version: owner.selection.version, sourcePath: owner.selection.install.installDir }, () =>
    withRuntimeMutation({ managerId: "android-macapk-google", sourcePath: owner.storage.root }, async () => {
      const isolation = await Policy.prepareIsolation(d, owner.storage, policy, { signal: context.signal });
      return captureProcess(isolation.command, isolation.args,
        { env: isolation.environment, cwd: owner.storage.root, signal: context.signal, timeout: 660000 });
    }, { userDataDir: context.userDataDir }), { userDataDir: context.userDataDir });
  if (result.code !== 0 && result.code !== 2) throw providerError();
  const completed = result.code === 0 && /^SIGNED_IN\t[^\r\n]+/m.test(result.output);
  await owner.accounts(); return { completed, interactionStarted: true };
}
async function importBrowserSession(context, { email, aasToken }, { signal = context.signal } = {}, dependencies = {}) {
  if (typeof email !== "string" || !email.includes("@") || email.length > 1024 || /[\x00-\x20\x7f]/.test(email) ||
      typeof aasToken !== "string" || !aasToken || aasToken.length > 16384 || /[\x00-\x20\x7f]/.test(aasToken))
    throw providerError("AUTHORIZATION_FAILED", 9);
  const owner = await (dependencies.acquire || acquire)({ ...context, signal }, { networkAllowed: false, install: true });
  try {
    const result = await owner.run({ operation: "register", account: email, aasToken }, { signal });
    if (result.completed !== true) throw providerError();
    const selected = (await owner.accounts()).accounts.find(value => value.name.toLowerCase() === email.toLowerCase());
    if (!selected) throw providerError();
    return { completed: true, accountId: selected.id };
  } finally { await owner.release(); }
}
async function remove(accountId, context) {
  const owner = await acquire(context), current = (await owner.accounts()).accounts.find(value => value.id === accountId);
  if (!current) throw new Error("The selected Google account is unavailable. Refresh accounts.");
  const result = await owner.run({ operation: "remove", account: current.name }); await owner.accounts(); return { completed: result.completed === true };
}
function choices(_entry, _payload, context) {
  return { googleAccounts: [{ value: "", label: "Google services without an account" }, ...snapshot(context).map(value => ({ value: value.id, label: value.name }))] };
}
async function prepareLaunch({ entry, context, packageSet, policy }) {
  const selected = selections(context); if (!selected.enabled) return null;
  const owner = await acquire(context, { entry, networkAllowed: policy.networkAllowed, packageSet }), accounts = (await owner.accounts()).accounts;
  const value = selected.id ? accounts.find(value => value.id === selected.id) : null;
  if (selected.id && !value) throw new Error("The selected Google account is unavailable. Refresh accounts.");
  const broker = await Broker.create({ owner, account: value, networkAllowed: policy.networkAllowed, signal: context.signal });
  return { enabled: true, mode: value ? "account" : "anonymous", socket: broker.socket, capability: broker.capability,
    enroll: broker.enroll, close: broker.close };
}
module.exports = { state, signIn, importBrowserSession, remove, choices, prepareLaunch, acquire, profilePaths, snapshot, selections, signatureVerifier };

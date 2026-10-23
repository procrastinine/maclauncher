const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../../shared/writable-input");
const Host = require("../host"), Storage = require("../storage"), Preparation = require("../prepare"), Packages = require("../service-packages");
const { createAccountControl } = require("../account-control");
const publicError = message => Object.assign(new Error(message), { playPublic: true });
async function materializeControl(context, _payload, _java, cacheRoot) {
  context.signal?.throwIfAborted();
  const source = fs.readFileSync(path.join(__dirname, "java/maclauncher/android/AccountControl.java"));
  const policySource = fs.readFileSync(path.join(__dirname, "java/maclauncher/android/framework/HostAccountAccess.java"));
  const bytes = fs.readFileSync(path.join(__dirname, "resources/account-control.jar")), record = require("./resources/account-control.json");
  const digest = value => crypto.createHash("sha256").update(value).digest("hex");
  if (record.schema !== 1 || digest(source) !== record.sourceSha256 || digest(policySource) !== record.policySourceSha256 || digest(bytes) !== record.sha256)
    throw publicError("The included Google account access helper is invalid. Reinstall MacLauncher.");
  const parent = path.join(cacheRoot, "google-play-control"), output = path.join(parent, record.sha256 + ".jar");
  Writable.assertOwnDirectory(cacheRoot, parent);
  try { if (!fs.lstatSync(output).isSymbolicLink() && digest(fs.readFileSync(output)) === record.sha256) return output; } catch {}
  Writable.atomicWrite(output, bytes, { root: parent }); fs.chmodSync(output, 0o400); return output;
}

async function runCaller(context, { packageName, selected, command, value, signal = context.signal }, dependencies = {}) {
  const deadline = AbortSignal.timeout(180000), operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  context = { ...context, signal: operationSignal, networkAllowed: true,
    runtimeSettings: { ...context.runtimeSettings, execution: "jvm", googleIntegration: true, googleAccount: selected?.accountId || null, networkIsolation: false } };
  const { payload, java } = await (dependencies.ensureGoogleServices || require("./microg-caller").ensureGoogleServices)(context);
  const realAccount = selected ? require("../google-accounts").selected(context.userDataDir, selected.accountId) : null;
  const caller = await (dependencies.resolveCaller || require("./microg-caller").resolveCaller)(context, { signal: operationSignal, packageName });
  const entry = { gameId: Packages.dataId(packageName), name: "Google account access", gamePath: caller.apks[0],
    ...(caller.apks.length > 1 ? { moduleData: { packageSet: true }, gamePath: path.dirname(caller.apks[0]) } : {}),
    runtimeSettings: { klepton: context.runtimeSettings } };
  let prepared, preparedRelease, installed, services, child, control;
  try {
    const storage = await Storage.prepareStorage({ gameId: Packages.dataId(packageName) }, context.userDataDir, { signal: operationSignal, payloadRoot: payload.root });
    prepared = await Preparation.prepareApk({ ...entry, gameId: Packages.codeId(packageName) }, { userDataDir: context.userDataDir, payload, java, signal: operationSignal,
      onToolProcessSpawn: context.onToolProcessSpawn, requireLauncher: false, retain: true });
    preparedRelease = await Preparation.retainPrepared(prepared);
    if (prepared.metadata.packageName !== packageName) throw publicError("The Google account caller package is invalid.");
    prepared = { ...prepared, filesRoot: storage.filesRoot, cacheRoot: storage.cacheRoot };
    const classes = await materializeControl(context, payload, java, prepared.cacheRoot);
    installed = await Packages.prepareInstalled(entry, prepared, context, payload, java);
    if (!installed || packageName !== "com.google.android.gms" && !installed.services.some(service => service.record.packageName === "com.google.android.gms")) throw publicError("microG Services must be enabled in Android account settings.");
    const presentation = Host.presentationEnvironment(payload, context);
    const config = { ...Host.launchConfig(entry, prepared, payload, context.runtimeSettings, presentation, true), serviceProcess: 1, accountControlFd: 6,
      googleProviderCompatibility: 1, networkAllowed: 1, webLinksAllowed: 0 };
    const launchProvider = Host.serviceLauncher(context, payload, java, presentation, {}, true);
    services = await require("../service-processes").prepareConnections({
      userDataDir: context.userDataDir, installed, game: prepared, config, signal: operationSignal,
      accountOptions: { userDataDir: context.userDataDir, runtimeRoot: payload.root, runtimeIdentity: payload.runtimeIdentity, javaPath: java.javaPath,
        moduleRoot: path.resolve(__dirname, ".."), account: realAccount, networkAllowed: true },
      platformOptions: payload.profile?.platformServicesVersion === 1 ? { userDataDir: context.userDataDir, runtimeRoot: payload.root,
        runtimeIdentity: payload.runtimeIdentity, javaPath: java.javaPath, moduleRoot: path.resolve(__dirname, ".."), systemServices: payload.profile.systemServicesVersion === 1 } : undefined,
      descriptorSender: path.join(payload.root, "native/android-supervisor-send"), processIdentityVersion: payload.profile?.processIdentityVersion,
      lazyProfileServicesVersion: payload.profile?.lazyProfileServicesVersion, launchService: launchProvider
    });
    const launchCaller = Host.serviceLauncher(context, payload, java, presentation, { spawnService: (command, args, ...rest) => {
      const index = args.indexOf("-cp"); if (index < 0) throw publicError("The Android account caller class path is unavailable.");
      const next = [...args]; next[index + 1] = classes + path.delimiter + next[index + 1];
      return require("../../../core/processes").spawnDetachedChecked(command, next, ...rest);
    } }, true);
    child = await launchCaller({ record: { packageName: prepared.metadata.packageName }, prepared,
      storage: { ...storage, launchFile: path.join(storage.root, "google-play-account.json") } }, config,
      services.stdio(["ignore", "ignore", "pipe", "ignore", "ignore", "pipe", "pipe"]), services.sandbox);
    control = createAccountControl({ child, control: child.stdio[6] });
    await services.connect(child);
    return await control.request(command, value || { name: realAccount.name },
      { signal: operationSignal, networkAllowed: true });
  } finally {
    control?.close(); child?.stdio?.[6]?.end();
    try { await services?.close(); } finally {
      if (child && child.exitCode == null && child.signalCode == null) {
        child.stdio?.[5]?.end();
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); child.removeListener("exit", done); resolve(); };
          const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 2500); timer.unref?.();
          child.once("exit", done); if (child.exitCode != null || child.signalCode != null) done();
        });
      }
      try { await installed?.release(); } finally { try { await preparedRelease?.(); } finally { await caller.release?.(); } }
    }
  }
}

function requestToken(context, selected, { signal = context.signal, refresh = false, previousToken } = {}, dependencies = {}) {
  const realAccount = require("../google-accounts").selected(context.userDataDir, selected.accountId);
  return runCaller(context, { packageName: "com.android.vending", selected, signal, command: "storeToken",
    value: { name: realAccount.name, ...(refresh && previousToken ? { invalidateToken: previousToken } : {}) } }, dependencies);
}

function importBrowserSession(context, { email, aasToken }, { signal = context.signal } = {}, dependencies = {}) {
  if (typeof email !== "string" || !email.includes("@") || email.length > 320 || /[\x00-\x20\x7f]/.test(email) ||
      typeof aasToken !== "string" || !aasToken || aasToken.length > 16384 || /[\x00-\x20\x7f]/.test(aasToken))
    return Promise.reject(publicError("The Google account sign-in result is invalid. Sign in again."));
  return runCaller(context, { packageName: "com.google.android.gms", signal, command: "storeImport", value: { email, aasToken } }, dependencies);
}

module.exports = { requestToken, importBrowserSession, materializeControl };

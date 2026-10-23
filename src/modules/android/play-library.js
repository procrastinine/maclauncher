const path = require("node:path"), { randomUUID } = require("node:crypto");
const Host = require("./host"), Google = require("./google-accounts"), Storage = require("./storage");
const Preparation = require("./prepare"), Packages = require("./service-packages");
const { withCatalogLock } = require("./catalog-lock");

const messages = {
  licensed: "Google Play reports this package is licensed for the selected account. It may already have been in the library.",
  "not-licensed": "Google Play did not grant a free license for this package. No paid purchase was attempted.",
  unavailable: "The installed Google Play service could not provide a license response.",
  failure: "The Google Play service reported an error. No license was confirmed.",
  timeout: "The Google Play service did not finish the request. No license was confirmed."
};
const labels = { licensed: "Licensed", "not-licensed": "Not licensed", unavailable: "Unavailable", failure: "Failed", timeout: "Timed out" };

function policy(entry, context) {
  const selected = Google.selections(entry);
  if (!selected.enabled || !selected.accountId) throw Error("Enable microG and select a Google account in game Settings first.");
  if (context.runtimeSettings?.networkIsolation === true || context.networkAllowed === false)
    throw Error("Enable network access for this game before adding it to Google Play.");
  if (context.isGameRunning?.()) throw Error("Close the game before adding it to Google Play.");
  return selected;
}
function waitForResult(child, signal) {
  let finish;
  const promise = new Promise((resolve, reject) => {
    const result = value => done(null, value);
    const exited = () => done(Error("The Google Play operation ended without a license response."));
    const aborted = () => done(signal.reason || Error("The Google Play operation was cancelled."));
    const timer = setTimeout(() => done(null, { status: "timeout", code: -1 }), 180000);
    timer.unref?.();
    function done(error, value) {
      clearTimeout(timer); child.removeListener("androidOperationResult", result);
      child.removeListener("exit", exited); child.removeListener("error", exited); signal?.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve(value);
    }
    finish = done;
    child.once("androidOperationResult", result); child.once("exit", exited); child.once("error", exited);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted(); else if (child.exitCode != null || child.signalCode != null) exited();
  });
  // A setup failure can precede waiting for the reply; retain its one rejection.
  promise.catch(() => {});
  return { promise, cancel: () => finish(Error("The Google Play operation was closed.")) };
}
async function acquire(entry, _options, context, dependencies = {}) {
  const selection = policy(entry, context), account = Google.selected(context.userDataDir, selection.accountId);
  const manager = dependencies.manager || require("./runtime-manager");
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
  if (!selected.ready) throw new Error(selected.reason);
  await context.useRuntime?.({ managerId: manager.id, version: selected.version, sourcePath: selected.install.installDir });
  const payload = await (dependencies.resolveRuntime || require("./runtime").resolveForLaunch)(
    { root: selected.install.root, signal: context.signal }, selected.install.declaration);
  if (payload.profile?.playLibraryVersion !== 1) throw Error("This Android runtime does not support adding games to Google Play.");
  const storage = await Storage.prepareStorage(entry, context.userDataDir, { signal: context.signal, payloadRoot: payload.root });
  return withCatalogLock(path.join(storage.root, "play-library.lock"), async () => {
    context.signal?.throwIfAborted(); policy(entry, context);
    const java = await Host.ensureJava(context, dependencies);
    let installed, services, release, child, reply;
    try {
      const prepared = await (dependencies.prepare || Preparation.prepareApk)(entry, { userDataDir: context.userDataDir,
        payload, java, signal: context.signal, onToolProcessSpawn: context.onToolProcessSpawn, requireLauncher: false, retain: true });
      release = await Preparation.retainPrepared(prepared);
      installed = await (dependencies.prepareInstalled || Packages.prepareInstalled)(entry, prepared, context, payload, java);
      if (!installed?.services.some(service => service.record.packageName === "com.android.vending") ||
          !installed.services.some(service => service.record.packageName === "com.google.android.gms"))
        throw Error("Install and enable the Google Play service packages first.");
      const presentation = Host.presentationEnvironment(payload, context);
      const config = { ...Host.launchConfig(entry, prepared, payload, context.runtimeSettings || {}, presentation, true),
        serviceProcess: 1, serviceOperation: "play-library", operationId: randomUUID(), webLinksAllowed: 0,
        googleProviderCompatibility: 1, networkAllowed: 1 };
      // The existing supervisor retains one caller-scoped GMS data container.
      // Only this explicit operation enables its original free-acquisition preference.
      const launchService = Host.serviceLauncher(context, payload, java, presentation, dependencies, true);
      services = await (dependencies.prepareConnections || require("./service-processes").prepareConnections)({
        userDataDir: context.userDataDir, installed, game: prepared, config, signal: context.signal, logger: context.logger,
        processIdentityVersion: payload.profile.processIdentityVersion,
        lazyProfileServicesVersion: payload.profile.lazyProfileServicesVersion,
        accountOptions: { userDataDir: context.userDataDir, runtimeRoot: payload.root, runtimeIdentity: payload.runtimeIdentity, javaPath: java.javaPath,
          moduleRoot: __dirname, account, networkAllowed: true },
        platformOptions: { userDataDir: context.userDataDir, runtimeRoot: payload.root, runtimeIdentity: payload.runtimeIdentity, javaPath: java.javaPath,
          moduleRoot: __dirname, systemServices: payload.profile.systemServicesVersion === 1 },
        descriptorSender: path.join(payload.root, "native/android-supervisor-send"),
        launchService: (service, fields, stdio, sandbox) => launchService(service,
          { ...fields, ...(service.record.packageName === "com.google.android.gms" ? { googleFreeAcquisition: 1 } : {}) }, stdio, sandbox)
      });
      // An ordinary supervised package process supplies the real UID/package
      // identity. The explicit operation does not instantiate the game Activity.
      child = await launchService({ record: { packageName: prepared.metadata.packageName }, prepared,
        storage: { ...storage, launchFile: path.join(storage.root, "play-library.json") } }, config,
        services.stdio(["ignore", "ignore", "pipe"]), services.sandbox);
      reply = waitForResult(child, context.signal);
      await services.connect(child);
      const result = await reply.promise;
      return { status: labels[result.status], message: messages[result.status], code: result.code };
    } finally {
      reply?.cancel();
      // End the same supervisor before releasing code or the per-caller lease.
      // Provider shutdown restores the original preference; a killed provider
      // recovers its journal before its next settings publication.
      try { await services?.close(); } finally {
        if (child && child.exitCode == null && child.signalCode == null) {
          child.stdio?.[5]?.end();
          await new Promise(resolve => {
            const done = () => { clearTimeout(timer); child.removeListener("exit", done); resolve(); };
            const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
            child.once("exit", done); if (child.exitCode != null || child.signalCode != null) done();
          });
        }
        try { await installed?.release(); } finally { await release?.(); }
      }
    }
  });
}
module.exports = { acquire, policy, waitForResult };

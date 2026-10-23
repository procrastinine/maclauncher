const { profilePaths, saveSnapshot } = require("./profile");
const Packages = require("./packages");
const { signingCertificates } = require("./apk-identity");

function providerError(code = "ACCOUNT_PROVIDER_ERROR", interactiveRequired = false) {
  const error = new Error(interactiveRequired ? "Google account authorization requires an account action in Settings."
    : "The Android Google account service could not complete the request.");
  error.code = code; error.interactiveRequired = interactiveRequired; return error;
}
function validateCaller(caller) {
  if (!caller || !/^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(caller.packageName || "") ||
    !Array.isArray(caller.signers) || !caller.signers.length || caller.signers.some(s => !/^[a-f0-9]{64}$/.test(s)) ||
    !Array.isArray(caller.apks) || !caller.apks.length) throw new Error("The Android account caller identity is invalid.");
  return { packageName: caller.packageName, signers: [...new Set(caller.signers)].sort(), apks: caller.apks };
}
function inspectCaller(packageSet) {
  const apks = packageSet?.apks || packageSet?.selected?.map(item => item.file);
  const packageName = packageSet?.metadata?.packageName || packageSet?.base?.metadata?.packageName;
  if (!Array.isArray(apks) || !apks.length) throw new Error("The Android account caller package is missing.");
  const signers = signingCertificates(apks[0]);
  for (const file of apks) if (JSON.stringify(signingCertificates(file)) !== JSON.stringify(signers))
    throw new Error("Android base and split APKs have different signing certificates.");
  // The canonical Android PackageManager verifies the actual APK signatures at
  // install. Parsing the host-side certificate is only a comparison identity.
  return validateCaller({ packageName, signers, apks });
}

async function acquire(context, { networkAllowed = false, install = false, packages, caller } = {}, dependencies = {}) {
  packages ||= install ? await Packages.ensurePackages(context, dependencies) : Packages.resolvePackages(context.userDataDir);
  if (!packages) throw providerError("GOOGLE_NOT_INSTALLED");
  const storage = profilePaths(context.userDataDir, { create: true });
  const aim = dependencies.aim || require("../providers/aim");
  if (typeof aim.acquireGoogleSystem !== "function") throw providerError("GOOGLE_RUNTIME_UNAVAILABLE");
  const system = await aim.acquireGoogleSystem({ context, storage, packages, networkAllowed });
  let closed = false, verifiedCaller = null;
  async function request(operation, data = {}, { signal = context.signal } = {}) {
    if (closed) throw providerError("GOOGLE_OWNER_CLOSED");
    signal?.throwIfAborted();
    let reply;
    try { reply = await system.request({ ...data, operation }, { signal, networkAllowed }); }
    catch (error) { if (signal?.aborted || error.name === "AbortError") throw error; throw providerError(error.code); }
    if (!reply || reply.ok !== true || !reply.result || typeof reply.result !== "object") {
      const failure = providerError(typeof reply?.error?.code === "string" ? reply.error.code : "ACCOUNT_PROVIDER_ERROR");
      if (Number.isSafeInteger(reply?.error?.code)) failure.providerCode = reply.error.code;
      throw failure;
    }
    if (reply.result.interactiveRequired) throw providerError("AUTHORIZATION_REQUIRED", true);
    if (reply.result.providerCode !== undefined) {
      const failure = providerError("ACCOUNT_PROVIDER_ERROR"); failure.providerCode = reply.result.providerCode; throw failure;
    }
    return reply.result;
  }
  try {
    if (caller) {
      caller = validateCaller(caller);
      await system.installCaller(caller.apks, { signal: context.signal });
      const result = await request("verifyCaller", { packageName: caller.packageName, signers: caller.signers });
      if (result.packageName !== caller.packageName || !Number.isSafeInteger(result.uid) || result.uid < 10000)
        throw providerError("AUTHORIZATION_FAILED");
      verifiedCaller = { ...caller, uid: result.uid };
    }
    return { storage, packages, caller: verifiedCaller,
      async accounts() {
        const result = await request("accounts");
        if (!Array.isArray(result.accounts)) throw providerError();
        return { accounts: saveSnapshot(context.userDataDir, result.accounts), canSignIn: result.canSignIn === true };
      },
      request,
      async token(operation, account, data = {}, options = {}) {
        if (!verifiedCaller) throw providerError("AUTHORIZATION_FAILED");
        if (operation === "token" && !networkAllowed) throw providerError("NETWORK_DISABLED");
        return request(operation, { ...data, account, packageName: verifiedCaller.packageName, signers: verifiedCaller.signers }, options);
      },
      async release(options) { if (closed) return; closed = true; await system.release?.(options); }
    };
  } catch (error) { await system.release?.(); throw error; }
}
module.exports = { acquire, inspectCaller, validateCaller, providerError };

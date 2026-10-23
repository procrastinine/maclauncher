const path = require("node:path");

function execution(context = {}) {
  const selected = context.runtimeSettings?.execution ?? "jvm";
  if (selected !== "jvm" && selected !== "art") throw new Error("The Android execution engine is unsupported.");
  return selected;
}

function networkBlocked(context = {}) {
  return context.runtimeSettings?.networkIsolation !== false || context.networkAllowed === false;
}

function platformServiceOptions({ context, payload, platformPayload = payload, java }) {
  if ((payload.profile?.processIdentityVersion ?? 0) !== (platformPayload.profile?.processIdentityVersion ?? 0))
    throw new Error("The Android application and platform runtime use incompatible process identities.");
  return { userDataDir: context.userDataDir, runtimeRoot: platformPayload.root,
    runtimeIdentity: platformPayload.runtimeIdentity, javaPath: java.javaPath, moduleRoot: __dirname };
}

/** ART's extra image belongs to application execution. Profile services use
 * the selected verified common JVM closure, with its own complete identity. */
async function resolvePlatformRuntime({ context, payload }, dependencies = {}) {
  if (!dependencies.resolvePlatformRuntime && (!payload.runtimeIdentity || !payload.runtimeDeclaration?.files))
    throw new Error("The Android runtime identity is unavailable.");
  const platformPayload = dependencies.resolvePlatformRuntime
    ? await dependencies.resolvePlatformRuntime({ signal: context.signal })
    : await require("./runtime").resolveForLaunch({ root: payload.root, signal: context.signal }, payload.runtimeDeclaration);
  platformServiceOptions({ context, payload, platformPayload, java: {} });
  return platformPayload;
}

/** Both VM entries enroll in the same profile owners with the same account
 * selection and session network policy. Only process execution is supplied by
 * the VM adapter. Resolve selection at launch, independently of open UI views. */
function serviceOptions({ context, payload, platformPayload = payload, java, installed }) {
  const base = platformServiceOptions({ context, payload, platformPayload, java });
  return {
    processIdentityVersion: payload.profile?.processIdentityVersion,
    lazyProfileServicesVersion: payload.profile?.lazyProfileServicesVersion,
    descriptorSender: path.join(payload.root, "native/android-supervisor-send"),
    platformOptions: platformPayload.profile?.platformServicesVersion === 1 ? {
      ...base, systemServices: platformPayload.profile?.systemServicesVersion === 1
    } : undefined,
    accountOptions: platformPayload.profile?.sharedAccountsVersion === 1 &&
      (platformPayload.profile?.frameworkServicesVersion === 1 || installed?.google?.enabled) ? {
        ...base, account: require("./google-accounts").selected(context.userDataDir, installed?.google?.accountId),
        networkAllowed: !networkBlocked(context)
      } : undefined
  };
}

module.exports = { execution, networkBlocked, serviceOptions, platformServiceOptions, resolvePlatformRuntime };

function pickRuntimeId({
  requestedRuntime,
  supported,
  defaultRuntime,
  nativePath,
  canLaunchRuntime,
  entry,
  moduleSettings,
  context
}) {
  const supportedList = Array.isArray(supported) ? supported.filter(Boolean) : [];
  const normalized =
    typeof requestedRuntime === "string" ? requestedRuntime.trim().toLowerCase() : "";
  const fallbackRuntime = supportedList.includes(defaultRuntime)
    ? defaultRuntime
    : supportedList[0] || defaultRuntime || null;
  let runtime = supportedList.includes(normalized) ? normalized : fallbackRuntime;

  if (typeof canLaunchRuntime === "function") {
    const candidates = [runtime, ...supportedList];
    for (const candidate of candidates) {
      if (!candidate || !supportedList.includes(candidate)) continue;
      if (canLaunchRuntime(candidate, entry, moduleSettings, context)) {
        runtime = candidate;
        break;
      }
    }
  }

  if (runtime === "native" && !nativePath) {
    const nonNative = supportedList.filter(rt => rt !== "native");
    if (nonNative.length > 0) {
      runtime = nonNative.includes(defaultRuntime) ? defaultRuntime : nonNative[0];
    }
  }

  if (runtime && !supportedList.includes(runtime)) runtime = fallbackRuntime;
  return runtime;
}

module.exports = {
  pickRuntimeId
};

// Developer ABI probe; no game, SDK library or Steam account is distributed.
// Run through the exact NW.js host with the publisher's unchanged bridge.
async function probeGreenworks(greenworks, { versions = process.versions, architecture = process.arch,
  expectedArchitecture = "arm64", expectedAppId, mode = "offline", timeoutMs = 8000 } = {}) {
  if (versions.nw !== "0.103.1" || versions.greenworks !== "0.22.0" || architecture !== expectedArchitecture)
    throw new Error("The probe requires the exact Greenworks 0.22 / NW.js 0.103.1 host and CPU.");
  if (!Number.isInteger(expectedAppId) || expectedAppId < 1 || expectedAppId > 0xffffffff)
    throw new Error("An explicit positive fixture application ID is required.");
  if (!["offline", "native"].includes(mode) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new Error("Choose a finite native or offline ABI probe.");
  const result = { mode, architecture, versions, gameProof: false, loaded: true, bridgeVersion: greenworks._version,
    running: greenworks.isSteamRunning(), initialized: greenworks.initAPI() };
  if (typeof result.running !== "boolean" || typeof result.initialized !== "boolean")
    throw new Error("The bridge returned an invalid initialization result.");
  if (!result.initialized) {
    if (mode === "offline") throw new Error("The controlled offline bridge did not initialize.");
    return result;
  }
  result.appId = greenworks.getAppId();
  result.language = greenworks.getCurrentGameLanguage();
  const identity = greenworks.getSteamId();
  result.identityValid = identity?.isValid === true || identity?.isValid === 1;
  if (result.appId !== expectedAppId || typeof result.language !== "string" || !result.language || !result.identityValid)
    throw new Error("The initialized bridge returned invalid typed client values.");
  const callback = action => new Promise((resolve, reject) => {
    let finished = false;
    const finish = value => { if (!finished) { finished = true; clearTimeout(timeout); resolve(value); } };
    const timeout = setTimeout(() => finish({ delivered: false, timeout: true }), timeoutMs);
    try { action(value => finish({ delivered: true, success: true, value }), error => finish({ delivered: true, success: false, error: String(error) })); }
    catch (error) { clearTimeout(timeout); finished = true; reject(error); }
  });
  // An unconfigured fixture achievement must retain its actual error result.
  result.achievementCallback = await callback((success, error) => greenworks.getAchievement("MACLAUNCHER_GREENWORKS_ABI_PROBE", success, error));
  result.statsCallback = await callback((success, error) => greenworks.storeStats(success, error));
  if (!result.achievementCallback.delivered || !result.statsCallback.delivered || !result.statsCallback.success ||
      String(result.statsCallback.value) !== String(expectedAppId)) throw new Error("The native stats callback ABI did not return the fixture application ID.");
  return result;
}

module.exports = { probeGreenworks };

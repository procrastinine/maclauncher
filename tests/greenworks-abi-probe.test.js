const test = require("node:test");
const assert = require("node:assert/strict");
const { probeGreenworks } = require("../src/modules/shared/web/runtime/greenworks-abi-probe");
const options = { versions: { nw: "0.103.1", greenworks: "0.22.0" }, architecture: "arm64", expectedAppId: 480, timeoutMs: 100 };
function bridge() { return { _version: "0.22.0", isSteamRunning: () => true, initAPI: () => true, getAppId: () => 480,
  getCurrentGameLanguage: () => "english", getSteamId: () => ({ isValid: 1 }),
  getAchievement: (_name, _success, error) => error("Unconfigured fixture achievement"), storeStats: success => setImmediate(() => success("480")) }; }

test("ABI probes reject a different host, bridge, CPU or inferred application ID before initialization", async () => {
  for (const override of [{ versions: { nw: "0.117.0", greenworks: "0.22.0" } }, { versions: { nw: "0.103.1", greenworks: "0.21.0" } },
    { architecture: "x64" }, { expectedAppId: undefined }]) {
    await assert.rejects(probeGreenworks({ initAPI: () => assert.fail("Unqualified probes cannot initialize") }, { ...options, ...override }));
  }
});

test("an uninitialized native API does not call pointer getters or invent initialization", async () => {
  const native = { _version: "0.22.0", isSteamRunning: () => false, initAPI: () => false, getAppId: () => assert.fail("No initialized interface") };
  const result = await probeGreenworks(native, { ...options, mode: "native" });
  assert.equal(result.initialized, false); assert.equal(result.gameProof, false);
  await assert.rejects(probeGreenworks(native, options), /did not initialize/);
});

test("typed client values and actual callback errors remain distinct from a game proof", async () => {
  const result = await probeGreenworks(bridge(), options);
  assert.equal(result.appId, 480); assert.equal(result.identityValid, true); assert.equal(result.gameProof, false);
  assert.deepEqual(result.achievementCallback, { delivered: true, success: false, error: "Unconfigured fixture achievement" });
  assert.deepEqual(result.statsCallback, { delivered: true, success: true, value: "480" });
});

test("wrong typed values, missing callbacks and another game's callback ID cannot qualify", async () => {
  for (const override of [{ getAppId: () => 481 }, { getSteamId: () => ({ isValid: false }) },
    { storeStats: () => {} }, { storeStats: success => success("481") }]) await assert.rejects(probeGreenworks({ ...bridge(), ...override }, options));
});

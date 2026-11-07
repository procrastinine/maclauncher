const test = require("node:test"), assert = require("node:assert/strict");
const Adapter = require("../src/modules/shared/runtime/dxgi-adapter-description");
const Hardware = require("../src/modules/shared/runtime/graphics-hardware");
const CrossOver = require("../src/modules/crossover/runtime/launch");

test("NVIDIA DXGI descriptions preserve user config, quote the actual GPU name and require DXVK DXGI", async t => {
  const original = ' dxgi.customVendorId = "10DE"; dxvk.hud = "fps,compiler"; dxgi.maxFrameRate = 60; ';
  const values = { DXVK_ENABLE_NVAPI: "1", DXVK_CONFIG: original };
  let calls = 0, name = "Apple M2 Max";
  t.mock.method(Hardware, "graphicsHardware", async (_host, options) => {
    calls++; assert.equal(options.requireName, true); return { gpuName: name };
  });
  const description = engine => ({ id: engine, engine, files: [{ path: "/translator/x86_64-windows/dxgi.dll", format: "pe", machine: 0x8664 }] });
  for (const runtime of ["crossover", "sikarugir"]) for (const engine of ["dxvk", "vkd3d-proton"]) {
    const used = description(engine), file = used.files[0];
    const translatorPlan = { runtime, apiMode: true, placements: [{ description: used, file, roles: [engine === "dxvk" ? "d3d11" : "d3d12"] }] };
    const added = await Adapter.prepare(values, { translatorPlan });
    assert.equal(added.DXVK_CONFIG, 'dxgi.customDeviceDesc = "Apple M2 Max (DXVK)"; ' + original);
    assert.equal(values.DXVK_CONFIG, original, "the caller's environment is unchanged");
    assert.match(CrossOver.wineEnvironmentString(added), /dxgi\.customDeviceDesc = "Apple M2 Max \(DXVK\)"/,
      "the CrossOver environment transport retains DXVK's double quotes");
  }
  const translatorPlan = { components: { "d3d-renderer": { used: description("dxvk"), inherited: true } } };
  assert.ok((await Adapter.prepare(values, { translatorPlan })).DXVK_CONFIG, "the legacy inherited DXGI route uses the same merge");
  const before = calls;
  for (const config of [
    original + '; dxgi.customDeviceDesc = "User GPU name"',
    'dxgi.customDeviceDesc = ; ' + original,
    'dxgi.customDeviceDesc = ""; ' + original,
    original + '; dxgi.customVendorId = 1002',
    'dxgi.customVendorId = 8086',
    'dxvk.hud = fps'
  ]) assert.deepEqual(await Adapter.prepare({ ...values, DXVK_CONFIG: config }, { translatorPlan }), {}, config);
  assert.deepEqual(await Adapter.prepare({ DXVK_ENABLE_NVAPI: "1" }, { translatorPlan }), {},
    "enabling NVAPI alone does not turn an Apple adapter into NVIDIA");
  assert.deepEqual(await Adapter.prepare(values, { translatorPlan: { components: { "d3d-renderer": { used: description("dxmt") } } } }), {});
  assert.deepEqual(await Adapter.prepare(values, { translatorPlan: { apiMode: true, placements: [] } }), {});
  assert.equal(calls, before, "unused or user-controlled descriptions do not query hardware");
  for (name of [null, "", 'GPU "quoted"', "GPU; dxgi.customVendorId = 1002"]) {
    assert.deepEqual(await Adapter.prepare(values, { translatorPlan }), {}, "no replacement name is invented");
  }
  assert.equal(Adapter.environment({ DXVK_CONFIG: "dxgi.customVendorId=10de", DXVK_ENABLE_NVAPI: "0" }, "Apple M2 Max").DXVK_CONFIG,
    'dxgi.customDeviceDesc = "Apple M2 Max (DXVK)"; dxgi.customVendorId=10de', "an explicit vendor override controls presentation");
});

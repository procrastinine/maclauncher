const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Hardware = require("../src/modules/shared/reshade/hardware-support");
const Plan = require("../src/modules/shared/effects/plan");
const Graphics = require("../src/modules/shared/reshade/graphics-settings");
function device(name, registryID, supported, isDefault = false) {
  return {name, registryID, isDefault, metalfx: Object.fromEntries(Hardware.OPERATIONS.map(key => [key,
    {supported, metal4Supported: supported, minimumMacOS: ["denoised", "interpolation"].includes(key) ? "26.0" : "13.0",
      ...(["temporal", "denoised"].includes(key) && supported ? {minScale: 1, maxScale: 3} : {})}]))};
}
function response(devices) {
  const selected = devices.find(row => row.isDefault);
  return {schema: 1, device: {name: selected.name, registryID: selected.registryID}, devices, metalfx: selected.metalfx};
}
test("GPU support has no CPU-generation gate and a secondary supported GPU remains usable", () => {
  const m2 = Hardware.validate(response([device("Apple M2 Max", "4294968563", true, true)]));
  assert.equal(Hardware.operationReason(m2, "denoised"), null);
  const multiple = Hardware.validate(response([device("Default GPU", "10", false, true), device("Secondary GPU", "11", true)]));
  assert.equal(Hardware.operationReason(multiple, "denoised"), null);
  assert.equal(Hardware.operationReason(multiple, "denoised", {deviceRegistryID: "10"}), "Not supported by Default GPU.");
  assert.equal(Hardware.operationReason(multiple, "denoised", {macOSVersion: "15.0", deviceRegistryID: "10"}), "Requires macOS 26.0 or later.");
  assert.equal(Hardware.operationReason({state: "unknown"}, "denoised"), null);
  const queryFailure = Hardware.validate(response([device("GPU", "13", false, true)]));
  queryFailure.devices[0].metalfx.denoised.reason = "The device query failed";
  assert.equal(Hardware.operationReason(queryFailure, "denoised"), null);
});
test("known MetalFX API floors survive an unavailable hardware helper without restricting older image operations",async()=>{
  const support={spatial:true,spatialMethods:["bilinear","metalfx"],temporal:true,temporalMethods:["metalfx","metalfx-denoised"],
    providerTemporalMethods:["metalfx","metalfx-denoised"],frameGeneration:true,frameGenerationMethods:["metalfx"]};
  for(const macOSVersion of ["13.0","25.0","26.0"]){
    const hardware=await Hardware.inspect(path.join(__dirname,"fixtures/missing-graphics-runtime"),{platform:"darwin",macOSVersion,
      execute:()=>assert.fail("An absent probe must not launch a helper")});
    assert.equal(hardware.state,"unknown");assert.equal(hardware.macOSVersion,macOSVersion);
    assert.equal(Hardware.operationReason(hardware,"spatial"),null);assert.equal(Hardware.operationReason(hardware,"temporal"),null);
    const rows=Plan.catalog({reshadeState:{available:true},graphicsCapabilities:{...support,hardware},graphicsInputs:{}});
    assert.equal(rows.find(row=>row.id==="upscale:bilinear").available,true);
    assert.equal(rows.find(row=>row.id==="upscale:metalfx").available,true);
    assert.equal(rows.find(row=>row.id==="temporal:metalfx").available,true);
    for(const id of ["temporal:metalfx-denoised","frame-generation:metalfx"]){const row=rows.find(row=>row.id===id);
      if(macOSVersion==="26.0"){assert.equal(row.available,true);assert.equal(row.reason,undefined);}
      else{assert.equal(row.available,false);assert.equal(row.availableWithoutInputs,false);assert.equal(row.reason,"Requires macOS 26.0 or later.");}
    }
    assert.equal(hardware.state,"unknown","OS knowledge never becomes a fabricated GPU result");
  }
});
test("invalid capability responses never become positive or false hardware support", () => {
  const data = response([device("GPU", "18446744073709551615", true, true)]);
  assert.equal(Hardware.validate(data).device.registryID, "18446744073709551615");
  for (const change of [row => {row.devices[0].registryID = 2 ** 60;}, row => {row.metalfx.denoised.supported = "yes";},
    row => {row.metalfx.temporal.minScale = 4;}, row => {row.devices.push({...row.devices[0]});}]) {
    const invalid = structuredClone(data);change(invalid);assert.throws(() => Hardware.validate(invalid));
  }
});
test("concurrent offline requests share one bounded probe and source replacement invalidates it", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-device-"));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({features: {graphics: {hardwareQueryAPI: 1}}}));
  const helper = path.join(root, "maclauncher-graphics-hardware");fs.writeFileSync(helper, "fixture", {mode: 0o755});
  let calls = 0, release;
  const execute = async (_file, args, options) => {
    calls++;assert.deepEqual(args, []);assert.equal(options.timeout, 3000);
    assert.ok(Object.keys(options.env).every(key => !/^(DYLD_|RESHADE_|MTL_CAPTURE_)/.test(key)));
    await new Promise(resolve => {release = resolve;});
    return {stdout: JSON.stringify(response([device("GPU", "12", true, true)]))};
  };
  const options = {platform: "darwin", macOSVersion: "26.0", execute};
  const first = Hardware.inspect(root, options), second = Hardware.inspect(root, options);
  await new Promise(resolve => setImmediate(resolve));assert.equal(calls, 1);release();
  assert.equal((await first).state, "ready");await second;
  assert.equal((await Hardware.inspect(root, options)).device.registryID, "12");assert.equal(calls, 1);
  fs.appendFileSync(helper, "-new");assert.equal(Hardware.snapshot(root, options).state, "unknown");
  const replaced = Hardware.inspect(root, options);await new Promise(resolve => setImmediate(resolve));release();await replaced;
  assert.equal(calls, 2);
});
test("denoised scaling is an ordinary scene peer with actual AOV requirements and no model download", () => {
  assert.equal(Graphics.updateSettings({}, {temporalMethod: "metalfx-denoised"}).temporalMethod, "metalfx-denoised");
  const support = {spatial: true, spatialMethods: ["bilinear"], temporal: true,
    temporalMethods: ["metalfx", "metalfx-denoised"], providerTemporalMethods: ["metalfx", "metalfx-denoised"],
    frameGeneration: false, frameGenerationMethods: []};
  const rows = Plan.catalog({reshadeState: {available: true}, graphicsCapabilities: support, graphicsInputs: {depth: true, motionVectors: true}});
  const denoised = rows.find(row => row.id === "temporal:metalfx-denoised");
  assert.ok(denoised.availableWithoutInputs);
  assert.deepEqual(denoised.pendingInputs, ["viewMatrix", "projectionMatrix", "noisyColor", "normal", "roughness", "diffuseAlbedo", "specularAlbedo"]);
  assert.equal(denoised.runtimeManagerId, undefined);
  assert.equal(rows.find(row => row.id === "upscale:bilinear").available, true);
  const hardware = Hardware.validate(response([device("GPU", "10", false, true)]));
  const unavailable = Plan.catalog({reshadeState: {available: true}, graphicsCapabilities: {...support, hardware}, graphicsInputs: {}})
    .find(row => row.id === "temporal:metalfx-denoised");
  assert.equal(unavailable.available, false);assert.equal(unavailable.availableWithoutInputs, false);
  assert.match(unavailable.reason, /detected GPUs/);
});

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Components = require("../src/modules/shared/reshade/runtime/components");
const FSR = require("../src/modules/shared/reshade/temporal/fsr/source.json");
const FSR4 = require("../src/modules/shared/reshade/temporal/fsr4/source.json");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-components-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = (relative, value) => { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); };
  file("runtime.json", JSON.stringify({ schema: 1, version: "1.0", minimumMacOS: "13.0", features: {
    graphics: { spatialMethods: ["fsr1", "metalfx"], temporalMethods: ["metalfx", "fsr2", "fsr3", "fsr4"] } } }));
  file("libreshade-macos.dylib", "provider");
  for (const method of ["fsr2", "fsr3"]) {
    file(`temporal/fsr/${method}-build.json`, JSON.stringify({ providerABI: 1, commit: "installed-build", shaderVariants: 16 }));
    file(`temporal/fsr/libmaclauncher-${method}.dylib`, "provider");
    fs.mkdirSync(path.join(root, "temporal/fsr", method));
  }
  file("temporal/fsr4/provider.json", JSON.stringify({ providerABI: 1, complete: true, commit: "installed-build", library: "libmaclauncher-fsr4.dylib", model: FSR4.model,
    profilesAPI: 1, resourcePreparation: 1, supportedProfiles: FSR4.supportedProfiles, profiles: FSR4.profiles }));
  file("temporal/fsr4/libmaclauncher-fsr4.dylib", "provider");
  file("temporal/fsr4/third_party/fsr411/initializers.bin", "model");
  file("temporal/fsr4/third_party/fsr411/LICENSE.Lite2.txt", "license");
  fs.mkdirSync(path.join(root, "temporal/fsr4/build"));
  return root;
}
test("Graphics overview separates installed components, system requirements and purchased models without network", t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Opening Runtimes must stay offline"));
  const root = fixture(t), options = { root, platform: "darwin", macOSVersion: "27.0", hardwareArch: "arm64" };
  const rows = Object.fromEntries(Components.getComponents(options).map(row => [row.id, row]));
  assert.equal(rows.metalfx.status, "Provided by macOS");
  assert.equal(rows.fsr1.status, "Included");
  assert.equal(rows.fsr2.version, "2.2.1"); assert.equal(rows.fsr3.version, "3.1.4");
  assert.equal(rows.fsr4.version, FSR4.model); assert.equal(rows.fsr4.status, "Included");
  assert.match(rows.fsr2.requirements, /camera projection/);
  assert.equal(rows.lossless.status, "Models required");
  assert.equal(Components.getComponents({ ...options, installed: [{ version: "model" }] }).find(row => row.id === "lossless").status, "1 model file imported");
  const older = Components.getComponents({ ...options, macOSVersion: "14.0" });
  assert.equal(older.find(row => row.id === "fsr4").status, `Requires macOS ${FSR4.minimumMacOS}`);
  assert.equal(older.find(row => row.id === "fsr3").status, "Included");
  const current = Components.getComponents({ ...options, macOSVersion: "15.0" }).find(row => row.id === "fsr4");
  assert.equal(current.status, "Included");assert.equal(current.available, true);
  // An accepted older payload reports its own floor rather than the current source's.
  const legacy = FSR4.legacyPayloads[0], provider = path.join(root, "temporal/fsr4/provider.json");
  fs.writeFileSync(provider, JSON.stringify({ providerABI: 1, complete: true, commit: "legacy-build", library: "libmaclauncher-fsr4.dylib",
    model: legacy.model, profile: "exact-fast" }));
  const payload = Components.getComponents({ ...options, macOSVersion: "15.0" }).find(row => row.id === "fsr4");
  assert.equal(payload.status, `Requires macOS ${legacy.minimumMacOS}`);assert.equal(payload.available, false);
  assert.match(payload.requirements, new RegExp(`macOS ${legacy.minimumMacOS.replace(".", "\\.")} or later`));
  assert.equal(Components.getComponents(options).find(row => row.id === "fsr4").status, "Included");
  fs.rmSync(path.join(root, "temporal/fsr/libmaclauncher-fsr3.dylib"));
  assert.equal(Components.getComponents(options).find(row => row.id === "fsr3").status, "Not included");
});
test("component presence stays visible across CPU, unknown-host and per-method deployment requirements", t => {
  const root = fixture(t), options = { root, platform: "darwin", macOSVersion: "15.4.1", hardwareArch: "arm64" };
  const provider = path.join(root, "temporal/fsr4/provider.json");
  fs.writeFileSync(provider, JSON.stringify({ ...JSON.parse(fs.readFileSync(provider)), minimumMacOS: "15.4.2" }));
  const fsr2 = path.join(root, "temporal/fsr/fsr2-build.json");
  fs.writeFileSync(fsr2, JSON.stringify({ ...JSON.parse(fs.readFileSync(fsr2)), minimumMacOS: "15.4.2" }));
  const rows = Object.fromEntries(Components.getComponents(options).map(row => [row.id, row]));
  for (const method of ["fsr2", "fsr4"]) {
    assert.equal(rows[method].status, "Requires macOS 15.4.2");
    assert.equal(rows[method].available, false);
    assert.ok(rows[method].version, "included payload identity remains visible");
  }
  assert.equal(rows.fsr3.available, true, "a higher FSR2 requirement does not remove FSR3");
  const runtime = require("../src/modules/shared/reshade/temporal/fsr");
  assert.deepEqual(runtime.resolve(root, options).methods, ["fsr3"]);
  assert.equal(runtime.resolve(root, options).minimumMacOS, FSR.minimumMacOS);
  assert.deepEqual(runtime.resolve(root, { ...options, macOSVersion: "15.4.2" }).methods, ["fsr2", "fsr3"]);
  assert.equal(runtime.resolve(root, { ...options, macOSVersion: "15.4.2" }).minimumMacOS, "15.4.2");
  const intel = Components.getComponents({ ...options, macOSVersion: "27.0", hardwareArch: "x64" });
  assert.match(intel.find(row => row.id === "fsr4").status, /Apple Silicon/);
  assert.equal(intel.find(row => row.id === "fsr4").available, false);
  assert.equal(intel.find(row => row.id === "fsr3").available, true);
  const unknownRows = Components.getComponents({ ...options, macOSVersion: null, hardwareArch: null });
  const unknown = unknownRows.find(row => row.id === "fsr4");
  assert.equal(unknown.status, "Included");assert.equal(unknown.available, true);
  assert.equal(unknownRows.find(row => row.id === "metalfx").version, null);
});
test("the ANR provider row separates the included runtime, the host floor and models prepared in the profile", t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Opening Runtimes must stay offline"));
  const root = fixture(t), userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-components-profile-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const options = { root, platform: "darwin", macOSVersion: "26.1", hardwareArch: "arm64", userDataDir };
  const anr = (overrides = {}) => Components.getComponents({ ...options, ...overrides }).find(row => row.id === "anr");
  assert.equal(anr().status, "Not included");assert.equal(anr().available, false);
  const record = path.join(root, "runtime.json"), current = JSON.parse(fs.readFileSync(record, "utf8"));
  fs.writeFileSync(record, JSON.stringify({ ...current, features: { graphics: { ...current.features.graphics, anrGenerationAPI: 1 } } }));
  const directory = path.join(root, "generation/anr");fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "provider.json"), JSON.stringify({ method: "anr", providerABI: 1, complete: true, preparation: 1 }));
  for (const name of ["libmaclauncher-anr-generation.dylib", "helpers.metallib", "anr-convert-dxil", "anr-verify"]) fs.writeFileSync(path.join(directory, name), "provider");
  assert.equal(anr().status, "Models required");assert.equal(anr().available, false);
  const Manager=require('../src/modules/shared/reshade/runtime/anr-manager');
  t.mock.method(Manager.core,'listInstalled',()=>[{version:'FG-V.B15',ready:true},{version:'older',ready:true}]);
  assert.deepEqual(anr().capabilities.map(row=>row.label),['Apex Neural Rendering FG-V.B15','Apex Neural Rendering older']);
  assert.match(anr().requirements, /macOS 26\.0 or later on Apple Silicon/);
  assert.equal(anr({ macOSVersion: "15.5" }).status, "Requires macOS 26.0");
});

 test('ANR explicitly names an installed package without its generation runtime',t=>{
 const row=Components.getComponents({root:fixture(t),platform:'darwin',macOSVersion:'26.1',hardwareArch:'arm64'}).find(row=>row.id==='anr');
 assert.match(row.description,/installed graphics package does not include/i);
 });

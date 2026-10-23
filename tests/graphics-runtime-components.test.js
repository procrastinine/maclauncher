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
    file(`temporal/fsr/${method}-build.json`, JSON.stringify({ providerABI: 1, commit: FSR[method].commit, shaderVariants: 16 }));
    file(`temporal/fsr/libmaclauncher-${method}.dylib`, "provider");
    fs.mkdirSync(path.join(root, "temporal/fsr", method));
  }
  file("temporal/fsr4/provider.json", JSON.stringify({ providerABI: 1, complete: true, commit: FSR4.commit, library: "libmaclauncher-fsr4.dylib", model: FSR4.model }));
  file("temporal/fsr4/libmaclauncher-fsr4.dylib", "provider");
  file("temporal/fsr4/third_party/fsr411/initializers.bin", "model");
  fs.mkdirSync(path.join(root, "temporal/fsr4/build"));
  return root;
}
test("Graphics overview separates installed components, system requirements and purchased models without network", t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Opening Runtimes must stay offline"));
  const root = fixture(t), options = { root, platform: "darwin", macOSVersion: "27.0" };
  const rows = Object.fromEntries(Components.getComponents(options).map(row => [row.id, row]));
  assert.equal(rows.metalfx.status, "Provided by macOS");
  assert.equal(rows.fsr1.status, "Included");
  assert.equal(rows.fsr2.version, "2.2.1"); assert.equal(rows.fsr3.version, "3.1.4");
  assert.equal(rows.fsr4.version, FSR4.model); assert.equal(rows.fsr4.status, "Included");
  assert.match(rows.fsr2.requirements, /camera projection/);
  assert.equal(rows.lossless.status, "Models required");
  assert.equal(Components.getComponents({ ...options, installed: [{ version: "model" }] }).find(row => row.id === "lossless").status, "1 model file imported");
  const older = Components.getComponents({ ...options, macOSVersion: "15.0" });
  assert.equal(older.find(row => row.id === "fsr4").status, "Requires macOS 26.0");
  assert.equal(older.find(row => row.id === "fsr3").status, "Included");
  fs.rmSync(path.join(root, "temporal/fsr/libmaclauncher-fsr3.dylib"));
  assert.equal(Components.getComponents(options).find(row => row.id === "fsr3").status, "Not included");
});

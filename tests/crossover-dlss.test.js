const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const DLSS = require("../src/modules/crossover/dlss");
const CrossOver = require("../src/modules/crossover/runtime/launch");

function installation(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-dlss-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ["lib/dxmt/x86_64-windows", "lib64/apple_gptk/wine/x86_64-windows"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const name of DLSS.DLLS) fs.writeFileSync(path.join(root, dir, name + ".dll"), Buffer.alloc(256));
  }
  return { crossoverRoot: root };
}

test("shared temporal selection enables Wine's matched game integration and preserves legacy selection", t => {
  const install = installation(t), options = { host: { arch: "arm64", macOSVersion: "26.0" }, executableArchitecture: "x86_64", baseEnvironment: {} };
  const saved = { graphicsBackend: "dxmt", dlss: false };
  for (const temporalMethod of ["metalfx", "fsr2", "fsr3", "fsr4"]) {
    const settings = DLSS.withTemporalSelection(saved, { temporalMethod });
    assert.equal(settings.dlss, true);
    const result = CrossOver.buildEnvironment(settings, install, "/private/game", "/private/game/bottle", options);
    assert.equal(result.overrides.DXMT_ENABLE_NVEXT, "1");
    assert.equal(result.overrides.D3DM_ENABLE_METALFX, "0");
  }
  assert.equal(saved.dlss, false, "launch preparation does not mutate saved runtime preferences");
  assert.equal(DLSS.withTemporalSelection({ dlss: true }, {}).dlss, true);
  assert.equal(DLSS.withTemporalSelection({ dlss: false }, { temporalMethod: "off" }).dlss, false);
  assert.equal(DLSS.withTemporalSelection({}, { spatialMethod: "fsr1", frameGeneration: "lsfg" }).dlss, false);
});

test("Advanced temporal rows select Wine integration independently of inactive Simple settings", () => {
  const rows = enabled => ({schema: 1, mode: "advanced", video: [
    {id: "scene", kind: "temporal", enabled, method: "fsr3", settings: {}}
  ]});
  assert.equal(DLSS.withTemporalSelection({}, {temporalMethod: "off"}, rows(true)).dlss, true);
  assert.equal(DLSS.withTemporalSelection({}, {temporalMethod: "fsr2"}, rows(false)).dlss, false,
    "inactive Advanced rows do not inherit hidden Simple demand");
  assert.equal(DLSS.withTemporalSelection({dlss: true}, {}, rows(false)).dlss, true,
    "an explicit runtime integration selection remains enabled");
});

test("Wine bridge dependency planning reads enabled Advanced temporal rows", () => {
  const Temporal = require("../src/modules/crossover/temporal");let calls = 0;
  const manager = {resolveSelection() {++calls;return {ready: false};}}, context = {runtimeId: "sikarugir"};
  const entry = {graphics: {temporalMethod: "off"}, effects: {schema: 1, mode: "advanced", video: [
    {id: "scene", kind: "temporal", enabled: true, method: "fsr3", settings: {}}
  ]}};
  assert.deepEqual(Temporal.requirements(entry, context, {manager}), []);assert.equal(calls, 1);
  entry.effects.video[0].enabled = false;entry.graphics.temporalMethod = "fsr2";
  Temporal.requirements(entry, context, {manager});assert.equal(calls, 1);
});

test("DLSS uses installed matched libraries, selected graphics and real host requirements", t => {
  const install = installation(t), common = { host: { arch: "arm64", macOSVersion: "15.7" }, executableArchitecture: "x86_64", baseEnvironment: {} };
  const run = (settings, options = common) => CrossOver.buildEnvironment(settings, install, "/private/game", "/private/game/bottle", options);
  const dxmt = run({ graphicsBackend: "dxmt", dlss: true });
  assert.equal(dxmt.overrides.DXMT_ENABLE_NVEXT, "1");
  assert.equal(dxmt.overrides.D3DM_ENABLE_METALFX, "0");
  assert.match(CrossOver.wineEnvironmentString(dxmt.overrides), /'DXMT_ENABLE_NVEXT=1'/);
  assert.throws(() => run({ graphicsBackend: "d3dmetal", dlss: true }), /unavailable/);
  const d3d = run({ graphicsBackend: "d3dmetal", dlss: true }, { ...common, host: { arch: "arm64", macOSVersion: "26.0" } });
  assert.equal(d3d.overrides.DXMT_ENABLE_NVEXT, "0");
  assert.equal(d3d.overrides.D3DM_ENABLE_METALFX, "1");
  const auto = run({ dlss: true });
  assert.equal(auto.overrides.CX_GRAPHICS_BACKEND, undefined, "vendor automatic graphics selection is retained");
  assert.equal(auto.overrides.DXMT_ENABLE_NVEXT, "1");
  assert.throws(() => run({ graphicsBackend: "dxvk", dlss: true }), /requires DXMT or D3DMetal/);
  assert.throws(() => run({ graphicsBackend: "dxmt", dlss: true }, { ...common, executableArchitecture: "x86" }), /64-bit Windows/);
  assert.throws(() => run({ graphicsBackend: "dxmt", dlss: true }, { ...common, host: { arch: "x64", macOSVersion: "26.0" } }), /Apple Silicon/);
  fs.unlinkSync(path.join(install.crossoverRoot, "lib/dxmt/x86_64-windows/nvngx.dll"));
  assert.throws(() => run({ graphicsBackend: "dxmt", dlss: true }), /unavailable/);
});

test("turning DLSS off clears inherited flags without changing graphics or requiring libraries", () => {
  const install = { crossoverRoot: "/absent/CrossOver" };
  const result = CrossOver.buildEnvironment({ graphicsBackend: "wined3d", dlss: false }, install, "/game", "/game/bottle",
    { baseEnvironment: { DXMT_ENABLE_NVEXT: "1", D3DM_ENABLE_METALFX: "1" }, host: { arch: "x64", macOSVersion: "11.0" } });
  assert.equal(result.environment.DXMT_ENABLE_NVEXT, "0");
  assert.equal(result.environment.D3DM_ENABLE_METALFX, "0");
  assert.equal(result.overrides.CX_GRAPHICS_BACKEND, "wined3d");
});

test("DLSS library detection refuses incomplete and escaping runtime files", t => {
  const install = installation(t), dir = path.join(install.crossoverRoot, "lib/dxmt/x86_64-windows");
  assert.equal(DLSS.hasLibraries(dir), true);
  const file = path.join(dir, "nvngx.dll");
  fs.unlinkSync(file); fs.symlinkSync(path.join(install.crossoverRoot, "lib64/apple_gptk/wine/x86_64-windows/nvngx.dll"), file);
  assert.equal(DLSS.hasLibraries(dir), false);
  assert.equal(DLSS.hasLibraries("relative/path"), false);
});

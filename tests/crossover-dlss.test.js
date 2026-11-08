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

test("shared temporal selection enables Wine's matched game integration and preserves the saved runtime selection", t => {
  const install = installation(t), options = { host: { hardwareArch: "arm64", macOSVersion: "26.0" }, executableArchitecture: "x86_64", baseEnvironment: {} };
  const saved = { graphicsBackend: "dxmt", dlss: false };
  for (const temporalMethod of ["metalfx", "fsr2", "fsr3", "fsr4"]) {
    const settings = DLSS.withTemporalSelection(saved, rows(true, temporalMethod));
    assert.equal(settings.dlss, true);
    const result = CrossOver.buildEnvironment(settings, install, "/private/game", "/private/game/bottle", options);
    assert.equal(result.overrides.DXMT_ENABLE_NVEXT, "1");
    assert.equal(result.overrides.D3DM_ENABLE_METALFX, "0");
  }
  assert.equal(saved.dlss, false, "launch preparation does not mutate saved runtime preferences");
  assert.equal(DLSS.withTemporalSelection({ dlss: true }, null).dlss, true);
  assert.equal(DLSS.withTemporalSelection({ dlss: false }, null).dlss, false);
  assert.equal(DLSS.withTemporalSelection({}, {schema: 2, mode: "advanced", video: [
    {id: "scale", kind: "spatial", enabled: true, method: "bilinear", settings: {}}]}).dlss, false);
});

test("only enabled temporal rows select Wine integration", () => {
  assert.equal(DLSS.withTemporalSelection({}, rows(true)).dlss, true);
  assert.equal(DLSS.withTemporalSelection({}, rows(false)).dlss, false, "an inactive row does not select integration");
  assert.equal(DLSS.withTemporalSelection({dlss: true}, rows(false)).dlss, true,
    "an explicit runtime integration selection remains enabled");
});
test("scene input selection preserves automatic vendor validation without overriding known Vulkan translators", () => {
  const noOverride = {apiMode: true, components: {d3d11: {used: null}, d3d12: {used: null}}};
  assert.equal(DLSS.withTemporalSelection({graphicsBackend: "auto"}, rows(true), noOverride).dlss, true);
  assert.equal(DLSS.withTemporalSelection({graphicsBackend: "dxvk"}, rows(true), noOverride).dlss, false);
  const vulkan = {apiMode: true, components: {d3d11: {used: {engine: "dxvk"}}, d3d12: {used: {engine: "vkd3d-proton"}}}};
  assert.equal(DLSS.withTemporalSelection({graphicsBackend: "auto"}, rows(true), vulkan).dlss, false);
  assert.equal(DLSS.withTemporalSelection({dlss: true}, null, vulkan).dlss, true);
});
function rows(enabled, method = "fsr3") {
  return {schema: 2, mode: "advanced", video: [{id: "scene", kind: "temporal", enabled, method, settings: {}}]};
}

test("CrossOver inspects automatic game API compatibility while shared processing is off", async t => {
  const settings = {dlss: false, graphicsBackend: "dxmt"}, stop = Error("inspection boundary");
  // Launch preparation reads the game's executable and the runtime's translator
  // plan before it inspects the camera bridge: an empty CrossOver root and one
  // Windows executable reach that inspection.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-dlss-automatic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const crossoverRoot = path.join(root, "crossover"), game = path.join(root, "game", "Game.exe");
  fs.mkdirSync(crossoverRoot);fs.mkdirSync(path.dirname(game));
  const pe = require("./helpers/pe-fixture").peFixture({ is64: true });
  pe.bytes.writeUInt16LE(0x22, pe.peOffset + 22);pe.bytes.writeUInt16LE(2, pe.optional + 68);
  fs.writeFileSync(game, pe.bytes);
  t.mock.method(require("../src/modules/crossover/runtime/manager"), "resolveSelection", () => ({ready: true, install: {crossoverRoot}}));
  let calls = 0;
  t.mock.method(require("../src/modules/crossover/temporal"), "resolvePlan", (_entry, _context, options) => {
    ++calls;assert.equal(options.automatic, true);assert.equal(options.settings.dlss, false);throw stop;
  });
  await assert.rejects(CrossOver.prepareLaunch({gamePath: game, graphics: {temporalMethod: "off"}}, {runtimeSettings: settings}), error => error === stop);
  assert.equal(calls, 1);assert.deepEqual(settings, {dlss: false, graphicsBackend: "dxmt"});
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
  const install = installation(t), common = { host: { hardwareArch: "arm64", macOSVersion: "15.7" }, executableArchitecture: "x86_64", baseEnvironment: {} };
  const run = (settings, options = common) => CrossOver.buildEnvironment(settings, install, "/private/game", "/private/game/bottle", options);
  const dxmt = run({ graphicsBackend: "dxmt", dlss: true });
  assert.equal(dxmt.overrides.DXMT_ENABLE_NVEXT, "1");
  assert.equal(dxmt.overrides.D3DM_ENABLE_METALFX, "0");
  assert.match(CrossOver.wineEnvironmentString(dxmt.overrides), /'DXMT_ENABLE_NVEXT=1'/);
  assert.throws(() => run({ graphicsBackend: "d3dmetal", dlss: true }), /unavailable/);
  const d3d = run({ graphicsBackend: "d3dmetal", dlss: true }, { ...common, host: { hardwareArch: "arm64", macOSVersion: "26.0" } });
  assert.equal(d3d.overrides.DXMT_ENABLE_NVEXT, "0");
  assert.equal(d3d.overrides.D3DM_ENABLE_METALFX, "1");
  const auto = run({ dlss: true });
  assert.equal(auto.overrides.CX_GRAPHICS_BACKEND, undefined, "vendor automatic graphics selection is retained");
  assert.equal(auto.overrides.DXMT_ENABLE_NVEXT, "1");
  assert.throws(() => run({ graphicsBackend: "dxvk", dlss: true }), /requires DXMT or D3DMetal/);
  assert.throws(() => run({ graphicsBackend: "dxmt", dlss: true }, { ...common, executableArchitecture: "x86" }), /64-bit Windows/);
  assert.throws(() => run({ graphicsBackend: "dxmt", dlss: true }, { ...common, host: { hardwareArch: "x64", macOSVersion: "26.0" } }), /Apple Silicon/);
  fs.unlinkSync(path.join(install.crossoverRoot, "lib/dxmt/x86_64-windows/nvngx.dll"));
  assert.throws(() => run({ graphicsBackend: "dxmt", dlss: true }), /unavailable/);
});

test("temporal eligibility uses resolved engine families for foreign references in aggregate and API plans", () => {
  const reference = { id: 'sikarugir:template-1.0.24:dxmt080', engine: 'dxmt', source: { runtime: 'sikarugir' } };
  for (const runtime of ['crossover', 'sikarugir']) for (const apiMode of [false, true]) {
    const plan = { runtime, apiMode, components: apiMode ? { d3d11: { used: reference }, d3d12: { used: null } } :
      { 'd3d-renderer': { used: reference }, d3d12: { used: null } } };
    assert.deepEqual(DLSS.checkSelection({ dlss: true }, { backend: reference.id, translatorPlan: plan, dxmt: true,
      hardwareArch: 'arm64', macOSVersion: '26.0', executableArchitecture: 'x86_64' }), { enabled: true, dxmt: true, d3dmetal: false });
    const unsupported = { ...plan, components: { 'd3d-renderer': { used: { engine: 'dxvk' } } } };
    assert.throws(() => DLSS.checkSelection({ dlss: true }, { backend: 'dxmt', translatorPlan: unsupported, dxmt: true,
      hardwareArch: 'arm64', macOSVersion: '26.0', executableArchitecture: 'x86_64' }), /unavailable/);
  }
});

test("explicitly selected DXMT and D3DMetal forward DLSS without the setting; the runtime's own translators follow it", () => {
  const host = { hardwareArch: "arm64", macOSVersion: "26.0", executableArchitecture: "x86_64" };
  for (const engine of ["dxmt", "d3dmetal"]) {
    const installed = { id: `${engine}:1.0`, engine, managerId: engine }, own = { id: `included:d3d-renderer:${engine}`, engine, included: true };
    const plan = used => ({ runtime: "crossover", apiMode: true, components: { d3d11: { used }, d3d12: { used } } });
    const flags = { dxmt: engine === "dxmt", d3dmetal: engine === "d3dmetal" };
    for (const saved of [{}, { dlss: false }]) {
      const settings = DLSS.withTemporalSelection(saved, null, plan(installed));
      assert.equal(settings.dlss, true, `${engine}: an explicit translator forwards without the setting`);
      assert.deepEqual(DLSS.checkSelection(settings, { ...host, backend: "auto", translatorPlan: plan(installed), ...flags }), { enabled: true, ...flags });
      // A route that cannot run integration starts the game without it.
      for (const unsupported of [{ executableArchitecture: "x86" }, { hardwareArch: "x64" }, { macOSVersion: "13.0" }])
        assert.deepEqual(DLSS.checkSelection(settings, { ...host, ...unsupported, backend: "auto", translatorPlan: plan(installed), ...flags }),
          { enabled: false, dxmt: false, d3dmetal: false });
      assert.deepEqual(DLSS.checkSelection(settings, { ...host, executableArchitecture: "x86", backend: "auto", translatorPlan: plan(installed), vulkan: true }),
        { enabled: true, dxmt: false, d3dmetal: false, vulkan: true });
    }
    // The runtime's own translator, automatic or picked, runs as shipped unless the setting asks for integration.
    for (const used of [own, null]) {
      const settings = DLSS.withTemporalSelection({ graphicsBackend: "dxvk" }, null, plan(used));
      assert.equal(settings.dlss, false);
      assert.deepEqual(DLSS.checkSelection(settings, { ...host, backend: "auto", translatorPlan: plan(used), ...flags }), { enabled: false, dxmt: false, d3dmetal: false });
    }
    assert.throws(() => DLSS.checkSelection(DLSS.withTemporalSelection({ dlss: true }, null, plan(own)),
      { ...host, executableArchitecture: "x86", backend: "auto", translatorPlan: plan(own), ...flags }), /64-bit Windows/);
  }
});

test("turning DLSS off clears inherited flags without changing graphics or requiring libraries", () => {
  const install = { crossoverRoot: "/absent/CrossOver" };
  const result = CrossOver.buildEnvironment({ graphicsBackend: "wined3d", dlss: false }, install, "/game", "/game/bottle",
    { baseEnvironment: { DXMT_ENABLE_NVEXT: "1", D3DM_ENABLE_METALFX: "1" }, host: { hardwareArch: "x64", macOSVersion: "11.0" } });
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

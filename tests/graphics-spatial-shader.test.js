const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const Requirements = require("../src/modules/shared/effects/execution-requirements");

test("a spatial shader requests only its own processor unless render reduction is explicitly selected", () => {
  const shader = {enabled: true, preset: "custom", effectPath: "/upscale.hook"};
  const normal = Requirements.analyze({graphics: {spatialMethod: "off", spatialShader: shader}});
  assert.equal(normal.needed.shaders, true);assert.equal(normal.needed.ordered, true);
  assert.equal(normal.needed.presentation, true);assert.equal(normal.source, null);
  assert.equal(normal.needed.virtualWindow, false);assert.equal(normal.needed.losslessModel, false);
  const reduced = Requirements.analyze({graphics: {spatialMethod: "off", spatialShader: shader, spatialMultiplier: 2}}, {sourceSupport: {control: "virtual"}});
  assert.deepEqual(reduced.source, {multiplier: 2});assert.equal(reduced.needed.virtualWindow, true);
  const off = Requirements.analyze({graphics: {spatialMethod: "off", spatialShader: null}});
  assert.equal(off.mode, "none");assert.equal(off.needed.processor, false);
  const Graphics = require("../src/modules/shared/reshade/graphics-settings");
  const disabled = Graphics.normalizeSettings({spatialShader: {...shader, enabled: false}});
  assert.equal(disabled.spatialShader, null);assert.equal(Graphics.enabled(disabled), false);
  assert.equal(Requirements.analyze({graphics: disabled}).mode, "none");
  assert.equal(Graphics.updateSettings({}, {spatialShader: {...shader, enabled: false}}).spatialShader, null);
});

test("queued spatial parameter edits reject a changed shader before resource preparation", async () => {
  const source = fs.readFileSync(require.resolve("../src/main/main"), "utf8");
  const begin = source.indexOf('ipcMain.handle("launcher:setGameGraphics"'), end = source.indexOf("function publishReShadeFilters()", begin);
  for (const [current, expected] of [
    [{enabled: true, preset: "custom", effectPath: "/new.hook"}, {preset: "custom", effectPath: "/old.hook"}],
    [{enabled: true, preset: "chain", effects: ["crt", "cas"]}, {preset: "chain", effects: ["cas", "crt"]}],
    [null, {preset: "custom", effectPath: "/old.hook"}]
  ]) {
    const entry = {gamePath: "/Game", graphics: {spatialShader: expected}}, handlers = {};
    let release;const gate = new Promise(resolve => {release = resolve;});
    const context = {
      ipcMain: {handle(name, fn) {handlers[name] = fn;}},
      editGraphics: (_gamePath, edit) => gate.then(() => edit(new AbortController().signal)),
      loadSettings: () => ({}), loadGamesHydrated: () => [entry], findGameByPath: () => entry,
      EffectsPlan: {normalize: () => null}, ReShade: require("../src/modules/shared/reshade"),
      GraphicsSettings: require("../src/modules/shared/reshade/graphics-settings"),
      gameEffectsOptions() {assert.fail("Stale spatial parameters reached resource preparation");},
      require: id => require(path.resolve(__dirname, "../src/main", id))
    };
    vm.runInNewContext(source.slice(begin, end), context);
    const request = handlers["launcher:setGameGraphics"]({}, entry.gamePath, {spatialShader: {...expected, parameters: {Old: [2]}}}, expected);
    entry.graphics.spatialShader = current;release();
    await assert.rejects(request, error => error.code === "GRAPHICS_SHADER_STALE");
    assert.equal(entry.graphics.spatialShader, current);
  }
});

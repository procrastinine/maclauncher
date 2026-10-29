const test = require("node:test"), assert = require("node:assert/strict");
const Requirements = require("../src/modules/shared/effects/execution-requirements");

test("a spatial shader requests only its own processor unless render reduction is explicitly selected", () => {
  const shader = {enabled: true, preset: "custom", effectPath: "/upscale.hook"};
  const plan = (row, extra = {}) => ({effects: {schema: 2, mode: "advanced", enabled: true, video: [{id: "scale", kind: "shader", enabled: true, shader, ...row}], ...extra}});
  const normal = Requirements.analyze(plan());
  assert.equal(normal.needed.shaders, true);assert.equal(normal.needed.ordered, true);
  assert.equal(normal.needed.presentation, true);assert.equal(normal.source, null);
  assert.equal(normal.needed.virtualWindow, false);assert.equal(normal.needed.losslessModel, false);
  const reduced = Requirements.analyze(plan({}, {renderResolution: {multiplier: 2}}), {sourceSupport: {control: "virtual"}});
  assert.deepEqual(reduced.source, {multiplier: 2});assert.equal(reduced.needed.virtualWindow, true);
  const off = Requirements.analyze({effects: null});
  assert.equal(off.mode, "none");assert.equal(off.needed.processor, false);
  assert.equal(Requirements.analyze(plan({enabled: false})).mode, "none");
  const Graphics = require("../src/modules/shared/reshade/graphics-settings");
  const disabled = Graphics.normalizeSettings({spatialShader: {...shader, enabled: false}});
  assert.equal(disabled.spatialShader, null);assert.equal(Graphics.enabled(disabled), false);
  assert.equal(Graphics.updateSettings({}, {spatialShader: {...shader, enabled: false}}).spatialShader, null);
});

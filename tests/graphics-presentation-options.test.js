const test = require("node:test"), assert = require("node:assert/strict");
const Plan = require("../src/modules/shared/effects/plan.mjs"), Requirements = require("../src/modules/shared/effects/execution-requirements");
const OutputOptions = require("../src/modules/shared/effects/output-options"), features = require("../src/modules/shared/reshade/features.json");
const plan = {schema: 2, mode: "advanced", enabled: true, video: []};

test("overlay, frame-rate cap and presentation options round-trip within their bounds", () => {
  const output = {hud: "detailed", frameRateCap: 48, displaySync: false, drawableCount: 2};
  const saved = Plan.validate({...plan, output});
  assert.deepEqual(saved.output, output);
  assert.deepEqual(Plan.validate(JSON.parse(JSON.stringify(saved))).output, output);
  assert.equal(Plan.validate({...plan, output: {frameRateCap: 0}}).output.frameRateCap, 0);
  for (const invalid of [{hud: "on"}, {frameRateCap: 9}, {frameRateCap: 1001}, {frameRateCap: 59.5}, {displaySync: "no"}, {drawableCount: 4}, {drawableCount: 1}])
    assert.throws(() => Plan.validate({...plan, output: invalid}), undefined, JSON.stringify(invalid));
});

test("an invalid option is dropped alone while the other output settings stay", () => {
  const salvaged = Plan.salvage({...plan, output: {hud: "compact", frameRateCap: 5, toneMapping: "reinhard"}});
  assert.deepEqual(salvaged.plan.output, {hud: "compact", toneMapping: "reinhard"});
  assert.deepEqual(salvaged.dropped.map(row => row.id), ["output.frameRateCap"]);
});

test("the overlay needs presentation, a cap needs the processor, and the master switch removes both", () => {
  const hud = Requirements.analyze({effects: {...plan, output: {hud: "compact"}}}).needed;
  assert.equal(hud.processor, true);assert.equal(hud.presentation, true);assert.equal(hud.generation, false);
  const cap = Requirements.analyze({effects: {...plan, output: {frameRateCap: 30}}}).needed;
  assert.equal(cap.processor, true);assert.equal(cap.frameRateCap, true);assert.equal(cap.hud, false);
  assert.equal(Requirements.analyze({effects: {...plan, output: {hud: "off", frameRateCap: 0}}}).needed.processor, false);
  const bypassed = Requirements.analyze({effects: {...plan, enabled: false, output: {hud: "detailed", frameRateCap: 30}}}).needed;
  assert.equal(bypassed.processor, false);assert.equal(bypassed.hud, false);assert.equal(bypassed.frameRateCap, false);
  assert.equal(Plan.execution({...plan, enabled: false, output: {hud: "detailed"}}).output, undefined);
});

test("published output keeps only the options the graphics package declares", () => {
  const output = {toneMapping: "reinhard", hud: "compact", frameRateCap: 60, displaySync: false, drawableCount: 2};
  const all = {performanceHud: true, frameRateCap: true, presentationOptions: true};
  assert.deepEqual(OutputOptions.supported(output, all, []), output);
  const pending = [];
  assert.deepEqual(OutputOptions.supported(output, {}, pending), {toneMapping: "reinhard"});
  assert.deepEqual(pending.map(row => row.id), ["performance-overlay", "frame-rate-cap", "presentation-options"]);
  const quiet = [];
  assert.equal(OutputOptions.supported({hud: "off", frameRateCap: 0}, all, quiet), undefined);
  assert.deepEqual(quiet, []);
  const partial = [];
  assert.deepEqual(OutputOptions.supported({hud: "compact", frameRateCap: 30}, {performanceHud: true}, partial), {hud: "compact"});
  assert.deepEqual(partial.map(row => row.id), ["frame-rate-cap"]);
});

test("the cap is declared only by hosts whose frame adapters pace the producer", () => {
  const graphics = features.graphics;
  assert.equal(graphics.performanceHudAPI, 1);assert.equal(graphics.frameRateCapAPI, 1);assert.equal(graphics.presentationOptionsAPI, 1);
  assert.equal(graphics.presentation.hosts.window.frameRateCap, true);assert.equal(graphics.presentation.hosts.catalyst.frameRateCap, true);
  assert.equal(graphics.presentation.hosts.remote.frameRateCap, undefined);assert.equal(graphics.presentation.hosts.explicit.frameRateCap, undefined);
});

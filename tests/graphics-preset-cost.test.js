const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Presets = require("../src/modules/shared/effects/presets");

const plan = () => ({ schema: 2, mode: "advanced", video: [
  { id: "shrink", kind: "spatial", method: "downsample", enabled: true, settings: { spatialMultiplier: .5 } },
  { id: "fg", kind: "frame-generation", enabled: true, method: "lsfg", settings: { frameMultiplier: 2 } }] });
const context = (stages, extra = {}) => ({ identityState: "matching", historical: false, input: { width: 1920, height: 1080 }, stages, ...extra });
const measured = [
  { id: "shrink", gpu: { milliseconds: 3.5, scope: "section", section: 1 } },
  { id: "fg", gpu: { milliseconds: 3.5, scope: "section", section: 1 } },
  { id: "extra", gpu: { milliseconds: 9, scope: "row", section: 0 } }];

test("a preset keeps the last measured total of its rows, one value that each new measurement replaces", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "preset-cost-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = Presets.save(root, { name: "Smooth", plan: plan() }), other = Presets.save(root, { name: "Other", plan: { ...plan(), video: plan().video.slice(0, 1) } });
  // The game runs a copy of the preset with its own row identities.
  const game = Presets.list(root)[0].plan;game.video = game.video.map((row, index) => ({ ...row, id: ["a", "b"][index] }));
  const stages = measured.map(row => ({ ...row, id: { shrink: "a", fg: "b" }[row.id] || row.id }));
  assert.equal(Presets.recordCost(root, game, [context(stages.slice(0, 1))], 1000), false, "every enabled row needs a measurement");
  assert.equal(Presets.recordCost(root, game, [context(stages, { identityState: "previous" })], 1000), false);
  assert.equal(Presets.recordCost(root, game, [context(stages)], 1000), true);
  let rows = Presets.list(root);
  // A shared command buffer counts once; rows outside the chain do not count.
  assert.deepEqual(rows.find(row => row.id === saved.id).measuredCost, { milliseconds: 3.5, width: 1920, height: 1080, measuredAt: 1000 });
  assert.equal(rows.find(row => row.id === other.id).measuredCost, undefined);
  assert.equal(Presets.recordCost(root, game, [context(stages)], 20000), false, "a recent value at the same size is kept");
  const own = stages.map(row => row.id === "b" ? { ...row, gpu: { milliseconds: 6, scope: "row", section: 0 } } : row);
  assert.equal(Presets.recordCost(root, game, [context(own, { input: { width: 1280, height: 720 } })], 21000), true);
  rows = Presets.list(root);assert.deepEqual(rows.find(row => row.id === saved.id).measuredCost, { milliseconds: 9.5, width: 1280, height: 720, measuredAt: 21000 });
  assert.equal(rows.find(row => row.id === saved.id).updatedAt, saved.updatedAt, "a measurement does not change the preset's edit version");
  // Editing the rows drops the measurement of the previous rows.
  const edited = Presets.save(root, { id: saved.id, name: "Smooth", updatedAt: saved.updatedAt, plan: { ...plan(), video: plan().video.slice(1) } });
  assert.equal(Presets.list(root).find(row => row.id === edited.id).measuredCost, undefined);
});

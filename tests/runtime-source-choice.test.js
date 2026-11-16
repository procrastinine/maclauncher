const test = require("node:test");
const assert = require("node:assert/strict");
const Plan = require("../src/core/runtime-resolution/translator-plan");

const build = (id, version) => ({ id, version, sourceId: "dxvk-upstream", component: "d3d-renderer", engine: "dxvk", label: "DXVK", form: "native", files: [] });

test("a source choice uses the newest usable version of that source", () => {
  const choices = [build("managed:2.0", "2.0.0"), build("managed:3.0", "3.0.0"), build("managed:2.6", "2.6.0")];
  const selections = { "d3d-renderer": "source:dxvk-upstream" };
  assert.equal(Plan.resolvePlan({ runtime: "sikarugir", selections, choices }).components["d3d-renderer"].used.id, "managed:3.0");
  const compatibility = { "managed:3.0": { compatible: false, reason: "No x64 slice." } };
  const row = Plan.resolvePlan({ runtime: "sikarugir", selections, choices, compatibility }).components["d3d-renderer"];
  assert.deepEqual([row.used.id, row.fallback], ["managed:2.6", false]);
});

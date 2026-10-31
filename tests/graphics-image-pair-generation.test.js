const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Graphics = require("../src/modules/shared/reshade/graphics-settings");
const Plan = require("../src/modules/shared/effects/plan");
const {GENERATION, generationMultipliers, automaticCandidates} = require("../src/modules/shared/effects/operation-contracts.mjs");
const FRAMEWORK = ["vt-interpolation", "metalfx-image", "vision-flow"];
function fixture(t, graphics) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "image-pair-generation-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({features: {graphics}}));return root;
}
const generationRow = (id, frameMultiplier = 2) => ({id: "fg", kind: "frame-generation", enabled: true, method: id, settings: {frameGeneration: id, frameMultiplier}});

test("framework image-pair methods are provider entries in the shared generation registry", async () => {
  for (const method of [...FRAMEWORK, "auto"]) {
    const operation = GENERATION[method];
    assert.equal(operation.scene, false);assert.equal(operation.camera, false);assert.equal(operation.matrices, false);
    assert.equal(operation.gpuWorkScope, "external-queues");
  }
  assert.deepEqual(generationMultipliers("vt-interpolation"), [2, 4]);
  assert.deepEqual(generationMultipliers("metalfx-image"), [2]);
  assert.deepEqual(generationMultipliers("vision-flow"), [2, 3, 4, 5]);
  assert.deepEqual(generationMultipliers("lsfg"), [2, 3, 4, 5]);
  assert.deepEqual(GENERATION.auto.candidates, FRAMEWORK);
  assert.deepEqual(automaticCandidates(FRAMEWORK, 4), ["vt-interpolation", "vision-flow"]);
  assert.deepEqual(automaticCandidates(["vision-flow"], 2), ["vision-flow"]);
  // The native registry header is generated from the same contracts.
  const {generationMethodsHeader} = await import("../scripts/generate-graphics-contracts.mjs");
  const header = fs.readFileSync(path.join(__dirname, "../src/modules/shared/reshade/native/generation-methods.hpp"), "utf8");
  assert.equal(header, generationMethodsHeader());
  assert.match(header, /\{"vt-interpolation",false,false,false,4,"external-queues",true,20\}/);
  assert.match(header, /automaticGenerationCandidates\{"vt-interpolation","metalfx-image","vision-flow"\}/);
});

test("the package feature list announces the methods and older packages keep their own list", t => {
  const features = JSON.parse(fs.readFileSync(path.join(__dirname, "../src/modules/shared/reshade/features.json"), "utf8"));
  for (const method of [...FRAMEWORK, "auto"]) assert.ok(features.graphics.frameGenerationMethods.includes(method), method);
  const presentation = {hosts: {window: {spatial: true, frameGeneration: true}}};
  const options = {graphicsHardware: {state: "unknown", macOSVersion: "27.0"}};
  const older = Graphics.capabilities(fixture(t, {frameGenerationMethods: ["lsfg", "metalfx", "mlx-interpolation"], presentation}), "window", options);
  for (const method of [...FRAMEWORK, "auto"]) assert.equal(older.frameGenerationMethods.includes(method), false);
  const current = Graphics.capabilities(fixture(t, {frameGenerationMethods: features.graphics.frameGenerationMethods, presentation}), "window", options);
  for (const method of [...FRAMEWORK, "auto"]) assert.ok(current.frameGenerationMethods.includes(method), method);
});

test("capability gating follows declared macOS floors and MetalFX device support", () => {
  const all = ["lsfg", ...FRAMEWORK, "auto"], none = () => null;
  assert.deepEqual(Graphics.generationMethodsAllowed(all, none, {macOSVersion: "26.0"}), all);
  assert.deepEqual(Graphics.generationMethodsAllowed(all, none, {macOSVersion: "15.4"}), ["lsfg", "vision-flow", "auto"]);
  assert.deepEqual(Graphics.generationMethodsAllowed(all, name => name === "interpolation" ? "Not supported by the detected GPUs." : null, {macOSVersion: "27.0"}),
    ["lsfg", "vt-interpolation", "vision-flow", "auto"]);
  // Automatic is listed only while one of its candidates remains.
  assert.deepEqual(Graphics.generationMethodsAllowed(["lsfg", "metalfx-image", "auto"], none, {macOSVersion: "15.0"}), ["lsfg"]);
  // An unknown macOS version is not a negative result.
  assert.deepEqual(Graphics.generationMethodsAllowed(all, none, {}), all);
});

test("settings and plans round-trip the methods and reject multipliers a method cannot produce", async () => {
  for (const [method, multiplier] of [["vt-interpolation", 4], ["metalfx-image", 2], ["vision-flow", 3], ["auto", 5]]) {
    const settings = Graphics.updateSettings({}, {frameGeneration: method, frameMultiplier: multiplier});
    assert.deepEqual(Graphics.normalizeSettings(settings), settings);
    assert.equal(settings.frameGeneration, method);assert.equal(settings.frameMultiplier, multiplier);
    const plan = Plan.validate({schema: 2, mode: "advanced", video: [generationRow(method, multiplier)]});
    assert.deepEqual(Plan.validate(plan), plan);assert.equal(plan.video[0].method, method);
  }
  assert.throws(() => Plan.validate({schema: 2, mode: "advanced", video: [generationRow("vt-interpolation", 3)]}), /frame multiplier/);
  assert.throws(() => Plan.validate({schema: 2, mode: "advanced", video: [generationRow("metalfx-image", 4)]}), /frame multiplier/);
  const support = {frameGeneration: true, frameGenerationMethods: ["vt-interpolation"], providerGenerationMethods: ["vt-interpolation"]};
  await assert.rejects(Graphics.prepare({frameGeneration: "vt-interpolation", frameMultiplier: 3}, {graphicsCapabilities: support}), /multiplier/);
  const environment = await Graphics.prepare({frameGeneration: "vt-interpolation", frameMultiplier: 4}, {graphicsCapabilities: support});
  assert.equal(typeof environment, "object");
});

test("the editor catalog lists each method in the Frame generation type with its contract", () => {
  const support = {frameGeneration: true, frameGenerationMethods: [...FRAMEWORK, "auto"], providerGenerationMethods: [...FRAMEWORK, "auto"]};
  const rows = Plan.catalog({graphicsCapabilities: support}), row = id => rows.find(value => value.id === "frame-generation:" + id);
  assert.equal(row("vt-interpolation").label, "VideoToolbox interpolation");
  assert.deepEqual(row("vt-interpolation").outputContract.multipliers, [2, 4]);
  assert.equal(row("vt-interpolation").outputContract.maximumMultiplier, 4);
  assert.equal(row("metalfx-image").category, "MetalFX");
  assert.equal(row("metalfx-image").outputContract.phases, "midpoint");
  assert.equal(row("metalfx-image").template.settings.frameMultiplier, 2);
  assert.equal(row("vision-flow").outputContract.maximumMultiplier, 5);
  assert.equal(row("auto").label, "Automatic");
  for (const id of [...FRAMEWORK, "auto"]) {
    const value = row(id);
    assert.equal(value.available, true, id);assert.equal(value.inputContract.domain, "image-pair");assert.equal(value.acceptsSynthetic, true);
    assert.equal(value.requirements.includes("models"), false);assert.equal(value.pendingInputs, undefined);
  }
  // A package without the methods lists none of them.
  assert.equal(Plan.catalog({graphicsCapabilities: {frameGeneration: true, frameGenerationMethods: ["lsfg"]}}).some(value => value.id === "frame-generation:vt-interpolation"), false);
});

const assert = require("node:assert/strict");
const test = require("node:test");
const Godot = require("../src/modules/godot/main");

function fixture(t, { ready = false, answer = 1, fail = false } = {}) {
  let extractions = 0;
  const prompts = [];
  t.mock.method(Godot.actions, "refreshExtractionStatus", entry => { entry.moduleData.extractedReady = ready; });
  t.mock.method(Godot.actions, "gdreRecover", async () => { extractions++; if (fail) throw new Error("Extraction failed"); });
  const entry = { moduleData: { packPath: "/game.pck" }, runtimeSettings: { godot: { value: "keep" }, other: { value: true } } };
  const context = { ui: { dialog: { showMessageBox: async options => { prompts.push(options); return { response: answer }; } } }, logger: { error() {} } };
  return { entry, context, prompts, extractions: () => extractions };
}

test("module crash recovery ignores unrelated exits and games already using extracted content", async t => {
  const { entry, context, prompts } = fixture(t);
  assert.equal(await Godot.onRuntimeCrash(entry, { runtimeId: "native", signal: "SIGTRAP" }, context), false);
  assert.equal(await Godot.onRuntimeCrash(entry, { runtimeId: "godot", signal: "SIGTERM" }, context), false);
  entry.runtimeSettings.godot.preferExtracted = true;
  assert.equal(await Godot.onRuntimeCrash(entry, { runtimeId: "godot", signal: "SIGTRAP" }, context), false);
  assert.equal(prompts.length, 0);
});

test("cancelled module recovery never extracts or enables the runtime override", async t => {
  const { entry, context, extractions } = fixture(t, { answer: 0 });
  assert.equal(await Godot.onRuntimeCrash(entry, { runtimeId: "godot", signal: "SIGTRAP" }, context), false);
  assert.equal(extractions(), 0);
  assert.equal(entry.runtimeSettings.godot.preferExtracted, undefined);
});

test("accepted module recovery extracts then preserves other runtime settings", async t => {
  const { entry, context, extractions } = fixture(t);
  assert.equal(await Godot.onRuntimeCrash(entry, { runtimeId: "godot", signal: "SIGTRAP" }, context), true);
  assert.equal(extractions(), 1);
  assert.equal(entry.runtimeSettings.godot.preferExtracted, true);
  assert.equal(entry.runtimeSettings.godot.value, "keep");
  assert.equal(entry.runtimeSettings.other.value, true);
});

test("already extracted recovery uses existing content and extraction errors preserve the override", async t => {
  const { entry, context, extractions, prompts } = fixture(t, { ready: true });
  assert.equal(await Godot.onRuntimeCrash(entry, { runtimeId: "godot", signal: "SIGTRAP" }, context), true);
  assert.equal(extractions(), 0);
  assert.equal(prompts[0].buttons[1], "Use extracted project");
});

test("failed module recovery reports its error without enabling extracted mode", async t => {
  const { entry, context, prompts } = fixture(t, { fail: true });
  assert.equal(await Godot.onRuntimeCrash(entry, { runtimeId: "godot", signal: "SIGTRAP" }, context), false);
  assert.equal(entry.runtimeSettings.godot.preferExtracted, undefined);
  assert.equal(prompts[1].message, "Failed to extract the Godot project.");
});

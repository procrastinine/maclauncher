const assert = require("node:assert/strict");
const test = require("node:test");

const Modules = require("../src/modules/registry");

test("runtime entries expose runtime settings schemas when available", () => {
  const modules = Modules.listModules();
  const mv = modules.find(mod => mod.id === "mv");
  assert.ok(mv?.runtime?.entries?.electron?.settings);
  assert.ok(mv?.runtime?.entries?.nwjs?.settings);
  const electronFields = mv.runtime.entries.electron.settings.fields || [];
  assert.ok(electronFields.some(field => field.key === "enableProtections"));
});

test("runtime entries allow runtimes without settings", () => {
  const modules = Modules.listModules();
  const renpy = modules.find(mod => mod.id === "renpy");
  assert.ok(renpy?.runtime?.entries?.sdk);
  assert.equal(Boolean(renpy?.runtime?.entries?.sdk?.settings), false);
});

test("java runtime entry exposes vm/app argument settings", () => {
  const modules = Modules.listModules();
  const java = modules.find(mod => mod.id === "java");
  assert.ok(java?.runtime?.entries?.java?.settings);
  const fields = java.runtime.entries.java.settings.fields || [];
  assert.ok(fields.some(field => field.key === "vmArgs"));
  assert.ok(fields.some(field => field.key === "appArgs"));
  assert.ok(fields.some(field => field.key === "workingDir"));
});

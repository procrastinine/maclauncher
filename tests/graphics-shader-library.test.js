const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ReShade = require("../src/modules/shared/reshade");
const Filters = require("../src/modules/shared/reshade/filter-library");
const Library = require("../src/modules/shared/reshade/shader-library");
const Plan = require("../src/modules/shared/effects/plan");

function fixture(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-shader-library-")));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const profile = path.join(temporary, "profile"), root = path.join(temporary, "processor");
  fs.mkdirSync(profile); fs.mkdirSync(path.join(root, "effects"), { recursive: true });
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({schema:1,version:"1",minimumMacOS:"13",features:{}}));
  for (const file of ["libreshade-macos.dylib", "fx-compile"]) fs.writeFileSync(path.join(root, file), "");
  for (const preset of ["crt", "grayscale", "vibrance", "sharpen", "cas"]) fs.writeFileSync(path.join(root, "effects", `${preset}.fx`), "// ordinary image filter\n");
  const file = path.join(temporary, "My Filter.hook"); fs.writeFileSync(file, "//!HOOK MAIN\nvec4 hook(){return HOOKED_tex(HOOKED_pos);}\n");
  const imported = Filters.importFiles(profile, [file])[0];
  const state = () => ReShade.getState({root,userDataDir:profile,platform:"darwin",macOSVersion:"26.0",graphicsArchitecture:"arm64"});
  return {profile, root, file, imported, state};
}
test("library and inspector share stable shader selections, names, contracts and availability offline", t => {
  const f = fixture(t); t.mock.method(globalThis, "fetch", () => assert.fail("Shader browsing stays offline"));
  const before = f.state(), included = before.shaderLibrary.find(row => row.id === "shader:sweetfx:curves");
  assert.ok(included); assert.equal(included.origin, "included"); assert.equal(included.canRemove, false); assert.equal(included.canRelocate, false);
  assert.ok(fs.statSync(included.path).isFile());
  const source = fs.readFileSync(included.path), importedIdentity = Filters.identity(f.profile, `filter:${f.imported.id}`);
  Library.rename(f.profile, included.id, "My contrast");
  Library.rename(f.profile, `filter:${f.imported.id}`, "My soft filter");
  const state = f.state(), catalog = Plan.catalog({reshadeState:state});
  assert.equal(state.shaderLibrary.length, state.presets.filter(row => !["custom","chain"].includes(row.id)).length);
  for (const row of state.shaderLibrary) {
    const preset = state.presets.find(preset => preset.id === row.presetId), choice = catalog.find(choice => choice.id === row.implementationId);
    assert.ok(preset); assert.ok(choice); assert.equal(row.name, preset.label); assert.equal(row.name, choice.label);
    assert.deepEqual(row.outputContract, preset.outputContract);
  }
  assert.equal(state.shaderLibrary.find(row => row.id === included.id).name, "My contrast");
  const local = state.shaderLibrary.find(row => row.presetId === `filter:${f.imported.id}`);
  assert.equal(local.name, "My soft filter"); assert.equal(local.filterId, f.imported.id); assert.equal(local.canRemove, true); assert.equal(local.canRelocate, true);
  assert.deepEqual(Filters.identity(f.profile, local.presetId), importedIdentity);
  assert.deepEqual(fs.readFileSync(included.path), source);
  Library.rename(f.profile, included.id, " ");
  assert.equal(f.state().shaderLibrary.find(row => row.id === included.id).name, included.name);
});
test("an invalid name edit preserves all existing names and corrupt metadata remains recoverable", t => {
  const f = fixture(t), metadata = path.join(f.profile, "graphics", "shader-names.json");
  Library.rename(f.profile, "crt", "My screen"); const previous = fs.readFileSync(metadata);
  assert.throws(() => Library.rename(f.profile, "crt", "broken\nname"), /without control/);
  assert.throws(() => Library.rename(f.profile, "custom", "Custom"), /Choose a shader/);
  assert.deepEqual(fs.readFileSync(metadata), previous);
  fs.writeFileSync(metadata, "{broken"); const state = f.state();
  assert.match(state.shaderLibraryError, /could not be read/); assert.ok(state.shaderLibrary.some(row => row.id === "crt"));
  assert.throws(() => Library.rename(f.profile, "crt", "Replacement"), /could not be read/);
  assert.equal(fs.readFileSync(metadata, "utf8"), "{broken");
});

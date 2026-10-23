const test = require("node:test"), assert = require("node:assert/strict");
const Traits = require("../src/modules/shared/reshade/shader-traits");
test("MPV network layers use declared output geometry and descriptions rather than filenames", () => {
  const shader = `//!DESC Example CNN x2
//!HOOK MAIN
//!BIND HOOKED
//!SAVE features
//!WIDTH HOOKED.w
//!HEIGHT HOOKED.h
vec4 hook() { return vec4(0); }
//!HOOK MAIN
//!BIND features
//!WIDTH MAIN.w 2 *
//!HEIGHT MAIN.h 2 *
vec4 hook() { return vec4(1); }`;
  const traits = Traits.inspect(shader, "libplacebo");
  assert.equal(traits.category, "upscaling"); assert.equal(traits.neural, true);
  assert.deepEqual(traits.outputScale, {x: 2, y: 2}); assert.equal(traits.rgbCompatible, true);
  assert.equal(Traits.group(traits), "Imported upscalers");
  const dynamic = Traits.inspect(shader.replace("MAIN.w 2 *", "OUTPUT.w").replace("MAIN.h 2 *", "OUTPUT.h"), "libplacebo");
  assert.equal(dynamic.outputScale, undefined); assert.equal(dynamic.geometryKnown, false);
});
test("MPV requirements and unsupported geometry stay explicit without inventing RGB inputs", () => {
  const traits = Traits.inspect("//!DESC Neural denoise\n//!HOOK LUMA\n//!WIDTH HOOKED.w\n//!HEIGHT HOOKED.h\nvec4 hook() { return vec4(1); }", "libplacebo");
  assert.equal(traits.rgbCompatible, false); assert.equal(traits.neural, true); assert.equal(traits.category, "restoration");
  assert.equal(traits.outputScale, undefined);
  assert.deepEqual(Traits.inspect("vec4 x;", "fx"), {category: "effects", neural: false});
  const bad = Traits.inspect("//!HOOK MAIN\n//!WIDTH HOOKED.w 0 /\n//!HEIGHT HOOKED.h\nvec4 hook() { return vec4(1); }", "libplacebo");
  assert.equal(bad.geometryKnown, false); assert.equal(bad.outputScale, undefined);
});
test("absolute pixel expressions and dimensionless ratios are not mistaken for input-relative upscales", () => {
  for (const expression of ["2", "1", "HOOKED.w HOOKED.w / 2 *", "HOOKED.w HOOKED.w *"]) {
    const traits = Traits.inspect(`//!HOOK MAIN\n//!WIDTH ${expression}\n//!HEIGHT HOOKED.h 2 *\nvec4 hook(){return vec4(1);}`, "libplacebo");
    assert.equal(traits.outputScale, undefined);assert.equal(traits.geometryKnown, false);assert.equal(traits.unresolvedGeometry, true);
  }
  const proportional = Traits.inspect("//!HOOK MAIN\n//!WIDTH 2 HOOKED.w *\n//!HEIGHT HOOKED.h 4 * 2 /\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.deepEqual(proportional.outputScale, { x: 2, y: 2 });
});
test("conditional or display-dependent resize directives defer output dimensions to the original renderer", () => {
  const conditional = Traits.inspect("//!DESC Example CNN x2\n//!HOOK MAIN\n//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\n//!WHEN OUTPUT.w HOOKED.w >\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(conditional.outputScale, undefined);assert.equal(conditional.geometryKnown, false);
  assert.equal(conditional.conditionalGeometry, true);assert.equal(conditional.displayDependentGeometry, true);
  assert.equal(conditional.category, "upscaling");
  const display = Traits.inspect("//!HOOK MAIN\n//!WIDTH OUTPUT.w\n//!HEIGHT OUTPUT.h\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(display.outputScale, undefined);assert.equal(display.displayDependentGeometry, true);
  const color = Traits.inspect("//!HOOK MAIN\n//!WHEN OUTPUT.w HOOKED.w >\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(color.conditionalGeometry, undefined);assert.equal(color.displayDependentGeometry, undefined);
  assert.equal(color.unresolvedGeometry, undefined);
  const crossStage = Traits.inspect("//!HOOK MAIN\n//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\nvec4 hook(){return vec4(1);}\n//!HOOK PREKERNEL\n//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(crossStage.outputScale, undefined);assert.equal(crossStage.unresolvedGeometry, true);
});
test("neural names with underscore suffixes and saved hook outputs retain their declared resizing", () => {
  for (const name of ["ArtCNN_C4F32", "FSRCNNX_x2", "NNEDI3_nns32"]) {
    const traits = Traits.inspect(`//!DESC ${name}\n//!HOOK MAIN\n//!SAVE features\nvec4 hook(){return vec4(1);}\n//!HOOK MAIN\n//!SAVE MAIN\n//!WIDTH features.w 2 *\n//!HEIGHT features.h 2 *\nvec4 hook(){return vec4(1);}`, "libplacebo");
    assert.equal(traits.neural, true);assert.equal(traits.category, "upscaling");assert.deepEqual(traits.outputScale, {x: 2, y: 2});
  }
  const dynamic = Traits.inspect("//!HOOK MAIN\n//!SAVE MAIN\n//!WIDTH OUTPUT.w\n//!HEIGHT OUTPUT.h\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(dynamic.geometryKnown, false);assert.equal(dynamic.outputScale, undefined);
});
test("scratch feature geometry and chroma reconstruction do not become frame upscalers", () => {
  const scratch = Traits.inspect("//!DESC Neural restoration\n//!HOOK MAIN\n//!SAVE features\n//!WIDTH OUTPUT.w\n//!HEIGHT OUTPUT.h\n//!WHEN OUTPUT.w HOOKED.w >\nvec4 hook(){return vec4(1);}\n//!HOOK MAIN\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(scratch.neural, true);assert.equal(scratch.category, "restoration");
  assert.equal(scratch.unresolvedGeometry, undefined);assert.equal(scratch.outputScale, undefined);
  const chroma = Traits.inspect("//!DESC CNN chroma\n//!HOOK CHROMA\n//!WIDTH LUMA.w\n//!HEIGHT LUMA.h\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(chroma.category, "chroma");assert.equal(chroma.outputScale, undefined);assert.equal(chroma.requiresVideoPlanes, true);
  assert.equal(Traits.inspect("//!HOOK CHROMA_SCALED\nvec4 hook(){return vec4(1);}", "libplacebo").category, "chroma");
  const luma = Traits.inspect("//!DESC Neural resize\n//!HOOK LUMA\n//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(luma.category, "upscaling");assert.deepEqual(luma.outputScale, {x: 2, y: 2});assert.equal(luma.requiresVideoPlanes, true);
  const dynamic = Traits.inspect("//!HOOK MAIN\n//!WIDTH OUTPUT.w\n//!HEIGHT OUTPUT.h\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(dynamic.category, "scaling");assert.equal(dynamic.outputScale, undefined);
});
test("Advanced catalog separates declared scaling from appearance without activating a provider", () => {
  const Plan = require("../src/modules/shared/effects/plan");
  const rows = Plan.catalog({reshadeState: {available: true, presets: [
    {id: "filter:up", label: "Upscale", traits: {category: "upscaling", neural: true}},
    {id: "filter:down", label: "Downscale", traits: {category: "downscaling"}},
    {id: "filter:restore", label: "Restore", traits: {category: "restoration", neural: true}},
    {id: "filter:chroma", label: "Chroma", traits: {category: "chroma", requiresVideoPlanes: true}},
    {id: "crt", label: "CRT", traits: {category: "crt"}}]}});
  const row = id => rows.find(value => value.id === id);
  assert.equal(row("filter:up").group, "Upscaling");assert.equal(row("filter:up").category, "Neural shaders");
  assert.equal(row("filter:down").group, "Downscaling");assert.equal(row("filter:restore").group, "Shaders and filters");
  assert.equal(row("shader:crt").category, "CRT");assert.equal(row("filter:chroma").available, false);
  assert.match(row("filter:chroma").reason, /luma and chroma/);
});

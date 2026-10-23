const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");

test("the actual graphics compiler emits complete live shader metadata", { skip: process.platform !== "darwin" }, async t => {
  const root = process.env.RESHADE_NATIVE_BUILD || require("../src/modules/shared/reshade").runtimeRoot();
  const compiler = path.join(root, "fx-compile");
  if (!fs.existsSync(compiler)) return t.skip("Requires the macOS ReShade compiler");
  const { verifyReShadeCompiler } = await import("../scripts/reshade-compiler-contract.mjs");
  const result = verifyReShadeCompiler(compiler);
  assert.deepEqual(result.textures, ["lookup.png"]);
  assert.equal(result.requirements.depth, true);
  assert.equal(result.requirements.techniques.CompilerContract.depth, true);
  assert.ok(result.uniforms.some(row => row.name === "V__Amount" && row.default[0] === 0.5));
  assert.ok(result.shaders.some(name => name.endsWith(".glsl")));
  assert.ok(result.shaders.some(name => name.endsWith(".metal")));
});

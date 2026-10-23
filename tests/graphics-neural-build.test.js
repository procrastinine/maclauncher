const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

test("the neural adaptation synchronizes only the actual shared parameter cache", async t => {
  const root = path.resolve(__dirname, ".."), helper = await import(pathToFileURL(path.join(root,
    "src/modules/shared/reshade/neural/native/prepare-upstream.mjs")).href);
  const file = path.join(root, "src/external/MLX-DLSS", helper.kernelParametersFile);
  if (!fs.existsSync(file)) return t.skip("The registered neural source checkout is not initialized.");
  const original = fs.readFileSync(file, "utf8"), applied = helper.patchKernelParameters(original);
  const start = original.indexOf("enum NeuralRenderingKernelParameters {"), end = original.indexOf("enum NeuralRenderingFusedWindowAttention {");
  assert.equal(applied.slice(0, start), original.slice(0, start));
  assert.equal(applied.slice(applied.indexOf("enum NeuralRenderingFusedWindowAttention {")), original.slice(end));
  const body = applied.slice(start, applied.indexOf("enum NeuralRenderingFusedWindowAttention {"));
  assert(body.indexOf("cacheLock.lock()") < body.indexOf("cache[values]"));
  assert(body.indexOf("cacheLock.unlock()") < body.indexOf("MLXArray(values)"));
  assert(body.indexOf("eval(created)") < body.lastIndexOf("cacheLock.lock()"));
  assert(body.lastIndexOf("cache[values]") > body.lastIndexOf("cacheLock.lock()"));
  assert.throws(() => helper.patchKernelParameters(original + "\n"), /pinned adaptation/);
  assert.throws(() => helper.patchKernelParameters(applied), /pinned adaptation/);
});

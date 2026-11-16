const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const native = path.join(__dirname, "../src/modules/shared/reshade/native");
const execution = () => fs.readFileSync(path.join(native, "effects-execution.mm"), "utf8");
const resources = () => fs.readFileSync(path.join(native, "metalfx-generation-resources.mm"), "utf8");

test("encodeRange binds MetalFX generation resources only within the scene's own command buffer", () => {
  const range = execution().split("ShaderResult EffectExecution::encodeRange(const ShaderFrame &incoming,")[1];
  const binding = range.slice(0, range.indexOf("bindMetalFxGenerationResources(to,from,"));
  const guard = binding.slice(binding.lastIndexOf("if(const auto scene=temporal?temporal:sceneLease?&sceneLease->frame:held->scene?&*held->scene:nullptr"));
  assert.match(guard, /^if\(const auto scene=temporal\?temporal:sceneLease\?&sceneLease->frame:held->scene\?&\*held->scene:nullptr;scene&&scene->commandBuffer==\(__bridge void\*\)frame\.commands\)\{auto from=\*scene;/,
    "a scene presented through another command buffer is compared by pointer and never messaged");
});

test("the binding's validity check messages the frame's command buffer, so its caller must hold that buffer", () => {
  // validFrame sends retainedReferences, status and device to f.commandBuffer, a raw pointer that RSTemporalFrame and
  // EffectSceneLease do not retain; the guard above is what keeps a released buffer from being messaged.
  assert.match(resources(), /bool validFrame\(const RSTemporalFrame&f\)\{.*auto commands=\(__bridge id<MTLCommandBuffer>\)f\.commandBuffer;return commands\.retainedReferences&&commands\.status<MTLCommandBufferStatusCommitted&&commands\.device;\}/);
  const lease = execution().match(/struct EffectSceneLease \{[^\n]*\};/)[0];
  assert.doesNotMatch(lease, /id<MTLCommandBuffer>/, "the scene lease holds no strong command buffer reference");
});

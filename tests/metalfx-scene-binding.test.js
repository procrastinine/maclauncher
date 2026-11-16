const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const native = path.join(__dirname, "../src/modules/shared/reshade/native");
const execution = () => fs.readFileSync(path.join(native, "effects-execution.mm"), "utf8");
const resources = () => fs.readFileSync(path.join(native, "metalfx-generation-resources.mm"), "utf8");

test("encodeRange binds MetalFX generation resources only within the scene's own recording command buffer", () => {
  const range = execution().split("ShaderResult EffectExecution::encodeRange(const ShaderFrame &incoming,")[1];
  const binding = range.slice(0, range.indexOf("bindMetalFxGenerationResources(to,from,"));
  const guard = binding.slice(binding.lastIndexOf("const auto scene=temporal?temporal:sceneLease?&sceneLease->frame:held->scene?&*held->scene:nullptr;"));
  assert.match(guard, /id<MTLCommandBuffer>sceneCommands=temporal\?\(temporal->commandBuffer==\(__bridge void\*\)frame\.commands\?frame\.commands:nil\):sceneLease\?sceneLease->commands:held->scene&&held->scene->commandBuffer==\(__bridge void\*\)frame\.commands\?frame\.commands:nil;/,
    "a lease's scene is matched through its weak command buffer reference, never through its raw pointer");
  assert.match(guard, /if\(scene&&sceneCommands&&sceneCommands==frame\.commands\)\{auto from=\*scene;/);
});

test("a scene lease references its command buffer weakly, taken from the live buffer that recorded it", () => {
  const source = execution();
  assert.match(source, /struct EffectSceneLease \{bool resolvedColor=false;RSTemporalFrame frame\{\};__weak id<MTLCommandBuffer>commands=nil;/);
  const capture = source.split("EffectExecution::captureSceneLease(id<MTLCommandBuffer>commands){")[1].split("\n}")[0];
  assert.match(capture, /lease->frame=\*scratch->scene;if\(lease->frame\.commandBuffer==\(__bridge void\*\)commands\)lease->commands=commands;/);
  const bound = source.split("auto result=std::make_shared<EffectSceneLease>();result->frame=source->frame;")[1].split("\n}")[0];
  assert.match(bound, /result->commands=commands;actual\.commandBuffer=\(__bridge void\*\)commands/);
});

test("the binding's validity check messages the frame's command buffer, so its caller must hold that buffer", () => {
  // validFrame sends retainedReferences, status and device to f.commandBuffer, a raw pointer that RSTemporalFrame and
  // EffectSceneLease do not retain; the guard above is what keeps a released buffer from being messaged.
  assert.match(resources(), /bool validFrame\(const RSTemporalFrame&f\)\{.*auto commands=\(__bridge id<MTLCommandBuffer>\)f\.commandBuffer;return commands\.retainedReferences&&commands\.status<MTLCommandBufferStatusCommitted&&commands\.device;\}/);
  const lease = execution().match(/struct EffectSceneLease \{[^\n]*\};/)[0];
  assert.doesNotMatch(lease.replace("__weak id<MTLCommandBuffer>commands", ""), /id<MTLCommandBuffer>/, "the scene lease holds no strong command buffer reference");
});

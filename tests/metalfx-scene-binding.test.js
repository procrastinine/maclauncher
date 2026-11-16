const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const native = path.join(__dirname, "../src/modules/shared/reshade/native");
const execution = () => fs.readFileSync(path.join(native, "effects-execution.mm"), "utf8");
const resources = () => fs.readFileSync(path.join(native, "metalfx-generation-resources.mm"), "utf8");

// validFrame sends retainedReferences, status and device to f.commandBuffer. RSTemporalFrame is a C record and retains
// nothing, so each stored record must name a buffer its holder keeps alive, or none.
test("the binding's validity check messages the frame's command buffer and refuses a committed one", () => {
  assert.match(resources(), /bool validFrame\(const RSTemporalFrame&f\)\{.*!f\.commandBuffer\)return false;auto commands=\(__bridge id<MTLCommandBuffer>\)f\.commandBuffer;return commands\.retainedReferences&&commands\.status<MTLCommandBufferStatusCommitted&&commands\.device;\}/);
});

test("a scene lease holds the command buffer its frame names, or its frame names none", () => {
  const source = execution();
  assert.match(source, /struct EffectSceneLease \{bool resolvedColor=false;RSTemporalFrame frame\{\};id<MTLCommandBuffer>commands=nil;/,
    "the lease's command buffer reference is strong");
  const capture = source.split("EffectExecution::captureSceneLease(id<MTLCommandBuffer>commands){")[1].split("\n}")[0];
  assert.match(capture, /lease->frame=\*scratch->scene;if\(lease->frame\.commandBuffer==\(__bridge void\*\)commands\)lease->commands=commands;else lease->frame\.commandBuffer=nullptr;/);
  const bound = source.split("auto result=std::make_shared<EffectSceneLease>();result->frame=source->frame;")[1].split("\n}")[0];
  assert.match(bound, /result->commands=commands;actual\.commandBuffer=\(__bridge void\*\)commands/);
});

test("a scratch scene names only the scratch's own command buffer", () => {
  const source = execution();
  const assignments = source.match(/scratch->scene=[^;]*;/g) || [];
  assert.deepEqual(assignments, ["scratch->scene=canonical;"]);
  const recording = source.slice(0, source.indexOf("scratch->scene=canonical;"));
  const last = recording.slice(recording.lastIndexOf("canonical.commandBuffer="));
  assert.match(last, /^canonical\.commandBuffer=temporal\.commandBuffer==\(__bridge void\*\)frame\.commands\?temporal\.commandBuffer:nullptr;/);
});

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const native = name => fs.readFileSync(path.join(__dirname, "../src/modules/shared/reshade/native", name), "utf8");
const presentation = () => native("presentation.mm");

test("G4: only ExternalWindow supplies a display limit to generation delivery", () => {
  assert.match(presentation(), /const bool windowCapture=frameSource\.load\(std::memory_order_relaxed\)==RuntimeFrameSource::ExternalWindow;\s*const auto deliveryMode=generationDelivery\(generator&&generationEnabled,outputPolicy\.active\(\),windowCapture\?displayHz\.load\(\):0,/);
  assert.match(presentation(), /if\(windowCapture\)\{const bool requestedPhases=.*?displayLimitedPhases/);
});

test("G5: game multi-stage generation keeps unlimited display images", () => {
  const compose = presentation().split("ShaderResult composeGeneration(")[1].split("input.timeMs=")[0];
  assert.match(compose, /windowCapture=frameSource\.load\(std::memory_order_relaxed\)==RuntimeFrameSource::ExternalWindow/);
  assert.match(compose, /input\.displayImages=windowCapture\?\(visibleImages\?visibleImages:displayVisibleImages\([^;]+\)\):0;/);
  assert.match(native("generation-execution.mm"), /capacity=input.displayImages\?std::min\(input.capacity,input.displayImages\):input.capacity/);
});

test("G6: refresh phase alignment is confined to external windows", () => {
  assert.match(presentation(), /if\(!batch->targeted&&hz&&frameSource\.load\(std::memory_order_relaxed\)==RuntimeFrameSource::ExternalWindow\)\{[^\n]*delivery.alignToRefresh/);
  assert.equal((presentation().match(/delivery\.alignToRefresh/g) || []).length, 1);
});

test("G7: games add no single-row pair analysis without explicit static-content processing", () => {
  assert.match(presentation(), /if\(stage&&generated.encoded&&\(windowCapture\|\|stage->keepStaticContent\)\)\{const ImagePairAnalysisKey/);
  assert.equal((presentation().match(/encodeGenerationPair\(/g) || []).length, 1);
  assert.match(native("effects-execution.hpp"), /keepStaticContent=false/);
});

test("G10: a status lease cannot enable per-row GPU timing with the HUD off", () => {
  const body = native("effects-execution.mm").split("bool EffectExecution::rowCostRequested()const{")[1].split("}")[0];
  assert.equal(body.trim(), 'return impl->snapshot->output.hud!="off";');
});

test("B2: browser attach preserves the boolean result and the original optional NSError", () => {
  assert.match(native("window-stream.mm"), /bool WindowStream::attach\(SCContentFilter \*filter,NSError \*__autoreleasing \*failure\)\{[\s\S]*?return \[stream addStreamOutput:receiver type:SCStreamOutputTypeScreen sampleHandlerQueue:intakeQueue error:failure\];/);
  assert.match(native("browser-frame.mm"), /NSError \*failure=nil;if\(!self->attach\(filter,&failure\)\)/);
});

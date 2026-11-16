const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const source = () => fs.readFileSync(path.join(__dirname, "../src/modules/shared/reshade/native/presentation.mm"), "utf8");
const pumpTail = () => source().split(" void pump(){")[1].split(" void generationBudgetContract(")[0];

test("a Metal display-link wait arms a supply deadline instead of parking the pump timer", () => {
  const tail = pumpTail();
  const waiting = tail.slice(tail.indexOf("if(waitingForDrawable&&metalTiming.load())"));
  assert.ok(tail.includes("if(waitingForDrawable&&metalTiming.load())"), "the Metal route wait has its own branch");
  assert.match(waiting, /deadline=std::max\(linkStarted\.load\(\),linkSupplied\.load\(\)\)\+linkSupplyTimeout/);
  assert.match(waiting, /if\(now<deadline\)next=deadline;/);
  assert.doesNotMatch(tail, /if\(waitingForDrawable\)next=metalTiming\.load\(\)\?std::optional<double>\{\}/, "a waiting Metal route never sets a FOREVER timer");
});

test("a display link that supplies no drawable past the deadline is retired once for layer drawables", () => {
  const waiting = pumpTail().split("if(waitingForDrawable&&metalTiming.load())")[1];
  assert.match(waiting, /if\(linkRetiredEpoch\.exchange\(epoch\)!=epoch\)\{nativeLog\("Presentation display link supplied no drawable for ".*?linkSupplyCounts\(\).*?presenting with layer drawables"\);retireMetalTiming\(epoch\);\}/);
  const retire = source().split(" void retireMetalTiming(uint64_t epoch){")[1].split(" std::string linkSupplyCounts()")[0];
  assert.match(retire, /self->metalTimingUnavailable=true;self->metalTiming=false;\+\+self->timingEpoch;/);
  assert.match(retire, /self->metalLink->invalidate\(\);self->metalLink\.reset\(\);/);
  assert.match(retire, /self->start\(\);\}\s*self->schedule\(\);/);
  assert.match(source(), /static constexpr double linkSupplyTimeout=0\.5;/);
});

test("display-link callbacks are counted and an accepted drawable renews the supply deadline", () => {
  const update = source().split(" void displayUpdate(uint64_t epoch,id<CAMetalDrawable> drawable,double target,unsigned rate){")[1].split(" void pauseGenerationTiming()")[0];
  assert.match(update, /^\s*const auto updates=linkUpdates\.fetch_add\(1,std::memory_order_relaxed\)\+1;/);
  assert.match(update, /if\(since>=1&&!linkRateReported\.exchange\(true\)\)nativeLog\("Presentation display link delivered "/);
  assert.match(update, /if\(!drawable&&target==0\)\{retireMetalTiming\(epoch\);return;\}/);
  assert.match(update, /if\(!drawable\)linkEmpty\.fetch_add\(1,std::memory_order_relaxed\);\s*else\{linkSupplied\.store\(CACurrentMediaTime\(\)\);/);
  assert.equal((update.match(/linkStale\.fetch_add/g) || []).length, 2, "both stale-epoch exits are counted");
  assert.match(source(), /if\(!metalTiming\.exchange\(true\)\)\{linkUpdatesAtStart\.store\(linkUpdates\.load\(\)\);linkStarted\.store\(CACurrentMediaTime\(\)\);linkRateReported\.store\(false\);/);
});

test("a drawable of another size is abandoned and logged instead of silently dropped", () => {
  const mismatch = pumpTail().split("if(drawable.texture.width!=display->batch->outputWidth||drawable.texture.height!=display->batch->outputHeight){")[1].split("}else if")[0];
  assert.match(mismatch, /drawables\.abandon\(drawable\);drawableSizeDrops\.fetch_add\(1,std::memory_order_relaxed\);deliveryDecision\(display->batch,"drawable-size-mismatch"\);/);
  assert.match(mismatch, /if\(!drawableSizeReported\.exchange\(true\)\)nativeLog\("Presentation drawable "/);
});

test("a link drawable that is not the layer's size does not renew the supply deadline", () => {
  const update = source().split(" void displayUpdate(uint64_t epoch,id<CAMetalDrawable> drawable,double target,unsigned rate){")[1].split(" void pauseGenerationTiming()")[0];
  const check = update.indexOf("linkSizeMismatches.fetch_add"), supplied = update.indexOf("linkSupplied.store");
  assert.ok(check > 0 && supplied > check, "the size check precedes the supply renewal");
  assert.match(update, /if\(drawable\.texture\.width!=unsigned\(size\.width\)\|\|drawable\.texture\.height!=unsigned\(size\.height\)\)\{linkSizeMismatches\.fetch_add\(1,std::memory_order_relaxed\);[\s\S]*?return;\}\}/);
});

test("a pump that has not finished for a second is reported once with its step", () => {
  assert.match(source(), / void finishPump\(bool more=false\)\{\n  pumpEnteredAt\.store\(0\);/);
  assert.match(source(), / void pump\(\)\{\n  pumpEnteredAt\.store\(CACurrentMediaTime\(\)\);/);
  const publish = source().split(" void publish(const std::shared_ptr<Batch>&batch,bool ready){")[1].slice(0, 600);
  assert.match(publish, /entered>0&&CACurrentMediaTime\(\)-entered>=1&&!pumpStallReported\.exchange\(true\)/);
});

const displayLink = () => fs.readFileSync(path.join(__dirname, "../src/modules/shared/reshade/native/presentation-display-link.mm"), "utf8");

test("starting, pausing and resuming the display link never wait for the main queue", () => {
  const apply = displayLink().split("    void apply(){")[1].split("\n")[0];
  assert.doesNotMatch(apply, /dispatch_get_main_queue/);
  assert.match(apply, /\[\(MacFXPresentationDisplayLink\*\)driver applyState\]/);
  const state = displayLink().split("- (void)applyState {")[1].split("- (void)observeScreens {")[0];
  assert.match(state, /std::lock_guard lock\(_threadMutex\);\s*if\(!_thread\)\{/);
  assert.match(state, /\[_thread start\];/);
  assert.match(state, /dispatch_async\(dispatch_get_main_queue\(\),\^\{\[weak observeScreens\];\}\);/, "only the screen-rate read goes to the main queue");
  assert.match(displayLink(), /addToRunLoop:NSRunLoop\.currentRunLoop forMode:NSRunLoopCommonModes\];\}\n\s*macfx::nativeLog\("Presentation display link runs on its own thread/);
});

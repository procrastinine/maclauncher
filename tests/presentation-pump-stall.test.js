const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const native = path.join(__dirname, "../src/modules/shared/reshade/native");
const source = () => fs.readFileSync(path.join(native, "presentation.mm"), "utf8");
const stack = () => fs.readFileSync(path.join(native, "thread-stack.hpp"), "utf8");
const encodeFinal = () => source().split(" bool encodeFinal(id<MTLCommandBuffer>commands,id<CAMetalDrawable>drawable,const Display&display,bool producer,")[1].split(" bool replayCompleted(){")[0];

test("a stalled pump is reported once per pass with the pump, main and display-link thread stacks", () => {
  const publish = source().split(" void publish(const std::shared_ptr<Batch>&batch,bool ready){")[1].split(" void encodeFlipped(")[0];
  assert.match(source(), /#include "thread-stack\.hpp"/);
  assert.match(publish, /previous!=entered&&pumpStallReportedAt\.compare_exchange_strong\(previous,entered\)&&pumpStallReports\.fetch_add\(1\)<4\)\{/);
  assert.match(publish, /pumpStack=describeThreadStack\(pumpThread\.load\(\)\),mainStack=describeMainThreadStack\(\),linkStack=describeThreadStack\(linkThread\.load\(\)\);/);
  assert.match(publish, /if\(pumpEnteredAt\.load\(\)==entered\)nativeLog\("Presentation pump has not finished for ".*?; pump thread: "\+pumpStack\+"; main thread: "\+mainStack\+"; display-link thread: "\+linkStack\);/);
  assert.doesNotMatch(source(), /pumpStallReported\.exchange\(true\)/, "the report is not limited to the first stall of the presenter");
});

test("the pump records its thread before its start time, and a reported pump logs its finish", () => {
  assert.match(source(), /pumpThread\.store\(pthread_mach_thread_np\(pthread_self\(\)\),std::memory_order_relaxed\);pumpStep\.store\(1,std::memory_order_relaxed\);pumpEnteredAt\.store\(CACurrentMediaTime\(\)\);/);
  const finish = source().split(" void finishPump(bool more=false){")[1].split(" void failWithoutLock(")[0];
  assert.match(finish, /if\(const double entered=pumpEnteredAt\.exchange\(0\);entered>0&&entered==pumpStallReportedAt\.load\(\)\)\s*nativeLog\("Presentation pump finished after "/);
  assert.match(source(), /void displayUpdate\(uint64_t epoch,id<CAMetalDrawable> drawable,double target,unsigned rate\)\{\s*linkThread\.store\(pthread_mach_thread_np\(pthread_self\(\)\),std::memory_order_relaxed\);/);
});

test("the final encode reports its sub-steps in order", () => {
  const body = encodeFinal();
  const order = [51, 52, 53, 54, 55, 56, 57, 58, 59].map(step => body.indexOf(`pumpStep.store(${step},std::memory_order_relaxed);`));
  assert.ok(order.every(index => index >= 0), "every sub-step is recorded");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "sub-steps follow the encode order");
  assert.ok(body.indexOf("pumpStep.store(52,") < body.indexOf("encodeContentImage(frame,contentStamp") && body.indexOf("encodeContentImage(frame,contentStamp") < body.indexOf("pumpStep.store(53,"));
  assert.ok(body.indexOf("pumpStep.store(58,") < body.indexOf("drawables.fromDisplayLink(drawable)"));
  assert.match(source(), /5 final encode, 51 admitted, 52 effects encode, 53 effects encoded, 54 color, 55 copy, 56 capture, 57 overlay, 58 handlers, 59 encoded, 6 commit, 7 committed/);
});

test("a stack is read while its thread is suspended and symbolized after it resumes", () => {
  const capture = stack().split("inline std::vector<uintptr_t> threadReturnAddresses(")[1].split("inline thread_act_t firstProcessThread(")[0];
  const suspended = capture.slice(capture.indexOf("thread_suspend(thread)"), capture.indexOf("thread_resume(thread)"));
  assert.ok(capture.indexOf("addresses.reserve(limit+2)") < capture.indexOf("thread_suspend(thread)"), "storage is reserved before the thread stops");
  assert.match(suspended, /vm_read_overwrite\(mach_task_self\(\)/);
  assert.doesNotMatch(suspended, /dladdr|std::string|nativeLog|malloc|new /, "nothing that can take a lock runs while the thread is stopped");
  assert.match(capture, /thread==pthread_mach_thread_np\(pthread_self\(\)\)\)return addresses;/, "the calling thread never suspends itself");
  const describe = stack().split("inline std::string describeThreadStack(")[1];
  assert.ok(describe.indexOf("threadReturnAddresses(thread,limit)") < describe.indexOf("dladdr("));
  assert.match(describe, /"@0x%llx"/, "each frame carries its image offset");
});

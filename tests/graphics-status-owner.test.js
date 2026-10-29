const test = require("node:test"), assert = require("node:assert/strict");
const Status = require("../src/main/graphics-status");

const settle = () => new Promise(resolve => setImmediate(resolve));
function fakeClock() {
  let now = 1000, id = 0;const timers = new Map();
  return {now: () => now, setTimeout(callback, ms) {const key = ++id;timers.set(key, {at: now + ms, callback});return key;},
    clearTimeout(key) {timers.delete(key);}, get timers() {return timers.size;},
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);now = next[1].at;next[1].callback();await settle();
      }
      now = end;await settle();
    }};
}
const plan = (...video) => ({schema: 2, mode: "advanced", enabled: true, video});
const gray = {id: "gray", kind: "shader", enabled: true, shader: {enabled: true, preset: "grayscale"}};
function fixture(options = {}) {
  const clock = fakeClock(), events = [];
  const owner = Status.createGraphicsStatusOwner({clock, send: (event, extra) => events.push({...event, extra}), ...options});
  return {clock, events, owner, phases: () => events.map(event => event.status.phase), last: () => events.at(-1)?.status};
}
const live = (f, gamePath = "/Games/A") => f.owner.bound(gamePath, {launchId: "launch-1", pid: 4242, live: true});

test("an edit of a stopped game is saved with one event and no timers", async () => {
  const f = fixture(), desired = plan(gray);
  const seq = f.owner.desired("/Games/A", {revision: "r1", plan: desired});
  assert.equal(seq, 1);assert.equal(f.owner.status("/Games/A").phase, "saved");
  await settle();
  assert.equal(f.events.length, 1);assert.equal(f.events[0].plan, desired);assert.equal(f.clock.timers, 0);
  assert.equal(f.owner.status("/Games/Other").phase, "saved");assert.equal(f.owner.status("/Games/Other").desiredSeq, 0);
});

test("a live edit moves from preparing through published to applied and leaves no timers", async () => {
  const f = fixture();live(f);await settle();
  const seq = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray)});await settle();
  assert.equal(f.last().phase, "saved", "the edit right after binding waits for the throttle window");
  await f.clock.advance(Status.THROTTLE_MS);
  assert.equal(f.last().phase, "preparing");assert.ok(f.events.at(-1).plan);
  f.owner.prepared("/Games/A", seq, {pending: []});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-1", controlsDigest: "c1"});await f.clock.advance(Status.THROTTLE_MS);
  assert.equal(f.last().phase, "published");assert.equal(f.clock.timers, 1, "one confirmation deadline");
  f.owner.ack("/Games/A", {launchId: "launch-1", documentRevision: "doc-1", controlsDigest: "c1"});await settle();
  const status = f.last();
  assert.equal(status.phase, "applied");assert.equal(status.acknowledged.documentRevision, "doc-1");
  assert.deepEqual(status.rows, {gray: {state: "active"}});
  assert.equal(f.clock.timers, 0, "no timers at rest");
  assert.equal(f.events.filter(event => event.plan).length, 1, "the plan is sent only when the desired plan changes");
});

test("an acknowledgement of an older revision reports retained graphics", async () => {
  const f = fixture();live(f);
  const seq = f.owner.desired("/Games/A", {revision: "r2", plan: plan(gray)});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-2"});
  f.owner.ack("/Games/A", {documentRevision: "doc-1"});await settle();
  assert.equal(f.last().phase, "published");assert.deepEqual(f.last().retained, {documentRevision: "doc-1"});
  f.owner.ack("/Games/A", {launchId: "other-launch", documentRevision: "doc-2"});await settle();
  assert.equal(f.owner.status("/Games/A").phase, "published", "another launch cannot acknowledge this one");
  f.owner.ack("/Games/A", {documentRevision: "doc-2"});await settle();
  assert.equal(f.last().phase, "applied");assert.equal(f.last().retained, undefined);
});

test("rollback and a source retry keep one publication without a phase flip (S1)", async () => {
  const f = fixture();live(f);
  const seq = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray)});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-0"});
  f.owner.ack("/Games/A", {documentRevision: "doc-0"});
  const next = f.owner.desired("/Games/A", {revision: "r2", plan: plan({...gray, enabled: false})});
  f.owner.retrying("/Games/A", next);f.owner.rolledBack("/Games/A", next, {restoredRevision: "doc-0"});
  assert.equal(f.owner.status("/Games/A").phase, "preparing");
  f.owner.published("/Games/A", next, {documentRevision: "doc-2"});
  f.owner.ack("/Games/A", {documentRevision: "doc-2"});await settle();
  const after = f.phases().slice(f.phases().lastIndexOf("preparing"));
  assert.deepEqual(after, ["preparing", "applied"].filter(phase => after.includes(phase)));
  assert.ok(!after.slice(after.indexOf("applied") + 1).includes("preparing"));
});

test("a skipped row is bypassed while the other rows apply, and a rollback restores the running publication", async () => {
  const f = fixture();live(f);
  const broken = {...gray, id: "broken"}, seq = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray, broken)});
  f.owner.prepared("/Games/A", seq, {skipped: [{id: "broken", reason: "The shader could not be compiled."}]});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-1"});
  f.owner.ack("/Games/A", {documentRevision: "doc-1"});await settle();
  let status = f.owner.status("/Games/A");
  assert.equal(status.phase, "partial");assert.equal(status.reason, "The shader could not be compiled.");
  assert.deepEqual(status.rows, {gray: {state: "active"}, broken: {state: "bypassed", reason: "The shader could not be compiled."}});
  const running = status.published, next = f.owner.desired("/Games/A", {revision: "r2", plan: plan(gray)});
  f.owner.published("/Games/A", next, {documentRevision: "doc-2"});
  f.owner.rolledBack("/Games/A", next, {restored: running});
  status = f.owner.status("/Games/A");
  assert.equal(status.phase, "preparing");assert.equal(status.published.documentRevision, "doc-1", "the last accepted chain is still the running one");
  f.owner.rolledBack("/Games/A", next, {restored: null});
  assert.equal(f.owner.status("/Games/A").published, undefined, "nothing was running before the first publication");
});

test("the confirmation deadline reports Not confirmed and a late acknowledgement still applies", async () => {
  const f = fixture();live(f);
  const seq = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray)});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-1"});
  await f.clock.advance(Status.CONFIRM_MS);
  assert.equal(f.last().phase, "unconfirmed");assert.equal(f.last().reason, Status.REASONS.unconfirmed);
  assert.equal(f.clock.timers, 0);
  f.owner.ack("/Games/A", {documentRevision: "doc-1"});await settle();
  assert.equal(f.last().phase, "applied");

  const slow = fixture();live(slow);
  const slowSeq = slow.owner.desired("/Games/A", {revision: "r1", plan: plan(gray)});
  slow.owner.published("/Games/A", slowSeq, {documentRevision: "doc-1", slow: true, read: () => null});
  await slow.clock.advance(Status.CONFIRM_MS + 100);
  assert.equal(slow.owner.status("/Games/A").phase, "published", "a model or virtual-source publication waits longer");
  await slow.clock.advance(Status.SLOW_CONFIRM_MS);
  assert.equal(slow.last().phase, "unconfirmed");assert.equal(slow.last().reason, Status.REASONS.unconfirmed);
  assert.equal(slow.clock.timers, 0, "the fallback probe stops with the deadline");
});
test("an unconfirmed publication reports the reason native code gave, when it gave one", async () => {
  const f = fixture();live(f);
  const seq = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray)});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-1", explain: () => "The candidate graph exceeds the image budget."});
  await f.clock.advance(Status.CONFIRM_MS);
  assert.equal(f.last().phase, "unconfirmed");assert.equal(f.last().reason, "The candidate graph exceeds the image budget.");
  const failing = f.owner.desired("/Games/A", {revision: "r2", plan: plan(gray)});
  f.owner.published("/Games/A", failing, {documentRevision: "doc-2", explain: () => {throw new Error("status unreadable");}});
  await f.clock.advance(Status.CONFIRM_MS);
  assert.equal(f.last().phase, "unconfirmed");assert.equal(f.last().reason, Status.REASONS.unconfirmed);
});

test("the fallback probe confirms a publication with bounded backoff", async () => {
  let reads = 0;const f = fixture();live(f);
  const seq = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray)});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-1", read: () => ++reads < 4 ? null : {documentRevision: "doc-1", launchId: "launch-1"}});
  await f.clock.advance(1000);
  assert.equal(reads, 4);assert.equal(f.last().phase, "applied");assert.equal(f.clock.timers, 0);
});

test("fresh native preparation has a soft observation window and still accepts late readiness", async () => {
  const f = fixture();live(f);
  const seq = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray)});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-1"});
  const report = () => ({launchId: "launch-1", documentRevision: "doc-1", phase: "preparing", reason: "Waiting for a pipeline.", observedAt: f.clock.now()});
  f.owner.native("/Games/A", seq, report());
  assert.equal(f.owner.status("/Games/A").phase, "preparing");
  await f.clock.advance(Status.PREPARING_CONFIRM_MS - 1);
  f.owner.native("/Games/A", seq, report());
  assert.equal(f.owner.status("/Games/A").phase, "preparing");
  await f.clock.advance(1);
  assert.equal(f.last().phase, "preparing");assert.match(f.last().reason, /Waiting for a pipeline/);
  await f.clock.advance(Status.THROTTLE_MS);
  assert.equal(f.clock.timers, 0);
  f.owner.native("/Games/A", seq, report());
  assert.equal(f.owner.status("/Games/A").phase, "preparing", "repeated progress does not restart aggressive observation");
  f.owner.ack("/Games/A", {documentRevision: "doc-1", launchId: "launch-1"});await settle();
  assert.equal(f.last().phase, "applied", "elapsed observation time never invalidates a valid publication");
});

test("main keeps a slow metadata observer after confirmation expiry and rejects a superseded late result", async () => {
  const fs = require("node:fs"), vm = require("node:vm"), source = fs.readFileSync(require.resolve("../src/main/main"), "utf8");
  const begin = source.indexOf("const GRAPHICS_OUTCOME_MS"), end = source.indexOf("\n// The publication", begin);
  assert.ok(begin >= 0 && end > begin);
  for (const superseded of [false, true]) {
    let now = 0, phase = "published", calls = 0, publicationAt = 1;const waits = [], acknowledged = [];
    const context = {Date: {now: () => now}, GraphicsStatus: Status, logger: {warn: () => assert.fail("No read failed")},
      graphicsStatus: {isCurrent: () => true, status: () => ({phase, published: {documentRevision: "doc", at: publicationAt}}),
        ack: (_game, ack) => {acknowledged.push(ack);phase = "applied";}},
      EffectsRuntime: {acceptance: async (_entry, options) => {
        if (++calls === 1) {now = Status.PREPARING_CONFIRM_MS + 1;phase = "unconfirmed";return null;}
        assert.equal(options.timeoutMs, 0, "late checks read metadata without another bounded wait");
        if (superseded) publicationAt++;
        return {revision: "doc", launchId: "launch"};
      }}, require: id => {
        assert.equal(id, "node:timers/promises");return {setTimeout: async (ms, _value, options) => {
          waits.push(ms);assert.equal(options.ref, false);now += ms;
        }};
      }};
    vm.runInNewContext(source.slice(begin, end), context);
    await context.observeGraphicsAcceptance("/Games/A", 1, {}, {}, {documentRevision: "doc"});
    assert.equal(calls, 2);assert.equal(acknowledged.length, superseded ? 0 : 1);
    assert.ok(waits.length === 1 && waits[0] >= 1000, "expired confirmation backs off instead of polling quickly");
  }
});

test("the deadline rereads exact native progress, and a candidate failure retains the accepted graph", async () => {
  const f = fixture();live(f);
  const seq = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray)});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-1", progress: () => ({launchId: "launch-1",
    documentRevision: "doc-1", phase: "preparing", reason: "Preparing model.", observedAt: f.clock.now()})});
  f.owner.ack("/Games/A", {documentRevision: "previous"});
  await f.clock.advance(Status.CONFIRM_MS);
  assert.equal(f.owner.status("/Games/A").phase, "preparing");
  f.owner.native("/Games/A", seq, {launchId: "launch-1", documentRevision: "doc-1", phase: "failed",
    reason: "The pipeline could not be created.", observedAt: f.clock.now()});
  await settle();
  assert.equal(f.last().phase, "rejected");assert.equal(f.last().reason, "The pipeline could not be created.");
  assert.deepEqual(f.last().retained, {documentRevision: "previous"});assert.equal(f.clock.timers, 0);
});

test("stale or unrelated native progress cannot extend or reject a newer publication", async () => {
  const f = fixture();live(f);
  let seq = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray)});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-1"});
  const old = seq;seq = f.owner.desired("/Games/A", {revision: "r2", plan: plan(gray)});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-2"});
  const report = {launchId: "launch-1", documentRevision: "doc-2", phase: "preparing", observedAt: f.clock.now()};
  f.owner.native("/Games/A", old, report);
  f.owner.native("/Games/A", seq, {...report, launchId: "other"});
  f.owner.native("/Games/A", seq, {...report, documentRevision: "doc-1"});
  f.owner.native("/Games/A", seq, {...report, observedAt: f.clock.now() - 7000});
  await f.clock.advance(Status.CONFIRM_MS);
  assert.equal(f.last().phase, "unconfirmed");assert.equal(f.clock.timers, 0);
});

test("a running game without a live binding defers the edit to the next launch (L2)", async () => {
  const f = fixture();
  f.owner.bound("/Games/A", {launchId: "launch-1", pid: 1, live: false});
  f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray)});await settle();
  assert.equal(f.last().phase, "deferred");assert.equal(f.last().reason, Status.REASONS.unbound);
});

test("a rejected publication reports the previous graphics as retained", async () => {
  const f = fixture();live(f);
  const first = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray)});
  f.owner.published("/Games/A", first, {documentRevision: "doc-1"});f.owner.ack("/Games/A", {documentRevision: "doc-1"});
  const second = f.owner.desired("/Games/A", {revision: "r2", plan: plan(gray, {...gray, id: "b"})});
  f.owner.rejected("/Games/A", second, "shader compile failed\n");await settle();
  assert.equal(f.last().phase, "rejected");assert.equal(f.last().reason, "shader compile failed ");
  assert.deepEqual(f.last().retained, {documentRevision: "doc-1"});
  const third = f.owner.desired("/Games/A", {revision: "r3", plan: plan(gray)});
  f.owner.published("/Games/A", third, {documentRevision: "doc-3"});
  f.owner.ack("/Games/A", {documentRevision: "doc-1", rejected: {documentRevision: "doc-3", reason: "Native preparation failed."}});await settle();
  assert.equal(f.last().phase, "rejected");assert.equal(f.last().reason, "Native preparation failed.");assert.equal(f.clock.timers, 0);
});

test("events of a superseded desired plan are ignored", async () => {
  const f = fixture();live(f);
  const old = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray)});
  const seq = f.owner.desired("/Games/A", {revision: "r2", plan: plan()});
  f.owner.published("/Games/A", old, {documentRevision: "doc-1"});f.owner.rejected("/Games/A", old, "late");
  f.owner.deferred("/Games/A", old, "late");f.owner.prepared("/Games/A", old, {pending: [{id: "gray", reason: "late"}]});
  assert.equal(f.owner.status("/Games/A").phase, "preparing");assert.equal(f.owner.status("/Games/A").published, undefined);
  assert.equal(f.owner.isCurrent("/Games/A", old), false);assert.equal(f.owner.isCurrent("/Games/A", seq), true);
  assert.equal(f.clock.timers, 0);
});

test("ending the session during a publication saves the change for the next launch", async () => {
  const f = fixture();live(f);
  const seq = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray)});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-1", read: () => null});
  assert.ok(f.clock.timers > 0);
  f.owner.ended("/Games/A", {launchId: "launch-1"});await settle();
  assert.equal(f.last().phase, "saved");assert.equal(f.last().reason, Status.REASONS.stopped);
  assert.equal(f.last().running, false);assert.equal(f.clock.timers, 0);
  f.owner.ack("/Games/A", {documentRevision: "doc-1"});assert.equal(f.owner.status("/Games/A").phase, "saved");
  f.owner.ended("/Games/B");assert.equal(f.owner.status("/Games/B").phase, "saved");
});

test("Stop preserves a known graphics failure until a new edit or launch", async () => {
  const f = fixture();live(f);
  let seq = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray)});
  const reason = "The executable's hardened runtime does not allow DYLD graphics attachment.";
  f.owner.rejected("/Games/A", seq, reason);
  f.owner.ended("/Games/A", {launchId: "older-launch"});
  assert.equal(f.owner.status("/Games/A").running, true, "a stale Stop cannot end the current launch");
  f.owner.ended("/Games/A", {launchId: "launch-1"});await settle();
  assert.equal(f.last().phase, "saved");assert.equal(f.last().reason, reason);
  assert.equal(f.last().running, false);assert.equal(f.last().launchId, undefined);
  assert.equal(f.clock.timers, 0);
  f.owner.ended("/Games/A", {launchId: "launch-1"});await settle();
  assert.equal(f.last().reason, reason, "a repeated Stop preserves the same known outcome");

  seq = f.owner.desired("/Games/A", {revision: "r2", plan: plan(gray)});await settle();
  assert.equal(f.last().reason, undefined, "a new stopped edit does not inherit an old launch's failure");
  live(f);
  f.owner.rejected("/Games/A", seq, reason);
  f.owner.ended("/Games/A", {launchId: "launch-1"});await settle();
  assert.equal(f.last().reason, reason);
  f.owner.bound("/Games/A", {launchId: "launch-2", pid: 4343, live: true});await settle();
  assert.equal(f.last().phase, "saved");assert.equal(f.last().reason, undefined);
  f.owner.published("/Games/A", seq, {documentRevision: "doc-2"});
  f.owner.ack("/Games/A", {launchId: "launch-2", documentRevision: "doc-2"});await settle();
  assert.equal(f.last().phase, "applied", "a later compatible target can accept the same saved settings");
  assert.equal(f.clock.timers, 0);
});

test("an Off or empty graph waits for native acknowledgement like any other", async () => {
  const f = fixture();live(f);
  const seq = f.owner.desired("/Games/A", {revision: "r1", plan: {...plan(gray), enabled: false}});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-off"});await settle();
  assert.equal(f.last().phase, "published");assert.equal(f.clock.timers, 1, "one confirmation deadline");
  f.owner.ack("/Games/A", {documentRevision: "doc-off"});await settle();
  assert.equal(f.last().phase, "applied");assert.deepEqual(f.last().rows, {gray: {state: "off"}});assert.equal(f.clock.timers, 0);
  const next = f.owner.desired("/Games/A", {revision: "r2", plan: plan()});
  f.owner.published("/Games/A", next, {documentRevision: "doc-empty"});
  await f.clock.advance(Status.CONFIRM_MS);
  assert.equal(f.last().phase, "unconfirmed", "an unacknowledged empty graph is never reported as applied");
  f.owner.ack("/Games/A", {documentRevision: "doc-empty"});await settle();
  assert.equal(f.last().phase, "applied");assert.equal(f.last().acknowledged.documentRevision, "doc-empty");
});

test("one revision settles once: a repeated publication never downgrades it and no timer flips it (D8)", async () => {
  const f = fixture();live(f);
  const seq = f.owner.desired("/Games/A", {revision: "r1", plan: {...plan(gray), enabled: false}});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-off", committedAt: f.clock.now()});
  f.owner.ack("/Games/A", {documentRevision: "doc-off"});await settle();
  assert.equal(f.last().phase, "applied");
  // The same revision published again (a resumed publication) keeps its outcome.
  await f.clock.advance(1000);
  f.owner.prepared("/Games/A", seq, {pending: []});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-off", committedAt: f.clock.now()});
  await f.clock.advance(Status.PREPARING_CONFIRM_MS);
  assert.deepEqual(f.phases().slice(-1), ["applied"]);assert.ok(!f.phases().includes("unconfirmed"), "an applied revision is never downgraded");
  assert.deepEqual(f.last().rows, {gray: {state: "off"}});assert.equal(f.clock.timers, 0);

  // An unconfirmed revision published again does not restart its expired
  // window, so the status cannot alternate; native acknowledgement still applies it.
  const next = f.owner.desired("/Games/A", {revision: "r2", plan: plan(gray)});
  f.owner.published("/Games/A", next, {documentRevision: "doc-2"});
  await f.clock.advance(Status.CONFIRM_MS);
  assert.equal(f.last().phase, "unconfirmed");
  const before = f.events.length;
  for (let index = 0; index < 20; index++) {
    f.owner.published("/Games/A", next, {documentRevision: "doc-2"});
    f.owner.ack("/Games/A", {documentRevision: "doc-off"});
    await f.clock.advance(100);
  }
  assert.ok(f.events.slice(before).every(event => event.status.phase === "unconfirmed"), "no published/unconfirmed alternation");
  assert.ok(f.events.length - before <= 2, "repeated acknowledgements of the earlier revision send no events");
  f.owner.ack("/Games/A", {documentRevision: "doc-2"});await settle();
  assert.equal(f.last().phase, "applied");assert.equal(f.clock.timers, 0);
  // A new document for the same desired plan is still a new publication.
  f.owner.published("/Games/A", next, {documentRevision: "doc-3"});await settle();
  assert.equal(f.owner.status("/Games/A").phase, "published");
});

test("pending rows make an acknowledged publication partly active", async () => {
  const f = fixture();live(f);
  const seq = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray, {id: "nr", kind: "upscale", method: "realesrgan", enabled: true, settings: {}})});
  f.owner.prepared("/Games/A", seq, {pending: [{id: "nr", reason: "A compatible model is needed."}]});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-1"});f.owner.ack("/Games/A", {documentRevision: "doc-1"});await settle();
  assert.equal(f.last().phase, "partial");assert.equal(f.last().reason, "A compatible model is needed.");
  assert.deepEqual(f.last().rows, {gray: {state: "active"}, nr: {state: "pending", reason: "A compatible model is needed."}});
});

test("rows native code reports as not running are bypassed with their reason and never count as active (D10, D9)", async () => {
  const f = fixture();live(f);
  const temporal = {id: "temporal", kind: "temporal", method: "metalfx", enabled: true, settings: {}};
  const seq = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray, temporal)});
  f.owner.prepared("/Games/A", seq, {pending: []});f.owner.published("/Games/A", seq, {documentRevision: "doc-1"});
  const missing = "Needs matching renderer depth, motion and jitter";
  f.owner.ack("/Games/A", {launchId: "launch-1", documentRevision: "doc-1", outcomes: {temporal: {reason: missing}}});await settle();
  assert.equal(f.last().phase, "partial");assert.equal(f.last().reason, missing);
  assert.deepEqual(f.last().rows, {gray: {state: "active"}, temporal: {state: "bypassed", reason: missing}});
  // Later reports for the accepted revision: the row runs, then stops again.
  const observe = outcomes => f.owner.observed("/Games/A", {documentRevision: "doc-1", launchId: "launch-1", outcomes});
  observe({});await f.clock.advance(Status.THROTTLE_MS);
  assert.equal(f.last().phase, "applied");assert.deepEqual(f.last().rows, {gray: {state: "active"}, temporal: {state: "active"}});
  const before = f.events.length;observe({});await f.clock.advance(Status.THROTTLE_MS);
  assert.equal(f.events.length, before, "an unchanged report sends no event");
  observe({temporal: {state: "pending", reason: "Neural provider is warming up"}});await f.clock.advance(Status.THROTTLE_MS);
  assert.equal(f.last().phase, "partial");assert.equal(f.last().reason, "Neural provider is warming up");
  assert.deepEqual(f.last().rows.temporal, {state: "pending", reason: "Neural provider is warming up"});
  observe({temporal: {reason: "The GPU stopped responding."}});await f.clock.advance(Status.THROTTLE_MS);
  assert.equal(f.last().phase, "partial");assert.deepEqual(f.last().rows.temporal, {state: "bypassed", reason: "The GPU stopped responding."});
  // Another revision or launch cannot clear it, and the same revision published again keeps it.
  f.owner.observed("/Games/A", {documentRevision: "doc-0", outcomes: {}});
  f.owner.observed("/Games/A", {documentRevision: "doc-1", launchId: "launch-2", outcomes: {}});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-1"});await f.clock.advance(Status.THROTTLE_MS);
  assert.equal(f.owner.status("/Games/A").phase, "partial");assert.equal(f.owner.status("/Games/A").rows.temporal.state, "bypassed");
  // The next revision starts from its own report; a row that is off stays off.
  const next = f.owner.desired("/Games/A", {revision: "r2", plan: plan({...gray, enabled: false}, temporal)});
  f.owner.published("/Games/A", next, {documentRevision: "doc-2"});
  f.owner.ack("/Games/A", {documentRevision: "doc-2", outcomes: {gray: {reason: missing}}});await f.clock.advance(Status.THROTTLE_MS);
  assert.equal(f.last().phase, "applied");assert.deepEqual(f.last().rows, {gray: {state: "off"}, temporal: {state: "active"}});
  assert.equal(f.clock.timers, 0);
});

test("main settles a revision partial about one second after acceptance wherever the bypassed row sits, and ignores a brief busy bypass (D10)", async () => {
  const fs = require("node:fs"), vm = require("node:vm"), source = fs.readFileSync(require.resolve("../src/main/main"), "utf8");
  const begin = source.indexOf("const GRAPHICS_OUTCOME_MS"), end = source.indexOf("\n// The publication", begin);
  const missing = "Needs matching renderer depth", busy = "Ordered effect image capacity is busy";
  const running = completed => ({running: true, reason: "", completed});
  // The bypassed row first (XeGTAO before gray, 540p and FSR 1), in the middle, and last (depth fog after a resize).
  const layout = position => calls => Object.fromEntries(["ao", "gray", "down", "up"].map((id, index) =>
    [id, index === position ? {running: false, reason: missing, completed: 0} : running(10 + calls)]));
  const cases = {
    first: [layout(0), {ao: {reason: missing}}], middle: [layout(1), {gray: {reason: missing}}], last: [layout(3), {up: {reason: missing}}],
    single: [() => ({t: {running: false, reason: missing, completed: 0}}), {t: {reason: missing}}],
    // A provider still warming up is pending, not bypassed.
    warming: [() => ({nn: {running: false, reason: "Neural provider is warming up", completed: 0, pending: true}}),
      {nn: {state: "pending", reason: "Neural provider is warming up"}}],
    brief: [calls => ({ao: calls < 4 ? {running: false, reason: busy, completed: 0} : running(2), gray: running(calls)}), {}],
    // A row that completed a frame since the previous read runs.
    completing: [calls => ({ao: {running: false, reason: busy, completed: calls}}), {}]};
  for (const [name, [stages, expected]] of Object.entries(cases)) {
    let now = 0, calls = 0;const acknowledged = [], votes = [];
    const context = {Date: {now: () => now}, GraphicsStatus: Status, logger: {warn: (...args) => assert.fail(args.join(" "))},
      graphicsStatus: {isCurrent: () => true, status: () => ({phase: "published", published: {documentRevision: "doc", at: 1}}),
        ack: (_game, ack) => acknowledged.push({...ack, at: now})},
      // One acceptance vote; a later vote would fail while a context still shows the previous revision.
      EffectsRuntime: {acceptance: async (_entry, options) => {votes.push(options.timeoutMs);now += 400;
        return votes.length === 1 ? {revision: "doc", launchId: "launch", stages: stages(calls++)} : null;},
        outcomes: async (_entry, options) => {assert.equal(options.revision, "doc");return {revision: "doc", stages: stages(calls++)};}},
      require: () => ({setTimeout: async ms => {now += ms;}})};
    vm.runInNewContext(source.slice(begin, end), context);
    await context.observeGraphicsAcceptance("/Games/A", 1, {}, {}, {documentRevision: "doc"});
    assert.equal(acknowledged.length, 1, name);assert.deepEqual(JSON.parse(JSON.stringify(acknowledged[0].outcomes)), expected, name);
    assert.deepEqual(votes, [2500], name + ": a held acknowledgement reads outcomes without another acceptance vote");
    const window = vm.runInContext("GRAPHICS_OUTCOME_MS", context);assert.equal(window, 1000);
    if (Object.keys(expected).length) assert.ok(acknowledged[0].at >= 400 + window && acknowledged[0].at < 400 + window + 300, name + ": settles about 1 s after acceptance");
    else assert.ok(acknowledged[0].at < 400 + window, name);
  }
});

test("a confirmation deadline during an outcome hold applies what is known instead of Not confirmed (D10)", async () => {
  const f = fixture();live(f);
  const temporal = {id: "temporal", kind: "temporal", method: "fsr2", enabled: true, settings: {}}, missing = "Needs matching renderer depth, motion and jitter";
  const seq = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray, temporal)});
  f.owner.prepared("/Games/A", seq, {pending: []});f.owner.published("/Games/A", seq, {documentRevision: "doc-1"});
  const known = {launchId: "launch-1", documentRevision: "doc-1", outcomes: {temporal: {reason: missing}}};
  f.owner.holding("/Games/A", "doc-0", {...known, documentRevision: "doc-0"});
  f.owner.holding("/Games/A", "doc-1", known);f.owner.holding("/Games/A", "doc-0");
  await f.clock.advance(Status.CONFIRM_MS);
  assert.ok(!f.phases().includes("unconfirmed"));assert.equal(f.last().phase, "partial");
  assert.deepEqual(f.last().rows, {gray: {state: "active"}, temporal: {state: "bypassed", reason: missing}});
  // The final report replaces it; an ended hold no longer applies.
  f.owner.ack("/Games/A", {...known, outcomes: {}});await f.clock.advance(Status.THROTTLE_MS);
  assert.equal(f.last().phase, "applied");f.owner.holding("/Games/A", "doc-1");
  const next = f.owner.desired("/Games/A", {revision: "r2", plan: plan(temporal)});f.owner.published("/Games/A", next, {documentRevision: "doc-2"});
  await f.clock.advance(Status.CONFIRM_MS);assert.equal(f.last().phase, "unconfirmed");assert.equal(f.clock.timers, 0);
});

test("main settles a single bypassed row partial when acceptance comes near or after the confirmation deadline (D10)", async () => {
  const fs = require("node:fs"), vm = require("node:vm"), source = fs.readFileSync(require.resolve("../src/main/main"), "utf8");
  const begin = source.indexOf("const GRAPHICS_OUTCOME_MS"), end = source.indexOf("\n// The publication", begin);
  const missing = "Needs matching renderer depth, motion and jitter", temporal = {id: "t", kind: "temporal", method: "fsr2", enabled: true, settings: {}};
  for (const [name, acceptAt] of [["accepted just before the deadline", Status.CONFIRM_MS - 500], ["accepted after the deadline", Status.CONFIRM_MS + 1000]]) {
    const f = fixture();live(f);
    const seq = f.owner.desired("/Games/A", {revision: "r1", plan: plan(temporal)});
    f.owner.prepared("/Games/A", seq, {pending: []});f.owner.published("/Games/A", seq, {documentRevision: "doc-1"});
    const start = f.clock.now(), stages = () => ({t: {running: false, reason: missing, completed: 0}}), held = [];let acceptedAt;
    const context = {Date: {now: () => f.clock.now()}, GraphicsStatus: Status, graphicsStatus: f.owner, logger: {warn: (...args) => assert.fail(args.join(" "))},
      EffectsRuntime: {acceptance: async (_entry, {timeoutMs}) => {
        await f.clock.advance(Math.min(timeoutMs, Math.max(0, start + acceptAt - f.clock.now())));
        if (f.clock.now() < start + acceptAt) return null;
        acceptedAt ??= f.clock.now();return {revision: "doc-1", launchId: "launch-1", stages: stages()};
      }, outcomes: async () => {held.push([f.clock.now() - start, f.owner.status("/Games/A").phase]);return {revision: "doc-1", stages: stages()};}},
      require: () => ({setTimeout: async ms => f.clock.advance(ms)})};
    vm.runInNewContext(source.slice(begin, end), context);
    await context.observeGraphicsAcceptance("/Games/A", seq, {}, {}, {documentRevision: "doc-1"});
    assert.ok(held.length > 0, name);
    // While the outcome is timed the status is never Not confirmed: it is
    // published before the deadline and partial from what is known after it.
    for (const [at, phase] of held) assert.equal(phase, at < Status.CONFIRM_MS ? "published" : "partial", name + " at " + at);
    if (acceptAt > Status.CONFIRM_MS) assert.ok(f.phases().includes("unconfirmed"), "before acceptance the game had not reported the change");
    else assert.ok(!f.phases().includes("unconfirmed"), name);
    assert.equal(f.last().phase, "partial", name);assert.deepEqual(f.last().rows, {t: {state: "bypassed", reason: missing}}, name);
    const settledAfter = f.clock.now() - acceptedAt;
    assert.ok(settledAfter >= 1000 && settledAfter < 1300, name + ": the final outcome follows about 1 s after acceptance");
    await f.clock.advance(Status.THROTTLE_MS);assert.equal(f.clock.timers, 0, name);
  }
});

test("status reads report a row that stops after its revision settled, and its recovery (D9)", async () => {
  const fs = require("node:fs"), vm = require("node:vm"), source = fs.readFileSync(require.resolve("../src/main/main"), "utf8");
  const RuntimeStatus = require("../src/modules/shared/reshade/runtime-status");
  const outcomes = source.slice(source.indexOf("const GRAPHICS_OUTCOME_MS"), source.indexOf("async function observeGraphicsAcceptance("));
  const start = source.indexOf('ipcMain.handle("launcher:getGameGraphicsStatus"'), end = source.indexOf("ipcMain.handle(", start + 1);
  const f = fixture(), entry = {gamePath: "/Games/A"}, handlers = new Map(), temporal = {id: "temporal", kind: "temporal", method: "dlss", enabled: true, settings: {}};
  live(f);const seq = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray, temporal)});
  f.owner.prepared("/Games/A", seq, {pending: []});f.owner.published("/Games/A", seq, {documentRevision: "doc-1"});
  f.owner.ack("/Games/A", {launchId: "launch-1", documentRevision: "doc-1", outcomes: {}});await settle();
  assert.equal(f.last().phase, "applied");
  let now = 1e6, stage = {phase: "completed", reason: "", completed: 10}, other = "doc-1", state = "observed";
  const context = {Date: {now: () => now}, ipcMain: {handle: (id, callback) => handlers.set(id, callback)}, userDataDir: "/Profile",
    loadGamesHydrated: () => [entry], findGameByPath: () => entry, loadSettings: () => ({}), graphicsStatus: f.owner, graphicsReadOutcomes: new Map(),
    runningGameSessions: new Map([[entry.gamePath, new Map([["current", {pid: 4242}]])]]),
    require: () => ({rowOutcomes: RuntimeStatus.rowOutcomes, read: () => ({launchId: "launch-1", state, contexts: state === "unavailable" ? [] : [
      {pid: 4242, id: "1", phase: "completed", processStart: {seconds: 1}, observedAt: Date.now(), acceptedRevision: other, stages: [
        {id: "gray", phase: "completed", reason: "", completed: 10}, {id: "temporal", ...stage}]}]})})};
  vm.runInNewContext(outcomes + source.slice(start, end), context);
  const read = async ms => {now += ms;handlers.get("launcher:getGameGraphicsStatus")(null, entry.gamePath);await f.clock.advance(Status.THROTTLE_MS);};
  await read(0);assert.equal(f.last().phase, "applied");
  // DLSS stops after a GPU timeout and its renewal fails.
  stage = {phase: "failed", reason: "The GPU stopped responding.", completed: 10};
  await read(2000);assert.equal(f.owner.status("/Games/A").phase, "applied", "one read inside the transient window changes nothing");
  await read(2000);assert.equal(f.last().phase, "partial");
  assert.deepEqual(f.last().rows, {gray: {state: "active"}, temporal: {state: "bypassed", reason: "The GPU stopped responding."}});
  // A read without current contexts, or of another revision, keeps the row as shown.
  state = "unavailable";await read(2000);assert.equal(f.owner.status("/Games/A").rows.temporal.state, "bypassed");
  state = "observed";other = "doc-0";await read(2000);assert.equal(f.owner.status("/Games/A").rows.temporal.state, "bypassed");
  // It runs again.
  other = "doc-1";stage = {phase: "completed", reason: "", completed: 11};
  await read(2000);assert.equal(f.last().phase, "applied");assert.deepEqual(f.last().rows.temporal, {state: "active"});
});

test("status events are coalesced to one per 33 ms per game while terminal transitions are immediate", async () => {
  const f = fixture();live(f);await settle();await f.clock.advance(Status.THROTTLE_MS);
  const before = f.events.length;
  for (let index = 0; index < 10; index++) {f.owner.desired("/Games/A", {revision: "r" + index, plan: plan()});await f.clock.advance(3);}
  assert.equal(f.events.length - before, 1, "one event within the first throttle window");
  assert.equal(f.clock.timers, 1, "one trailing event is pending");
  await f.clock.advance(Status.THROTTLE_MS);
  assert.equal(f.events.length - before, 2);assert.equal(f.last().desiredRevision, "r9");
  assert.equal(f.clock.timers, 0);
  f.owner.desired("/Games/A", {revision: "rA", plan: plan()});f.owner.deferred("/Games/A", f.owner.status("/Games/A").desiredSeq, "Next launch.");
  await settle();
  assert.equal(f.last().phase, "deferred", "a terminal transition is not throttled");
  for (let index = 0; index < 5; index++) f.owner.desired("/Games/B", {revision: "b" + index, plan: plan()});
  await settle();
  assert.equal(f.events.filter(event => event.gamePath === "/Games/B").length, 1, "games are throttled independently");
});

test("an unreadable stored plan is reported as invalid", async () => {
  const f = fixture();live(f);
  f.owner.invalid("/Games/A", Object.assign(new Error("Unsupported schema."), {code: "GRAPHICS_STORED_PLAN_INVALID"}));await settle();
  assert.equal(f.last().phase, "invalid");assert.equal(f.last().planSource, "invalid");assert.equal(f.last().reason, "Unsupported schema.");
  f.owner.ended("/Games/A");assert.equal(f.owner.status("/Games/A").phase, "invalid");
});

test("an acknowledgement watcher replaces the fallback probe and stops at session end", async () => {
  let deliver, stopped = 0;const f = fixture();
  f.owner.bound("/Games/A", {launchId: "launch-1", pid: 1, live: true, watch: callback => {deliver = callback;return () => stopped++;}});
  const seq = f.owner.desired("/Games/A", {revision: "r1", plan: plan(gray)});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-1", read: () => assert.fail("a watched launch is not probed")});
  await f.clock.advance(200);
  deliver({launchId: "launch-1", documentRevision: "doc-1", rows: {gray: {state: "active", activeMethod: "grayscale"}}});await settle();
  assert.equal(f.last().phase, "applied");assert.deepEqual(f.last().rows.gray, {state: "active", activeMethod: "grayscale"});
  f.owner.ended("/Games/A");assert.equal(stopped, 1);assert.equal(f.clock.timers, 0);
});

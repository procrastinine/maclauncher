const test = require("node:test"), assert = require("node:assert/strict");
const Items = require("../src/modules/shared/item-results");

test("one failed item is recorded with its id and reason while the aggregate continues", async () => {
  const rows = [{id: "a"}, {id: "bad"}, {id: "c"}], run = row => {if (row.id === "bad") throw new Error("missing\nfile");return row.id;};
  const sync = Items.settle(rows, run);
  assert.deepEqual(sync.results, ["a", "c"]);
  assert.deepEqual(sync.failures.map(({id, reason}) => ({id, reason})), [{id: "bad", reason: "missing file"}]);
  const indexed = await Items.settleAsync(rows, async row => run(row), {id: (_row, index) => index});
  assert.deepEqual(indexed.results, ["a", "c"]);assert.equal(indexed.failures[0].id, 1);
  // A section falls back to its default and records why.
  const failures = [];
  assert.equal(Items.section(() => {throw new Error("unreadable");}, "fallback", failures, "models"), "fallback");
  assert.equal(Items.section(() => "value", "fallback", failures, "packs"), "value");
  assert.deepEqual(failures.map(({id, reason}) => ({id, reason})), [{id: "models", reason: "unreadable"}]);
});

test("cancellation and a changed launch end the aggregate instead of being recorded", async () => {
  const stale = Object.assign(new Error("The launch changed."), {code: "GRAPHICS_LIVE_STALE"});
  assert.throws(() => Items.settle([1, 2], () => {throw stale;}), stale);
  assert.throws(() => Items.section(() => {throw Object.assign(new Error("stop"), {name: "AbortError"});}, null, []), {name: "AbortError"});
  const controller = new AbortController(), seen = [];
  await assert.rejects(Items.settleAsync([1, 2, 3], async value => {seen.push(value);if (value === 1) controller.abort();return value;},
    {signal: controller.signal}), {name: "AbortError"});
  assert.deepEqual(seen, [1]);
});

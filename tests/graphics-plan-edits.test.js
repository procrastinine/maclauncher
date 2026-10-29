const test = require("node:test");
const assert = require("node:assert/strict");
const {rebase} = require("../src/modules/shared/effects/edit-operations.mjs"), {revision} = require("../src/modules/shared/effects/stored-plan");
const row = (id, parameters = {}) => ({id, kind: "shader", enabled: true,
  shader: {enabled: true, preset: "custom", parameters}});
const graph = (...video) => ({schema: 2, mode: "advanced", enabled: true, video});

test("concurrent windows retain independent shader parameters and enabled changes", () => {
  const base = graph(row("a", {strength: [1], exposure: [0]}), row("b"));
  const current = structuredClone(base);current.video[0].shader.parameters.strength = [2];
  const desired = structuredClone(base);desired.video[0].shader.parameters.exposure = [1];desired.video[1].enabled = false;
  const merged = rebase(current, base, desired);
  assert.deepEqual(merged.video[0].shader.parameters, {strength: [2], exposure: [1]});
  assert.equal(merged.video[1].enabled, false);
});

test("late parameter edits do not resurrect a node removed in another window", () => {
  const base = graph(row("a", {strength: [1]}), row("b"));
  const desired = structuredClone(base);desired.video[0].shader.parameters.strength = [2];
  assert.deepEqual(rebase(graph(row("b")), base, desired).video.map(node => node.id), ["b"]);
});

test("reorder and removal preserve independent newly added rows and settings", () => {
  const base = graph(row("a"), row("b"), row("c"));
  const current = graph(row("a"), row("x"), row("b", {value: [3]}), row("c"));
  const desired = graph(row("b"), row("a"));
  const result = rebase(current, base, desired);
  assert.deepEqual(result.video.map(node => node.id), ["b", "a", "x"]);
  assert.deepEqual(result.video[0].shader.parameters, {value: [3]});
});

test("global bypass preserves independent edits and the requested chain", () => {
  const base = graph(row("a"));const desired = {...base, enabled: false};
  const current = graph(row("a", {strength: [2]}), row("new"));
  const result = rebase(current, base, desired);
  assert.equal(result.enabled, false);
  assert.equal(result.video.length, 2);
  assert.deepEqual(result.video[0].shader.parameters, {strength: [2]});
  assert.notEqual(revision(result), revision(current));
  assert.deepEqual(current, graph(row("a", {strength: [2]}), row("new")));
});
test("convenience input sizing cannot overwrite a concurrent manual choice", () => {
  const base=graph(row("a")), current={...base,renderResolution:{multiplier:3}};
  const result=rebase(current,base,{...base,renderResolution:{multiplier:2,managedBy:"upscale"}});
  assert.deepEqual(result.renderResolution,{multiplier:3});
  const owned={...base,renderResolution:{multiplier:2,managedBy:"upscale"}};
  assert.deepEqual(rebase(current,owned,base).renderResolution,{multiplier:3});
});

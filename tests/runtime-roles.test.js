const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { loadSources } = require("../src/runtime-sources");
const { projectRuntimeRoles } = require("../src/core/runtime-roles");

test("source labels are unique within a kind, counting each Wine's included components", () => {
  const seen = new Map();
  for (const source of loadSources()) for (const item of [source, ...(source.included || [])]) {
    const key = item.kind + ":" + item.label;
    assert.equal(seen.get(key), undefined, `${item.id} repeats the ${item.kind} label "${item.label}" of ${seen.get(key)}`);
    seen.set(key, item.id);
  }
});

test("the source loader refuses a repeated included label", t => {
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "runtime-sources-labels-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "wine")); fs.mkdirSync(path.join(root, "d3d-translator"));
  fs.writeFileSync(path.join(root, "d3d-translator", "upstream.json"), JSON.stringify({ id: "upstream", kind: "d3d-translator", label: "DXVK" }));
  fs.writeFileSync(path.join(root, "wine", "sample.json"), JSON.stringify({ id: "sample", kind: "wine", label: "Sample",
    included: [{ id: "sample-dxvk", kind: "d3d-translator", label: "DXVK", engine: "dxvk", parts: [{ path: "dxvk" }] }] }));
  assert.throws(() => loadSources(root), /unique within a kind/);
});

test("role options name their source, label builds by source and version, and carry only the option fields", () => {
  const wine = { id: "sample", kind: "wine", label: "Sample", labels: { automatic: "Sample's automatic choice", environment: "Wrapper setting" },
    included: [{ id: "sample-dxvk", kind: "d3d-translator", label: "Sample DXVK", engine: "dxvk", parts: [{ path: "dxvk", name: "dxvk" }] },
      { id: "sample-wined3d", kind: "d3d-translator", label: "Sample WineD3D", engine: "wined3d", parts: [{ path: "lib/wine", name: "builtins" }] }] };
  const sources = [{ id: "upstream-dxvk", kind: "d3d-translator", label: "DXVK" }];
  const install = { kind: "sample", id: "11.0-install", runtime: "sample", label: "Sample 11.0" };
  const inventory = {
    included: [
      { id: "included:d3d-renderer:dxvk", engine: "dxvk", included: true, templateComponent: "dxvk", sourceId: "sample-dxvk", version: "1.10.3", source: install },
      { id: "included:d3d-renderer:wined3d", engine: "wined3d", included: true, version: "11.0", source: install }],
    choices: [
      { id: "managed:2.0-a", engine: "dxvk", sourceId: "upstream-dxvk", version: "2.0.0", source: "managed" },
      { id: "managed:2.0-b", engine: "dxvk", sourceId: "upstream-dxvk", version: "2.0.0", source: "managed", prerelease: true },
      { id: "managed:3.0", engine: "dxvk", sourceId: "upstream-dxvk", version: "3.0.0", source: "managed" }] };
  const options = [{ value: "", label: "Automatic" }, ...[...inventory.included, ...inventory.choices].map(item => ({ value: item.id, label: item.id }))];
  const result = projectRuntimeRoles({ plan: { roles: [{ id: "d3d11" }], inventory }, source: wine, sources,
    optionLists: { translatorD3D11Options: options }, settings: { translatorD3D11: "build:managed:1.0" } });
  assert.deepEqual(result.roleKeys, ["translatorD3D11"]);
  const rows = result.translatorD3D11;
  for (const option of rows) {
    assert.deepEqual(Object.keys(option).filter(key => !["value", "label", "kind", "sourceId", "version", "prerelease", "disabled"].includes(key)), []);
    assert.equal(typeof option.sourceId, "string");
  }
  assert.deepEqual(rows.filter(option => option.kind === "source").map(option => [option.sourceId, option.label]),
    [["sample-dxvk", "Sample DXVK"], ["sample-wined3d", "Sample WineD3D"], ["upstream-dxvk", "DXVK"]]);
  assert.equal(new Set(rows.map(option => option.label)).size, rows.length, "every option label is distinct");
  assert.deepEqual(rows.filter(option => option.kind === "build" && !option.disabled).map(option => [option.value, option.label, option.prerelease === true]), [
    ["build:managed:2.0-a", "DXVK · 2.0-a", false], ["build:managed:2.0-b", "DXVK · 2.0-b", true], ["build:managed:3.0", "DXVK · 3.0.0", false]]);
  assert.deepEqual(rows.at(-1), { value: "build:managed:1.0", label: "managed:1.0", kind: "build", sourceId: "managed:1.0", disabled: true },
    "an unusable saved choice stays named and its value is unchanged");
});

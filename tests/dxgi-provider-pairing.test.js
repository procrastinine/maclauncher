const test = require("node:test"), assert = require("node:assert/strict");

// Deep Rock Galactic -dx12 on CrossOver: Direct3D 12 set to vkd3d-proton, Direct3D 8-11 left automatic. vkd3d-proton
// presents through the DXGI that DXVK 2 and later provide, so the pairing gives Direct3D 9-11 and DXGI to a DXVK.
const X64 = 0x8664;
const pe = (folder, names) => names.map(name => ({ path: `/fixture/${folder}/x64/${name}.dll`, relative: `x64/${name}.dll`, format: "pe", machine: X64, form: "native" }));
const dxvk = (folder, version, source) => ({ component: "d3d-renderer", engine: "dxvk", version, source, form: "native", apis: [],
  files: pe(folder, ["d3d9", "d3d10core", "d3d11", "dxgi"]) });
const installs = {
  macos: ["macos-dxvk-v1.10.3", dxvk("dxvk-macos", "1.10.3", { kind: "upstream", id: "macos", label: "DXVK-macOS" })],
  upstream: ["upstream-dxvk-3.1.1", dxvk("dxvk-upstream", "3.1.1", { kind: "upstream", id: "upstream", label: "DXVK" })],
  maclauncher: ["3.1.1-MCLv1", dxvk("maclauncher-dxvk", "3.1.1", { kind: "builds", label: "MacLauncher Builds" })]
};
function manager(id, engine, sourceIds, rows) {
  const declarations = require("../src/runtime-sources").loadSources();
  return { id, translatorEngine: engine, sources: sourceIds.map(source => declarations.find(item => item.id === source)),
    getState: () => ({ installed: rows.map(([version]) => ({ version })) }),
    resolveSelection: (_entry, _settings, _userDataDir, { version }) => ({ install: { version, installDir: "/fixture", translator: rows.find(row => row[0] === version)[1] } }) };
}
// The plan for the given installed DXVK versions, in the order they were installed.
function dx12Plan(installed) {
  const Wine = require("../src/modules/shared/runtime/wine-translators");
  const proton = ["3.1-MCLv2", { component: "d3d12", engine: "vkd3d-proton", version: "3.1", source: { kind: "builds", label: "MacLauncher Builds" }, form: "native", apis: [],
    files: pe("vkd3d-proton", ["d3d12", "d3d12core"]) }];
  const managers = [
    manager("translator-dxvk", "dxvk", ["dxvk-upstream", "dxvk-macos"], installed.filter(name => name !== "maclauncher").map(name => installs[name])),
    ...(installed.includes("maclauncher") ? [manager("dxvk", "dxvk", ["maclauncher-dxvk"], [installs.maclauncher])] : []),
    manager("vkd3d-proton", "vkd3d-proton", ["maclauncher-ngx"], [proton])];
  const choices = Wine.managedTranslators({ userDataDir: "/state", settings: {} }, "crossover", managers, "x86_64", () => null);
  const input = { runtime: "crossover", choices, included: [], environment: null, selections: {}, layout: { architecture: "x86_64" } };
  const plan = Wine.optionsPlan(input, { runtimeSettings: { translatorD3D12: "vkd3d-proton:3.1-MCLv2" } });
  return { plan, dxgi: plan.dxgiBinding?.description?.id || null, d3d11: plan.components.d3d11.used?.id || null, choices };
}

test("vkd3d-proton declares that it presents through the DXGI of DXVK 2 and later", () => {
  const declarations = require("../src/runtime-sources").loadSources();
  for (const id of ["vkd3d-proton-upstream", "maclauncher-ngx"])
    assert.deepEqual(declarations.find(item => item.id === id).dxgi, { engine: "dxvk", from: "2" }, id);
  const { choices } = dx12Plan(["macos", "upstream"]);
  assert.deepEqual(choices.find(item => item.engine === "vkd3d-proton").dxgiRequires, { engine: "dxvk", from: "2" });
});

test("with DXVK-macOS 1.10.3 installed beside DXVK 3.1.1, automatic DXGI for vkd3d-proton stays on DXVK 3.1.1", () => {
  // 0526: DXVK-macOS 1.10.3 was installed for another game, first in install order, and became the DXGI.
  let result = dx12Plan(["macos", "upstream"]);
  assert.equal(result.dxgi, "translator-dxvk:upstream-dxvk-3.1.1");
  assert.equal(result.d3d11, "translator-dxvk:upstream-dxvk-3.1.1");
  // Install order never decides; a further DXVK 3.1.1 from a later source does not change it either.
  for (const installed of [["upstream", "macos"], ["macos", "maclauncher", "upstream"], ["maclauncher", "macos", "upstream"]]) {
    result = dx12Plan(installed);
    assert.equal(result.dxgi, "translator-dxvk:upstream-dxvk-3.1.1", installed.join(", "));
  }
  // With only DXVK-macOS 1.10.3, no installed DXVK can be vkd3d-proton's DXGI; Play offers DXVK.
  result = dx12Plan(["macos"]);
  assert.equal(result.dxgi, null);
  assert.deepEqual(result.plan.requiredTranslators, ["dxvk"]);
  // MacLauncher DXVK 3.1.1 alone serves.
  assert.equal(dx12Plan(["macos", "maclauncher"]).dxgi, "dxvk:3.1.1-MCLv1");
});

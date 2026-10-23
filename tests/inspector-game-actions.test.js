const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const modulesRoot = path.join(__dirname, "../src/modules");
const manifests = fs.readdirSync(modulesRoot).flatMap(id => {
  const file = path.join(modulesRoot, id, "manifest.json");
  return fs.existsSync(file) ? [JSON.parse(fs.readFileSync(file, "utf8"))] : [];
});

test("game inspectors contain game operations without runtime or tool management", () => {
  const management = /^(?:runtimeStatus|registerRuntime|buildRuntime|registerDecompiler|downloadDetectedRuntime|installDecompiler|decompilerStatus|registerOfficialRuntime|installOfficialRuntime|officialRuntimeStatus|downloadOfficialPackages|revealOfficialPackages|buildOpenGLHelper|openGLHelperStatus)$/;
  for (const manifest of manifests) {
    for (const action of manifest.ui?.actions || []) assert.doesNotMatch(action.id, management, `${manifest.id}: ${action.label}`);
    const actions = new Set((manifest.ui?.actions || []).map(action => action.id));
    for (const group of manifest.ui?.actionGroups || []) {
      assert.ok(group.actions.length || group.infoFields?.length, `${manifest.id}: empty ${group.id} group`);
      for (const action of group.actions) assert.ok(actions.has(action), `${manifest.id}: missing ${action}`);
    }
    for (const runtime of Object.values(manifest.runtime?.entries || {})) {
      for (const field of runtime.settings?.fields || []) assert.ok(!["runtimePath", "sourcePath", "sdlSourcePath"].includes(field.key), `${manifest.id}: management-only setting ${field.key}`);
    }
  }
});

test("game-specific inspection, decompilation, patches and exports remain available", () => {
  const expected = { gamemaker: ["inspect", "exportChunks", "decompile", "revealExport"],
    alicesoft: ["decompile", "revealSourceExport", "openLiveVariables"], kirikiri: ["exportScripts", "revealScripts"],
    unity: ["decompile", "openAssetInspector", "exportAssets"], flash: ["decompile", "exportAssets"],
    renpy: ["extractGame", "buildApp", "patchLive2D"], hashlink: ["inspectBytecode"],
    nitroplus: ["extractScripts", "checkScripts"], gemrb: ["openInspector", "inspectGame", "prepareConfig"],
    rgss: ["exportScripts", "repackScripts", "stageAssets"], mv: ["installClipboardPlugin", "reconstructProject"] };
  for (const [id, expectedActions] of Object.entries(expected)) {
    const manifest = manifests.find(item => item.id === id), ids = new Set(manifest.ui.actions.map(action => action.id));
    for (const action of expectedActions) assert.ok(ids.has(action), `${id}: missing game operation ${action}`);
  }
});

test("managed native imports live in Runtimes while fixed built-ins have no management tabs", () => {
  for (const file of ["gamemaker/runtime/butterscotch", "gamemaker/runtime/undertale-mod-tool", "hashlink/runtime/manager"]) {
    const exported = require(path.join(modulesRoot, file)), manager = exported.manager || exported;
    assert.equal(typeof manager.importRuntime, "function", manager.id);
    assert.equal(manager.getState({}).catalog.importVersionRequired, true, manager.id);
  }
  for (const id of ["ai5", "alicesoft", "kirikiri", "gemrb", "minori", "nitroplus"]) {
    const manifest = manifests.find(item => item.id === id);
    for (const descriptor of Object.values(manifest.runtime.managerUi)) assert.equal(descriptor.management, "built-in", id);
  }
});

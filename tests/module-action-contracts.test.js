const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const registry = require("../src/modules/registry");
const { createBackendOperations } = require("../src/core/backend-operations");

function assertHandler(mod, original, kind, action, runtimeId, declaration) {
  assert.equal(typeof mod[kind]?.[action], "function", `${mod.id}: ${declaration} has no ${kind}.${action}`);
  // A composed dispatcher can exist even when the selected runtime has no target.
  const target = mod.getRuntimeProvider?.(runtimeId)?.[kind]?.[action] || original[kind]?.[action];
  assert.equal(typeof target, "function", `${mod.id}/${runtimeId}: ${declaration} has no target for ${kind}.${action}`);
}

test("every registered module settings and inspector action has a handler for its runtime", () => {
  const hostManagers = { "google-play": require("../src/modules/android/store/google-account-manager").createGoogleAccountManager() };
  for (const id of registry.listModuleIds()) {
    const mod = registry.getModule(id), original = require(path.join(registry.getModuleDir(id), "main.js"));
    const manifest = mod.manifest;
    for (const [runtimeId, runtime] of Object.entries(manifest.runtime?.entries || {})) {
      const schema = runtime.settings;
      for (const field of schema?.fields || []) {
        for (const [key, action] of Object.entries(field).filter(([key]) => key.endsWith("Action"))) {
          assertHandler(mod, original, "actions", action, runtimeId, `${field.key}.${key}`);
          if (!field.gameOnly) assertHandler(mod, original, "settingsActions", action, runtimeId, `${field.key}.${key}`);
        }
      }
      for (const key of ["readAction", "writeAction"]) if (schema?.provider?.[key]) {
        assertHandler(mod, original, "actions", schema.provider[key], runtimeId, `settings.provider.${key}`);
        if (!schema.provider.gameOnly) assertHandler(mod, original, "settingsActions", schema.provider[key], runtimeId, `settings.provider.${key}`);
      }
    }
    for (const action of manifest.ui?.actions || []) {
      assertHandler(mod, original, "actions", action.id, manifest.runtime?.default, `ui.actions.${action.id}`);
    }
    for (const group of manifest.ui?.actionGroups || []) for (const action of group.actions || []) {
      assertHandler(mod, original, "actions", action, manifest.runtime?.default, `ui.actionGroups.${group.id}`);
    }
    for (const selector of manifest.ui?.entrySelectors || []) for (const key of ["optionsAction", "setAction"]) {
      if (selector[key]) assertHandler(mod, original, "actions", selector[key], manifest.runtime?.default, `ui.entrySelectors.${selector.id}.${key}`);
    }
    if (manifest.ui?.cheatsStatusAction) assertHandler(mod, original, "actions", manifest.ui.cheatsStatusAction, manifest.runtime?.default, "ui.cheatsStatusAction");
    for (const patch of manifest.ui?.cheatsPatches || []) for (const key of ["addAction", "removeAction"]) {
      if (patch[key]) assertHandler(mod, original, "actions", patch[key], manifest.runtime?.default, `ui.cheatsPatches.${patch.id}.${key}`);
    }
    for (const descriptor of [manifest.ui?.accounts, ...(manifest.ui?.accountProviders || [])].filter(Boolean)) {
      for (const key of ["stateAction", "signInAction", "removeAction"]) {
        const action = descriptor[key];
        const host = mod.settingsHostAccountActions?.[action];
        const handler = host ? hostManagers[host.manager]?.[host.action] : mod.settingsActions?.[action];
        assert.equal(typeof handler, "function", `${id}: accounts.${key} has no handler for ${action}`);
      }
    }
  }
});

test("PS5 Vulkan choices resolve through Settings and inspector backend dispatch offline", async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "module-action-contracts-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const operations = createBackendOperations({ userDataDir, registry });
  t.after(() => operations.beginShutdown());
  const entry = { moduleId: "anyps5", gameId: "ps5-actions", gamePath: path.join(userDataDir, "game"), runtimeId: "anyps5", moduleData: { format: "elf" } };
  for (const runtimeId of ["anyps5", "prosper"]) {
    for (const moduleId of new Set(["anyps5", runtimeId])) {
      const choices = await operations.moduleSettingsAction(moduleId, "listVulkanRuntimes", { runtimeId });
      assert.deepEqual(choices, { vulkanRuntimes: [{ value: "auto", label: "Automatic" }] });
    }
    assert.deepEqual(await operations.moduleAction(entry, "listVulkanRuntimes", {}, { runtimeId }),
      { vulkanRuntimes: [{ value: "auto", label: "Automatic" }] });
  }
});

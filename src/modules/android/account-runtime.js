const Manager = require("./runtime-manager");
const Runtime = require("./runtime");
const { confirmToolInstall } = require("../shared/runtime/tool-install");
const { withRuntimeMutation } = require("../../core/coordinated-runtime-managers");

// Account actions use the same selected immutable runtime as Android games.
// Status/enumeration never authorizes a download or refreshes the catalog.
async function resolveForAccounts(context, { install = false } = {}, dependencies = {}) {
  const manager = dependencies.manager || Manager;
  let selected = manager.resolveSelection(null, context.settings, context.userDataDir);
  if (!selected.ready && install) {
    await (dependencies.confirmToolInstall || confirmToolInstall)(context, {
      manager, version: selected.version, requiresDownload: true,
      detail: "Required to use the Android Google account manager. Account data remains in the existing profile."
    });
    if (!selected.version) {
      await manager.refreshCatalog({ userDataDir: context.userDataDir, logger: context.logger, signal: context.signal });
      selected = manager.resolveSelection(null, context.settings, context.userDataDir);
    }
    if (!selected.version) throw new Error(selected.reason);
    const mutate = dependencies.withRuntimeMutation || withRuntimeMutation;
    await mutate({ managerId: manager.id, version: selected.version }, async () => {
      const current = manager.resolveSelection(null, context.settings, context.userDataDir);
      if (!current.ready) await manager.installRuntime({ ...context, version: selected.version });
    }, { userDataDir: context.userDataDir });
    context.onRuntimeStateChange?.();
    selected = manager.resolveSelection(null, context.settings, context.userDataDir);
  }
  if (!selected.ready) throw new Error(selected.reason || "The Android account runtime is unavailable.");
  const payload = await (dependencies.resolveForLaunch || Runtime.resolveForLaunch)({ root: selected.install.root, signal: context.signal }, selected.install.declaration);
  if (install) await (dependencies.prepareRuntimeImage || require("./runtime-image").prepare)({ payload, context });
  return payload;
}

module.exports = { resolveForAccounts };

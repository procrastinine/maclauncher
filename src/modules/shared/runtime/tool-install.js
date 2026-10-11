const { createAbortError, throwIfAborted } = require("./download-utils");

// Explicit tool actions use the same injected download consent as Play. Callers
// without a UI adapter authorize required downloads by invoking the action.
async function confirmToolInstall(context, { manager, managerId = manager?.id, version,
  installOptions = {}, label = manager?.label || managerId, requiresDownload, detail } = {}) {
  throwIfAborted(context.signal);
  if (requiresDownload === undefined) {
    const state = manager?.getState?.({ userDataDir: context.userDataDir,
      settings: context.settings?.runtimes?.[managerId] });
    const section = state && ((state.sections || [state]).find(item => item.id === installOptions.sectionId) || state);
    requiresDownload = section?.catalog?.versionRequirements?.[version]?.requiresDownload ?? true;
  }
  if (requiresDownload && typeof context.confirmRuntimeInstall === "function") {
    const consent = await context.confirmRuntimeInstall({ managerId, version, installOptions, label,
      requiresDownload: true, kind: "tool", confirmLabel: "Download and Continue",
      detail: detail || "Required for this game action." });
    if (consent !== true && consent?.approved !== true) throw createAbortError("Tool installation canceled.");
  }
  throwIfAborted(context.signal);
}

module.exports = { confirmToolInstall };

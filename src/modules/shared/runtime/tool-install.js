const { createAbortError, throwIfAborted } = require("./download-utils");

// A download needs a consent result. Play, live edits and game actions pass the
// UI adapter; explicit Install and setup actions pass their own approval. A
// context without an adapter is declined.
async function downloadApproved(context, plan) {
  if (typeof context?.confirmRuntimeInstall !== "function") return false;
  const consent = await context.confirmRuntimeInstall(plan);
  return consent === true || consent?.approved === true;
}
const approveDownloads = async () => true;

async function confirmToolInstall(context, { manager, managerId = manager?.id, version,
  installOptions = {}, label = manager?.label || managerId, requiresDownload, detail } = {}) {
  throwIfAborted(context.signal);
  if (requiresDownload === undefined) {
    const state = manager?.getState?.({ userDataDir: context.userDataDir,
      settings: context.settings?.runtimes?.[managerId], runtimeSettings: context.settings?.runtimes });
    const section = state && ((state.sections || [state]).find(item => item.id === installOptions.sectionId) || state);
    requiresDownload = section?.catalog?.versionRequirements?.[version]?.requiresDownload ?? true;
  }
  if (requiresDownload && !await downloadApproved(context, { managerId, version, installOptions, label,
    requiresDownload: true, kind: "tool", confirmLabel: "Download and Continue",
    detail: detail || "Required for this game action." })) throw createAbortError("Tool installation canceled.");
  throwIfAborted(context.signal);
}

module.exports = { confirmToolInstall, downloadApproved, approveDownloads };

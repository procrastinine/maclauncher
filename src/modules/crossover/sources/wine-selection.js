// Version selection shared by the downloaded Wine sources: the shared
// manager's choice, then the installed payload's own check before the version
// counts as ready.
function createSelection({ base, resolvePayload, planned }) {
  return function resolveSelection(entry, settings, userDataDir, options = {}) {
    const selection = base.resolveSelection(entry, settings, userDataDir, options);
    if (!selection.install) return planned(selection);
    const resolved = resolvePayload(selection.install, options);
    return planned({ ...selection, install: resolved.install, ready: Boolean(resolved.install),
      requiresDownload: !resolved.install, repairRequired: !resolved.install && !resolved.minimumMacOS, reason: resolved.reason });
  };
}
module.exports = { createSelection };

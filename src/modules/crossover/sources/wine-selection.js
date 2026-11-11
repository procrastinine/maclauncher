// Version selection shared by the downloaded Wine sources. The installed
// payload is checked before a version counts as ready. A version saved as the
// Runtimes default is a preference: when it is not installed and another
// usable version is, Play uses the installed one and asks for no download.
// Only a version chosen for the game itself is exact.
function createSelection({ id, base, resolvePayload, planned }) {
  function resolve(entry, settings, userDataDir, options) {
    const selection = base.resolveSelection(entry, settings, userDataDir, options);
    if (!selection.install) return planned(selection);
    const resolved = resolvePayload(selection.install, options);
    return planned({ ...selection, install: resolved.install, ready: Boolean(resolved.install),
      requiresDownload: !resolved.install, repairRequired: !resolved.install && !resolved.minimumMacOS, reason: resolved.reason });
  }
  return function resolveSelection(entry, settings, userDataDir, options = {}) {
    const selection = resolve(entry, settings, userDataDir, options), saved = settings?.runtimes?.[id];
    if (selection.ready || selection.selectionSource !== "default" || !saved?.defaultVersion || saved.defaultVersion === "auto") return selection;
    const { defaultVersion: _preferred, ...rest } = saved;
    const installed = resolve(entry, { ...settings, runtimes: { ...settings.runtimes, [id]: rest } }, userDataDir, options);
    return installed.ready ? { ...installed, preferredVersion: selection.version } : selection;
  };
}
module.exports = { createSelection };

// Backcompat: MacLauncher 0.6.1 and earlier stored a game's module default
// icon as an absolute path into the running app's own modules
// (…/src/modules/<module>/resources/icon.png), so each run from another
// place (a worktree, a moved or updated app) rewrote the record. Records now
// store the module default as a reference. A stored path of that shape is
// read as the reference and never written back. Remove when profiles from
// those versions are no longer supported.

const FORMER_MODULE_ICON = /[\\/]src[\\/]modules[\\/]([0-9A-Za-z_-]+)[\\/]resources[\\/]icon\.png$/;

// The module whose default icon a stored path names, from any app location.
function formerModuleIcon(iconPath) {
  return typeof iconPath === "string" ? FORMER_MODULE_ICON.exec(iconPath)?.[1] || null : null;
}

module.exports = { formerModuleIcon };

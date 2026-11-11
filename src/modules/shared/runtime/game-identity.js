// Optional child-process identity. Preserve the caller's prepared environment.
function environment(entry, base = process.env) {
  return { ...base, MACLAUNCHER_GAME_NAME: entry?.name || "", MACLAUNCHER_GAME_ICON: entry?.iconPath || "" };
}
module.exports = { environment };

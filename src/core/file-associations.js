// Detection accepts common sidecars as well as primary game files. Register all
// of those as Open With choices, while giving game-specific formats priority.
const COMMON_FORMATS = new Set([
  "arc", "cfg", "dat", "def", "dll", "htm", "html", "ini", "json", "key",
  "py", "scr", "sh", "tjs", "txt", "utf", "zip"
]);

function gameFileAssociations(extensions) {
  const available = [...new Set(extensions)].filter(extension =>
    typeof extension === "string" && /^[a-z0-9_]+$/.test(extension) && extension !== "app").sort();
  return [
    { name: "Game", ext: available.filter(extension => !COMMON_FORMATS.has(extension)), rank: "Owner", role: "Viewer" },
    { name: "Game files", ext: available.filter(extension => COMMON_FORMATS.has(extension)), rank: "Alternate", role: "Viewer" }
  ].filter(association => association.ext.length);
}

function gameDocumentTypes(extensions, icon = "icon.icns") {
  return gameFileAssociations(extensions).map(association => ({
    CFBundleTypeName: association.name,
    CFBundleTypeExtensions: association.ext,
    CFBundleTypeRole: association.role,
    CFBundleTypeIconFile: icon,
    LSHandlerRank: association.rank
  }));
}

module.exports = { gameFileAssociations, gameDocumentTypes };

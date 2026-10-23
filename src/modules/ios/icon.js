const fs = require("node:fs"), path = require("node:path");
const Archive = require("./archive"), { plist } = require("./inspect");
const Images = require("../../core/icon-utils"), GameData = require("../shared/game-data"), Writable = require("../shared/writable-input");
function declaredNames(info) {
  const values = [info.CFBundleIconFile, ...(Array.isArray(info.CFBundleIconFiles) ? info.CFBundleIconFiles : []),
    ...[info.CFBundleIcons, info["CFBundleIcons~ipad"]].flatMap(group => Array.isArray(group?.CFBundlePrimaryIcon?.CFBundleIconFiles) ? group.CFBundlePrimaryIcon.CFBundleIconFiles : [])];
  return [...new Set(values.filter(value => typeof value === "string" && value.length <= 1024 && !/[\\\0:]/.test(value) &&
    value.split("/").every(part => part && part !== "." && part !== "..")))].slice(0, 32);
}
function resolveGameIcon(entry, context = {}) {
  context.signal?.throwIfAborted();
  if (!context.userDataDir || !entry.gameId || typeof entry.gamePath !== "string" || !/\.ipa$/i.test(entry.gamePath)) return null;
  const archive = Archive.open(entry.gamePath);
  try {
    const apps = archive.entries.filter(item => /^Payload\/[^/]+\.app\/Info\.plist$/.test(item.name));
    if (apps.length !== 1) return null;
    const prefix = apps[0].name.slice(0, -"Info.plist".length), info = plist(archive.read(apps[0].name)), declared = declaredNames(info);
    const candidates = archive.entries.flatMap(item => {
      if (!item.name.startsWith(prefix) || !/\.png$/i.test(item.name)) return [];
      const resource = item.name.slice(prefix.length), base = resource.replace(/(?:@\dx)?(?:~(?:ipad|iphone))?\.png$/i, "");
      const specified = declared.some(value => value === resource || value.replace(/\.png$/i, "") === base);
      return specified || !resource.includes("/") && /^(?:AppIcon|Icon)(?:\d|@|~|\.|$)/i.test(resource) ? [{ ...item, specified }] : [];
    }).sort((a, b) => Number(b.specified) - Number(a.specified) || b.uncompressedSize - a.uncompressedSize).slice(0, 16);
    let best = null, area = 0, total = 0, specified = false;
    for (const item of candidates) {
      context.signal?.throwIfAborted();
      if (item.uncompressedSize > 8 * 1024 ** 2 || (total += item.uncompressedSize) > 32 * 1024 ** 2) continue;
      let bytes; try { bytes = archive.read(item.name, 8 * 1024 ** 2); } catch { continue; }
      if (bytes.toString("ascii", 1, 4) !== "PNG" || !Images.isSupportedImageBuffer(bytes)) continue;
      const pixels = bytes.readUInt32BE(16) * bytes.readUInt32BE(20);
      if (!best || (item.specified || !specified) && pixels > area) { best = bytes; area = pixels; specified = item.specified; }
    }
    if (!best) return null;
    const output = path.join(GameData.resolveGameIconsDir(context.userDataDir, entry.gameId), "ios-icon.png");
    let matches = false;
    Writable.assertOwnDirectory(context.userDataDir, path.dirname(output));
    try { const stat = fs.lstatSync(output); matches = stat.isFile() && stat.size === best.length && fs.readFileSync(output).equals(best); } catch {}
    if (!matches) Writable.atomicWrite(output, best, { root: context.userDataDir });
    return output;
  } finally { archive.close(); }
}
module.exports = { resolveGameIcon };

const fs = require("node:fs"), path = require("node:path");
const Images = require("../../core/icon-utils");
const GameData = require("../shared/game-data");
const Writable = require("../shared/writable-input");
function resolveGameIcon(entry, context = {}) {
  context.signal?.throwIfAborted();
  const candidate = entry.iconPath;
  if (typeof candidate !== "string" || !/\.ico$/i.test(candidate) || !context.userDataDir || !entry.gameId) return null;
  try {
    const root = fs.realpathSync(entry.contentRootDir || entry.gamePath), source = fs.realpathSync(candidate), relative = path.relative(root, source), stat = fs.statSync(source);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || !stat.isFile() || stat.size > 8 * 1024 ** 2) return null;
    const png = Images.extractIcoPngBuffer(fs.readFileSync(source));
    if (!png) return null;
    const output = path.join(GameData.resolveGameIconsDir(context.userDataDir, entry.gameId), "siglus-icon.png");
    let matches = false;
    Writable.assertOwnDirectory(context.userDataDir, path.dirname(output));
    try { const stat = fs.lstatSync(output); matches = stat.isFile() && stat.size === png.length && fs.readFileSync(output).equals(png); } catch {}
    if (!matches) Writable.atomicWrite(output, png, { root: context.userDataDir });
    return output;
  } catch (error) { context.signal?.throwIfAborted(); return null; }
}
module.exports = { resolveGameIcon };

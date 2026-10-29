const fs = require("node:fs"), path = require("node:path");
const Archive = require("./archive"), { plist } = require("./inspect");
const Images = require("../../core/icon-utils"), GameData = require("../shared/game-data"), Writable = require("../shared/writable-input");
const zlib = require("node:zlib");
function normalizePng(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return null;
  if (bytes.toString("ascii", 12, 16) !== "CgBI") return Images.isSupportedImageBuffer(bytes) ? bytes : null;
  let header, ended = false;
  const compressed = [];
  for (let at = 8; at + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(at), end = at + size + 12;
    if (end > bytes.length || Images.crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return null;
    const kind = bytes.toString("ascii", at + 4, at + 8), data = bytes.subarray(at + 8, end - 4);
    if (kind === "IHDR") { if (header || size !== 13) return null; header = data; }
    if (kind === "IDAT") compressed.push(data);
    if (kind === "IEND") { ended = size === 0 && end === bytes.length; break; }
    at = end;
  }
  if (!header || !ended || !compressed.length) return null;
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4), channels = { 2: 3, 6: 4 }[header[9]];
  // Apple's optimized icons store non-interlaced 8-bit BGR(A) scanlines.
  if (!width || !height || width > 2048 || height > 2048 || header[8] !== 8 || !channels || header[10] || header[11] || header[12]) return null;
  const stride = width * channels, length = (stride + 1) * height;
  let rows;
  try { rows = zlib.inflateRawSync(Buffer.concat(compressed), { maxOutputLength: length }); } catch { return null; }
  if (rows.length !== length) return null;
  const pixels = Buffer.alloc(stride * height), rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = rows[y * (stride + 1)];
    if (filter > 4) return null;
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, left = x >= channels ? pixels[at - channels] : 0;
      const up = y ? pixels[at - stride] : 0, corner = y && x >= channels ? pixels[at - stride - channels] : 0;
      const p = left + up - corner, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
      const predictor = [0, left, up, Math.floor((left + up) / 2), a <= b && a <= c ? left : b <= c ? up : corner][filter];
      pixels[at] = (rows[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  for (let src = 0, dst = 0; src < pixels.length; src += channels, dst += 4) {
    const alpha = channels === 4 ? pixels[src + 3] : 255;
    for (let c = 0; c < 3; c++) rgba[dst + c] = alpha ? Math.min(255, Math.round(pixels[src + 2 - c] * 255 / alpha)) : 0;
    rgba[dst + 3] = alpha;
  }
  return Images.encodePngBitmap({ width, height, buffer: rgba }, { maximumDimension: 2048 });
}
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
      bytes = normalizePng(bytes);
      if (!bytes) continue;
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
module.exports = { resolveGameIcon, normalizePng };

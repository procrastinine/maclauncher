const fs = require("node:fs");
const path = require("node:path");
const Icons = require("../../../core/icon-utils");
const GameData = require("../game-data");
const Writable = require("../writable-input");

const inside = (root, candidate) => { const relative = path.relative(root, candidate); return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); };
function boundedFile(root, candidate, maximum) {
  try {
    if (!inside(root, candidate) || !inside(fs.realpathSync(root), fs.realpathSync(candidate))) return null;
    const stat = fs.statSync(candidate);
    return stat.isFile() && stat.size <= maximum ? fs.readFileSync(candidate) : null;
  } catch { return null; }
}
function entities(value) {
  return String(value || "").replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (all, entity) => {
    if (entity[0] !== "#") return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " }[entity.toLowerCase()];
    const point = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : all;
  });
}
function title(value) {
  if (typeof value !== "string") return null;
  const text = entities(value).replace(/\s+/g, " ").trim();
  return text && text.length <= 512 && !/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(text) ? text : null;
}
function localResource(root, base, href) {
  if (typeof href !== "string") return null;
  let name = entities(href).trim();
  if (!name || /[\0\\]/.test(name) || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(name)) return null;
  try { name = decodeURIComponent(name.split(/[?#]/, 1)[0]); } catch { return null; }
  if (!name || /[\0\\]/.test(name)) return null;
  const target = name.startsWith("/") ? path.resolve(root, "." + name) : path.resolve(base, name);
  return inside(root, target) ? target : null;
}
function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
  return result;
}
function read(entry) {
  const requestedRoot = entry?.contentRootDir || entry?.indexDir || entry?.gamePath;
  if (typeof requestedRoot !== "string" || !path.isAbsolute(requestedRoot)) return null;
  let root; try { root = fs.statSync(requestedRoot).isDirectory() ? path.resolve(requestedRoot) : null; } catch {}
  if (!root) return null;
  const index = typeof entry.indexHtml === "string" ? entry.indexHtml : path.join(root, "index.html"), base = path.dirname(index);
  const icons = []; let packageTitle = null, htmlTitle = null;
  for (const directory of [...new Set([root, base])]) {
    const raw = boundedFile(root, path.join(directory, "package.json"), 256 * 1024);
    if (!raw) continue;
    try {
      const pkg = JSON.parse(raw.toString("utf8"));
      packageTitle ||= title(pkg.window?.title) || title(pkg.productName);
      const icon = localResource(root, directory, pkg.window?.icon);
      if (icon) icons.push(icon);
    } catch {}
  }
  const html = boundedFile(root, index, 1024 * 1024)?.toString("utf8").replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  if (html) {
    htmlTitle = title(html.match(/<title\b[^>]*>([^<]*)<\/title\s*>/i)?.[1]);
    const baseHref = attributes(html.match(/<base\b[^>]*>/i)?.[0] || "").href;
    const documentBase = baseHref ? localResource(root, base, baseHref) : base;
    if (documentBase) for (const tag of [...html.matchAll(/<link\b[^>]*>/gi)].slice(0, 128)) {
      const attr = attributes(tag[0]);
      if (!/(?:^|\s)(?:icon|apple-touch-icon)(?:\s|$)/i.test(attr.rel || "")) continue;
      const icon = localResource(root, documentBase, attr.href);
      if (icon) icons.push(icon);
    }
  }
  return { root, name: packageTitle || htmlTitle, icons: [...new Set(icons)] };
}
function resolveGameMetadata(entry) {
  const metadata = read(entry);
  return metadata ? { ...(metadata.name ? { name: metadata.name } : {}), moduleData: { webMetadataName: metadata.name } } : null;
}
function resolveGameIcon(entry, context = {}) {
  const metadata = read(entry);
  if (!metadata) return null;
  let remaining = 32 * 1024 ** 2;
  for (const candidate of metadata.icons.slice(0, 16)) {
    context.signal?.throwIfAborted();
    if (!remaining) break;
    const bytes = boundedFile(metadata.root, candidate, Math.min(8 * 1024 ** 2, remaining));
    if (!bytes) continue;
    remaining -= bytes.length;
    if (Icons.isSupportedImageBuffer(bytes)) return candidate;
    const png = Icons.extractIcoPngBuffer(bytes);
    if (!png || !context.userDataDir || !entry.gameId) continue;
    const output = path.join(GameData.resolveGameIconsDir(context.userDataDir, entry.gameId), "web-icon.png");
    Writable.assertOwnDirectory(context.userDataDir, path.dirname(output));
    let matches = false;
    try { const stat = fs.lstatSync(output); matches = stat.isFile() && stat.size === png.length && fs.readFileSync(output).equals(png); } catch {}
    if (!matches) Writable.atomicWrite(output, png, { root: context.userDataDir });
    return output;
  }
  return null;
}
function mergeEntry(previous, incoming) {
  if (!previous?.name) return incoming;
  const automatic = [previous.moduleData?.webMetadataName, incoming.moduleData?.webMetadataName,
    ...[previous.gamePath, previous.importPath].filter(Boolean).flatMap(file => [path.basename(file), path.basename(file, path.extname(file))])];
  return automatic.includes(previous.name) ? incoming : { ...incoming, name: previous.name };
}
module.exports = { metadataSources: ["../shared/web/metadata.js"], resolveGameMetadata, resolveGameIcon, mergeEntry };

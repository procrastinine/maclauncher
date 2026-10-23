const fs = require("node:fs"), path = require("node:path");
const Zip = require("../shared/runtime/zip");
const Images = require("../../core/icon-utils");
const GameData = require("../shared/game-data");
const Writable = require("../shared/writable-input");
const { selectRoot } = require("./archive");
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); };
const memberName = name => String(name || "").replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
function literal(text, field) {
  const values = [], pattern = new RegExp(`^\\s*t\\.(?:window\\.)?${field}\\s*=\\s*(["'])((?:\\\\.|[^\\\\])*?)\\1\\s*(?:--.*)?$`, "gm");
  for (const match of text.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, "").matchAll(pattern)) {
    for (let at = 0; at < match[2].length; at++) {
      if (match[2][at] === "\\") at++;
      else if (match[2][at] === match[1]) return null;
    }
    const value = match[2].replace(/\\([\\"'nrt])/g, (_all, char) => ({ n: "\n", r: "\r", t: "\t" }[char] || char));
    if (value.length > (field === "title" ? 512 : 4096) || /[\0\r\n]/.test(value) || /\\/.test(value)) return null;
    values.push(value);
  }
  return values.length && new Set(values).size === 1 ? values[0] : null;
}
function read(entry) {
  try {
    const target = entry.moduleData?.launchTargetPath || entry.moduleData?.embeddedLovePath || entry.moduleData?.packagedPath || entry.gamePath;
    if (typeof target !== "string" || !path.isAbsolute(target)) return null;
    if (fs.statSync(target).isDirectory()) {
      const root = fs.realpathSync(target), file = path.join(target, "conf.lua"), stat = fs.statSync(file);
      if (!inside(root, fs.realpathSync(file)) || !stat.isFile() || stat.size > 512 * 1024) return null;
      const text = fs.readFileSync(file, "utf8");
      return { root, text, load: name => {
        const file = path.resolve(root, name);
        if (!inside(root, file) || !inside(root, fs.realpathSync(file))) return null;
        const stat = fs.statSync(file);
        return stat.isFile() && stat.size <= 8 * 1024 ** 2 ? { bytes: fs.readFileSync(file), path: file } : null;
      } };
    }
    const fd = fs.openSync(target, "r"); let info;
    try { info = Zip.findZipEocd(fd); } finally { fs.closeSync(fd); }
    if (!info || info.cdSize > 8 * 1024 ** 2 || info.entries > 65534) return null;
    const archive = Zip.readZipEntries(target), entries = archive?.entries || [];
    const selected = selectRoot(entries);
    if (!selected.mainEntry || selected.ambiguous) return null;
    const prefix = selected.root;
    if (prefix && (path.posix.isAbsolute(prefix) || prefix.split("/").some(part => !part || part === "." || part === ".." || /[\0:]/.test(part)))) return null;
    const confName = prefix ? prefix + "/conf.lua" : "conf.lua";
    const conf = entries.find(item => memberName(item.name) === confName);
    if (!conf || conf.compressedSize > 1024 * 1024) return null;
    const text = Zip.readZipEntry(target, conf, { maxOutputBytes: 512 * 1024 })?.toString("utf8");
    return text ? { text, load: name => {
      const wanted = prefix ? prefix + "/" + name : name, matches = entries.filter(item => memberName(item.name) === wanted);
      if (matches.length !== 1 || matches[0].compressedSize > 16 * 1024 ** 2) return null;
      return { bytes: Zip.readZipEntry(target, matches[0], { maxOutputBytes: 8 * 1024 ** 2 }) };
    } } : null;
  } catch { return null; }
}
function resolveGameMetadata(entry) {
  const source = read(entry), name = source && literal(source.text, "title");
  return { ...(name ? { name } : {}), moduleData: { loveMetadataName: name || null } };
}
function resolveGameIcon(entry, context = {}) {
  context.signal?.throwIfAborted();
  const source = read(entry), name = source && literal(source.text, "icon");
  if (!name || path.isAbsolute(name) || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..") || !/\.(?:png|webp)$/i.test(name)) return null;
  let icon; try { icon = source.load(name); } catch { return null; }
  if (!icon || !Images.isSupportedImageBuffer(icon.bytes)) return null;
  if (icon.path) return icon.path;
  if (!context.userDataDir || !entry.gameId) return null;
  const output = path.join(GameData.resolveGameIconsDir(context.userDataDir, entry.gameId), `love-icon${path.extname(name).toLowerCase()}`);
  Writable.assertOwnDirectory(context.userDataDir, path.dirname(output));
  let matches = false;
  try { const stat = fs.lstatSync(output); matches = stat.isFile() && stat.size === icon.bytes.length && fs.readFileSync(output).equals(icon.bytes); } catch {}
  if (!matches) Writable.atomicWrite(output, icon.bytes, { root: context.userDataDir });
  return output;
}
function preserveName(previous, incoming) {
  if (!previous?.name) return incoming;
  const automatic = [previous.moduleData?.loveMetadataName, ...[previous.gamePath, previous.importPath].filter(Boolean).flatMap(file => [path.basename(file), path.basename(file, path.extname(file))])];
  return automatic.includes(previous.name) ? incoming : { ...incoming, name: previous.name };
}
module.exports = { resolveGameMetadata, resolveGameIcon, preserveName };

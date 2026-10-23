const fs = require("node:fs"), path = require("node:path");
const Icons = require("../../core/icon-utils");
const Pack = require("./pack");
const MAX_CONFIG_BYTES = 1024 * 1024, MAX_ICON_BYTES = 8 * 1024 * 1024;

function contained(root, file) {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
function readFile(root, file, maximum) {
  try {
    const canonical = fs.realpathSync(file);
    if (!contained(root, canonical)) return null;
    const stat = fs.statSync(canonical);
    return stat.isFile() && stat.size > 0 && stat.size <= maximum ? fs.readFileSync(canonical) : null;
  } catch {return null;}
}
function stringValue(text) {
  const match = /^\s*("(?:[^"\\]|\\.)*")\s*(?:;.*)?$/.exec(text);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "string" && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
  } catch {return null;}
}
function read(root) {
  try {root = fs.realpathSync(root);} catch {return null;}
  for (const filename of ["project.godot", "engine.cfg"]) {
    const bytes = readFile(root, path.join(root, filename), MAX_CONFIG_BYTES);
    if (!bytes) continue;
    let section = "", name = null, icon = null;
    for (const line of bytes.toString("utf8").split(/\r?\n/)) {
      const header = /^\s*\[([^\]]+)\]\s*(?:;.*)?$/.exec(line);
      if (header) {section = header[1].trim();continue;}
      if (section !== "application") continue;
      const setting = /^\s*((?:config\/)?(?:name|icon))\s*=(.*)$/.exec(line);
      if (!setting) continue;
      const value = stringValue(setting[2]);
      if (setting[1].endsWith("name")) name = value?.trim() || null;else icon = value;
    }
    let iconPath = null;
    if (icon?.startsWith("res://") && !icon.includes("\\")) {
      try {
        const candidate = fs.realpathSync(path.resolve(root, icon.slice(6)));
        if (contained(root, candidate)) iconPath = candidate;
      } catch {}
    }
    return {root, configPath: path.join(root, filename), name: name && name.length <= 512 ? name : null, iconPath};
  }
  return null;
}
function project(entry) {
  const data = entry?.moduleData || {};
  const roots = [data.projectRoot, data.packagedType === "project-dir" && data.packagedPath,
    data.extractedReady && data.extractedRoot].filter(value => typeof value === "string" && path.isAbsolute(value));
  for (const root of roots) {const result = read(root);if (result) return result;}
  return null;
}
function icon(metadata) {
  if (!metadata?.iconPath || /\.svg$/i.test(metadata.iconPath)) return null;
  const bytes = readFile(metadata.root, metadata.iconPath, MAX_ICON_BYTES);
  return bytes && Icons.isSupportedImageBuffer(bytes) ? metadata.iconPath : null;
}
const SETTING_KEYS = new Set(["application/config/name", "application/name", "application/config/icon", "application/icon",
  "application/config/windows_native_icon", "application/config/macos_native_icon"]);
function binarySettings(bytes) {
  if (!bytes || bytes.length < 8 || bytes.length > MAX_CONFIG_BYTES || bytes.toString("ascii", 0, 4) !== "ECFG") return null;
  let position = 8;const count = bytes.readUInt32LE(4), settings = Object.create(null);
  if (count > 16384) return null;
  function take(length) {if (length < 0 || position > bytes.length - length) throw Error("Truncated Godot settings.");const value = bytes.subarray(position, position + length);position += length;return value;}
  function u32() {return take(4).readUInt32LE();}
  try {
    for (let i = 0; i < count; i++) {
      const keyLength = u32();if (keyLength > 4096) return null;
      const key = new TextDecoder("utf-8", {fatal: true}).decode(take(keyLength)), length = u32(), value = take(length);
      // Only literal String Variants are decoded. No object or script values
      // from an exported project are deserialized by the launcher.
      if (!SETTING_KEYS.has(key) || length < 8 || value.readUInt32LE() !== 4) continue;
      const size = value.readUInt32LE(4);if (size > 4096 || size > length - 8) continue;
      const text = new TextDecoder("utf-8", {fatal: true}).decode(value.subarray(8, 8 + size));
      if (!/[\x00-\x1f\x7f]/.test(text)) settings[key] = text;
    }
    return settings;
  } catch {return null;}
}
function exported(entry, {readIcons = false} = {}) {
  const data = entry?.moduleData || {}, file = data.packPath;
  if (typeof file !== "string" || !path.isAbsolute(file)) return null;
  try {
    return Pack.open(file, {offset: data.packOffset ?? 0, ...(data.packSize ? {size: data.packSize} : {})}, (fd, pack) => {
      const bytes = Pack.readEntry(fd, pack.entries.get("project.binary"), MAX_CONFIG_BYTES), settings = binarySettings(bytes);
      if (!settings) return null;
      const title = (settings["application/config/name"] || settings["application/name"] || "").trim();
      const native = /\.exe$/i.test(file) ? "application/config/windows_native_icon" :
        entry.nativeAppPath || /\.app(?:\/|$)/i.test(file) ? "application/config/macos_native_icon" : null;
      const paths = [...new Set([native && settings[native], settings["application/config/icon"], settings["application/icon"]].filter(Boolean))];
      const icons = [];
      if (readIcons) for (const resource of paths) {
        if (!resource.startsWith("res://")) continue;
        const name = resource.slice(6), item = pack.entries.get(name);
        if (!item || !/\.(?:png|webp|ico|svg)$/i.test(name)) continue;
        const image = Pack.readEntry(fd, item, MAX_ICON_BYTES);
        if (image) icons.push({name, bytes: image});
      }
      return {name: title && title.length <= 512 ? title : null, icons, root: path.dirname(file)};
    });
  } catch {return null;}
}
function preserveName(existing, incoming) {
  if (!existing?.name) return incoming;
  const automatic = [existing.moduleData?.projectName, ...[existing.gamePath, existing.importPath].filter(Boolean)
    .flatMap(file => [path.basename(file), path.basename(file, path.extname(file))])];
  return automatic.includes(existing.name) ? incoming : {...incoming, name: existing.name};
}
module.exports = {read, project, icon, exported, binarySettings, preserveName};

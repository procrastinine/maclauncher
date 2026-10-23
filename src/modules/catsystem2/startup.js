const fs = require("node:fs"), path = require("node:path");
const Encoding = require("./encoding");
const LIMITS = Object.freeze({ bytes: 1024 * 1024, nodes: 20000, depth: 64, canvasPixels: 32 * 1024 * 1024 });

function entities(text) {
  return text.replace(/&([^;\s]{1,32});/g, (_, value) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(named, value)) return named[value];
    if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(value)) throw new Error("Unsupported CatSystem2 XML entity.");
    const cp = value[1] === "x" ? parseInt(value.slice(2), 16) : Number(value.slice(1));
    if (!Number.isInteger(cp) || cp < 1 || cp > 0x10ffff || cp >= 0xd800 && cp <= 0xdfff) throw new Error("Invalid CatSystem2 XML character.");
    return String.fromCodePoint(cp);
  });
}

/** Bounded XML elements/attributes used by authored settings. No DTD or I/O. */
function parseXml(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMITS.bytes) throw new Error("CatSystem2 XML exceeds its read limit.");
  const declaration = bytes.subarray(0, 160).toString("ascii").match(/^\s*<\?xml\s[^?]*encoding=["']([^"']+)["']/i);
  const encoding = declaration?.[1]?.toLowerCase() || "utf-8";
  if (!["utf-8", "utf8", "shift_jis", "shift-jis", "windows-31j", "cp932"].includes(encoding)) throw new Error("Unsupported CatSystem2 XML encoding.");
  const text = encoding.startsWith("utf") ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : Encoding.decode(bytes);
  const root = { name: "", children: [], text: "" }, stack = [root]; let at = 0, count = 0;
  while (at < text.length) {
    if (text.startsWith("<!--", at)) {
      const end = text.indexOf("-->", at + 4); if (end < 0 || text.slice(at + 4, end).includes("--")) throw new Error("Invalid CatSystem2 XML comment.");
      at = end + 3; continue;
    }
    if (text.startsWith("<?xml", at) && stack.length === 1 && root.children.length === 0 && !root.text.trim()) {
      const end = text.indexOf("?>", at + 5); if (end < 0) throw new Error("Invalid CatSystem2 XML declaration."); at = end + 2; continue;
    }
    if (text[at] !== "<") {
      const end = text.indexOf("<", at), value = text.slice(at, end < 0 ? text.length : end);
      if (/&(?![A-Za-z]+;|#(?:\d+|x[0-9A-Fa-f]+);)/.test(value)) throw new Error("Invalid CatSystem2 XML entity.");
      stack.at(-1).text += entities(value); at = end < 0 ? text.length : end; continue;
    }
    let end = at + 1, quote = null;
    for (; end < text.length; end++) {
      const character = text[end];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (end >= text.length) throw new Error("Truncated CatSystem2 XML element.");
    const tag = text.slice(at + 1, end), close = /^\/([A-Za-z_][A-Za-z0-9_.-]*)\s*$/.exec(tag);
    if (close) {
      if (stack.length === 1 || stack.at(-1).name !== close[1]) throw new Error("Mismatched CatSystem2 XML element."); stack.pop();
    } else {
      const open = /^([A-Za-z_][A-Za-z0-9_.-]*)([\s\S]*?)\s*(\/)?$/.exec(tag);
      if (!open || ++count > LIMITS.nodes || stack.length >= LIMITS.depth) throw new Error("Unsupported or oversized CatSystem2 XML structure.");
      const attributes = Object.create(null); let rest = open[2], attributeCount = 0;
      while (rest.trim()) {
        const attribute = /^\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(rest);
        if (!attribute || Object.hasOwn(attributes, attribute[1]) || ++attributeCount > 64) throw new Error("Invalid CatSystem2 XML attribute.");
        const raw = attribute[2] ?? attribute[3];
        if (/&(?![A-Za-z]+;|#(?:\d+|x[0-9A-Fa-f]+);)/.test(raw)) throw new Error("Invalid CatSystem2 XML attribute entity.");
        attributes[attribute[1]] = entities(raw); rest = rest.slice(attribute[0].length);
      }
      const node = { name: open[1], children: [], attributes, text: "" }; stack.at(-1).children.push(node); if (!open[3]) stack.push(node);
    }
    at = end + 1;
  }
  if (stack.length !== 1 || root.children.length !== 1 || root.text.trim() || root.children[0].name !== "document") throw new Error("CatSystem2 XML requires one complete document element.");
  return root.children[0];
}
function child(node, name, required = true) {
  const matches = node?.children?.filter(item => item.name === name) || [];
  if (matches.length > 1 || required && matches.length !== 1) throw new Error(`CatSystem2 XML ${name} is absent or ambiguous.`);
  return matches[0];
}
function value(node, name, required = true) {
  const item = child(node, name, required); if (!item) return null;
  if (item.children.length) throw new Error(`CatSystem2 XML ${name} requires a scalar value.`); return item.text.trim();
}
function integer(node, name, minimum, maximum) {
  const raw = value(node, name); if (!/^\d+$/.test(raw)) throw new Error(`Invalid CatSystem2 ${name}.`);
  const number = Number(raw); if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error(`CatSystem2 ${name} exceeds its range.`); return number;
}
function memberPath(value) {
  if (typeof value !== "string" || !value.length || value.length > 4096 || /[\x00-\x1f\x7f<>:"|?*\\]|\p{Surrogate}/u.test(value) || value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error("CatSystem2 authored member path is unsafe.");
  return value;
}
function parseLanguages(document) {
  const section = child(document, "language", false); if (!section) return null;
  const defaultIndex = integer(section, "default", 0, 99), items = [];
  for (const node of section.children) if (/^L\d\d$/.test(node.name)) {
    const index = Number(node.name.slice(1)), prefix = value(node, "prefix"), rawCode = value(node, "code", false);
    if (!/^[a-z]{2,8}$/.test(prefix) || rawCode != null && (!/^\d+$/.test(rawCode) || Number(rawCode) < 1 || Number(rawCode) > 65535)) throw new Error("Unsupported CatSystem2 language definition.");
    if (items.some(item => item.index === index || item.prefix === prefix)) throw new Error("CatSystem2 language definitions are repeated.");
    items.push({ index, prefix, code: rawCode == null ? null : Number(rawCode) });
  }
  items.sort((a, b) => a.index - b.index);
  if (!items.length || items.some((item, index) => item.index !== index) || defaultIndex >= items.length) throw new Error("CatSystem2 language definitions are incomplete.");
  return { defaultIndex, items };
}
function parseStartup(bytes) {
  const document = parseXml(bytes), version = integer(child(document, "VERSION"), "ini", 20, 20), screen = child(document, "SCREEN");
  const width = integer(screen, "width", 1, 16384), height = integer(screen, "height", 1, 16384), fps = integer(screen, "fps", 1, 240);
  if (width * height > LIMITS.canvasPixels) throw new Error("CatSystem2 startup canvas exceeds its pixel limit.");
  const start = memberPath(value(child(document, "SCRIPT"), "start")), languages = parseLanguages(document), language = languages?.items[languages.defaultIndex].prefix ?? null;
  const app = child(document, "APP", false), flag = child(child(document, "GAME", false), "flag", false);
  const textureNode = child(document, "TEXTURE", false); let texture = null;
  if (textureNode) {
    const size = child(textureNode, "size"), count = child(textureNode, "vt");
    const tileWidth = integer(size, "x", 1, 4096), tileHeight = integer(size, "y", 1, 4096);
    const width = tileWidth * integer(count, "x", 1, 256), height = tileHeight * integer(count, "y", 1, 256);
    if (width > 16384 || height > 16384 || width * height > LIMITS.canvasPixels) throw new Error("CatSystem2 texture atlas exceeds its pixel limit.");
    texture = { width, height, tileWidth, tileHeight, bpp: integer(textureNode, "bpp", 16, 32) };
    if (![16, 24, 32].includes(texture.bpp)) throw new Error("This CatSystem2 texture bit depth is unsupported.");
  }
  return { version, canvas: { width, height }, fps, start, language, languages, title: app ? value(app, "title", false) : null,
    flagCount: flag ? integer(flag, "max", 1, 65536) : null, texture, document };
}

async function readStartup(dataRoot) {
  const root = await fs.promises.realpath(dataRoot), directory = path.join(root, "config"), file = path.join(directory, "startup.xml");
  for (const candidate of [directory, file]) {
    const stat = await fs.promises.lstat(candidate);
    if (stat.isSymbolicLink() || (candidate === file ? !stat.isFile() || stat.size > LIMITS.bytes : !stat.isDirectory())) throw new Error("CatSystem2 startup settings require bounded original regular paths.");
  }
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = await handle.stat(); if (!before.isFile() || before.size > LIMITS.bytes) throw new Error("CatSystem2 startup settings exceed their read limit.");
    const bytes = Buffer.alloc(before.size); let at = 0;
    while (at < bytes.length) { const read = await handle.read(bytes, at, bytes.length - at, at); if (!read.bytesRead) throw new Error("Truncated CatSystem2 startup settings."); at += read.bytesRead; }
    const after = await handle.stat(), current = await fs.promises.lstat(file), resolved = await fs.promises.realpath(file);
    if (current.isSymbolicLink() || !resolved.startsWith(root + path.sep) || before.dev !== current.dev || before.ino !== current.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== current.size || before.mtimeMs !== current.mtimeMs || before.ctimeMs !== current.ctimeMs)
      throw new Error("CatSystem2 startup settings changed during reading.");
    return { ...parseStartup(bytes), path: file };
  } finally { await handle.close(); }
}
module.exports = { LIMITS, parseXml, child, value, integer, memberPath, parseLanguages, parseStartup, readStartup };

const fs = require("node:fs");
const path = require("node:path");
const Zip = require("../shared/runtime/zip");
const zlib = require("node:zlib");

const COMMANDS = new Set(["bgload", "setimg", "sound", "music", "text", "choice", "setvar", "gsetvar", "if", "fi", "jump", "delay", "random", "label", "goto", "cleartext"]);
function validHeader(bytes) {
  if (!bytes?.length || bytes.includes(0)) return null;
  const commands = bytes.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/)
    .map(line => line.trim()).filter(line => line && !line.startsWith("#")).slice(0, 64)
    .map(line => line.match(/^[a-z]+\b/)?.[0]);
  if (commands.length < 2 || commands.some(command => !COMMANDS.has(command)) || !commands.some(command => ["text", "choice", "jump", "bgload"].includes(command))) return null;
  return [...new Set(commands)];
}
function readZipScript(archive, entry, read) {
  if (!entry || entry.uncompressedSize > 65536 || entry.compressedSize > 65536) return null;
  const header = read(archive, entry.absoluteLocalHeaderOffset, 30);
  if (!header || header.length !== 30 || header.readUInt32LE(0) !== 0x04034b50 || (header.readUInt16LE(6) & 1)) return null;
  const method = header.readUInt16LE(8);
  const bytes = read(archive, entry.absoluteLocalHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), entry.compressedSize);
  if (!bytes || bytes.length !== entry.compressedSize) return null;
  const decoded = method === 0 ? bytes : method === 8 ? zlib.inflateRawSync(bytes, { maxOutputLength: 65536 }) : null;
  return decoded?.length === entry.uncompressedSize ? decoded : null;
}
function detectGame(context, helpers = {}) {
  if (context?.isAppBundle || !context?.rootDir) return null;
  const probes = { ...context.detection, ...helpers };
  const stat = probes.stat || (file => { try { return fs.statSync(file); } catch { return null; } });
  const read = probes.readBytes || ((file, offset, length) => { const fd = fs.openSync(file, "r"); try { const bytes = Buffer.alloc(length), count = fs.readSync(fd, bytes, 0, length, offset); return bytes.subarray(0, count); } finally { fs.closeSync(fd); } });
  let root = context.rootDir;
  // A selected script belongs to the same original VNDS folder as its assets.
  if (path.basename(root).toLowerCase() === "script") root = path.dirname(root);
  const script = path.join(root, "script", "main.scr"), archive = path.join(root, "script.zip");
  let scriptPath = script, commands, bytesRead = 0;
  if (stat(script)?.isFile()) {
    const bytes = read(script, 0, 65536); bytesRead = bytes?.length || 0; commands = validHeader(bytes);
  } else if (stat(archive)?.isFile()) {
    const listing = (probes.readZipEntries || Zip.readZipEntries)(archive);
    const entries = Array.isArray(listing) ? listing : listing?.entries;
    const selected = entries?.find(entry => /^(?:script\/)?main\.scr$/i.test(entry.name || entry.filename || ""));
    if (!selected || selected.uncompressedSize > 65536) return null;
    const bytes = readZipScript(archive, selected, read);
    bytesRead = bytes?.length || 0; commands = validHeader(bytes); scriptPath = archive;
  }
  if (!commands) return null;
  if (!stat(path.join(root, "background"))?.isDirectory() && !stat(path.join(root, "background.zip"))?.isFile() && !stat(path.join(root, "info.txt"))?.isFile()) return null;
  let title = null;
  const info = path.join(root, "info.txt");
  if (stat(info)?.isFile() && stat(info).size <= 16384) title = read(info, 0, 16384)?.toString("utf8").match(/^title\s*=\s*(.{1,160})$/im)?.[1].trim();
  return { gameType: "scripted", engine: "vnds", gamePath: root, contentRootDir: root, name: title || path.basename(root),
    moduleData: { scriptPath, scriptFormat: "vnds", resolvedChannel: "stable" },
    detectionEvidence: [{ type: "vnds-script-header", path: scriptPath, bytesRead, commands }, { type: "selected-artifact", path: scriptPath }] };
}
module.exports = { detectGame, validHeader, readZipScript, COMMANDS };

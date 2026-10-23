const fs = require("node:fs"), path = require("node:path");
const extensions = new Set(require("./manifest.json").detection.fileExtensions);

function videoTrack(bytes, depth = 0) {
  if (depth > 4) return false;
  for (let at = 0, count = 0; at + 8 <= bytes.length && count++ < 2048;) {
    let size = bytes.readUInt32BE(at), header = 8;
    if (size === 1) { if (at + 16 > bytes.length) return false; size = Number(bytes.readBigUInt64BE(at + 8)); header = 16; }
    if (size === 0) size = bytes.length - at;
    if (!Number.isSafeInteger(size) || size < header || size > bytes.length - at) return false;
    const kind = bytes.toString("ascii", at + 4, at + 8), body = bytes.subarray(at + header, at + size);
    if (kind === "hdlr" && body.length >= 12 && body.toString("ascii", 8, 12) === "vide") return true;
    if (["moov", "trak", "mdia"].includes(kind) && videoTrack(body, depth + 1)) return true;
    at += size;
  }
  return false;
}
function inspectIso(read, size) {
  let identified = false;
  for (let at = 0, count = 0; at + 8 <= size && count++ < 512;) {
    const bytes = read(at, Math.min(16, size - at));
    let length = bytes.readUInt32BE(0), header = 8;
    if (length === 1) { if (bytes.length < 16) return false; length = Number(bytes.readBigUInt64BE(8)); header = 16; }
    if (length === 0) length = size - at;
    if (!Number.isSafeInteger(length) || length < header || length > size - at) return false;
    const kind = bytes.toString("ascii", 4, 8);
    if (kind === "ftyp") identified = true;
    if (kind === "moov") return (identified || at === 0 || count > 1) && length <= 4 * 1024 * 1024 && videoTrack(read(at + header, length - header));
    if (!["ftyp", "mdat", "free", "skip", "wide", "uuid", "pnot"].includes(kind)) return false;
    at += length;
  }
  return false;
}
function detectGame(context) {
  const input = context?.inputPath;
  if (!input || !extensions.has(path.extname(input).toLowerCase())) return null;
  let fd;
  try {
    const stat = context.stat || context.detection?.stat?.(input) || fs.statSync(input);
    if (!stat.isFile() || stat.size < 12) return null;
    const read = (offset, count) => {
      if (context.detection?.readBytes) return context.detection.readBytes(input, offset, count);
      fd ??= fs.openSync(input, "r"); const buffer = Buffer.alloc(count);
      return buffer.subarray(0, fs.readSync(fd, buffer, 0, count, offset));
    };
    const bytes = read(0, Math.min(stat.size, 256 * 1024)), extension = path.extname(input).toLowerCase();
    let container;
    if ([".mp4", ".m4v", ".mov"].includes(extension) && inspectIso(read, stat.size)) container = extension === ".mov" ? "QuickTime" : "MPEG-4";
    else if ([".mkv", ".webm"].includes(extension) && bytes.readUInt32BE(0) === 0x1a45dfa3 &&
      (bytes.includes(Buffer.from("matroska")) || bytes.includes(Buffer.from("webm"))) && bytes.includes(Buffer.from([0x83, 0x81, 0x01]))) container = extension === ".webm" ? "WebM" : "Matroska";
    else if (extension === ".avi" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "AVI " && bytes.includes(Buffer.from("vids"))) container = "AVI";
    else if (extension === ".flv" && bytes.toString("ascii", 0, 3) === "FLV" && bytes[3] === 1 && (bytes[4] & 1)) container = "Flash Video";
    else if ([".mpg", ".mpeg", ".vob"].includes(extension) && bytes.readUInt32BE(0) === 0x000001ba && /\x00\x00\x01[\xe0-\xef]/.test(bytes.toString("latin1"))) container = "MPEG program stream";
    else if (extension === ".ogv" && bytes.toString("ascii", 0, 4) === "OggS" && bytes.includes(Buffer.from([0x80, ...Buffer.from("theora")]))) container = "Ogg Theora";
    if (!container) return null;
    return { moduleId: "video", engine: "video", gameType: "video", gamePath: input, contentRootDir: path.dirname(input),
      name: path.basename(input, path.extname(input)), moduleData: { container } };
  } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
module.exports = { detectGame, videoTrack };

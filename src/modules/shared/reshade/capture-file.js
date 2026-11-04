// Raw GPU captures are encoded outside the game. MCLCAP01 is SDR RGBA8;
// MCLCAP02 is canonical full-range BT.2020 PQ RGBA16, little endian.
// HDR PNG uses the cICP 9/16/0/1 encoding from the PNG specification.
// No image framework is needed.
const fs = require("node:fs"), zlib = require("node:zlib");
const MAGIC = Buffer.from("MCLCAP01"), HDR_MAGIC = Buffer.from("MCLCAP02"), HEADER = 24, MAXIMUM_DIMENSION = 32768, MAXIMUM_BYTES = 256 * 1024 * 1024;

function layout(width, height, stride, flags, version = flags & 4 ? 2 : 1) {
  const hdr = version === 2, pixelBytes = hdr ? 8 : 4;
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width <= MAXIMUM_DIMENSION && height <= MAXIMUM_DIMENSION && stride === width * pixelBytes &&
    Number.isInteger(flags) && flags >= 0 && (hdr ? flags === 4 || flags === 6 : version === 1 && flags <= 3) && stride * height <= MAXIMUM_BYTES;
}
function read(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size < HEADER + 4 || before.size > HEADER + MAXIMUM_BYTES)
      throw new Error("The captured frame is not a bounded regular file.");
    const header = Buffer.alloc(HEADER);
    if (fs.readSync(descriptor, header, 0, HEADER, 0) !== HEADER || (!header.subarray(0, MAGIC.length).equals(MAGIC) && !header.subarray(0, HDR_MAGIC.length).equals(HDR_MAGIC)))
      throw new Error("The captured frame header is invalid.");
    const version = header.subarray(0, HDR_MAGIC.length).equals(HDR_MAGIC) ? 2 : 1;
    const width = header.readUInt32LE(8), height = header.readUInt32LE(12), stride = header.readUInt32LE(16), flags = header.readUInt32LE(20);
    if (!layout(width, height, stride, flags, version) || before.size !== HEADER + stride * height)
      throw new Error("The captured frame layout is invalid.");
    const buffer = Buffer.allocUnsafe(stride * height);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, HEADER + offset);
      if (!count) throw new Error("The captured frame is incomplete.");
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error("The captured frame changed while being read.");
    return {width, height, stride, flags, version, bitDepth: version === 2 ? 16 : 8, colorSpace: version === 2 ? "rec2100-pq" : "srgb", buffer, mtime: before.mtime, atime: before.atime};
  } finally { fs.closeSync(descriptor); }
}
function chunk(name, bytes) {
  const result = Buffer.allocUnsafe(bytes.length + 12);
  result.writeUInt32BE(bytes.length); result.write(name, 4, 4, "ascii"); bytes.copy(result, 8);
  result.writeUInt32BE(zlib.crc32(result.subarray(4, -4)) >>> 0, result.length - 4);
  return result;
}
function png({width, height, stride, flags, buffer, version = flags & 4 ? 2 : 1}) {
  if (!layout(width, height, stride, flags, version) || !Buffer.isBuffer(buffer) || buffer.length !== stride * height)
    throw new Error("The captured frame layout is invalid.");
  const hdr = version === 2, rowBytes = width * (hdr ? 6 : 4);
  const rows = Buffer.allocUnsafe((rowBytes + 1) * height), bgra = flags & 1, flip = flags & 2;
  for (let y = 0; y < height; y++) {
    const destination = y * (rowBytes + 1), source = (flip ? height - y - 1 : y) * stride;
    rows[destination] = 0;
    for (let x = 0; x < width; x++) {
      if (hdr) {
        const from = source + x * 8, to = destination + 1 + x * 6;
        for (let channel = 0; channel < 3; channel++) rows.writeUInt16BE(buffer.readUInt16LE(from + channel * 2), to + channel * 2);
        continue;
      }
      const from = source + x * 4, to = destination + 1 + x * 4;
      rows[to] = buffer[from + (bgra ? 2 : 0)]; rows[to + 1] = buffer[from + 1];
      rows[to + 2] = buffer[from + (bgra ? 0 : 2)]; rows[to + 3] = 255;
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = hdr ? 16 : 8; header[9] = hdr ? 2 : 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), hdr ? chunk("cICP", Buffer.from([9, 16, 0, 1])) : chunk("sRGB", Buffer.from([0])),
    chunk("IDAT", zlib.deflateSync(rows, {level: 1})), chunk("IEND", Buffer.alloc(0))]);
}
module.exports = {read, png};

// Raw GPU captures are encoded outside the game. No image framework is needed.
const fs = require("node:fs"), zlib = require("node:zlib");
const MAGIC = Buffer.from("MCLCAP01"), HEADER = 24, MAXIMUM_DIMENSION = 32768, MAXIMUM_BYTES = 256 * 1024 * 1024;

function layout(width, height, stride, flags) {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width <= MAXIMUM_DIMENSION && height <= MAXIMUM_DIMENSION && stride === width * 4 &&
    Number.isInteger(flags) && flags >= 0 && flags <= 3 && stride * height <= MAXIMUM_BYTES;
}
function read(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size < HEADER + 4 || before.size > HEADER + MAXIMUM_BYTES)
      throw new Error("The captured frame is not a bounded regular file.");
    const header = Buffer.alloc(HEADER);
    if (fs.readSync(descriptor, header, 0, HEADER, 0) !== HEADER || !header.subarray(0, MAGIC.length).equals(MAGIC))
      throw new Error("The captured frame header is invalid.");
    const width = header.readUInt32LE(8), height = header.readUInt32LE(12), stride = header.readUInt32LE(16), flags = header.readUInt32LE(20);
    if (!layout(width, height, stride, flags) || before.size !== HEADER + stride * height)
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
    return {width, height, stride, flags, buffer, mtime: before.mtime, atime: before.atime};
  } finally { fs.closeSync(descriptor); }
}
function chunk(name, bytes) {
  const result = Buffer.allocUnsafe(bytes.length + 12);
  result.writeUInt32BE(bytes.length); result.write(name, 4, 4, "ascii"); bytes.copy(result, 8);
  result.writeUInt32BE(zlib.crc32(result.subarray(4, -4)) >>> 0, result.length - 4);
  return result;
}
function png({width, height, stride, flags, buffer}) {
  if (!layout(width, height, stride, flags) || !Buffer.isBuffer(buffer) || buffer.length !== stride * height)
    throw new Error("The captured frame layout is invalid.");
  const rows = Buffer.allocUnsafe((stride + 1) * height), bgra = flags & 1, flip = flags & 2;
  for (let y = 0; y < height; y++) {
    const destination = y * (stride + 1), source = (flip ? height - y - 1 : y) * stride;
    rows[destination] = 0;
    for (let x = 0; x < width; x++) {
      const from = source + x * 4, to = destination + 1 + x * 4;
      rows[to] = buffer[from + (bgra ? 2 : 0)]; rows[to + 1] = buffer[from + 1];
      rows[to + 2] = buffer[from + (bgra ? 0 : 2)]; rows[to + 3] = 255;
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("sRGB", Buffer.from([0])),
    chunk("IDAT", zlib.deflateSync(rows, {level: 1})), chunk("IEND", Buffer.alloc(0))]);
}
module.exports = {read, png};

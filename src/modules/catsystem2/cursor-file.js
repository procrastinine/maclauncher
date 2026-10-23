const LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024, entries: 32, dimension: 256 });

/** Windows CUR directory with one explicit, bounded BI_RGB32 cursor. */
function decodeCursor(bytes, { index } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > LIMITS.bytes || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 2)
    throw new Error("This Windows cursor header is unsupported.");
  const count = bytes.readUInt16LE(4), headerLength = 6 + count * 16;
  if (!count || count > LIMITS.entries || headerLength > bytes.length) throw new Error("Windows cursor entries exceed their bounds.");
  if (index == null) { if (count !== 1) throw new Error("Choose an explicit Windows cursor image."); index = 0; }
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error("Windows cursor image is absent.");
  const entries = [];
  for (let entry = 0; entry < count; entry++) {
    const at = 6 + entry * 16, width = bytes[at] || 256, height = bytes[at + 1] || 256;
    const hotspotX = bytes.readUInt16LE(at + 4), hotspotY = bytes.readUInt16LE(at + 6), length = bytes.readUInt32LE(at + 8), offset = bytes.readUInt32LE(at + 12);
    if (bytes[at + 3] || hotspotX >= width || hotspotY >= height || length < 40 || offset < headerLength || offset > bytes.length - length ||
        entries.some(other => offset < other.offset + other.length && other.offset < offset + length)) throw new Error("Windows cursor extents or hotspot disagree.");
    entries.push({ width, height, hotspotX, hotspotY, length, offset });
  }
  const { width, height, hotspotX, hotspotY, offset, length } = entries[index], data = bytes.subarray(offset, offset + length);
  const stride = width * 4, maskStride = Math.ceil(width / 32) * 4, pixelsLength = stride * height, maskLength = maskStride * height;
  if (data.readUInt32LE(0) !== 40 || data.readInt32LE(4) !== width || data.readInt32LE(8) !== height * 2 || data.readUInt16LE(12) !== 1 ||
      data.readUInt16LE(14) !== 32 || data.readUInt32LE(16) !== 0 || data.readUInt32LE(32) !== 0 || data.readUInt32LE(36) !== 0 ||
      ![0, pixelsLength, pixelsLength + maskLength].includes(data.readUInt32LE(20)) || length !== 40 + pixelsLength + maskLength)
    throw new Error("This Windows cursor bitmap format is unsupported.");
  const alpha = data.subarray(40, 40 + pixelsLength).some((value, at) => at % 4 === 3 && value !== 0), rgba = Buffer.alloc(pixelsLength);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = 40 + (height - y - 1) * stride + x * 4, to = (y * width + x) * 4;
    const masked = Boolean(data[40 + pixelsLength + (height - y - 1) * maskStride + (x >> 3)] & (0x80 >> (x & 7)));
    if (!alpha && masked && (data[from] || data[from + 1] || data[from + 2])) throw new Error("Windows cursor inversion pixels are unsupported.");
    rgba[to] = data[from + 2]; rgba[to + 1] = data[from + 1]; rgba[to + 2] = data[from]; rgba[to + 3] = alpha ? data[from + 3] : masked ? 0 : 255;
  }
  return { width, height, hotspotX, hotspotY, rgba, imageIndex: index };
}
module.exports = { LIMITS, decodeCursor };

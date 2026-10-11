// HG-3 format / decoding reference: TriggersTools.CatSystem2, MIT,
// Copyright (c) 2019 Robert Jordan. See resources/TriggersTools-MIT.txt.
// Pinned reference: 47fdcb605c16a5d93a97cb2894684326f21885c8.
// This bounded Node reader does not load a proprietary runner or mutate input.
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const inflate = promisify(zlib.inflate);

const VERSION = "1.0.0-ml1";
const LIMITS = Object.freeze({ inputBytes: 64 * 1024 * 1024, frameBytes: 64 * 1024 * 1024,
  pixels: 16 * 1024 * 1024, dimension: 16384, frames: 2048, tags: 256, commandBytes: 16 * 1024 * 1024 });

function range(bytes, start, length, end = bytes.length) {
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 0 || start > end || length > end - start)
    throw new Error("HG-3 data exceeds its frame range.");
  return bytes.subarray(start, start + length);
}
function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > LIMITS.dimension || height > LIMITS.dimension || width * height > LIMITS.pixels)
    throw new Error("HG-3 image dimensions exceed their limit.");
}
function inspectHg3(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > LIMITS.inputBytes || !bytes.subarray(0,4).equals(Buffer.from("HG-3")))
    throw new Error("Unsupported or oversized HG-3 image.");
  if (bytes.readUInt32LE(4) !== 12 || bytes.readUInt32LE(8) !== 0x300) throw new Error("Unsupported HG-3 header version.");
  const frames = [], counts = new Map(); let frameStart = 12;
  while (true) {
    if (frames.length >= LIMITS.frames) throw new Error("HG-3 frame count exceeds its limit.");
    range(bytes, frameStart, 8);
    const next = bytes.readUInt32LE(frameStart), frameId = bytes.readUInt32LE(frameStart + 4);
    const frameEnd = next ? frameStart + next : bytes.length;
    if (next && (next < 64 || frameEnd > bytes.length - 8)) throw new Error("HG-3 frame chain escapes its source.");
    let tagStart = frameStart + 8; const tags = [];
    while (true) {
      if (tags.length >= LIMITS.tags) throw new Error("HG-3 tag count exceeds its limit.");
      const header = range(bytes, tagStart, 16, frameEnd), signature = header.subarray(0, 8), nul = signature.indexOf(0);
      const nameBytes = signature.subarray(0, nul < 0 ? 8 : nul), name = nameBytes.toString("ascii");
      // The fixed eight-byte C string can retain uninitialized bytes after NUL
      // in original archives. Only its terminated name is part of the format.
      if (nameBytes.some(byte=>byte>127) || !/^[a-z0-9_]{1,8}$/.test(name))
        throw new Error("HG-3 tag signature is invalid.");
      const tagNext = header.readUInt32LE(8), length = header.readUInt32LE(12), dataOffset = tagStart + 16;
      range(bytes, dataOffset, length, frameEnd);
      if (tagNext && (tagNext < 16 + length || tagStart + tagNext > frameEnd - 16)) throw new Error("HG-3 tag chain overlaps or escapes its frame.");
      tags.push(Object.freeze({ name, offset: dataOffset, length }));
      if (!tagNext) break;
      tagStart += tagNext;
    }
    if (tags[0]?.name !== "stdinfo" || tags[0].length !== 40 || tags.filter(tag => tag.name === "stdinfo").length !== 1)
      throw new Error("HG-3 needs one leading stdinfo tag.");
    const info = range(bytes, tags[0].offset, 40), width = info.readUInt32LE(0), height = info.readUInt32LE(4), bpp = info.readUInt32LE(8);
    const offsetX = info.readInt32LE(12), offsetY = info.readInt32LE(16), canvasWidth = info.readUInt32LE(20), canvasHeight = info.readUInt32LE(24);
    dimensions(width, height); dimensions(canvasWidth, canvasHeight);
    if (![24, 32].includes(bpp)) throw new Error("HG-3 supports only 24-bit or 32-bit pixels.");
    if (Math.abs(offsetX) > LIMITS.dimension || Math.abs(offsetY) > LIMITS.dimension) throw new Error("HG-3 crop offsets exceed their limit.");
    const stride = Math.ceil(width * (bpp / 8) / 4) * 4;
    if (stride * height > LIMITS.frameBytes) throw new Error("HG-3 pixel buffer exceeds its limit.");
    const imageTags = tags.filter(tag => /^img\d{4,5}$/.test(tag.name));
    const otherImages = tags.filter(tag => ["img_jpg", "img_al", "img_wbp", "img_jpa"].includes(tag.name));
    if (!imageTags.length && !otherImages.length) throw new Error("HG-3 frame has no image data.");
    if (imageTags.length && otherImages.length || otherImages.some((tag, index) => otherImages.findIndex(candidate => candidate.name === tag.name) !== index))
      throw new Error("HG-3 image encodings are ambiguous.");
    const frame = Object.freeze({ frameId, frameIndex: frames.length, width, height, bpp, canvasWidth, canvasHeight, offsetX, offsetY,
      transparent: info.readUInt32LE(28) !== 0, baseX: info.readInt32LE(32), baseY: info.readInt32LE(36), stride,
      encoding: imageTags.length ? "lossless" : otherImages.map(tag => tag.name).join("+"), tags: Object.freeze(tags),
      offset: frameStart, bytes: frameEnd - frameStart });
    frames.push(frame); counts.set(frameId, (counts.get(frameId) || 0) + 1);
    if (!next) break;
    frameStart = frameEnd;
  }
  return Object.freeze({ format: "HG-3", formatVersion: "0x300", decoderVersion: VERSION, bytes: bytes.length,
    frames: Object.freeze(frames), ambiguousFrameIds: Object.freeze([...counts].filter(([, count]) => count > 1).map(([id]) => id)) });
}

function selectFrame(info, { frameId, frameIndex } = {}) {
  if (frameIndex !== undefined) {
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= info.frames.length) throw new Error("Choose a validated HG-3 frame index.");
    const selected = info.frames[frameIndex];
    if (frameId !== undefined && selected.frameId !== frameId) throw new Error("HG-3 frame ID and index disagree.");
    return selected;
  }
  if (frameId === undefined) {
    if (info.frames.length !== 1) throw new Error("Choose an HG-3 frame ID or index.");
    return info.frames[0];
  }
  const matches = info.frames.filter(frame => frame.frameId === frameId);
  if (matches.length !== 1) throw new Error(matches.length ? "HG-3 frame ID is ambiguous; choose its index." : "HG-3 frame ID was not found.");
  return matches[0];
}

async function inflateExact(bytes, length, maximum, signal) {
  signal?.throwIfAborted();
  if (!bytes.length || !Number.isInteger(length) || length < 0 || length > maximum) throw new Error("HG-3 inflated data exceeds its limit.");
  let result;
  try { result = await inflate(bytes, { maxOutputLength: Math.max(1, length), info: true }); }
  catch { throw new Error("HG-3 compressed image data is corrupt."); }
  signal?.throwIfAborted();
  if (result.buffer.length !== length || result.engine.bytesWritten !== bytes.length) throw new Error("HG-3 compressed image extents disagree.");
  return result.buffer;
}

function zeroRunDecode(data, commands, expected) {
  let bit = 0;
  function next() {
    if (bit >= commands.length * 8) throw new Error("HG-3 run commands are truncated.");
    const value = (commands[bit >>> 3] >>> (bit & 7)) & 1; bit++; return value;
  }
  function gamma() {
    let digits = 0;
    while (!next()) if (++digits > 26) throw new Error("HG-3 run length exceeds its limit.");
    let value = 1;
    while (digits--) value = value * 2 + next();
    return value;
  }
  let copy = next() === 1;
  if (gamma() !== expected) throw new Error("HG-3 run output length disagrees with image dimensions.");
  const output = Buffer.alloc(expected); let position = 0, read = 0;
  while (position < expected) {
    const length = gamma();
    if (length > expected - position) throw new Error("HG-3 run exceeds its pixel buffer.");
    if (copy) {
      if (length > data.length - read) throw new Error("HG-3 run data is truncated.");
      data.copy(output, position, read, read + length); read += length;
    }
    position += length; copy = !copy;
  }
  if (read !== data.length) throw new Error("HG-3 run data contains trailing bytes.");
  // The bit stream may end with at most seven zero padding bits.
  if (commands.length !== Math.ceil(bit / 8)) throw new Error("HG-3 run commands contain trailing bytes.");
  while (bit < commands.length * 8) if (next()) throw new Error("HG-3 run padding is nonzero.");
  return output;
}

const spread = new Uint32Array(256);
for (let value = 0; value < 256; value++) spread[value] = (value & 3) | ((value & 12) << 6) | ((value & 48) << 12) | ((value & 192) << 18);
function restorePixels(planes, width, height, bpp) {
  const stride = Math.ceil(width * (bpp / 8) / 4) * 4, quarter = planes.length / 4, pixels = Buffer.alloc(planes.length);
  if (!Number.isInteger(quarter) || planes.length !== stride * height) throw new Error("HG-3 pixel planes disagree with image dimensions.");
  for (let index = 0; index < quarter; index++) {
    const word = (spread[planes[index]] << 6) | (spread[planes[quarter + index]] << 4) |
      (spread[planes[quarter * 2 + index]] << 2) | spread[planes[quarter * 3 + index]];
    for (let channel = 0; channel < 4; channel++) {
      const encoded = (word >>> (channel * 8)) & 255;
      pixels[index * 4 + channel] = ((encoded >>> 1) ^ -(encoded & 1)) & 255;
    }
  }
  const depth = bpp / 8;
  for (let x = depth; x < stride; x++) pixels[x] = (pixels[x] + pixels[x - depth]) & 255;
  for (let y = 1; y < height; y++) for (let x = 0; x < stride; x++) {
    const position = y * stride + x; pixels[position] = (pixels[position] + pixels[position - stride]) & 255;
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = (height - 1 - y) * stride + x * depth, to = (y * width + x) * 4;
    rgba[to] = pixels[from + 2]; rgba[to + 1] = pixels[from + 1]; rgba[to + 2] = pixels[from];
    rgba[to + 3] = depth === 4 ? pixels[from + 3] : 255;
  }
  return rgba;
}

async function decodeFrame(bytes, selection, { signal, decodeRaster } = {}) {
  signal?.throwIfAborted();
  const info = inspectHg3(bytes), frame = selectFrame(info, selection), slices = frame.tags.filter(tag => /^img\d{4,5}$/.test(tag.name));
  let rgba;
  if (slices.length) {
    rgba = Buffer.alloc(frame.width * frame.height * 4); const rows = new Uint8Array(frame.height);
    for (const slice of slices) {
      const payload = range(bytes, slice.offset, slice.length); range(payload, 0, 24);
      const row = payload.readUInt32LE(0), height = payload.readUInt32LE(4), compressed = payload.readUInt32LE(8), decoded = payload.readUInt32LE(12);
      const commandsCompressed = payload.readUInt32LE(16), commandsDecoded = payload.readUInt32LE(20);
      if (!height || row >= frame.height || height > frame.height - row || compressed + commandsCompressed !== payload.length - 24 ||
          !commandsDecoded || commandsDecoded > LIMITS.commandBytes || decoded > frame.stride * height)
        throw new Error("HG-3 image slice extents disagree.");
      for (let y = row; y < row + height; y++) if (rows[y]++) throw new Error("HG-3 image slices overlap.");
      const data = await inflateExact(range(payload, 24, compressed), decoded, frame.stride * height, signal);
      const commands = await inflateExact(range(payload, 24 + compressed, commandsCompressed), commandsDecoded, LIMITS.commandBytes, signal);
      const pixels = restorePixels(zeroRunDecode(data, commands, frame.stride * height), frame.width, height, frame.bpp);
      // Slice start is in the underlying bottom-up bitmap; expose top-left RGBA.
      pixels.copy(rgba, (frame.height - row - height) * frame.width * 4);
      signal?.throwIfAborted();
    }
    if (rows.some(value => !value)) throw new Error("HG-3 image slices leave missing rows.");
  } else {
    const raster = frame.tags.find(tag => ["img_jpg", "img_wbp"].includes(tag.name));
    if (!raster || typeof decodeRaster !== "function" || frame.tags.some(tag => tag.name === "img_jpa"))
      throw new Error(`HG-3 ${frame.encoding} image decoding is unavailable.`);
    const result = await decodeRaster(range(bytes, raster.offset, raster.length), { encoding: raster.name === "img_jpg" ? "jpeg" : "webp",
      width: frame.width, height: frame.height, maximumBytes: LIMITS.frameBytes, signal });
    if (!Buffer.isBuffer(result) || result.length !== frame.width * frame.height * 4) throw new Error("HG-3 raster dimensions disagree.");
    rgba = Buffer.from(result);
    const alpha = frame.tags.find(tag => tag.name === "img_al");
    if (alpha) {
      const payload = range(bytes, alpha.offset, alpha.length); range(payload, 0, 8);
      const compressed = payload.readUInt32LE(0), decoded = payload.readUInt32LE(4);
      if (compressed !== payload.length - 8 || decoded !== frame.width * frame.height) throw new Error("HG-3 alpha dimensions disagree.");
      const mask = await inflateExact(payload.subarray(8), decoded, LIMITS.pixels, signal);
      for (let pixel = 0; pixel < mask.length; pixel++) rgba[pixel * 4 + 3] = mask[pixel];
    }
  }
  return Object.freeze({ frameId: frame.frameId, frameIndex: frame.frameIndex, width: frame.width, height: frame.height,
    canvasWidth: frame.canvasWidth, canvasHeight: frame.canvasHeight, offsetX: frame.offsetX, offsetY: frame.offsetY,
    baseX: frame.baseX, baseY: frame.baseY, rgba, bpp: frame.bpp, decoderVersion: VERSION });
}

module.exports = { VERSION, LIMITS, inspectHg3, selectFrame, decodeFrame };

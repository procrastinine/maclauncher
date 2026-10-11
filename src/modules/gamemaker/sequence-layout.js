// Format definitions: pinned UndertaleModTool UndertaleSprite/UndertaleSequence.
// Sequence headers gained Width/Height in 2024.13. A sprite can retain the old
// GEN8 tuple while this resource layout selects a different native runner.
const LIMITS = Object.freeze({ sprites: 64, bytes: 64 * 1024, stringBytes: 128, tracks: 64 });

function inspectSpriteSequences({ reader, spriteChunk, stringChunk, spriteCount, rawVersion }) {
  if (!spriteChunk || !spriteCount || Number(rawVersion?.split(".")[0]) < 2) {
    return { layout: "absent", evidence: [], scannedSprites: 0, truncated: false, readBytes: 0 };
  }
  const start = spriteChunk.dataOffset, end = start + spriteChunk.size;
  const tableEnd = start + 4 + spriteCount * 4;
  const scanCount = Math.min(spriteCount, LIMITS.sprites);
  let bytes = 0;
  function read(offset, length, low = start, high = end) {
    if (offset < low || length < 0 || offset > high - length) throw new Error("GameMaker sprite sequence escapes its resource.");
    if ((bytes += length) > LIMITS.bytes) throw new Error("GameMaker sprite sequence inspection exceeds its read budget.");
    return reader.read(offset, length);
  }
  const stringCache = new Map();
  function string(pointer) {
    if (stringCache.has(pointer)) return stringCache.get(pointer);
    const low = stringChunk.dataOffset + 4, high = stringChunk.dataOffset + stringChunk.size;
    if (!pointer || pointer < low + 4 || pointer >= high) return null;
    const length = read(pointer - 4, 4, low, high).readUInt32LE(0);
    if (length > LIMITS.stringBytes || pointer > high - length - 1) return null;
    const value = read(pointer, length + 1, low, high);
    if (value[length] !== 0) return null;
    const result = value.subarray(0, length).toString("utf8");
    stringCache.set(pointer, result);
    return result;
  }
  // Include one successor so a sampled sprite stays bounded by the next entry.
  const pointers = read(start + 4, Math.min(spriteCount, scanCount + 1) * 4);
  const layouts = new Map();
  function headerMatches(sequence, sequenceEnd, headerBytes) {
    try {
      const header = read(sequence + 4, headerBytes + 8, sequence, sequenceEnd);
      if (string(header.readUInt32LE(0)) === null || header.readUInt32LE(4) > 2 ||
        !Number.isFinite(header.readFloatLE(8)) || header.readUInt32LE(12) > 1 ||
        !Number.isFinite(header.readFloatLE(16)) || !Number.isFinite(header.readFloatLE(28))) return false;
      if (headerBytes === 40 && (!Number.isFinite(header.readFloatLE(32)) || !Number.isFinite(header.readFloatLE(36)))) return false;
      // Automatic sprite frame sequences have no broadcast messages and at
      // least one graphic track. More complex/ambiguous sequences stay unknown.
      if (header.readUInt32LE(headerBytes) !== 0) return false;
      const tracks = header.readUInt32LE(headerBytes + 4);
      if (!tracks || tracks > LIMITS.tracks) return false;
      const track = read(sequence + 4 + headerBytes + 8, 32, sequence, sequenceEnd);
      return ["GMSpriteFramesTrack", "GMGraphicTrack"].includes(string(track.readUInt32LE(0))) && string(track.readUInt32LE(4)) !== null &&
        track.readUInt32LE(16) <= 1 && [20, 24, 28].every(offset => track.readUInt32LE(offset) <= LIMITS.tracks);
    } catch { return false; }
  }
  for (let index = 0; index < scanCount; index++) {
    const pointer = pointers.readUInt32LE(index * 4);
    if (!pointer) continue;
    if (pointer < tableEnd || pointer > end - 60) throw new Error("Invalid GameMaker sprite pointer.");
    let spriteEnd = end;
    for (let next = index + 1; next < pointers.length / 4; next++) {
      const candidate = pointers.readUInt32LE(next * 4);
      if (candidate > pointer) { spriteEnd = candidate; break; }
    }
    const base = read(pointer, 60, pointer, spriteEnd);
    if (base.readInt32LE(56) !== -1) continue;
    const special = read(pointer + 60, 20, pointer, spriteEnd);
    const version = special.readUInt32LE(0), type = special.readUInt32LE(4);
    if (![2, 3].includes(version) || type !== 0) continue;
    const sequence = special.readUInt32LE(16);
    if (!sequence) continue;
    if (sequence < pointer + 80 || sequence > spriteEnd - 4 || read(sequence, 4, pointer, spriteEnd).readUInt32LE(0) !== 1) {
      throw new Error("Invalid GameMaker embedded sprite sequence.");
    }
    let sequenceEnd = spriteEnd;
    if (version === 3) {
      const nineSlice = read(pointer + 80, 4, pointer, spriteEnd).readUInt32LE(0);
      if (nineSlice > sequence && nineSlice <= spriteEnd) sequenceEnd = nineSlice;
    }
    const legacy = headerMatches(sequence, sequenceEnd, 32), modern = headerMatches(sequence, sequenceEnd, 40);
    if (legacy === modern) continue;
    const layout = legacy ? "legacy-32" : "dimensions-40";
    if (!layouts.has(layout)) layouts.set(layout, { source: "SPRT embedded sequence header", offset: sequence + 4,
      spriteIndex: index, layout, headerBytes: legacy ? 32 : 40 });
  }
  return { layout: layouts.size > 1 ? "mixed" : layouts.size ? [...layouts.keys()][0] : "unresolved",
    evidence: [...layouts.values()], scannedSprites: scanCount, truncated: spriteCount > scanCount, readBytes: bytes };
}

module.exports = { LIMITS, inspectSpriteSequences };

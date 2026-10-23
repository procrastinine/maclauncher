const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const B = require("../../shared/runtime/bundled-native"), Audio = require("./audio-decode");
const LIMITS = Object.freeze({ entries: 256, bytes: 512 * 1024 * 1024, metadataBytes: 4096 });
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), SHA = /^[a-f0-9]{64}$/;

function inspectWave(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > Audio.LIMITS.pcmBytes + 44 || bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 16) !== "WAVEfmt " || bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(34) !== 16 ||
      bytes.toString("ascii", 36, 40) !== "data" || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.readUInt32LE(40) !== bytes.length - 44)
    throw new Error("The decoded WAVE cache is invalid.");
  const channels = bytes.readUInt16LE(22), sampleRate = bytes.readUInt32LE(24), pcmBytes = bytes.length - 44, frameBytes = channels * 2;
  if (![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 192000 || bytes.readUInt16LE(32) !== frameBytes ||
      bytes.readUInt32LE(28) !== sampleRate * frameBytes || !pcmBytes || pcmBytes % frameBytes || pcmBytes / frameBytes > sampleRate * Audio.LIMITS.seconds)
    throw new Error("Decoded WAVE dimensions disagree.");
  return { channels, sampleRate, frames: pcmBytes / frameBytes, pcmBytes };
}

/** Immutable, content-addressed derived audio under one game's own cache. */
async function createAudioCache({ cacheRoot, helper, arch = process.arch, signal, decode = Audio.decodeOgg, spawnChild } = {}) {
  if (!path.isAbsolute(cacheRoot || "") || !["arm64", "x64"].includes(arch) || helper?.version !== Audio.VERSION || helper.protocolVersion !== 1 || !SHA.test(helper.binarySha256 || ""))
    throw new Error("A bounded per-game cache and exact Ogg/Vorbis helper are required.");
  B.realDirectory(cacheRoot, { create: true }); const root = await fs.promises.realpath(cacheRoot), directory = path.join(root, "audio"); B.realDirectory(directory, { create: true });
  const pending = new Map();
  async function footprint() {
    const names = await fs.promises.readdir(directory); if (names.length > LIMITS.entries * 2 + 32) throw new Error("The decoded audio cache exceeds its entry limit.");
    let bytes = 0, count = 0;
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.(?:wav|json)$/.test(name)) { if (name.startsWith(".partial-")) continue; throw new Error("The decoded audio cache contains an unexpected path."); }
      const stat = await fs.promises.lstat(path.join(directory, name)); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The decoded audio cache requires regular files.");
      bytes += stat.size; if (name.endsWith(".wav")) count++;
    }
    return { bytes, count };
  }
  async function get(source) {
    signal?.throwIfAborted(); if (!Buffer.isBuffer(source) || source.length < 27 || source.length > Audio.LIMITS.inputBytes || source.toString("ascii", 0, 4) !== "OggS")
      throw new Error("A bounded original Ogg/Vorbis stream is required.");
    const sourceSha256 = digest(source), identity = { schemaVersion: 1, decoderVersion: helper.version, decoderSha256: helper.binarySha256, arch, sourceSha256 };
    const key = digest(Buffer.from(JSON.stringify(identity))), file = path.join(directory, key + ".wav"), metadata = path.join(directory, key + ".json");
    if (pending.has(key)) return pending.get(key);
    const operation = (async () => {
      async function existing() {
        const record = JSON.parse(B.readRegular(metadata, LIMITS.metadataBytes).bytes);
        if (Object.entries(identity).some(([name, value]) => record[name] !== value) || !SHA.test(record.waveSha256 || "") || !Number.isSafeInteger(record.waveBytes) || record.waveBytes < 46 || record.waveBytes > Audio.LIMITS.pcmBytes + 44)
          throw new Error("The decoded audio cache identity changed.");
        const content = B.readRegular(file, Audio.LIMITS.pcmBytes + 44), dimensions = inspectWave(content.bytes);
        if (content.sha256 !== record.waveSha256 || content.size !== record.waveBytes || Object.entries(dimensions).some(([name, value]) => record[name] !== value))
          throw new Error("The decoded audio cache was modified.");
        return Object.freeze({ file, key, ...dimensions, waveSha256: content.sha256, sourceSha256, arch, reused: true });
      }
      try { return await existing(); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const decoded = await decode(helper, source, { signal, ...(spawnChild ? { spawnChild } : {}) }), wav = Audio.wave(decoded), dimensions = inspectWave(wav), used = await footprint();
      if (used.count >= LIMITS.entries || used.bytes + wav.length + LIMITS.metadataBytes > LIMITS.bytes) throw new Error("The decoded audio cache exceeds its storage limit.");
      const record = { ...identity, ...dimensions, waveBytes: wav.length, waveSha256: digest(wav) }, partial = path.join(directory, ".partial-" + crypto.randomUUID());
      try {
        await fs.promises.writeFile(partial + ".wav", wav, { flag: "wx", mode: 0o600 });
        await fs.promises.writeFile(partial + ".json", JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 }); signal?.throwIfAborted();
        for (const extension of [".wav", ".json"]) try { await fs.promises.link(partial + extension, path.join(directory, key + extension)); } catch (error) { if (error.code !== "EEXIST") throw error; }
        const result = await existing(); signal?.throwIfAborted(); return Object.freeze({ ...result, reused: false });
      } finally { await fs.promises.rm(partial + ".wav", { force: true }); await fs.promises.rm(partial + ".json", { force: true }); }
    })();
    pending.set(key, operation);
    try { return await operation; } finally { pending.delete(key); }
  }
  return { root, get };
}
module.exports = { LIMITS, inspectWave, createAudioCache };

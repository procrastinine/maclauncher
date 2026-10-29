const path = require("node:path"), fs = require("node:fs");
const Writable = require("../writable-input");
const Graphics = require("./graphics-settings");

// Wire ordinals follow RSTemporalMethod in temporal/frame.h. Menu order in
// Graphics.TEMPORAL_METHODS is independent and must not select the algorithm.
const METHOD_ORDINALS = Object.freeze({off: 0, metalfx: 1, fsr2: 2, fsr3: 3, fsr4: 4, xess: 5, asr: 6, sgsr2: 7, "metalfx-denoised": 8});

// Kept separate from the image-only frame-control ABI used by explicit hosts.
function packet(value) {
  const settings = Graphics.normalizeSettings(value), bytes = Buffer.alloc(24);
  bytes.write("MLTMCTL1", 0);
  bytes.writeUInt32LE(METHOD_ORDINALS[settings.temporalMethod] ?? 0, 8);
  bytes.writeFloatLE(settings.temporalSharpness, 12);
  if(settings.temporalMethod==="asr")bytes.writeUInt32LE(["quality","balanced","performance","ultra-performance"].indexOf(settings.asrQuality)+1,20);
  if(settings.temporalMethod==="fsr4")bytes.writeUInt32LE(settings.fsr4Profile==="lite"?2:settings.fsr4Profile==="lite2"?3:0,20);
  return bytes;
}
function file(entry, userDataDir) {
  if (!/^[\w-]+$/.test(entry.gameId || "")) throw new Error("Graphics controls require a saved game.");
  return path.join(userDataDir, "games", entry.gameId, "effects", "reshade", "temporal-controls.bin");
}
function write(entry, userDataDir, { create = false, publication } = {}) {
  const target = file(entry, userDataDir);
  if (!create && !fs.existsSync(target)) return null;
  Writable.assertOwnDirectory(userDataDir, path.dirname(target));
  if (publication) publication.write(target, packet(entry.graphics), {root: userDataDir});
  else Writable.atomicWrite(target, packet(entry.graphics), { root: userDataDir });
  return target;
}
module.exports = { METHOD_ORDINALS, packet, file, write };

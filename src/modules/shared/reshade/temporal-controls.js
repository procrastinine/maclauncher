const path = require("node:path"), fs = require("node:fs");
const Writable = require("../writable-input");
const Graphics = require("./graphics-settings");

// Kept separate from the image-only frame-control ABI used by explicit hosts.
function packet(value) {
  const settings = Graphics.normalizeSettings(value), bytes = Buffer.alloc(24);
  bytes.write("MLTMCTL1", 0);
  bytes.writeUInt32LE(Graphics.TEMPORAL_METHODS.indexOf(settings.temporalMethod), 8);
  bytes.writeFloatLE(settings.temporalSharpness, 12);
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
module.exports = { packet, file, write };

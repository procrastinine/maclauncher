const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../writable-input");
const Graphics = require("./graphics-settings");
const Filters = require("./filter-library");
function effectKey(settings, userDataDir) {
  const identity = [settings?.preset || "crt", settings?.effectPath || null,
    settings?.preset === "chain" ? settings.effects || ["cas", "crt"] : null];
  if (settings?.enabled === true && userDataDir && Filters.isFilterId(settings.preset)) identity.push(Filters.identity(userDataDir, settings.preset));
  return crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
function validParameters(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= 128 &&
    Object.entries(value).every(([name, values]) => /^[A-Za-z_][A-Za-z0-9_:]{0,126}$/.test(name) && Array.isArray(values) &&
      values.length >= 1 && values.length <= 4 && Array.from(values).every(v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e9));
}
function packet(entry, selection = {}, userDataDir) {
  const graphics = Graphics.normalizeSettings(entry.graphics), bytes = Buffer.alloc(19116);
  bytes.write("MLFXCTL2", 0);bytes.writeUInt32LE(graphics.targetFps, 8);bytes.writeUInt32LE(graphics.frameMultiplier, 12);
  bytes.writeUInt32LE((graphics.frameGeneration === "lsfg" ? 1 : 0) | (graphics.framePacing === "adaptive" ? 2 : 0) | (graphics.smoothCadence ? 4 : 0) |
    (entry.reshade?.enabled ? 8 : 0) | (entry.reshade?.preset === "chain" ? 16 : 0) | (graphics.effectPlacement === "after" ? 32 : 0), 16);
  bytes.write(effectKey(entry.reshade, userDataDir), 24);
  if (/^[a-f0-9]{64}$/.test(selection.revision || "")) bytes.write(selection.revision, 88);
  // Named provider filters run through the ordered executor. Its live packet
  // keeps the legacy ABI's scaler disabled rather than encoding an invalid index.
  bytes.writeUInt32LE(Math.max(0, Graphics.SPATIAL_METHODS.indexOf(graphics.spatialMethod)), 152);
  bytes.writeFloatLE(graphics.spatialSharpness, 156);bytes.writeUInt32LE(graphics.ls1Mode === "performance" ? 1 : 0, 160);
  bytes.writeUInt32LE((graphics.lsfgMode === "performance" ? 1 : 0) | (graphics.lsfgFp16 ? 2 : 0), 164);bytes.writeFloatLE(graphics.lsfgFlowScale, 168);
  const parameters = validParameters(entry.reshade?.parameters) ? Object.entries(entry.reshade.parameters) : [];
  bytes.writeUInt32LE(parameters.length, 20);
  parameters.forEach(([name, values], i) => { const offset = 172 + i * 148;
    bytes.write(name, offset, 127, "utf8");bytes.writeUInt32LE(values.length, offset + 128);
    values.forEach((value, c) => bytes.writeFloatLE(value, offset + 132 + c * 4));
  });
  return bytes;
}
function file(entry, userDataDir) {
  if (!/^[\w-]+$/.test(entry.gameId || "")) throw new Error("Graphics controls require a saved game.");
  return path.join(userDataDir, "games", entry.gameId, "effects", "reshade", "controls.bin");
}
function write(entry, userDataDir, { create = false, publication } = {}) {
  const target = file(entry, userDataDir);
  if (!create && !fs.existsSync(target)) return null;
  Writable.assertOwnDirectory(userDataDir, path.dirname(target));
  const selected = path.join(path.dirname(target), "live-selection.json");
  let selection;
  if (entry.reshade?.enabled) try { selection = JSON.parse(publication ? publication.read(selected, "utf8") : fs.readFileSync(selected, "utf8")); } catch {}
  if (publication) publication.write(target, packet(entry, selection, userDataDir), {root: userDataDir});
  else Writable.atomicWrite(target, packet(entry, selection, userDataDir), { root: userDataDir });
  require("./temporal-controls").write(entry, userDataDir, {publication});
  return target;
}
module.exports = { effectKey, validParameters, packet, file, write };

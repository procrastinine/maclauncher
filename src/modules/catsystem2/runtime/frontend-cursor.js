const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Startup = require("../startup"), Cursor = require("../cursor-file"), B = require("../../shared/runtime/bundled-native");
const LIMITS = Object.freeze({ definitions: 256, bytes: 64 * 1024 });
async function cacheCursor(cacheRoot, decoded, signal) {
  if (!path.isAbsolute(cacheRoot || "")) throw new Error("An absolute per-game cursor cache is required.");
  B.realDirectory(cacheRoot, { create: true }); const root = await fs.promises.realpath(cacheRoot), directory = path.join(root, "cursors");
  B.realDirectory(directory, { create: true }); const rgbaSha256 = B.digest(decoded.rgba);
  const key = B.digest(Buffer.from(JSON.stringify({ decoder: "WindowsCUR-BI_RGB32", version: 1, width: decoded.width, height: decoded.height, rgbaSha256 }))), target = path.join(directory, key + ".rgba");
  function verify() { const record = B.readRegular(target, 256 * 256 * 4); if (record.size !== decoded.rgba.length || record.sha256 !== rgbaSha256) throw new Error("The decoded cursor cache was modified."); }
  try { verify(); return target; } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = path.join(directory, ".partial-" + crypto.randomUUID()); let handle;
  try {
    handle = await fs.promises.open(temporary, "wx", 0o600); await handle.writeFile(decoded.rgba); await handle.sync(); await handle.close(); handle = null;
    signal?.throwIfAborted(); try { await fs.promises.link(temporary, target); } catch (error) { if (error.code !== "EEXIST") throw error; }
    verify(); return target;
  } finally { await handle?.close(); await fs.promises.rm(temporary, { force: true }); }
}
function parseCursorDefinitions(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.bytes) throw new Error("CatSystem2 cursor definitions exceed their limit.");
  const document = Startup.parseXml(bytes), definitions = new Map();
  for (const node of document.children) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(node.name) || node.children.length || Object.keys(node.attributes).length || definitions.has(node.name.toLowerCase()) || definitions.size >= LIMITS.definitions)
      throw new Error("CatSystem2 cursor definitions are unsupported or repeated.");
    const file = Startup.memberPath(node.text.trim().replaceAll("\\", "/"));
    if (!/\.cur$/i.test(file)) throw new Error("This CatSystem2 native cursor format is unsupported.");
    definitions.set(node.name.toLowerCase(), file);
  }
  if (!definitions.has("default")) throw new Error("The authored default cursor is absent."); return definitions;
}
/** Authored native cursor definitions, original CUR files and per-game RGBA. */
async function createFrontEndCursor({ document, registry, assets, cacheRoot, presentCursor, signal } = {}) {
  const mode = Startup.value(Startup.child(document, "CURSOR", false), "type", false);
  if (mode !== "1" || !registry?.read || !assets?.read || typeof presentCursor !== "function") throw new Error("This CatSystem2 cursor mode is unsupported.");
  const definitions = parseCursorDefinitions(await registry.read("config", "cursor", { maximumBytes: LIMITS.bytes })), cursors = new Map();
  let selected = null;
  async function select(name = "default", hotspot) {
    signal?.throwIfAborted();
    if (typeof name !== "string" || !definitions.has(name.toLowerCase()) || hotspot && (!Array.isArray(hotspot) || hotspot.length !== 2 || !hotspot.every(Number.isInteger)))
      throw new Error("The authored CatSystem2 cursor or hotspot is unsupported.");
    const key = name.toLowerCase();
    if (!cursors.has(key)) {
      const operation = (async () => {
        const decoded = Cursor.decodeCursor(await assets.read(definitions.get(key), { maximumBytes: Cursor.LIMITS.bytes }));
        const rgbaPath = await cacheCursor(cacheRoot, decoded, signal);
        return { kind: "image", rgbaPath, width: decoded.width, height: decoded.height, hotspotX: decoded.hotspotX, hotspotY: decoded.hotspotY };
      })(); cursors.set(key, operation); operation.catch(() => cursors.delete(key));
    }
    const cursor = { ...await cursors.get(key) };
    if (hotspot) [cursor.hotspotX, cursor.hotspotY] = hotspot;
    if (cursor.hotspotX < 0 || cursor.hotspotY < 0 || cursor.hotspotX >= cursor.width || cursor.hotspotY >= cursor.height) throw new Error("CatSystem2 cursor hotspot exceeds its image.");
    const identity = JSON.stringify(cursor); if (identity !== selected) { await presentCursor(cursor); selected = identity; }
    return cursor;
  }
  return { select, definitions };
}
module.exports = { LIMITS, parseCursorDefinitions, createFrontEndCursor };

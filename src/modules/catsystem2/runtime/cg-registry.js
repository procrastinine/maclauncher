const Encoding = require("../encoding"), { decodeStoredData } = require("./data-records");
const LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024, blocks: 4096, files: 65536, nameBytes: 64 });
function fixedName(bytes) {
  const end = bytes.indexOf(0); if (end < 1 || bytes.subarray(end + 1).some(Boolean)) throw new Error("CatSystem2 CG-list name is invalid.");
  const name = Encoding.decode(bytes.subarray(0, end));
  if (/[\x00-\x1f\\/]/.test(name) || name === "." || name === "..") throw new Error("CatSystem2 CG-list name is unsafe."); return name;
}
/** Bounded compiled CG list: header words and sized blocks of fixed names. */
function parseCgList(bytes) {
  const compiled = Buffer.isBuffer(bytes) && bytes.length > 4 && bytes.subarray(0, 4).equals(Buffer.from("CGL\0"));
  const fileBytes = compiled ? 256 : 64;
  if (compiled) bytes = bytes.subarray(4);
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > LIMITS.bytes || bytes.readUInt32LE(0) !== 0 || bytes.readUInt32LE(4) !== 0 || bytes.readUInt32LE(8) > LIMITS.blocks)
    throw new Error("This CatSystem2 CG-list header is unsupported.");
  const blocks = [], names = new Set(); let offset = 12, totalFiles = 0;
  for (let index = 0; index < bytes.readUInt32LE(8); index++) {
    if (offset > bytes.length - 72) throw new Error("CatSystem2 CG-list block is truncated.");
    const nextOffset = bytes.readUInt32LE(offset), count = bytes.readUInt32LE(offset + 68), length = 72 + count * fileBytes;
    if (nextOffset !== (index === bytes.readUInt32LE(8) - 1 ? 0 : length) || length > bytes.length - offset || (totalFiles += count) > LIMITS.files) throw new Error("CatSystem2 CG-list extents disagree.");
    const name = fixedName(bytes.subarray(offset + 4, offset + 68)), files = [];
    if (names.has(name.toLowerCase())) throw new Error("CatSystem2 CG-list block is repeated."); names.add(name.toLowerCase());
    for (let file = 0; file < count; file++) files.push(fixedName(bytes.subarray(offset + 72 + file * fileBytes, offset + 72 + (file + 1) * fileBytes)));
    blocks.push({ index, name, files }); offset += length;
  }
  if (offset !== bytes.length - 12 || bytes.subarray(offset).some(Boolean)) throw new Error("CatSystem2 CG-list terminal marker is unsupported."); return { blocks, totalFiles };
}
function createCgRegistry({ assets, readStoredData } = {}) {
  if (!assets?.read || typeof readStoredData !== "function") throw new Error("Bounded CatSystem2 CG resources are required.");
  let list = null;
  async function initialize(filename, dataId, listFile) {
    if (!Number.isInteger(dataId) || dataId < 0 || dataId > 0xffffffff) throw new Error("CatSystem2 CG record ID exceeds its range.");
    const parsed = parseCgList(await assets.read(listFile, { maximumBytes: LIMITS.bytes })), stored = await readStoredData(filename);
    if (stored !== null) {
      const records = await decodeStoredData(stored), registration = records.records.get(dataId);
      if (registration?.length) throw new Error("This stored CatSystem2 CG registration format is unsupported.");
    }
    list = parsed; return parsed;
  }
  function registered(selector) {
    if (!list) throw new Error("CatSystem2 CG registration has not been initialized.");
    const block = typeof selector === "number" ? list.blocks[selector] : list.blocks.find(item => item.name.toLowerCase() === String(selector).toLowerCase());
    if (!block) throw new Error("The authored CatSystem2 CG block is absent.");
    // Missing global data or a missing/empty CG record means no CG was seen.
    // Nonempty stored formats are rejected during initialization above.
    return 0;
  }
  return { initialize, registered, get list() { return list; } };
}
module.exports = { LIMITS, parseCgList, createCgRegistry };

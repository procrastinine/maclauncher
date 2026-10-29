const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_CATALOG_ENTRIES = 500;
function entryLimit(maxEntries) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 2000) throw new Error("Runtime catalog limit must be an integer from 1 to 2000.");
  return maxEntries;
}
function catalogPath(userDataDir, managerId, sourceId) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir) || userDataDir.includes("\0") ||
    !/^[a-z0-9-]+$/.test(managerId || "") || sourceId != null && !/^[a-z0-9-]+$/.test(sourceId)) throw new Error("Runtime catalogs require a local data directory and safe manager ID.");
  return path.join(userDataDir, "runtimes", managerId, sourceId ? `catalog-${sourceId}.json` : "catalog.json");
}
function readRuntimeCatalog({ userDataDir, managerId, sourceId, validateEntry = () => true, maxEntries = MAX_CATALOG_ENTRIES } = {}) {
  try {
    const limit = entryLimit(maxEntries);
    const file = catalogPath(userDataDir, managerId, sourceId);
    if (fs.statSync(file).size > 8 * 1024 * 1024) return null;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record.schemaVersion !== 1 || record.managerId !== managerId || (record.sourceId ?? null) !== (sourceId ?? null) || !Array.isArray(record.entries) ||
      record.entries.length > limit || !record.entries.every(validateEntry) ||
      (record.retainedEntries != null && (!Array.isArray(record.retainedEntries) || record.retainedEntries.length > limit || !record.retainedEntries.every(validateEntry)))) return null;
    return record;
  } catch { return null; }
}
function writeRuntimeCatalog({ userDataDir, managerId, sourceId, entries, retainedEntries = [], source, sourceStates, fetchedAt = Date.now(), maxEntries = MAX_CATALOG_ENTRIES } = {}) {
  const limit = entryLimit(maxEntries);
  if (!Array.isArray(entries) || entries.length > limit || !Array.isArray(retainedEntries) || retainedEntries.length > limit) throw new Error("Runtime catalog exceeds its release bound.");
  const file = catalogPath(userDataDir, managerId, sourceId);
  const data = JSON.stringify({ schemaVersion: 1, managerId, fetchedAt, source: source || null, entries, retainedEntries,
    ...(sourceId ? { sourceId } : {}), ...(sourceStates ? { sourceStates } : {}) }, null, 2) + "\n";
  if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw new Error("Runtime catalog exceeds its metadata size bound.");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  try { fs.writeFileSync(temporary, data, { flag: "wx" }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
  return readRuntimeCatalog({ userDataDir, managerId, sourceId, maxEntries });
}

module.exports = { catalogPath, readRuntimeCatalog, writeRuntimeCatalog, MAX_CATALOG_ENTRIES };

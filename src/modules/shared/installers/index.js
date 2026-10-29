const { probeInno } = require("./inno-header");
const Inno = require("./inno");
const fs = require("node:fs");
const path = require("node:path");
const GameData = require("../game-data");

// Shared input containers do not identify an engine. The unpacked data returns
// to the ordinary registry, so every supported engine uses the same import path.
const providers = Object.freeze([{ id: "inno", extensions: ["exe"], probe: probeInno, prepare: Inno.prepareInstaller }]);
function findCachedInputGameId(userDataDir, inputPath) {
  // A completed unpack can precede an unsupported-engine result. Retain that
  // owned generation on the next import rather than unpacking another copy.
  const provider = providers.find(item => item.probe(inputPath));
  if (!provider) return null;
  let entries;
  try { entries = fs.readdirSync(GameData.resolveGamesRoot(userDataDir), { withFileTypes: true }); } catch { return null; }
  if (entries.length > 10000) throw new Error("The game cache inventory exceeds its limit.");
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9A-Za-z_-]+$/.test(entry.name)) continue;
    const file = path.join(GameData.resolveGameDir(userDataDir, entry.name), "containers", provider.id, "current.json");
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) continue;
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      if ([1, 2].includes(record.schemaVersion) && /^[a-f0-9]{64}$/.test(record.key || "") && record.sources?.[0]?.path === inputPath) return entry.name;
    } catch {}
  }
  return null;
}
async function prepareInput(inputPath, options) {
  for (const provider of providers) {
    const probe = provider.probe(inputPath);
    if (probe) {
      try { return await provider.prepare(inputPath, { ...options, probe }); }
      catch (error) {
        // Discovery/download failures still belong to the installer reader,
        // rather than to game detection. Keep its diagnostic for logging.
        if (error.code === "ABORT_ERR" || error.name === "AbortError" || String(error.code).startsWith("INSTALLER_")) throw error;
        const failure = new Error(error.message, { cause: error });
        failure.code = "INSTALLER_READER_FAILED";
        if (error.stack) failure.stack += `\nCaused by: ${error.stack}`;
        throw failure;
      }
    }
  }
  return { inputPath, containerData: null };
}
function containerSourcesUnchanged(data) {
  try { return !data || data.sources.every(item => Inno.identity(item.path) === item.identity); } catch { return false; }
}
module.exports = { providers, prepareInput, containerSourcesUnchanged, findCachedInputGameId };

// Backcompat: MacLauncher 0.5.1 stat-only Inno extraction receipts (schema 1).
// Conversion runs once per existing game through the persisted migration, not
// import or Play. Remove after these profiles are no longer supported. The
// named historical-generation predicate only validates converted metadata;
// it never reads or hashes the mutable extracted game.
const path = require("node:path");
const GameData = require("../../game-data");
const Bundled = require("../../runtime/bundled-native");
const { probeInno, installerError } = require("../inno-header");
const SHA256 = /^[a-f0-9]{64}$/;

function isHistoricalGeneration(receipt, index, file) {
  const Inno = require("../inno"), origin = receipt?.legacyGeneration;
  const sources = origin && Inno.sourceList(origin.sources, file);
  if (!sources || !SHA256.test(origin.helperIdentity || "")) return false;
  // The conversion retains its physical generation, even after Locate changes
  // archive paths. Earlier schema-2 receipts derive that same key directly.
  return origin.key === undefined ? Inno.cacheKey(origin.helperIdentity, sources) === index.key :
    SHA256.test(origin.key) && origin.key === index.key;
}

async function migrateLegacyGameData(entry, context = {}) {
  if (entry?.containerData?.format !== "inno") return null;
  const Inno = require("../inno"), { userDataDir, signal } = context;
  if (!path.isAbsolute(userDataDir || "")) throw installerError("The MacLauncher data folder is unknown, so this game's earlier installer extraction was not converted. Its files were left unchanged. Copy any needed files from this folder before removing the game.", "INSTALLER_CACHE_INVALID");
  const cacheRoot = path.join(GameData.resolveGameDir(userDataDir, entry.gameId), "containers", "inno");
  if (!Bundled.realDirectory(cacheRoot)) return null;
  const index = Inno.readReceipt(path.join(cacheRoot, "current.json"));
  if (index?.schemaVersion === 2) return null;
  const invalid = () => installerError("The installer or the record of its earlier extraction has changed, so that extraction was not converted. Its files were left unchanged. Copy any needed files from this folder before removing the game.", "INSTALLER_CACHE_INVALID");
  if (index?.schemaVersion !== 1 || !SHA256.test(index.key || "")) throw invalid();
  const file = entry.containerData.sourcePath, generation = path.join(cacheRoot, index.key);
  if (!path.isAbsolute(file || "") || entry.containerData.key !== index.key ||
      path.resolve(entry.containerData.extractedRoot || "") !== path.join(generation, "files") || !Bundled.realDirectory(generation)) throw invalid();
  const receipt = Inno.readReceipt(Inno.receiptPath(generation, index));
  const sources = Inno.sourceList(index.sources, file), probe = probeInno(file);
  const helper = context.helper || Inno.resolveHelper({ ...context, entry });
  if (!sources || !probe || index.helperIdentity !== helper.identity || index.sourceIdentity !== sources[0].identity ||
      Inno.cacheKey(helper.identity, sources) !== index.key || receipt?.schemaVersion !== 1 || receipt.format !== "inno" ||
      receipt.key !== index.key || receipt.helperIdentity !== helper.identity || receipt.helperVersion !== helper.version ||
      (receipt.sourceRevision !== undefined && receipt.sourceRevision !== helper.sourceRevision) ||
      typeof receipt.formatVersion !== "string" || receipt.formatVersion.split(" ")[0] !== probe.formatVersion ||
      /\(unicode\)/.test(receipt.formatVersion) !== probe.unicode || JSON.stringify(receipt.sources) !== JSON.stringify(sources) ||
      !Inno.validCachedFiles(receipt.files) || sources.some(source => Inno.identity(source.path) !== source.identity)) throw invalid();
  await Inno.validateOutput(path.join(generation, "files"), receipt.files, { signal, cached: true });
  const compatibility = await Inno.helperCacheIdentity(helper, { signal });
  // Only unchanged originals establish archive hashes. The old extracted-file
  // facts stay unchanged and explicitly unhashed; saves and patches are valid.
  const hashed = await Inno.contentSources(sources, { signal });
  if (sources.some(source => Inno.identity(source.path) !== source.identity)) throw invalid();
  const next = Inno.upgradedRecords(receipt, helper, compatibility, hashed, receipt.files, { legacy: true });
  Inno.validateCacheReceipt(next.receipt, next.index, { file, probe, helper });
  signal?.throwIfAborted();
  Inno.publishCache(cacheRoot, generation, next.index, next.receipt);
  return { complete: true, entryPatch: { containerData: {
    ...entry.containerData, ...Inno.cacheResult(file, generation, next.index, next.receipt, helper).containerData
  } } };
}

module.exports = { migrateLegacyGameData, isHistoricalGeneration };

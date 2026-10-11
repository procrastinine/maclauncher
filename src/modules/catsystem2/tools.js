const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Inspect = require("./inspect");
const Archive = require("./archive");
const Scene = require("./scene");
const Localization = require("./localization");
const FrontEnd = require("./frontend-script");
const Crypto = require("./runtime/crypto");
const B = require("../shared/runtime/bundled-native");
const GameData = require("../shared/game-data");
const LIMITS = Object.freeze({ indexBytes: 16 * 1024 * 1024, entries: 100000, scripts: 1024, storedBytes: 64 * 1024 * 1024,
  decodedBytes: 128 * 1024 * 1024, exportBytes: 256 * 1024 * 1024 });

function game(entry) {
  const root = entry.contentRootDir || entry.gamePath, data = Inspect.inspectGame(root, { inputPath: entry.moduleData?.originalRunnerPath });
  if (!data) throw new Error("A CatSystem2 original runner and bounded scene.int KIF header were not found.");
  return data;
}

async function withArchives(entry, context, operation) {
  const data = game(entry), archives = [];
  let helper, seed, indexBytes = 0, entries = 0;
  if (data.archives.some(archive => archive.encrypted)) {
    helper = await Crypto.resolveHelper({ resourcesRoot: context?.resourcesRoot });
    seed = await Archive.readTocSeed(data.originalRunnerPath, helper, { signal: context?.signal });
  }
  try {
    for (const item of data.archives) {
      if (indexBytes >= LIMITS.indexBytes) throw new Error("CatSystem2 indexes exceed their aggregate inspection limit.");
      const archive = await Archive.inspectArchive(item.path, { helper, tocSeed: seed, maximumIndexBytes: Math.min(Archive.LIMITS.indexBytes, LIMITS.indexBytes - indexBytes), signal: context?.signal });
      archives.push(archive); indexBytes += archive.indexBytes; entries += archive.entries.length;
      if (entries > LIMITS.entries) throw new Error("CatSystem2 archive members exceed their aggregate inspection limit.");
    }
    return await operation({ data, archives, helper, indexBytes, entries });
  } finally { for (const archive of archives) Archive.releaseArchive(archive); }
}

async function inspectArchives(entry, _payload, context) {
  return withArchives(entry, context, ({ data, archives, helper, indexBytes, entries }) => ({
    archiveFormat: "KIF-64", archiveCount: archives.length, entryCount: entries, indexBytes,
    encryptedArchives: archives.filter(archive => archive.encrypted).length,
    scriptCount: archives.reduce((count, archive) => count + archive.entries.filter(entry => /\.(?:cst|cstl|fes)$/i.test(entry.name)).length, 0),
    duplicateNames: archives.reduce((count, archive) => count + archive.duplicateNames, 0),
    engineVersion: data.detectedVersion, helperVersion: helper?.version || null,
    requiredFeatures: data.requiredFeatures, compatibility: data.compatibility,
    archives: archives.map(archive => ({ archive: path.basename(archive.path), format: archive.format, bytes: archive.bytes, encrypted: archive.encrypted,
      duplicateNames: archive.duplicateNames, entries: archive.entries }))
  }));
}

async function scripts(archives, context, operation) {
  let count = 0, storedBytes = 0, decodedBytes = 0, lineCount = 0, localizationCount = 0;
  const records = [], languages = new Set(), unknownTypes = new Set();
  for (const archive of archives) for (const entry of archive.entries.filter(entry => /\.(?:cst|cstl|fes)$/i.test(entry.name))) {
    context?.signal?.throwIfAborted();
    if (++count > LIMITS.scripts || (storedBytes += entry.length) > LIMITS.storedBytes) throw new Error("CatSystem2 scripts exceed their aggregate read limit.");
    const bytes = await Archive.readEntry(archive, entry, { maximumBytes: Scene.LIMITS.storedBytes, signal: context?.signal });
    const localized = /\.cstl$/i.test(entry.name), frontEnd = /\.fes$/i.test(entry.name);
    const script = localized ? Localization.inspectLocalization(bytes) : frontEnd ? await FrontEnd.inspectFrontEndScript(bytes) : await Scene.inspectScene(bytes);
    decodedBytes += script.decodedBytes || script.storedBytes;
    if (decodedBytes > LIMITS.decodedBytes) throw new Error("CatSystem2 decoded scripts exceed their aggregate size limit.");
    for (const language of script.languages || []) languages.add(language);
    for (const type of script.unknownTypes || []) unknownTypes.add(type);
    lineCount += script.lineCount || 0; localizationCount += script.messageCount || 0;
    const record = { archive: path.basename(archive.path), name: entry.name, index: entry.index, format: script.format,
      storedBytes: bytes.length, decodedBytes: script.decodedBytes || bytes.length, sha256: B.digest(bytes),
      ...(localized ? { languages: script.languages, messageCount: script.messageCount } : frontEnd ? { lineCount: script.lineCount, executionSupported: false } :
        { lineCount: script.lineCount, inputCount: script.inputCount, unknownTypes: script.unknownTypes }) };
    await operation?.({ archive, entry, bytes, script, localized, frontEnd, record }); records.push(record);
    // Keep explicit inspection/export work responsive without runtime/Electron
    // state dependencies; large zlib decompression already uses Node's workers.
    await new Promise(resolve => setImmediate(resolve));
  }
  return { scriptCount: count, storedBytes, decodedBytes, lineCount, localizationCount,
    languages: [...languages].sort(), unknownTypes: [...unknownTypes].sort((a, b) => a - b), scripts: records };
}

function inspectScripts(entry, _payload, context) {
  return withArchives(entry, context, async ({ archives, data, helper }) => ({ ...(await scripts(archives, context)),
    engineVersion: data.detectedVersion, helperVersion: helper?.version || null, compatibility: data.compatibility }));
}

function outputRoot(entry, context) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(entry.gameId || "") || !path.isAbsolute(context?.userDataDir || "")) throw new Error("Import this game before exporting its CatSystem2 data.");
  const parent = GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "catsystem2");
  B.realDirectory(context.userDataDir, { create: true });
  let current = fs.realpathSync(context.userDataDir);
  for (const component of path.relative(context.userDataDir, parent).split(path.sep)) {
    current = path.join(current, component);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) throw new Error("CatSystem2 export directories cannot use symlinks.");
  }
  return current;
}

async function exportOperation(entry, context, name, operation) {
  const parent = outputRoot(entry, context), staging = await fs.promises.mkdtemp(path.join(parent, ".export-")), destination = path.join(parent, `${name}-${crypto.randomUUID()}`);
  let total = 0;
  async function write(relative, bytes) {
    B.relativeFile(relative); const target = path.join(staging, relative);
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if ((total += content.length) > LIMITS.exportBytes) throw new Error("CatSystem2 export exceeds its output byte limit.");
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(target, content, { flag: "wx", mode: 0o600 });
  }
  try {
    const report = await operation(write);
    await write("manifest.json", JSON.stringify(report, null, 2) + "\n");
    context?.signal?.throwIfAborted(); await fs.promises.rename(staging, destination);
    return { ...report, path: destination, exportedBytes: total };
  } finally { await fs.promises.rm(staging, { recursive: true, force: true }); }
}

const memberOutput = (archive, entry) => `${path.basename(archive.path)}/entries/${String(entry.index).padStart(6, "0")}/${entry.name}`;

function exportScripts(entry, _payload, context) {
  return withArchives(entry, context, ({ archives, data, helper }) => exportOperation(entry, context, "scripts", async write => {
    const report = await scripts(archives, context, async ({ archive, entry, bytes, script, localized, frontEnd }) => {
      const relative = memberOutput(archive, entry);
      await write(relative, bytes); await write(relative + ".json", JSON.stringify(script, null, 2) + "\n");
      await write(relative + ".txt", localized ? Localization.decompile(script) : frontEnd ? script.text : Scene.decompile(script));
    });
    if (!report.scriptCount) throw new Error("No supported CatScene, CSTL or FES members were found for script export.");
    return { schemaVersion: 1, ...report, engineVersion: data.detectedVersion, helperVersion: helper?.version || null,
      scope: "indexed-original-members-with-readable-script-and-localization-transcripts", originalFilesChanged: false, compilerRoundTripSupported: false };
  }));
}

function exportArchive(entry, payload, context) {
  const selected = payload?.archive || "scene.int";
  if (typeof selected !== "string" || selected !== path.basename(selected) || !/\.int$/i.test(selected)) throw new Error("Choose one original .int archive by filename.");
  return withArchives(entry, context, ({ archives, data, helper }) => {
    const matches = archives.filter(archive => path.basename(archive.path).toLowerCase() === selected.toLowerCase());
    if (matches.length !== 1) throw new Error("The selected CatSystem2 archive was not found unambiguously.");
    return exportOperation(entry, context, "archive", async write => {
      const archive = matches[0]; let storedBytes = 0;
      for (const member of archive.entries) {
        context?.signal?.throwIfAborted();
        if ((storedBytes += member.length) > LIMITS.exportBytes) throw new Error("Selected CatSystem2 archive exceeds its export limit.");
        await write(memberOutput(archive, member), await Archive.readEntry(archive, member, { signal: context?.signal }));
      }
      return { schemaVersion: 1, archive: path.basename(archive.path), entryCount: archive.entries.length, duplicateNames: archive.duplicateNames,
        storedBytes, engineVersion: data.detectedVersion, helperVersion: helper?.version || null, originalFilesChanged: false };
    });
  });
}

module.exports = { LIMITS, game, withArchives, inspectArchives, inspectScripts, exportScripts, exportArchive, outputRoot };

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { inspectRoot } = require("./detect");
const { openArchive } = require("./archive");
const { moduleDir, sourceFiles } = require("./prepare");
const { assertOwnDirectory, atomicWrite } = require("../shared/writable-input");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const { getUiServices } = require("../shared/ui-services");

function assets(entry) {
  const data = inspectRoot(entry.gamePath), archives = [], files = new Map();
  if (!data) throw new Error("WOLF RPG game data was not found.");
  function addArchive(file, prefix) {
    const archive = openArchive(file);
    if (!archive) throw Object.assign(new Error("This WOLF archive format needs extended extraction. Use Extract WOLF Pro assets or open unpacked game data."), { code: "WOLF_ARCHIVE_UNSUPPORTED" });
    archives.push(archive);
    for (const item of archive.entries) {
      const name = prefix + "/" + item.name;
      files.set(name.toLowerCase(), { name, size: item.size, read: () => archive.readEntry(item) });
    }
  }
  try {
    if (data.archivePath) addArchive(data.archivePath, "Data");
    if (data.dataDir) {
      const loose = sourceFiles(data.dataDir);
      // Partial archives are folders in the extracted view. Loose assets take
      // precedence over archived copies, as they do during ordinary play.
      for (const item of loose.filter(item => /\.wolf$/i.test(item.name))) addArchive(path.join(data.dataDir, item.name), "Data/" + item.name.slice(0, -5));
      for (const item of loose.filter(item => !/\.wolf$/i.test(item.name))) {
        const name = "Data/" + item.name;
        files.set(name.toLowerCase(), { name, size: item.size, read: () => fs.readFileSync(path.join(data.dataDir, item.name)) });
      }
    }
    const entries = [...files.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length > 100000 || entries.some(item => !Number.isSafeInteger(item.size) || item.size > 256 * 1024 ** 2) || entries.reduce((sum, item) => sum + item.size, 0) > 8 * 1024 ** 3) throw new Error("WOLF assets exceed the extraction limit.");
    return { entries, versions: [...new Set(archives.map(archive => archive.version))], close: () => archives.forEach(archive => archive.close()) };
  } catch (error) { archives.forEach(archive => archive.close()); throw error; }
}
function exportDir(entry, context) {
  const owned = moduleDir(entry, context), directory = path.join(owned, "exports");
  assertOwnDirectory(context.userDataDir, directory); return directory;
}
function remember(entry, context, value) {
  entry.moduleData = { ...entry.moduleData, ...value };
  context.onEntryChange?.({ moduleData: entry.moduleData });
}
function listArchive(entry, _payload, context) {
  const source = assets(entry);
  try {
    throwIfAborted(context.signal);
    const outputPath = path.join(exportDir(entry, context), "archive-list.json");
    const result = { fileCount: source.entries.length, bytes: source.entries.reduce((sum, item) => sum + item.size, 0), archiveVersions: source.versions };
    atomicWrite(outputPath, JSON.stringify({ ...result, files: source.entries.map(({ name, size }) => ({ name, size })) }, null, 2) + "\n", { root: moduleDir(entry, context) });
    remember(entry, context, { archiveListPath: outputPath }); return { ...result, outputPath };
  } finally { source.close(); }
}
function extractAssets(entry, _payload, context) {
  const directory = exportDir(entry, context), outputDir = path.join(directory, "assets"), temporary = path.join(directory, ".extract-" + crypto.randomUUID()), previous = path.join(directory, ".previous-" + crypto.randomUUID());
  // Reject pre-existing aliases before extraction or replacement. All asset
  // writes go to a fresh private directory, then publish in a single rename.
  assertOwnDirectory(directory, outputDir, { create: false });
  assertOwnDirectory(directory, temporary);
  let source;
  try {
    source = assets(entry); let bytes = 0;
    for (const item of source.entries) {
      throwIfAborted(context.signal);
      const file = path.join(temporary, ...item.name.split("/"));
      assertOwnDirectory(temporary, path.dirname(file));
      const contents = item.read();
      if (contents.length !== item.size) throw new Error("WOLF asset size does not match.");
      fs.writeFileSync(file, contents, { flag: "wx", mode: 0o600 }); bytes += contents.length;
    }
    throwIfAborted(context.signal);
    const existing = fs.existsSync(outputDir);
    if (existing) fs.renameSync(outputDir, previous);
    try { fs.renameSync(temporary, outputDir); } catch (error) { if (existing) fs.renameSync(previous, outputDir); throw error; }
    fs.rmSync(previous, { recursive: true, force: true });
    remember(entry, context, { assetExportDir: outputDir });
    return { outputDir, fileCount: source.entries.length, bytes };
  } finally { source?.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
}
function revealAssets(entry, _payload, context) {
  const directory = exportDir(entry, context), file = path.join(directory, "assets");
  assertOwnDirectory(directory, file, { create: false });
  if (!fs.existsSync(file)) throw new Error("Extract game assets before opening the export folder.");
  getUiServices(context).shell.showItemInFolder(file); return { outputDir: file };
}
function removeAssets(entry, _payload, context) {
  const directory = exportDir(entry, context), file = path.join(directory, "assets");
  assertOwnDirectory(directory, file, { create: false }); fs.rmSync(file, { recursive: true, force: true });
  remember(entry, context, { assetExportDir: null }); return { removed: true };
}
module.exports = { listArchive, extractAssets, revealAssets, removeAssets, assets };

const fs = require("node:fs");
const path = require("node:path");
const Snapshots = require("../modules/shared/save-snapshots");
const { writeSaveWithBackup } = require("../modules/shared/save-files");
const { hydrateGameSaveLocations } = require("./save-locations");
const { prepareModuleInput } = require("../modules/shared/writable-input");

const ACTIONS = new Set(["createSaveSnapshot", "listSaveSnapshots", "previewSaveSnapshot", "restoreSaveSnapshot",
  "readSaveDocument", "writeSaveDocument", "importSaveFolder", "importSaveFiles"]);

function createSaveService({ userDataDir, registry, isGameRunning = () => false }) {
  function options(entry) {
    // Save operations can resolve their owned directory without allocating an
    // entire runtime view, including direct consumers outside the launcher.
    entry = prepareModuleInput(entry, registry, { userDataDir, runtimeId: entry.runtimeId, readOnly: true });
    entry = hydrateGameSaveLocations(entry, registry, { userDataDir, runtimeId: entry.runtimeId });
    const moduleId = entry.moduleId || entry.engine;
    const mod = registry.getModule(moduleId);
    const provider = mod?.getRuntimeProvider?.(entry.runtimeId);
    if (provider?.supports?.saveLocation === false) throw new Error("Save tools are unavailable for this runtime.");
    const saveDir = entry.saveDirOverride || entry.defaultSaveDir;
    if (typeof saveDir !== "string" || !path.isAbsolute(saveDir)) throw new Error("An absolute save directory is required.");
    const save = provider ? provider.save : mod?.save;
    const extensions = save?.extensions;
    const names = save?.names;
    return { userDataDir, entry, saveDir, extensions, names, recursive: save?.recursive !== false };
  }
  function assertWriteAllowed(entry) {
    if (isGameRunning(entry)) throw new Error("Stop the game before changing its saves.");
  }
  function createSnapshot(entry, payload = {}) { return Snapshots.createSnapshot({ ...options(entry), reason: payload.reason }); }
  function assertSaveName(fileName, opts) {
    const normalized = Snapshots.relativeName(fileName).normalize("NFC").toLowerCase();
    const basename = path.posix.basename(fileName);
    if (basename.toLowerCase().includes(".maclauncher.") || basename.toLowerCase().startsWith(".maclauncher-")) throw new Error("Recovery and editor sidecars cannot be edited or imported as saves.");
    if (opts.extensions?.length && !opts.extensions.some(ext => normalized.endsWith(`.${String(ext).replace(/^\./, "").toLowerCase()}`)) && !opts.names?.includes(basename)) {
      throw new Error("File does not match this engine's save formats.");
    }
    return normalized;
  }
  function resolveSaveFile(entry, fileName) {
    if (typeof fileName !== "string" || path.basename(fileName) !== fileName || fileName === "." || fileName === "..") throw new Error("Invalid save filename.");
    Snapshots.relativeName(fileName);
    const opts = options(entry);
    assertSaveName(fileName, opts);
    if (!Snapshots.checkDirectory(opts.saveDir)) throw new Error("Save directory not found.");
    return path.join(opts.saveDir, fileName);
  }
  function codec(entry) {
    const mod = registry.getModule(entry.moduleId || entry.engine);
    const info = registry.getModuleInfo(entry.moduleId || entry.engine);
    const provider = mod?.getRuntimeProvider?.(entry.runtimeId);
    if (provider && (provider.supports?.saveEditing !== true || !provider.save?.decode || !provider.save?.encode)) throw new Error("JSON save editing is unavailable for this runtime.");
    if (provider) return provider.save;
    if (!info.supports?.saveEditing || !mod?.save?.decode || !mod?.save?.encode) throw new Error("JSON save editing is unavailable for this engine.");
    return mod.save;
  }
  function readDocument(entry, payload) {
    const file = Snapshots.readRegular(resolveSaveFile(entry, payload.fileName));
    const save = codec(entry);
    const json = save.decode(save.binary === true ? file.bytes : file.bytes.toString("utf8"), { maxOutputBytes: Snapshots.LIMITS.fileBytes });
    if (typeof json !== "string" || Buffer.byteLength(json) > Snapshots.LIMITS.fileBytes) throw new Error("Decoded save exceeds the size limit.");
    JSON.parse(json);
    return { fileName: payload.fileName, json, sourceHash: file.sha256 };
  }
  function writeDocument(entry, payload) {
    assertWriteAllowed(entry);
    const filePath = resolveSaveFile(entry, payload.fileName);
    const current = Snapshots.readRegular(filePath);
    if (typeof payload.expectedHash !== "string" || payload.expectedHash !== current.sha256) throw new Error("Save changed or edit version missing. Reload the save before writing.");
    if (typeof payload.json !== "string" || Buffer.byteLength(payload.json) > Snapshots.LIMITS.fileBytes) throw new Error("Invalid or oversized JSON save.");
    JSON.parse(payload.json);
    const save = codec(entry);
    // Preserve the JSON source, including unknown fields and numeric tokens.
    const encoded = save.encode(payload.json);
    const encodedBytes = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded, "utf8");
    if (encodedBytes.length > Snapshots.LIMITS.fileBytes) throw new Error("Encoded save exceeds the size limit.");
    const decoded = save.decode(save.binary === true ? encodedBytes : encodedBytes.toString("utf8"), { maxOutputBytes: Snapshots.LIMITS.fileBytes });
    if (decoded !== payload.json) throw new Error("Save codec failed its roundtrip validation.");
    const snapshot = createSnapshot(entry, { reason: "before-json-edit" });
    if (Snapshots.readRegular(filePath).sha256 !== current.sha256) throw new Error("Save changed during backup. Reload and retry.");
    writeSaveWithBackup(filePath, encoded, { expectedHash: current.sha256 });
    return { saved: true, snapshotId: snapshot.id, sourceHash: Snapshots.hash(encodedBytes) };
  }
  function importFiles(entry, files) {
    assertWriteAllowed(entry);
    const opts = options(entry);
    const seen = new Set();
    let total = 0;
    for (const file of files) {
      const key = assertSaveName(file.name, opts);
      if (seen.has(key)) throw new Error("Duplicate import filenames.");
      seen.add(key);
      total += file.bytes.length;
      if (files.length > Snapshots.LIMITS.files || total > Snapshots.LIMITS.bytes) throw new Error("Save import exceeds size limits.");
    }
    const expectedStateHash = Snapshots.stateHash(Snapshots.collectFiles(opts.saveDir, opts));
    const snapshot = createSnapshot(entry, { reason: "before-import" });
    Snapshots.replaceFiles({ ...opts, files, expectedStateHash });
    return { imported: files.length, snapshotId: snapshot.id };
  }
  async function runAction(entry, actionId, payload = {}) {
    const opts = options(entry);
    switch (actionId) {
      case "createSaveSnapshot": return createSnapshot(entry, payload);
      case "listSaveSnapshots": return Snapshots.listSnapshots({ userDataDir, gameId: entry.gameId });
      case "previewSaveSnapshot": return Snapshots.previewRestore({ ...opts, snapshotId: payload.snapshotId });
      case "restoreSaveSnapshot":
        assertWriteAllowed(entry);
        return Snapshots.restoreSnapshot({ ...opts, snapshotId: payload.snapshotId, expectedStateHash: payload.expectedStateHash });
      case "readSaveDocument": return readDocument(entry, payload);
      case "writeSaveDocument": return writeDocument(entry, payload);
      case "importSaveFolder": {
        if (typeof payload.directory !== "string" || !path.isAbsolute(payload.directory) || !Snapshots.checkDirectory(payload.directory)) throw new Error("Import directory not found.");
        const source = fs.realpathSync(payload.directory);
        const dest = path.resolve(opts.saveDir);
        if (source === dest || source.startsWith(dest + path.sep) || dest.startsWith(source + path.sep)) throw new Error("Import source and save destination must be separate directories.");
        return importFiles(entry, Snapshots.collectFiles(source, opts));
      }
      case "importSaveFiles": {
        if (!Array.isArray(payload.filePaths) || !payload.filePaths.length || payload.filePaths.length > Snapshots.LIMITS.files) throw new Error("Provide save file paths to import.");
        const paths = [], seen = new Set();
        for (const source of payload.filePaths) {
          if (typeof source !== "string" || !path.isAbsolute(source)) throw new Error("Import paths must be absolute.");
          const key = assertSaveName(path.basename(source), opts);
          if (seen.has(key)) throw new Error("Duplicate import filenames.");
          seen.add(key);
          Snapshots.checkDirectory(path.dirname(source));
          const stat = fs.lstatSync(source);
          if (!stat.isFile() || stat.size > Snapshots.LIMITS.fileBytes) throw new Error("Import file is not regular or exceeds the size limit.");
          paths.push({ source, size: stat.size });
        }
        if (paths.reduce((sum, file) => sum + file.size, 0) > Snapshots.LIMITS.bytes) throw new Error("Save import exceeds size limits.");
        const files = [];
        let total = 0;
        for (const { source } of paths) {
          const file = Snapshots.readRegular(source, Math.min(Snapshots.LIMITS.fileBytes, Snapshots.LIMITS.bytes - total));
          total += file.size;
          files.push({ name: path.basename(source), ...file });
        }
        return importFiles(entry, files);
      }
      default: throw new Error(`Unknown save action: ${actionId}`);
    }
  }
  function listFiles(entry) {
    const opts = options(entry);
    return Snapshots.collectFiles(opts.saveDir, opts).map(({ name, size, mtimeMs }) => ({ name, size, mtimeMs, path: path.join(opts.saveDir, name) }));
  }
  function exportFolder(entry, directory) {
    if (typeof directory !== "string" || !path.isAbsolute(directory) || fs.existsSync(directory)) throw new Error("Export requires a new absolute destination folder.");
    const opts = options(entry);
    const files = Snapshots.collectFiles(opts.saveDir, opts);
    try {
      Snapshots.checkDirectory(directory, { create: true });
      for (const file of files) {
        const target = path.join(directory, file.name);
        Snapshots.checkDirectory(path.dirname(target), { create: true });
        fs.writeFileSync(target, file.bytes, { flag: "wx", mode: 0o600 });
      }
      return directory;
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }
  function prepareExternalDocument(entry, { fileName, json } = {}) {
    codec(entry);
    if (typeof json !== "string" || Buffer.byteLength(json) > Snapshots.LIMITS.fileBytes) throw new Error("External JSON exceeds the size limit.");
    const file = `${resolveSaveFile(entry, fileName)}.maclauncher.json`;
    try { Snapshots.readRegular(file); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      fs.writeFileSync(file, json, { flag: "wx", mode: 0o600, encoding: "utf8" });
    }
    return file;
  }
  function readExternalDocument(entry, { fileName } = {}) {
    codec(entry);
    const file = `${resolveSaveFile(entry, fileName)}.maclauncher.json`;
    return Snapshots.readRegular(file).bytes.toString("utf8");
  }
  return { hasAction: actionId => ACTIONS.has(actionId), runAction, createSnapshot, assertWriteAllowed, resolveSaveFile, listFiles, exportFolder,
    prepareExternalDocument, readExternalDocument };
}

module.exports = { createSaveService };

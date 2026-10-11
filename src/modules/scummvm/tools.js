const fs = require("node:fs");
const path = require("node:path");
const manager = require("./runtime/tools-manager");
const GameData = require("../shared/game-data");
const { confirmToolInstall } = require("../shared/runtime/tool-install");
const { runToolCommand } = require("../shared/runtime/tool-command");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const { withRuntimeMutation, withRuntimeUse } = require("../../core/coordinated-runtime-managers");
const SAFE_NAME = name => name && name.length <= 255 && !/[\x00-\x1f\/\\:]/.test(name) && name !== "." && name !== "..";

function candidates(root) {
  try {
    const files = fs.readdirSync(root, { withFileTypes: true });
    if (files.length > 4096) return [];
    return files.filter(file => file.isFile() && SAFE_NAME(file.name) && /\.(?:stk|itk|ltk|jtk|pak)$/i.test(file.name))
      .map(file => ({ name: file.name, tool: /\.pak$/i.test(file.name) ? "extract_kyra" : "extract_gob_stk" }));
  } catch { return []; }
}
function readAt(fd, size, offset) {
  const data = Buffer.alloc(size);
  if (fs.readSync(fd, data, 0, size, offset) !== size) throw new Error("Game archive is truncated.");
  return data;
}
// Validate output names before passing a third-party archive to an extractor.
// Classic STK and DOS PAK inventories are small; game assets stay read-only.
function validateArchive(file, tool) {
  const size = fs.statSync(file).size, fd = fs.openSync(file, "r");
  try {
    if (tool === "extract_gob_stk") {
      const first = readAt(fd, 6, 0);
      if (first.toString("ascii") === "STK2.1") throw new Error("STK 2.1 archives are not supported by this extraction action.");
      const count = first.readUInt16LE(0), tableSize = count * 22;
      if (!count || count > 4096 || tableSize + 2 > size) throw new Error("Gob archive inventory is invalid.");
      const table = readAt(fd, tableSize, 2);
      for (let i = 0; i < count; i++) {
        const offset = i * 22, rawName = table.subarray(offset, offset + 13), zero = rawName.indexOf(0);
        const name = rawName.subarray(0, zero).toString("latin1");
        if (zero === -1 || !SAFE_NAME(name)) throw new Error("Gob archive contains an unsafe file name.");
        const length = table.readUInt32LE(offset + 13), position = table.readUInt32LE(offset + 17);
        if (position < tableSize + 2 || position > size || length > 512 * 1024 * 1024 || length > size - position) throw new Error("Gob archive entry is invalid.");
        if (table[offset + 21] && !name.includes("0OT")) {
          if (length < 8) throw new Error("Gob compressed archive entry is truncated.");
          const unpackedSize = readAt(fd, 4, position).readUInt32LE(0);
          if (!unpackedSize || unpackedSize > 512 * 1024 * 1024) throw new Error("Gob compressed archive entry size is invalid.");
        }
      }
      return count;
    }
    if (tool !== "extract_kyra") throw new Error("Unsupported ScummVM extraction format.");
    const length = Math.min(size, 1024 * 1024), data = readAt(fd, length, 0), firstOffset = data.readUInt32LE(0);
    if (firstOffset < 5 || firstOffset > size || firstOffset > data.length) throw new Error("Kyrandia DOS PAK inventory is invalid.");
    let cursor = 4, previousOffset = firstOffset, count = 0;
    while (cursor < firstOffset) {
      const zero = data.indexOf(0, cursor);
      if (zero < cursor || zero >= firstOffset || zero - cursor > 255) throw new Error("Kyrandia DOS PAK file name is invalid.");
      if (zero === cursor) return count;
      if (!SAFE_NAME(data.toString("latin1", cursor, zero)) || ++count > 4096) throw new Error("Kyrandia DOS PAK contains an unsafe file name.");
      cursor = zero + 1;
      if (cursor + 4 > firstOffset) throw new Error("Kyrandia DOS PAK inventory is truncated.");
      const next = data.readUInt32LE(cursor); cursor += 4;
      if (next !== 0 && (next < previousOffset || next > size)) throw new Error("Kyrandia DOS PAK entry is invalid.");
      if (next === 0) return count;
      previousOffset = next;
    }
    throw new Error("Kyrandia DOS PAK inventory is missing its terminator.");
  } finally { fs.closeSync(fd); }
}
function outputParent(entry, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(context.userDataDir || "")) throw new Error("Archive extraction requires a saved game entry.");
  return path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "scummvm"), "extracted");
}
async function ensureTools(entry, context) {
  const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
  if (selection.ready) return selection;
  await confirmToolInstall(context, { manager, version: selection.version, requiresDownload: true, detail: "Required to extract supported game archives." });
  await withRuntimeMutation({ managerId: manager.id, version: selection.version }, () => manager.installRuntime({
    userDataDir: context.userDataDir, version: selection.version, downloads: context.downloads, signal: context.signal, logger: context.logger }), { userDataDir: context.userDataDir });
  context.onRuntimeStateChange?.();
  const ready = manager.resolveSelection(entry, context.settings, context.userDataDir);
  if (!ready.ready) throw new Error(ready.reason);
  return ready;
}
async function extractArchives(entry, _payload, context, dependencies = {}) {
  const root = entry.contentRootDir || entry.gamePath, archives = candidates(root);
  if (!archives.length) throw new Error("No supported Gob or Kyrandia archives were found in this game folder.");
  for (const archive of archives) validateArchive(path.join(root, archive.name), archive.tool);
  const selected = await (dependencies.ensureTools || ensureTools)(entry, context);
  if (selected.install.needsRosetta && context.ensureRosetta) await context.ensureRosetta();
  const identity = { managerId: manager.id, version: selected.version };
  return withRuntimeUse([identity], async use => {
    if (!dependencies.ensureTools && !manager.resolveSelection(entry, context.settings, context.userDataDir).ready) throw new Error("ScummVM Tools changed before extraction. Try again.");
    const parent = outputParent(entry, context); fs.mkdirSync(parent, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(parent, ".extract-")), outputRoot = path.join(parent, selected.version);
    try {
      const logPath = path.join(temporary, "extract.log");
      for (const archive of archives) {
        throwIfAborted(context.signal);
        const destination = path.join(temporary, archive.name); fs.mkdirSync(destination);
        await (dependencies.runCommand || runToolCommand)(selected.install.executablePath,
          ["--tool", archive.tool, "-o", destination + path.sep, path.join(root, archive.name)],
          { cwd: temporary, logPath, signal: context.signal, timeout: 300000,
            onSpawn: child => Promise.all([use.bind(child.pid), context.onToolProcessSpawn?.(child)]) });
      }
      const result = { outputRoot, toolVersion: selected.version, archiveCount: archives.length, archives: archives.map(item => item.name) };
      fs.writeFileSync(path.join(temporary, "extract.json"), JSON.stringify(result, null, 2));
      const previous = outputRoot + ".previous";
      fs.rmSync(previous, { recursive: true, force: true });
      if (fs.existsSync(outputRoot)) fs.renameSync(outputRoot, previous);
      try { fs.renameSync(temporary, outputRoot); }
      catch (error) { if (fs.existsSync(previous)) fs.renameSync(previous, outputRoot); throw error; }
      fs.rmSync(previous, { recursive: true, force: true });
      entry.moduleData = { ...entry.moduleData, extractedRoot: outputRoot, extractorVersion: selected.version };
      context.onEntryChange?.(entry); return result;
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }, { userDataDir: context.userDataDir });
}
function revealExtraction(entry, context) {
  const root = entry.moduleData?.extractedRoot, parent = outputParent(entry, context);
  if (!root || !path.resolve(root).startsWith(parent + path.sep) || !fs.existsSync(path.join(root, "extract.json"))) throw new Error("Extract game archives first.");
  context.ui?.shell?.showItemInFolder?.(root); return { outputRoot: root };
}

module.exports = { candidates, validateArchive, extractArchives, revealExtraction, ensureTools };

const fs = require("node:fs");
const path = require("node:path");
const Archive = require("./archive");
const MsgTool = require("../shared/runtime/msg-tool");
const GameData = require("../shared/game-data");
const { assertOwnDirectory } = require("../shared/writable-input");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const crypto = require("node:crypto");
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

async function exportText(entry, payload, context) {
  const root = fs.realpathSync(entry.contentRootDir), parent = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "bgi"), "text-inputs");
  assertOwnDirectory(context.userDataDir, parent);
  const temporary = fs.mkdtempSync(path.join(parent, ".scripts-"));
  const inputs = [], sources = [], scriptSources = [], skippedArchives = []; let decodedBytes = 0, indexBytes = 0;
  try {
    const candidates = fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isFile() && /\.arc$/i.test(item.name));
    if (candidates.length > 128) throw new Error("Too many BGI archives for text export.");
    for (const item of candidates) {
      throwIfAborted(context.signal);
      const file = path.join(root, item.name), before = identity(fs.lstatSync(file)); let archive;
      try { archive = Archive.inspectArchive(file); }
      catch (error) { skippedArchives.push({ archive: item.name, reason: error.message }); continue; }
      if ((indexBytes += archive.bytesRead) > 24 * 1024 ** 2) throw new Error("BGI archive indexes exceed the text export limit.");
      const fd = fs.openSync(file, "r"); let used = false;
      try {
        for (const member of archive.members.values()) {
          if (path.extname(member.name) && !/\._bp$/i.test(member.name)) continue;
          const prefix = Buffer.alloc(Math.min(32, member.size)); fs.readSync(fd, prefix, 0, prefix.length, member.offset);
          const program = /\._bp$/i.test(member.name), compressed = prefix.toString("ascii", 0, 15) === "DSC FORMAT 1.00";
          if (!program && !compressed && !prefix.toString("ascii").startsWith("BurikoCompiledScriptVer1.00")) continue;
          const bytes = Archive.readMember(archive, member);
          if (!program && !bytes.toString("ascii", 0, 27).startsWith("BurikoCompiledScriptVer1.00")) continue;
          if ((decodedBytes += bytes.length) > 128 * 1024 ** 2) throw new Error("BGI scripts exceed the text export byte limit.");
          if (inputs.length >= 1024) throw new Error("BGI script count exceeds the text export limit.");
          const output = path.join(temporary, String(inputs.length).padStart(4, "0") + "-" + member.name);
          fs.writeFileSync(output, bytes, { flag: "wx", mode: 0o600 }); inputs.push(output); used = true;
          scriptSources.push({ input: output, archive: file, member: member.name, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
        }
      } finally { fs.closeSync(fd); }
      if (identity(fs.lstatSync(file)) !== before) throw new Error("A BGI archive changed during script extraction.");
      if (used) sources.push({ path: file, identity: before });
    }
    if (!inputs.length) throw new Error("No supported Buriko scenario or BP scripts were found.");
    const result = await MsgTool.exportText(entry, payload, context, { moduleId: "bgi", inputs,
      scriptType: file => /\._bp$/i.test(file) ? "bgi-bp" : "bgi", allowPartial: true });
    for (const source of sources) if (identity(fs.lstatSync(source.path)) !== source.identity) throw new Error("An original BGI archive changed during text export.");
    fs.writeFileSync(path.join(result.outputDir, "archives.json"), JSON.stringify({ sources, skippedArchives,
      scenarioFormat: "BurikoCompiledScriptVer1.00", decodedBytes }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    result.originalFiles = scriptSources.map(({ input, ...source }) => source);
    result.failedFiles = result.failedFiles.map(failure => ({ ...scriptSources.find(source => source.input === failure.path), reason: failure.reason }));
    result.complete = result.complete && skippedArchives.length === 0;
    result.skippedArchiveCount = skippedArchives.length; result.skippedArchives = skippedArchives;
    fs.writeFileSync(path.join(result.outputDir, "export.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    return result;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

module.exports = { exportText };

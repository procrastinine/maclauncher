const fs = require("node:fs");
const path = require("node:path");
const XP3 = require("./xp3");
const Script = require("./script");
const Native = require("../shared/runtime/local-native");
const GameData = require("../shared/game-data");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const { getUiServices } = require("../shared/ui-services");
const MsgTool = require("../shared/runtime/msg-tool");

function directory(entry, context) {
  return path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "kirikiri"), "script-export");
}
function collectScripts(entry, context = {}) {
  const root = fs.realpathSync(entry.contentRootDir || path.dirname(entry.gamePath));
  const selected = entry.moduleData?.archivePath;
  const candidates = fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isFile() && /\.xp3$/i.test(item.name))
    .sort((a, b) => { const patch = value => /^patch\d*\.xp3$/i.test(value) ? 1 : 0;
      return patch(a.name) - patch(b.name) || a.name.localeCompare(b.name, "en", { numeric: true }); }).map(item => path.join(root, item.name));
  if (selected) {
    const real = fs.realpathSync(selected);
    if (path.dirname(real) !== root) throw new Error("Selected XP3 archive is outside the imported game directory.");
    candidates.splice(0, 0, real);
  }
  const archives = [...new Set(candidates)];
  if (!archives.length) throw new Error("This game uses loose scripts. Open its game folder to inspect the source files.");
  if (archives.length > 33) throw new Error("The XP3 archive count exceeds supported limits.");
  const primary = XP3.inspectArchive(archives[0]);
  const selectedArchives = require("./prepare").selectLanguageArchives(archives, primary, context);
  const files = new Map(), sources = []; let bytes = 0;
  for (const file of selectedArchives.files) {
    const archive = file === primary.file ? primary : XP3.inspectArchive(file), sha256 = Native.hashFile(file);
    sources.push({ file, sha256 });
    for (const member of archive.members.values()) {
      if (!/\.(?:tjs|ks)$/i.test(member.name)) continue;
      const script = XP3.readScript(archive, member, { allowPlainProtected: entry.moduleData?.xp3ContentProfile === "verified-plain-v1" });
      bytes += script.length;
      if (bytes > XP3.LIMITS.scriptsTotal) throw new Error("XP3 scripts exceed the 32 MB export limit.");
      const compiled = script.subarray(0, 8).equals(Buffer.from("TJS2100\0"));
      const scrambled = script[0] === 0xfe && script[1] === 0xfe && [0, 1, 2].includes(script[2]);
      const text = compiled || scrambled ? null : Script.decode(script);
      if (text?.includes("\0")) throw new Error("This KiriKiri script encoding is unsupported.");
      files.set(member.name.toLowerCase(), { name: member.name, text, ...(compiled || scrambled ? { bytes: script, compiled, scrambled } : {}), sourceArchive: file });
    }
  }
  if (!files.size) throw new Error("No readable KiriKiri scripts were found in the game's archives.");
  return { files, sources, language: selectedArchives.language };
}
async function exportScripts(entry, payload, context) {
  throwIfAborted(context.signal);
  const source = collectScripts(entry, context), outputDir = directory(entry, context), parent = path.dirname(outputDir);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, ".script-export-")); let backup;
  try {
    const requiresTool = [...source.files.values()].some(script => script.compiled || script.scrambled);
    const tool = requiresTool ? await MsgTool.ensure(entry, payload, context) : null;
    const compiledScripts = [];
    for (const script of source.files.values()) {
      throwIfAborted(context.signal);
      const file = path.join(temporary, script.name); fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!script.compiled && !script.scrambled) fs.writeFileSync(file, script.text, "utf8");
      else {
        const original = path.join(temporary, "compiled", script.name); fs.mkdirSync(path.dirname(original), { recursive: true }); fs.writeFileSync(original, script.bytes);
        const output = script.compiled ? file + ".constants.json" : file;
        await MsgTool.run(entry, context, { moduleId: "kirikiri", install: tool, cwd: temporary, logPath: path.join(temporary, "export.log"),
          args: ["export", "-x", "1", "-X", "2", "-t", script.compiled ? "kirikiri-tjs2" : "kirikiri-simple-crypt", "-T", "custom", "-E", "utf8", original, output] });
        if (!fs.statSync(output).isFile()) throw new Error("msg-tool did not produce KiriKiri script output.");
        // SimpleCrypt custom export preserves the decoded source's UTF-16 BOM.
        if (script.scrambled) fs.writeFileSync(output, Script.decode(fs.readFileSync(output)), "utf8");
        if (script.compiled) compiledScripts.push(script.name);
      }
    }
    for (const file of source.sources) if (Native.hashFile(file.file) !== file.sha256)
      throw new Error("A game archive changed during script export. Try again.");
    const record = { outputDir, scriptCount: source.files.size, sourceArchives: source.sources, language: source.language, encoding: "UTF-8", compiledScripts,
      ...(tool ? { toolVersion: tool.version, toolArchiveSha256: tool.archiveSha256 } : {}),
      exportedAt: new Date().toISOString(), files: [...source.files.values()].map(item => ({ name: item.name, sourceArchive: item.sourceArchive })) };
    fs.writeFileSync(path.join(temporary, "export.json"), JSON.stringify(record, null, 2));
    if (fs.existsSync(outputDir)) { backup = outputDir + ".previous-" + Date.now(); fs.renameSync(outputDir, backup); }
    fs.renameSync(temporary, outputDir);
    if (backup) fs.rmSync(backup, { recursive: true, force: true });
    entry.moduleData = { ...entry.moduleData, scriptsExportDir: outputDir };
    context.onEntryChange?.({ moduleData: entry.moduleData }); return record;
  } catch (error) {
    if (backup) { fs.rmSync(outputDir, { recursive: true, force: true }); fs.renameSync(backup, outputDir); }
    throw error;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
function revealScripts(entry, _payload, context) {
  const outputDir = directory(entry, context);
  if (!fs.existsSync(path.join(outputDir, "export.json"))) throw new Error("Export KiriKiri scripts first.");
  getUiServices(context).shell.showItemInFolder(outputDir); return { outputDir };
}
module.exports = { exportScripts, revealScripts, __test: { collectScripts } };

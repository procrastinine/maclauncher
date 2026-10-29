const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Tool = require("./apktool-manager");
const { originalPackages } = require("./decompile");
const GameData = require("../../shared/game-data");
const Native = require("../../shared/runtime/local-native");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const pending = new Set();

async function decodeApk(entry, payload = {}, context = {}, dependencies = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(context.userDataDir || ""))
    throw new Error("APK decoding requires an imported application.");
  if (!path.isAbsolute(entry.gamePath || "") || entry.gamePath.includes("\0") || !fs.existsSync(entry.gamePath))
    throw new Error("Android package not found.");
  const key = context.userDataDir + ":" + entry.gameId;
  if (pending.has(key)) throw new Error("APK decoding is already running for this application.");
  pending.add(key);
  const parent = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "android"), "apktool");
  let inputs, temporary, backup;
  try {
    throwIfAborted(context.signal);
    inputs = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-apktool-"));
    const inspected = await originalPackages(entry.gamePath, inputs, context.signal);
    const sources = inspected.items.map(item => ({ ...item, sha256: Native.hashFile(item.file) }));
    const base = sources.find(item => item.metadata.split === null);
    const baseLibrary = path.join(inputs, "base-library.apk");
    if (base && sources.length > 1) fs.copyFileSync(base.file, baseLibrary, fs.constants.COPYFILE_FICLONE);
    fs.mkdirSync(parent, { recursive: true });
    temporary = fs.mkdtempSync(path.join(parent, ".decode-"));
    const logPath = path.join(temporary, "decode.log");
    fs.writeFileSync(logPath, "Apktool resource and smali export\n");
    const decoded = [];
    let tool;
    for (const [index, source] of sources.entries()) {
      throwIfAborted(context.signal);
      const name = source.metadata.split === null ? "base" : `${index}-${source.originalName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100)}`;
      tool = await (dependencies.run || Tool.core.run)(context, payload, {
        cwd: inputs, logPath, javaArgs: ["-Djava.awt.headless=true"],
        args: ["decode", "--all-src", "--frame-path", path.join(inputs, "framework"),
          ...(base && source !== base ? ["--lib", `${inspected.metadata.packageName}:${baseLibrary}`] : []),
          "--output", path.join(temporary, name), source.file]
      });
      if (!fs.existsSync(path.join(temporary, name, "AndroidManifest.xml"))) throw new Error("Apktool produced no decoded Android manifest.");
      decoded.push({ originalName: source.originalName, directory: name, sha256: source.sha256 });
    }
    throwIfAborted(context.signal);
    if (sources.some(source => Native.hashFile(source.file) !== source.sha256)) throw new Error("The Android package changed during decoding.");
    const outputDir = path.join(parent, "decoded");
    const result = { outputDir, ...tool, packageName: inspected.metadata.packageName, packages: decoded.length,
      decoded, sourcePath: entry.gamePath, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(temporary, "decode.json"), JSON.stringify(result, null, 2));
    if (fs.existsSync(outputDir)) { backup = fs.mkdtempSync(path.join(parent, ".previous-")); fs.rmdirSync(backup); fs.renameSync(outputDir, backup); }
    try { fs.renameSync(temporary, outputDir); temporary = null; }
    catch (error) { if (backup) { fs.renameSync(backup, outputDir); backup = null; } throw error; }
    if (backup) { fs.rmSync(backup, { recursive: true, force: true }); backup = null; }
    entry.moduleData = { ...entry.moduleData, apktoolOutputDir: outputDir, apktoolVersion: tool.toolVersion };
    context.onEntryChange?.({ moduleData: entry.moduleData });
    context.ui?.shell?.showItemInFolder?.(outputDir);
    return result;
  } catch (error) {
    const log = temporary && path.join(temporary, "decode.log");
    if (log && fs.existsSync(log) && !context.signal?.aborted && error.code !== "ABORT_ERR") {
      const retained = path.join(parent, "decode-failed.log"); fs.copyFileSync(log, retained);
      error.message = error.message.replaceAll(log, retained) + " Details: " + retained;
    }
    throw error;
  } finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    if (inputs) fs.rmSync(inputs, { recursive: true, force: true });
    pending.delete(key);
  }
}
module.exports = { decodeApk };

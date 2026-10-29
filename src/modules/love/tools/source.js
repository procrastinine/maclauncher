const fs = require("node:fs"), path = require("node:path");
const Archive = require("../archive");
const Zip = require("../../shared/runtime/zip");
const GameData = require("../../shared/game-data");
const Writable = require("../../shared/writable-input");
const Native = require("../../shared/runtime/local-native");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const Ljd = require("./ljd-manager");
const Unluac = require("./unluac-manager");
const pending = new Set(), MAX_SCRIPT = 16 * 1024 ** 2, MAX_TOTAL = 256 * 1024 ** 2;
const scriptName = name => /\.(?:lua|luac|lj|ljbc)$/i.test(name);
const identity = file => { const s = fs.statSync(file); return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":"); };

async function collect(input, temporary, signal) {
  const scripts = [], sourceIdentities = [];
  let bytes = 0, visited = 0;
  const remember = (file, relative) => {
    const stat = fs.statSync(file);
    if (stat.size > MAX_SCRIPT || (bytes += stat.size) > MAX_TOTAL) throw new Error("Lua source export exceeds its supported size.");
    scripts.push({ file, relative });
  };
  if (fs.statSync(input).isDirectory()) {
    function walk(directory, prefix = "") {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        throwIfAborted(signal);
        if (++visited > 50000) throw new Error("The LÖVE source folder exceeds its file limit.");
        const relative = prefix + item.name, file = path.join(directory, item.name);
        if (item.isDirectory()) walk(file, relative + "/");
        else if (item.isFile() && scriptName(item.name)) { sourceIdentities.push([file, identity(file)]); remember(file, relative); }
      }
    }
    walk(input);
  } else {
    sourceIdentities.push([input, identity(input)]);
    const archive = Archive.readArchive(input);
    if (!archive || archive.ambiguous || archive.root === null) throw new Error("Choose a LÖVE archive containing one game.");
    const inputs = path.join(temporary, "inputs"); fs.mkdirSync(inputs);
    for (const item of Archive.selectedEntries(archive).filter(item => scriptName(item.relative))) {
      throwIfAborted(signal);
      if (item.entry.uncompressedSize > MAX_SCRIPT) throw new Error("A Lua script exceeds its supported size.");
      const file = path.join(inputs, item.relative); fs.mkdirSync(path.dirname(file), { recursive: true });
      await Zip.extractZipEntry(input, item.entry, file, { maxOutputBytes: MAX_SCRIPT, signal });
      remember(file, item.relative);
    }
  }
  if (!scripts.length) throw new Error("No Lua source or bytecode files were found in this LÖVE game.");
  return { scripts, sourceIdentities };
}

async function exportSource(entry, payload = {}, context = {}, dependencies = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(context.userDataDir || ""))
    throw new Error("Source export requires an imported LÖVE game.");
  const key = context.userDataDir + ":" + entry.gameId;
  if (pending.has(key)) throw new Error("Source export is already running for this game.");
  pending.add(key);
  const parent = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "love"), "source");
  let temporary;
  try {
    throwIfAborted(context.signal);
    const input = await dependencies.resolveSource(entry, context);
    if (!path.isAbsolute(input || "") || !fs.existsSync(input)) throw new Error("LÖVE game source was not found.");
    Writable.assertOwnDirectory(context.userDataDir, parent);
    temporary = fs.mkdtempSync(path.join(parent, ".export-"));
    const { scripts, sourceIdentities } = await collect(input, temporary, context.signal);
    const logPath = path.join(temporary, "export.log"), failures = [], files = [], targets = new Set(), tools = {};
    fs.writeFileSync(logPath, "LÖVE Lua source export\n");
    let copied = 0, recovered = 0, installedLjd;
    for (const script of scripts) {
      throwIfAborted(context.signal);
      const data = fs.readFileSync(script.file), magic = data.subarray(0, 4).toString("latin1");
      const bytecode = magic.startsWith("\x1bLJ") ? "luajit" : magic === "\x1bLua" ? "lua" : null;
      const relative = script.relative + (bytecode && !/\.lua$/i.test(script.relative) ? ".lua" : "");
      const target = path.join(temporary, "source", relative), targetKey = relative.toLowerCase();
      if (targets.has(targetKey)) throw new Error("Lua export contains conflicting source filenames.");
      targets.add(targetKey); fs.mkdirSync(path.dirname(target), { recursive: true });
      const sha256 = Native.hashFile(script.file);
      if (!bytecode) { fs.copyFileSync(script.file, target); copied++; files.push({ path: script.relative, sha256, output: relative, status: "copied" }); continue; }
      const original = path.join(temporary, "bytecode", script.relative); fs.mkdirSync(path.dirname(original), { recursive: true }); fs.copyFileSync(script.file, original);
      try {
        if (bytecode === "luajit") {
          const tool = dependencies.ljd || Ljd;
          installedLjd ||= await tool.ensureTool(context, { version: payload.ljdVersion });
          await tool.run(context, ["--file", original, "--output", target], { installed: installedLjd, cwd: temporary, logPath });
          tools.ljd = installedLjd.version;
        } else {
          const result = await (dependencies.unluac || Unluac).core.run(context, { version: payload.unluacVersion }, {
            cwd: temporary, logPath, javaArgs: ["-Djava.awt.headless=true"], args: ["--output", target, original] });
          tools.unluac = result.toolVersion;
        }
        if (!fs.existsSync(target) || fs.statSync(target).size === 0) throw new Error("The decompiler produced no Lua source.");
        recovered++; files.push({ path: script.relative, sha256, output: relative, status: "recovered", bytecode });
      } catch (error) {
        throwIfAborted(context.signal);
        if (error.code === "ABORT_ERR" || error.name === "AbortError") throw error;
        failures.push({ path: script.relative, bytecode, reason: error.message });
        fs.rmSync(target, { force: true });
      }
    }
    if (sourceIdentities.some(([file, before]) => identity(file) !== before)) throw new Error("The LÖVE source changed during export.");
    fs.rmSync(path.join(temporary, "inputs"), { recursive: true, force: true });
    const outputDir = path.join(parent, "export");
    failures.forEach(failure => { failure.reason = failure.reason.replaceAll(temporary, outputDir); });
    const result = { outputDir, copied, recovered, failed: failures.length, tools,
      files, failures, sourcePath: input, createdAt: new Date().toISOString(),
      message: failures.length ? `${failures.length} Lua file(s) could not be recovered. Original bytecode and export.log are retained.`
        : "Lua sources are available for inspection; recovered code can differ from the original source." };
    fs.writeFileSync(path.join(temporary, "export.json"), JSON.stringify(result, null, 2));
    let backup;
    if (fs.existsSync(outputDir)) { backup = fs.mkdtempSync(path.join(parent, ".previous-")); fs.rmdirSync(backup); fs.renameSync(outputDir, backup); }
    try { fs.renameSync(temporary, outputDir); temporary = null; }
    catch (error) { if (backup) fs.renameSync(backup, outputDir); throw error; }
    if (backup) fs.rmSync(backup, { recursive: true, force: true });
    entry.moduleData = { ...entry.moduleData, sourceExportDir: outputDir }; context.onEntryChange?.({ moduleData: entry.moduleData });
    context.ui?.shell?.showItemInFolder?.(outputDir);
    return result;
  } finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); pending.delete(key); }
}

function revealSource(entry, _payload, context) {
  const outputDir = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "love"), "source", "export");
  if (entry.moduleData?.sourceExportDir !== outputDir || !fs.existsSync(path.join(outputDir, "export.json"))) throw new Error("Export this game's source first.");
  context.ui?.shell?.showItemInFolder?.(outputDir); return { outputDir };
}
module.exports = { exportSource, revealSource, __test: { collect } };

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const GameData = require("../shared/game-data");
const { createManagedWindowsTool, windowsPath } = require("../shared/runtime/managed-windows-tool");
const { readBytecode } = require("./bytecode");
const { throwIfAborted } = require("../shared/runtime/download-utils");

const manager = createManagedWindowsTool({ id: "hlbc", label: "hlbc", owner: "Gui-Yom", repo: "hlbc",
  executableName: "hlbc.exe", assetPattern: /^hlbc\.exe$/i, versionFromTag: tag => tag.replace(/^cli-v/, ""), order: 275 });

async function exportBytecode(entry, payload, context, dependencies = {}) {
  const source = entry.moduleData?.bytecodePath, info = readBytecode(source);
  if (info.version < 4 || info.version > 5) throw new Error("The published hlbc CLI exports HashLink bytecode versions 4 and 5. Metadata inspection remains available for this version.");
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(context.userDataDir || "")) throw new Error("Bytecode export requires a game in the library.");
  const toolManager = dependencies.manager || manager, install = await toolManager.ensure(entry, payload, context);
  const parent = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "hashlink"), "exports");
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, ".hlbc-")), outputRoot = path.join(parent, "bytecode");
  try {
    const logPath = path.join(temporary, "hlbc.log"), listing = path.join(temporary, "bytecode.txt");
    let host, disassemblyWarning;
    const run = (command, stdoutPath) => toolManager.run(entry, context, { moduleId: "hashlink", install, cwd: temporary, logPath,
      stdoutPath, args: [windowsPath(source), "-c", command] });
    try { host = await run("info;entrypoint;t ..;n ..;fn ..;exit", listing); }
    catch (error) {
      if (context.signal?.aborted || !Number.isInteger(error.exitCode) || error.exitCode === 0) throw error;
      disassemblyWarning = "The opcode listing is incomplete. Metadata, partial output and the tool log remain available.";
      host = await run("info;entrypoint;t ..;n ..;fnh ..;s ..;exit", path.join(temporary, "metadata.txt"));
    }
    throwIfAborted(context.signal);
    if (!fs.statSync(listing).size) throw new Error("hlbc did not export a bytecode listing.");
    let decompileWarning;
    try {
      await toolManager.run(entry, context, { moduleId: "hashlink", install, cwd: temporary, logPath,
        stdoutPath: path.join(temporary, "entrypoint.hx.txt"), args: [windowsPath(source), "-c", `decomp ${info.entrypoint};exit`] });
    } catch (error) {
      if (context.signal?.aborted || !Number.isInteger(error.exitCode) || error.exitCode === 0) throw error;
      decompileWarning = "The entrypoint pseudocode could not be recovered. The bytecode listing and tool log remain available.";
    }
    const result = { outputRoot, toolVersion: install.version, bytecodeVersion: info.version, functions: info.functions,
      representation: "bytecode listing and experimental entrypoint pseudocode", ...host,
      ...(disassemblyWarning ? { disassemblyWarning } : {}), ...(decompileWarning ? { decompileWarning } : {}) };
    fs.writeFileSync(path.join(temporary, "export.json"), JSON.stringify(result, null, 2));
    const previous = outputRoot + ".previous-" + crypto.randomUUID(), existed = fs.existsSync(outputRoot);
    if (existed) fs.renameSync(outputRoot, previous);
    try { fs.renameSync(temporary, outputRoot); }
    catch (error) { if (existed) fs.renameSync(previous, outputRoot); throw error; }
    if (existed) fs.rmSync(previous, { recursive: true, force: true });
    entry.moduleData = { ...entry.moduleData, bytecodeExportRoot: outputRoot };
    context.onEntryChange?.({ moduleData: entry.moduleData }); return result;
  } catch (error) {
    if (fs.existsSync(path.join(temporary, "hlbc.log"))) {
      const log = path.join(parent, "hlbc-failure.log"); fs.copyFileSync(path.join(temporary, "hlbc.log"), log); error.message += " Log: " + log;
    }
    throw error;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
module.exports = { manager, exportBytecode };

const fs = require("node:fs");
const path = require("node:path");
const { createManagedWindowsTool, windowsPath } = require("../shared/runtime/managed-windows-tool");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const Native = require("../shared/runtime/local-native");
const Inspect = require("./inspect");

const manager = createManagedWindowsTool({ id: "sc3tools", label: "sc3tools", owner: "CommitteeOfZero", repo: "sc3tools",
  executableName: "sc3tools.exe", assetPattern: /^sc3tools\.exe$/, order: 268 });

async function exportText(entry, payload, context, exportCompiled) {
  const info = Inspect.inspectGame(entry.contentRootDir);
  if (info?.editionId !== "steins-gate-windows-hd") throw new Error("Readable SC3 text export requires the supported Windows HD game profile.");
  const tool = await manager.ensure(entry, payload, context), report = Inspect.inspectScripts(entry.contentRootDir);
  const exported = exportCompiled(entry, {}, context), compiled = path.join(exported.path, "compiled");
  const pattern = windowsPath(compiled).replaceAll("\\", "/") + "/**/*.[sS][cC][xX]";
  const logPath = path.join(exported.path, "text-export.log");
  await manager.run(entry, context, { moduleId: "mages", install: tool, cwd: exported.path, logPath,
    args: ["extract-text", pattern, "sghd"] });
  throwIfAborted(context.signal);
  const files = [], failedFiles = []; let messageCount = 0;
  for (const script of report.scripts) {
    const source = path.join(compiled, ...script.relativePath.split("/")), file = path.join(path.dirname(source), "txt", path.basename(source) + ".txt");
    let text;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 ** 2) throw new Error("Text output is not a bounded regular file.");
      text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
      const lines = text ? text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length : 0;
      if (lines !== script.stringCount) throw new Error(`Expected ${script.stringCount} strings; recovered ${lines}.`);
      messageCount += lines;
      files.push({ path: path.relative(exported.path, file), messages: lines, sha256: Native.hashFile(file), originalScriptSha256: script.sha256 });
    } catch (error) {
      failedFiles.push({ script: script.relativePath, reason: error.message });
      fs.rmSync(file, { force: true });
    }
  }
  if (!files.length || !messageCount) throw new Error(`sc3tools produced no complete text exports. See ${logPath}.`);
  const result = { outputDir: exported.path, representation: "sc3-readable-text", toolVersion: tool.version,
    gameProfile: "sghd", messageCount, fileCount: files.length, complete: failedFiles.length === 0 && report.complete,
    failedFileCount: failedFiles.length, failedFiles, skippedScripts: report.skippedScripts,
    toolArchiveSha256: tool.archiveSha256, files };
  fs.writeFileSync(path.join(exported.path, "text-export.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  context.ui?.shell?.showItemInFolder?.(exported.path); return result;
}

module.exports = { manager, exportText };

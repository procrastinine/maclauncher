const fs = require("node:fs");
const path = require("node:path");
const Native = require("../shared/decompilation/native");
const { getUiServices } = require("../shared/ui-services");
const { inside } = require("./detect");
const { gameDirectory, resolveInput, resolveRuntime, runCli, prepareGame } = require("./prepare");

async function inspectProgram(entry, _payload, context, dependencies = {}) {
  const input = resolveInput(entry), selected = await resolveRuntime(entry, context, dependencies), root = gameDirectory(entry, context);
  fs.mkdirSync(root, { recursive: true });
  const outputRoot = fs.mkdtempSync(path.join(root, "program-inspection-"));
  const result = await runCli(selected.runtime, ["inspect", "--input", input.inputPath], outputRoot, context, dependencies);
  const report = result.events.findLast(item => item.schemaVersion === 1);
  if (!report) throw new Error("nxnative did not return its program inspection.");
  fs.writeFileSync(path.join(outputRoot, "inspection.json"), JSON.stringify(report, null, 2) + "\n");
  entry.moduleData = { ...entry.moduleData, ...(typeof report.titleId === "string" ? { titleId: report.titleId } : {}),
    ...(report.encrypted === true ? { keysRequired: true } : {}), nativeInspectionRoot: outputRoot };
  context.onEntryChange?.({ moduleData: entry.moduleData });
  return { ...report, outputRoot };
}
async function decompile(entry, payload, context, dependencies = {}) {
  const input = resolveInput(entry);
  if (!input.canDecompile) throw new Error("ELF export requires a Switch NSO module or a complete application.");
  const selected = await resolveRuntime(entry, context, dependencies);
  let source = input.inputPath;
  if (!input.inspectionOnly) source = (await prepareGame(entry, context, selected, dependencies)).prepared;
  const root = gameDirectory(entry, context);fs.mkdirSync(root, { recursive: true });
  const output = fs.mkdtempSync(path.join(root, "elf-export-")), elf = path.join(output, "main.elf");
  const result = await runCli(selected.runtime, ["inspect", "--input", source, "--export-elf", elf], output, context, dependencies);
  const report = result.events.findLast(item => item.schemaVersion === 1 && item.elfPath === elf);
  if (!report || !fs.statSync(elf).isFile()) throw new Error("nxnative did not export the original NSO as ELF.");
  return Native.inspect(entry, payload || {}, context, { ...dependencies, moduleId: "nxnative", resolveInput: () => elf });
}
function revealExport(entry, _payload, context) {
  const outputRoot = entry.moduleData?.nativeInspectionRoot, root = gameDirectory(entry, context);
  if (!path.isAbsolute(outputRoot || "") || !fs.existsSync(outputRoot) || !inside(fs.realpathSync(root), fs.realpathSync(outputRoot))) throw new Error("No Switch program export is available.");
  getUiServices(context).shell.showItemInFolder(outputRoot);return { outputRoot };
}
module.exports = { inspectProgram, decompile, revealExport };

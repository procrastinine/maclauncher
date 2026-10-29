const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createManagedWindowsTool, windowsPath } = require("../shared/runtime/managed-windows-tool");
const { moduleDir, sourceFiles } = require("./prepare");
const { assets } = require("./tools");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const { getUiServices } = require("../shared/ui-services");

const WolfTL = createManagedWindowsTool({ id: "wolftl", label: "WolfTL", owner: "Sinflower", repo: "WolfTL",
  executableName: "WolfTL.exe", assetPattern: /^WolfTL\.exe$/i, order: 270 });
const UberWolf = createManagedWindowsTool({ id: "uberwolf", label: "UberWolf", owner: "Sinflower", repo: "UberWolf",
  executableName: "UberWolfCli.exe", assetPattern: /^UberWolfCli\.exe$/i, order: 271 });

function remember(entry, context, changes) {
  entry.moduleData = { ...entry.moduleData, ...changes };
  context.onEntryChange?.({ moduleData: entry.moduleData });
}
function countFiles(directory, extension) {
  let count = 0;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error("The WOLF export contains an unsupported file alias.");
    if (item.isDirectory()) count += countFiles(path.join(directory, item.name), extension);
    else if (!extension || item.name.endsWith(extension)) count++;
  }
  return count;
}
function publish(temporary, target) {
  const previous = target + ".previous-" + crypto.randomUUID(), existed = fs.existsSync(target);
  if (existed) fs.renameSync(target, previous);
  try { fs.renameSync(temporary, target); }
  catch (error) { if (existed) fs.renameSync(previous, target); throw error; }
  if (existed) fs.rmSync(previous, { recursive: true, force: true });
}
function retainFailureLog(file, parent, name, error) {
  if (fs.existsSync(file)) {
    const target = path.join(parent, name + "-failure.log"); fs.copyFileSync(file, target);
    error.message += " Log: " + target;
  }
  throw error;
}
function sourceSignature(files) {
  return crypto.createHash("sha256").update(JSON.stringify(files.map(({ name, size, mtimeMs }) => [name, size, mtimeMs]))).digest("hex");
}

async function exportProjectJson(entry, payload, context, dependencies = {}) {
  const manager = dependencies.manager || WolfTL, install = await manager.ensure(entry, payload, context);
  const parent = path.join(moduleDir(entry, context), "exports"); fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, ".project-")), outputRoot = path.join(parent, "project-json");
  try {
    const input = path.join(temporary, "input"), output = path.join(temporary, "output");
    fs.mkdirSync(input); fs.mkdirSync(output);
    let source;
    try { source = (dependencies.assets || assets)(entry); }
    catch (error) {
      if (error.code !== "WOLF_ARCHIVE_UNSUPPORTED") throw error;
      const existing = path.join(parent, "assets"), signature = sourceSignature(sourceFiles(entry.gamePath));
      let previous;
      try { previous = JSON.parse(fs.readFileSync(path.join(existing, "export.json"), "utf8")); } catch {}
      const exported = entry.moduleData?.assetExportDir === existing && previous?.sourceSignature === signature
        ? existing : (await extractAdvancedAssets(entry, {}, context)).outputDir;
      source = assets({ ...entry, gamePath: exported });
    }
    let inputFiles = 0;
    try {
      for (const item of source.entries.filter(item => /\.(?:mps|dat|project)$/i.test(item.name))) {
        throwIfAborted(context.signal);
        const relative = item.name.replace(/^Data\//i, ""), file = path.join(input, ...relative.split("/"));
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, item.read()); inputFiles++;
      }
    } finally { source.close(); }
    if (!inputFiles) throw new Error("No WOLF database or map files were found. Extract the game archives first.");
    const host = await manager.run(entry, context, { moduleId: "wolfrpg", install,
      args: [windowsPath(input), windowsPath(output), "--create"], cwd: temporary, logPath: path.join(output, "wolftl.log") });
    const fileCount = countFiles(output, ".json");
    if (!fileCount) throw new Error("WolfTL did not export any project data. See " + path.join(output, "wolftl.log") + ".");
    const result = { outputRoot, fileCount, toolVersion: install.version, ...host };
    fs.writeFileSync(path.join(output, "export.json"), JSON.stringify(result, null, 2));
    publish(output, outputRoot);
    remember(entry, context, { projectExportRoot: outputRoot, projectExporterVersion: install.version });
    return result;
  } catch (error) { retainFailureLog(path.join(temporary, "output", "wolftl.log"), parent, "wolftl", error); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

async function extractAdvancedAssets(entry, payload, context, dependencies = {}) {
  const originals = sourceFiles(entry.gamePath);
  const executable = originals.find(item => /^(?:Game|GamePro)\.exe$/i.test(item.name));
  if (!executable) throw new Error("Extended WOLF extraction requires the original Game.exe or GamePro.exe beside the game data.");
  const manager = dependencies.manager || UberWolf, install = await manager.ensure(entry, payload, context);
  const parent = path.join(moduleDir(entry, context), "exports"); fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, ".uberwolf-")), outputDir = path.join(parent, "assets");
  try {
    const input = path.join(temporary, "game"); fs.mkdirSync(input);
    const archiveNames = originals.filter(item => /\.(?:wolf|data|pak|bin|assets|content|res|resource)$/i.test(item.name)).map(item => item.name);
    const staged = originals.filter(item => archiveNames.includes(item.name) || !/^Data\//i.test(item.name));
    for (const item of staged) {
      throwIfAborted(context.signal);
      const file = path.join(input, ...item.name.split("/")); fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(path.join(entry.gamePath, item.name), file, fs.constants.COPYFILE_FICLONE);
    }
    if (!archiveNames.length) throw new Error("No supported WOLF archives were found.");
    const parameters = ["--override", windowsPath(path.join(input, executable.name))];
    const host = await manager.run(entry, context, { moduleId: "wolfrpg", install, args: parameters,
      cwd: input, logPath: path.join(temporary, "uberwolf.log") });
    const generated = sourceFiles(input).filter(item => !staged.some(source => source.name.toLowerCase() === item.name.toLowerCase()));
    if (!generated.length) throw new Error("UberWolf did not export any assets. See " + path.join(temporary, "uberwolf.log") + ".");
    // Preserve loose-file precedence after decoding the copied containers.
    for (const item of originals.filter(item => /^Data\//i.test(item.name) && !archiveNames.includes(item.name))) {
      const file = path.join(input, ...item.name.split("/")); fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(path.join(entry.gamePath, item.name), file, fs.constants.COPYFILE_FICLONE);
    }
    // Copied containers and executables served only as inspection inputs.
    for (const item of originals.filter(item => archiveNames.includes(item.name) || /\.exe$/i.test(item.name))) fs.rmSync(path.join(input, item.name), { force: true });
    fs.copyFileSync(path.join(temporary, "uberwolf.log"), path.join(input, "uberwolf.log"));
    const result = { outputDir, fileCount: countFiles(input), toolVersion: install.version, sourceSignature: sourceSignature(originals), ...host };
    fs.writeFileSync(path.join(input, "export.json"), JSON.stringify(result, null, 2));
    publish(input, outputDir); remember(entry, context, { assetExportDir: outputDir }); return result;
  } catch (error) { retainFailureLog(path.join(temporary, "uberwolf.log"), parent, "uberwolf", error); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
function revealProject(entry, _payload, context) {
  const directory = path.join(moduleDir(entry, context), "exports", "project-json");
  if (entry.moduleData?.projectExportRoot !== directory || !fs.existsSync(path.join(directory, "export.json"))) throw new Error("Export the project data first.");
  getUiServices(context).shell.showItemInFolder(directory); return { outputRoot: directory };
}
module.exports = { WolfTL, UberWolf, exportProjectJson, extractAdvancedAssets, revealProject };

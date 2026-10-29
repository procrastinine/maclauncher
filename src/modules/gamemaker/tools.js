const fs = require("node:fs");
const path = require("node:path");
const { execFile: nodeExecFile } = require("node:child_process");
const Rosetta = require("../shared/runtime/rosetta");
const { inspectStudio, hashFile, LIMITS } = require("./inspect");
const { resolveOutputRoot, resolveDataPath, inspectEntry } = require("./export");

function createToolRunner({ execFile = nodeExecFile, rosetta = Rosetta, prerequisiteContext = {} } = {}) {
  return async (executablePath, args, options = {}) => {
    const { prerequisiteContext: callContext, ...processOptions } = options;
    const context = { ...prerequisiteContext, ...callContext,
      ...(processOptions.signal ? { signal: processOptions.signal } : {}) };
    await rosetta.ensureForExecutable(executablePath, context);
    // EOF on stdin prevents the CLI's interactive input buffer from waiting forever.
    return new Promise((resolve, reject) => {
      const child = execFile(executablePath, args, { encoding: "utf8", timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, ...processOptions },
        (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
      child.stdin?.end();
    });
  };
}
const runTool = createToolRunner();

function validateCodeNames(inspection) {
  const names = new Set();
  for (const entry of inspection.codeEntries) {
    const name = entry.name;
    if (typeof name !== "string" || !name || name.length > 240 || /[/\\\0:]/.test(name) || name === "." || name === ".." || names.has(name.toLowerCase())) {
      throw new Error("A code name is unsafe or duplicated on the Mac filesystem; automatic decompilation is unavailable for this file.");
    }
    names.add(name.toLowerCase());
  }
}

async function verifyUmt(selection, context, runProcess) {
  if (!selection?.install) throw new Error(`UndertaleModTool CLI ${selection?.version || ""} is not installed. Install it in Runtimes.`);
  const executable = selection.install.executablePath;
  const version = await runProcess(executable, ["--version"], { timeout: 15000, prerequisiteContext: context });
  const cliVersion = /^\d+\.\d+\.\d+\.\d+/.exec(selection.version || "")?.[0];
  if (!cliVersion || !/^[a-f0-9]{40}$/.test(selection.install.upstreamRevision || "")) throw new Error("Selected UndertaleModTool has no exact release version and source revision.");
  const expected = `${cliVersion}+${selection.install.upstreamRevision}`;
  if (version.stdout.trim() !== expected) throw new Error("Selected UndertaleModTool CLI does not report the pinned version and revision.");
  return executable;
}

async function decompileStudio(entry, context, selection, { runProcess = runTool } = {}) {
  const dataPath = resolveDataPath(entry);
  const inspection = inspectStudio(dataPath, { includeNames: true, limits: { ...LIMITS, names: LIMITS.entries } });
  if (inspection.executionKind !== "studio-vm") throw new Error("YYC/native or code-free Studio data has no VM GML to decompile.");
  validateCodeNames(inspection);
  const executable = await verifyUmt(selection, context, runProcess);
  const sourceSha256 = hashFile(dataPath);
  const output = fs.mkdtempSync(path.join(resolveOutputRoot(entry, context), "decompiled-"));
  try {
    const result = await runProcess(executable, ["dump", dataPath, "--output", output, "--code", "UMT_DUMP_ALL", "--strings"], { cwd: output, prerequisiteContext: context });
    if (hashFile(dataPath) !== sourceSha256) throw new Error("GameMaker data changed during decompilation.");
    const codeRoot = path.join(output, "CodeEntries");
    const codeFiles = fs.existsSync(codeRoot) ? fs.readdirSync(codeRoot).filter(file => file.endsWith(".gml")) : [];
    if (!codeFiles.length) throw new Error("The decompiler produced no GML files. No successful export was recorded.");
    fs.writeFileSync(path.join(output, "decompile.log"), result.stdout + result.stderr);
    fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify({ schemaVersion: 1,
      sourcePath: dataPath, sourceSha256, wadVersion: inspection.wadVersion, sourceCodeCount: inspection.codeCount,
      outputCodeCount: codeFiles.length, tool: "UndertaleModTool CLI", version: selection.version,
      upstreamRevision: selection.install.upstreamRevision, binarySha256: selection.install.binarySha256,
      backend: "cli", exportedAt: new Date().toISOString(), representation: "decompiled-gml-and-strings",
      caveat: "Nested code can be included in its parent GML output. This is not a complete editor project or native-code decompilation."
    }, null, 2));
    return { outputDir: output, codeCount: codeFiles.length, version: selection.version, sourceSha256 };
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

async function exportImages(entry, context, selection, { runProcess = runTool } = {}) {
  const dataPath = resolveDataPath(entry), inspection = inspectStudio(dataPath);
  const executable = await verifyUmt(selection, context, runProcess), sourceSha256 = hashFile(dataPath);
  const output = fs.mkdtempSync(path.join(resolveOutputRoot(entry, context), "images-"));
  try {
    const result = await runProcess(executable, ["dump", dataPath, "--output", output, "--textures", "--sprites"],
      { cwd: output, signal: context.signal, prerequisiteContext: context });
    if (hashFile(dataPath) !== sourceSha256) throw new Error("GameMaker data changed during image export.");
    function countImages(directory) {
      const root = path.join(output, directory);
      if (!fs.existsSync(root)) return 0;
      let count = 0;
      for (const file of fs.readdirSync(root, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(".png")) throw new Error("The image export contains an unexpected file.");
        const header = Buffer.alloc(24), descriptor = fs.openSync(path.join(root, file.name), "r");
        try {
          if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length ||
            !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            header.toString("ascii", 12, 16) !== "IHDR" || !header.readUInt32BE(16) || !header.readUInt32BE(20)) {
            throw new Error("The tool produced an invalid PNG image.");
          }
        } finally { fs.closeSync(descriptor); }
        count++;
      }
      return count;
    }
    const textureCount = countImages("EmbeddedTextures"), spriteFrameCount = countImages("Sprites");
    if (!textureCount && !spriteFrameCount) throw new Error("The tool produced no texture or sprite PNG images.");
    fs.writeFileSync(path.join(output, "export.log"), result.stdout + result.stderr);
    fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify({ schemaVersion: 1, sourcePath: dataPath, sourceSha256,
      wadVersion: inspection.wadVersion, textureCount, spriteFrameCount, tool: "UndertaleModTool CLI", version: selection.version,
      upstreamRevision: selection.install.upstreamRevision, binarySha256: selection.install.binarySha256,
      exportedAt: new Date().toISOString(), representation: "embedded-texture-pages-and-normal-sprite-frames-png",
      caveat: "Sprite frames are padded PNGs. Vector and skeletal sprites are not exported by this CLI action."
    }, null, 2));
    return { outputDir: output, textureCount, spriteFrameCount, version: selection.version, sourceSha256 };
  } catch (error) { fs.rmSync(output, { recursive: true, force: true }); throw error; }
}

async function decompileClassic(entry, context, selection, { runProcess = runTool } = {}) {
  const inspection = inspectEntry(entry, false);
  if (inspection.executionKind !== "classic") throw new Error("GM8Decompiler supports Classic 8.0/8.1 executables, not Studio data.");
  if (inspection.fileBytes > 128 * 1024 ** 2) throw new Error("Classic decompilation is limited to 128 MiB inputs.");
  if (!selection?.install) throw new Error("The selected GM8Decompiler could not be loaded.");
  const executable = selection.install.executablePath;
  const version = await runProcess(executable, ["--help"], { timeout: 15000, prerequisiteContext: context });
  const toolVersion = /^\d+\.\d+\.\d+/.exec(selection.version || "")?.[0];
  if (!toolVersion || !/^[a-f0-9]{40}$/.test(selection.install.upstreamRevision || "") ||
    !version.stdout.includes(`GM8Decompiler v${toolVersion}`) || !version.stdout.includes(`#${selection.install.upstreamRevision.slice(0, 7)}`)) throw new Error("Selected GM8Decompiler does not report the selected version and source revision.");
  const output = fs.mkdtempSync(path.join(resolveOutputRoot(entry, context), "classic-decompiled-"));
  const projectPath = path.join(output, inspection.classicVersion === "8.1" ? "project.gm81" : "project.gmk");
  try {
    const result = await runProcess(executable, [inspection.sourcePath, "--output", projectPath, "--deobfuscate", "off", "--preserve", "--singlethread"], { cwd: output, prerequisiteContext: context });
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).size) throw new Error("GM8Decompiler produced no project file.");
    if (hashFile(inspection.sourcePath) !== inspection.sourceSha256) throw new Error("Classic game changed during decompilation.");
    fs.writeFileSync(path.join(output, "decompile.log"), result.stdout + result.stderr);
    fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify({ schemaVersion: 1,
      sourcePath: inspection.sourcePath, sourceSha256: inspection.sourceSha256, classicVersion: inspection.classicVersion,
      tool: "GM8Decompiler", version: selection.version, upstreamRevision: selection.install.upstreamRevision,
      binarySha256: selection.install.binarySha256, projectPath, projectSha256: hashFile(projectPath),
      exportedAt: new Date().toISOString(), runtimeCompatibility: "not-qualified-by-decompilation"
    }, null, 2));
    return { outputDir: output, projectPath, version: selection.version, sourceSha256: inspection.sourceSha256 };
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { createToolRunner, runTool, validateCodeNames, decompileStudio, decompileClassic, exportImages };

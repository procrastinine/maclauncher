const fs = require("node:fs");
const path = require("node:path");
const { createManagedWindowsTool, windowsPath } = require("../shared/runtime/managed-windows-tool");
const { assertOwnDirectory } = require("../shared/writable-input");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const GameData = require("../shared/game-data");
const Native = require("../shared/runtime/local-native");
const { inspectRoot } = require("./detect");

const manager = createManagedWindowsTool({ id: "alice-tools", label: "Alice tools", owner: "nunuhara", repo: "alice-tools",
  executableName: "alice.exe", assetPattern: /^alice-tools-[0-9.]+\.zip$/, order: 266 });

async function decompile(entry, payload, context, dependencies = {}) {
  const info = inspectRoot(entry.contentRootDir);
  if (info?.generation !== "system4" || entry.moduleData?.generation !== "system4") throw new Error("Alice tools requires an original System 4 AIN program.");
  const input = info.scenarioPath, stat = fs.lstatSync(input);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 ** 2) throw new Error("The System 4 AIN input must be a bounded regular file.");
  throwIfAborted(context.signal);
  const selected = dependencies.manager || manager, tool = await selected.ensure(entry, payload, context);
  const root = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "alicesoft"), "source");
  assertOwnDirectory(context.userDataDir, root);
  const directory = fs.mkdtempSync(path.join(root, "decompiled-")), sourceSha256 = Native.hashFile(input);
  const logPath = path.join(directory, "decompile.log"), code = path.join(directory, "scenario.jam"), text = path.join(directory, "dialogue.txt");
  for (const [mode, output] of [["-c", code], ["-t", text]]) {
    await selected.run(entry, context, { moduleId: "alicesoft", install: tool, cwd: directory, logPath,
      args: ["ain", "dump", "--output-encoding=UTF-8", mode, "-o", windowsPath(output), windowsPath(input)] });
  }
  throwIfAborted(context.signal);
  if (Native.hashFile(input) !== sourceSha256) throw new Error("The original AIN program changed during export.");
  const files = [code, text].map(file => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 ** 2) throw new Error("Alice tools produced an invalid export.");
    return { path: path.basename(file), bytes: stat.size, sha256: Native.hashFile(file) };
  });
  if (!files[0].bytes) throw new Error(`Alice tools produced no disassembly. See ${logPath}.`);
  const result = { outputDir: directory, representation: "system4-ain-disassembly-and-text", toolVersion: tool.version,
    originalPath: input, originalSha256: sourceSha256, toolArchiveSha256: tool.archiveSha256,
    upstreamRevision: tool.upstreamRevision, encoding: "UTF-8", files };
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  entry.moduleData = { ...entry.moduleData, sourceExportDir: directory, sourceExportAt: Date.now() };
  context.onEntryChange?.({ moduleData: entry.moduleData });
  return result;
}

module.exports = { manager, decompile };

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Exports = require("../export");
const OpenGMK = require("./opengmk");
const Native = require("../../shared/runtime/local-native");
const Bundle = require("../../shared/runtime/bundled-native");

const LIMITS = Object.freeze({ files: 20000, bytes: 2 * 1024 ** 3, depth: 24 });
function inventory(root) {
  const files = [];
  let bytes = 0;
  function walk(relative, depth) {
    if (depth > LIMITS.depth) throw new Error("Classic game folders exceed the nesting limit.");
    for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".DS_Store", ".git"].includes(item.name)) continue;
      const name = Bundle.relativeFile(path.posix.join(relative, item.name));
      const source = path.join(root, name), stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) throw new Error("Classic game data cannot contain symbolic links.");
      if (stat.isDirectory()) walk(name, depth + 1);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (files.length >= LIMITS.files || bytes > LIMITS.bytes) throw new Error("Classic game content exceeds the size or file-count limit.");
        files.push({ path: name, size: stat.size, sha256: Native.hashFile(source) });
      } else throw new Error("Classic game content contains a non-file entry.");
    }
  }
  walk("", 0);
  return files;
}
function treeHash(files) { return crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex"); }

function prepareClassicGame(entry, context) {
  const gamePath = fs.realpathSync(Exports.resolveDataPath(entry));
  const originalRoot = path.dirname(gamePath);
  const root = path.join(Exports.resolveOutputRoot(entry, context), "classic");
  const gameRoot = path.join(root, "writable");
  Bundle.realDirectory(gameRoot, { create: true });
  if (gameRoot.startsWith(originalRoot + path.sep) || originalRoot.startsWith(gameRoot + path.sep)) {
    throw new Error("Classic writable data must be outside the original game folder.");
  }
  const sourceSha256 = Native.hashFile(gamePath);
  const recordPath = path.join(root, "source.json"), temporary = path.join(root, `.source-${crypto.randomUUID()}.json`);
  try {
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 2, sourcePath: gamePath,
      sourceSha256, writableDirectory: gameRoot, readMode: "original-content-in-place",
      writeMode: "private-copy-on-write", checkedAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, recordPath);
  } finally { fs.rmSync(temporary, { force: true }); }
  return { gamePath, gameRoot, sourceSha256 };
}

async function launchClassic(entry, context, selection) {
  if (!selection.ready) throw new Error(selection.reason);
  const inspection = await OpenGMK.preflight(Exports.resolveDataPath(entry), selection, { signal: context.signal });
  if (!inspection.parserAvailable) throw new Error("Install OpenGMK before playing Classic games.");
  const prepared = prepareClassicGame(entry, context);
  entry.defaultSaveDir = prepared.gameRoot;
  entry.moduleData = { ...entry.moduleData, classicAssetsVerified: true, extensionCount: inspection.extensionCount,
    classicExternalDefinitionCount: inspection.externalDefinitionCount, classicWritableRoot: prepared.gameRoot,
    classicUnsupportedLibraries: inspection.unsupportedLibraries,
    classicReadMode: "original-content-in-place", classicWriteMode: "private-copy-on-write",
    lastRuntimeVersion: selection.version, lastRuntimeRevision: selection.install.upstreamRevision,
    lastRuntimeBackend: "appkit", lastRuntimeSha256: selection.install.binarySha256,
    classicSourceSha256: prepared.sourceSha256 };
  context.onEntryChange?.({ defaultSaveDir: entry.defaultSaveDir, moduleData: entry.moduleData });
  return Native.launchLocalRuntime({ runtimePath: selection.install.executablePath, runtimeVersion: selection.version,
    upstreamRevision: selection.install.upstreamRevision, expectedSha256: selection.install.binarySha256,
    args: [prepared.gamePath, "--strict", "--singlethread", "--realtime", "--working-directory", prepared.gameRoot,
      ...(context.gameArguments || []).map(argument => `--game-arg=${argument}`)], cwd: prepared.gameRoot, context });
}

module.exports = { LIMITS, inventory, treeHash, prepareClassicGame, launchClassic };

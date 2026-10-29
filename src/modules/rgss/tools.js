const fs = require("node:fs");
const path = require("node:path");
const GameData = require("../shared/game-data");
const { parseMarshal, graphReport } = require("./marshal");
const Scripts = require("./script-tools");
const { writeLatestReport } = require("../shared/generated-reports");

const LEGACY_REPORT_NAME = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-[a-f0-9]{8}";

const SAVE_EXTENSIONS = Object.freeze({ ".rxdata": "RGSS1", ".rvdata": "RGSS2", ".rvdata2": "RGSS3" });

function existsDir(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function contentRoots(entry) {
  const candidates = [entry?.moduleData?.decryptedRoot, entry?.contentRootDir, entry?.gamePath];
  const roots = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue;
    const root = path.resolve(candidate);
    if (existsDir(root) && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

function findInside(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.includes("\0")) return null;
  const parts = relative.replace(/\\/g, "/").split("/");
  if (parts.some(part => !part || part === "." || part === "..")) return null;
  let current = root;
  for (const part of parts) {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return null; }
    const entry = entries.find(entry => entry.name.toLowerCase() === part.toLowerCase());
    if (!entry || entry.isSymbolicLink()) return null;
    current = path.join(current, entry.name);
  }
  try { return fs.lstatSync(current).isFile() ? current : null; } catch { return null; }
}

function resolveScriptsPath(entry) {
  for (const root of contentRoots(entry)) {
    const ini = findInside(root, "Game.ini");
    if (ini) {
      try {
        const raw = Scripts.readBoundedFile(ini, 1024 * 1024).toString("utf8");
        let gameSection = false;
        for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
          const section = line.trim().match(/^\[(.+)\]$/);
          if (section) gameSection = section[1].toLowerCase() === "game";
          const match = gameSection && line.match(/^\s*Scripts\s*=\s*(.+?)\s*$/i);
          if (match) {
            const candidate = findInside(root, match[1].replace(/\s[;#].*$/, "").trim());
            if (candidate) return candidate;
          }
        }
      } catch {}
    }
    const preferred = { RGSS1: "rxdata", RGSS2: "rvdata", RGSS3: "rvdata2" }[entry?.moduleData?.rgssVersion];
    const extensions = [...new Set([preferred, "rvdata2", "rvdata", "rxdata"].filter(Boolean))];
    for (const ext of extensions) {
      const candidate = findInside(root, `Data/Scripts.${ext}`);
      if (candidate) return candidate;
    }
  }
  return null;
}

function discoverSaveFiles(entry, { directory = null, maxFiles = 256 } = {}) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 256) throw new Error("Invalid save discovery limit.");
  const candidates = new Map();
  const custom = directory || entry?.saveDirOverride;
  if (custom) candidates.set(path.resolve(custom), "user-selected directory");
  for (const root of contentRoots(entry)) {
    candidates.set(root, "portable game directory");
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const sub of entries) {
      if (sub.isDirectory() && /^(save|saves)$/i.test(sub.name)) candidates.set(path.join(root, sub.name), "game save subdirectory");
    }
  }
  const files = [];
  let truncated = false;
  for (const [dir, reason] of candidates) {
    if (truncated) break;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const file of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile()) continue;
      const ext = path.extname(file.name).toLowerCase();
      const variant = SAVE_EXTENSIONS[ext];
      if (!variant && ext !== ".sav") continue;
      if (reason === "portable game directory" && !/^save/i.test(file.name)) continue;
      if (files.length >= maxFiles) { truncated = true; break; }
      const filePath = path.join(dir, file.name);
      let fd;
      try {
        fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) continue;
        const header = Buffer.alloc(2);
        const size = fs.readSync(fd, header, 0, 2, 0);
        files.push({ filePath, fileName: file.name, directory: dir, engineVariant: variant || null, reason, size: stat.size, modifiedAt: stat.mtimeMs, marshal48: size === 2 && header[0] === 4 && header[1] === 8 });
      } catch {
        // Discovery is read-only and tolerates files removed by a running game.
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
  }
  return {
    files,
    truncated,
    searchedDirectories: Array.from(candidates.keys()),
    note: "Stock XP/VX/Ace portable saves and Save/Saves subdirectories only. Custom scripts may save elsewhere or use another format; select their directory explicitly. Files have not been runtime-load validated."
  };
}

function runtimeIdentity(entry, context = {}) {
  const configured = entry?.runtimeData?.mkxpz?.version || context?.settings?.runtimes?.mkxpz?.defaultVersion || null;
  return { id: "mkxpz", configuredVersion: configured, engineVariant: entry?.moduleData?.rgssVersion || null, runtimeLoadValidated: false };
}

function toolsRoot(entry, context) {
  if (!context?.userDataDir || !/^[a-zA-Z0-9_-]+$/.test(String(entry?.gameId || ""))) throw new Error("RGSS tools require a valid per-game data directory.");
  return path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "rgss"), "tools");
}

function resolveExportDir(entry, context) {
  const id = entry?.moduleData?.scriptsExportId;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  const dir = path.join(toolsRoot(entry, context), "scripts", id);
  return existsDir(dir) ? dir : null;
}

function exportGameScripts(entry, context) {
  const sourcePath = resolveScriptsPath(entry);
  if (!sourcePath) throw new Error("No readable Scripts archive found. Extract the encrypted game first.");
  const root = path.join(toolsRoot(entry, context), "scripts");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const exportId = Scripts.uniqueExportName();
  const result = Scripts.exportScripts({ sourcePath, outputDir: path.join(root, exportId), engineVariant: entry?.moduleData?.rgssVersion || null, runtime: runtimeIdentity(entry, context) });
  entry.moduleData = { ...entry.moduleData, scriptsExportId: exportId, scriptsExportCount: result.scriptCount, scriptsExportedAt: Date.now() };
  return { ...result, exportId };
}

function repackGameScripts(entry, context) {
  const exportDir = resolveExportDir(entry, context);
  if (!exportDir) throw new Error("Export Scripts before repacking.");
  const outputRoot = path.join(toolsRoot(entry, context), "repacked");
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const manifest = JSON.parse(Scripts.readBoundedFile(path.join(exportDir, "manifest.json")).toString("utf8"));
  const ext = path.extname(String(manifest.sourceFileName || "")).toLowerCase();
  if (!Object.hasOwn(SAVE_EXTENSIONS, ext)) throw new Error("Unknown Scripts archive extension.");
  const outputPath = path.join(outputRoot, `${Scripts.uniqueExportName()}-Scripts${ext}`);
  return Scripts.writeRepackedScripts({ exportDir, outputPath });
}

function inspectFile(filePath, options = {}) {
  const graph = parseMarshal(Scripts.readBoundedFile(filePath), { ...options, allowMultiple: true });
  return { ...graphReport(graph), sourcePath: path.resolve(filePath), parserFormat: "ruby-marshal-4.8-static-v1" };
}

function writeInspectionReport(entry, filePath, context) {
  const report = { ...inspectFile(filePath), runtime: runtimeIdentity(entry, context), engineVariant: entry?.moduleData?.rgssVersion || SAVE_EXTENSIONS[path.extname(filePath).toLowerCase()] || null };
  const root = path.join(toolsRoot(entry, context), "reports");
  const outputPath = writeLatestReport(root, "inspection.json", report, { legacyFiles: new RegExp(`^${LEGACY_REPORT_NAME}\\.json$`) });
  return { outputPath, nodeCount: report.nodes.length, streamCount: report.streams.length, sourceSha256: report.sha256, readOnly: true };
}

function writeSaveDiscoveryReport(entry, context, payload = {}) {
  const report = { format: "maclauncher-rgss-save-discovery-v1", ...discoverSaveFiles(entry, { directory: payload.directory }), runtime: runtimeIdentity(entry, context), discoveredAt: new Date().toISOString() };
  const root = path.join(toolsRoot(entry, context), "reports");
  const outputPath = writeLatestReport(root, "saves.json", report, { legacyFiles: new RegExp(`^${LEGACY_REPORT_NAME}-saves\\.json$`) });
  return { outputPath, saveFileCount: report.files.length, truncated: report.truncated, ...report };
}

module.exports = { SAVE_EXTENSIONS, resolveScriptsPath, discoverSaveFiles, runtimeIdentity, toolsRoot, resolveExportDir, exportGameScripts, repackGameScripts, inspectFile, writeInspectionReport, writeSaveDiscoveryReport };

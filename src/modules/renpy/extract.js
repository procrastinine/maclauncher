const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { buildUnrenCommand } = require("./unren");

const GameData = require("../shared/game-data");
const EXTRACT_META = ".maclauncher-renpy-extract.json";
const EXTRACT_REPORT = ".maclauncher-renpy-tools-report.json";
const extractionLocks = new Set();

function existsDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readExtractionMeta(extractRoot) {
  const metaPath = path.join(extractRoot, EXTRACT_META);
  try {
    if (!fs.existsSync(metaPath)) return null;
  } catch {
    return null;
  }
  try {
    const raw = fs.readFileSync(metaPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeExtractionMeta(extractRoot, payload) {
  const metaPath = path.join(extractRoot, EXTRACT_META);
  fs.writeFileSync(metaPath, JSON.stringify(payload, null, 2), "utf8");
}

function resolveExtractionRoot({ entry, userDataDir }) {
  if (!userDataDir) return null;
  const gameId = entry?.gameId;
  if (!gameId) throw new Error("Missing gameId for extraction root.");
  return path.join(GameData.resolveGameModuleDir(userDataDir, gameId, "renpy"), "extracted");
}

function resolveExtractionStatus({ entry, userDataDir, sourcePath } = {}) {
  if (!userDataDir) {
    return { extractedReady: false, extractedRoot: null, extractedAt: null, sourcePath: null };
  }
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const extractRoot = moduleData.extractedRoot || resolveExtractionRoot({ entry, userDataDir });
  if (!existsDir(extractRoot)) {
    return { extractedReady: false, extractedRoot: extractRoot, extractedAt: null, sourcePath: null };
  }
  const meta = readExtractionMeta(extractRoot);
  if (!meta || (meta.state && meta.state !== "complete")) {
    return { extractedReady: false, extractedRoot: extractRoot, extractedAt: null, sourcePath: null };
  }
  const extractedAt = meta?.extractedAt || null;
  const recordedSource = meta?.sourcePath || null;
  if (sourcePath && recordedSource) {
    try {
      if (path.resolve(recordedSource) !== path.resolve(sourcePath)) {
        return {
          extractedReady: false,
          extractedRoot: extractRoot,
          extractedAt,
          sourcePath: recordedSource
        };
      }
    } catch {}
  }
  return { extractedReady: true, extractedRoot: extractRoot, extractedAt, sourcePath: recordedSource,
    reportPath: meta.reportPath || null, extractedFiles: meta.extractedFiles ?? null,
    decompiledFiles: meta.decompiledFiles ?? null };
}

function copyLooseSources(source, destination) {
  const sourceFiles = [];
  function visit(dir, relative = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const rel = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (!["saves", "cache"].includes(entry.name)) visit(path.join(dir, entry.name), rel);
      } else if (entry.isFile() && [".rpy", ".rpym", ".rpyc", ".rpymc", ".py"].includes(path.extname(entry.name).toLowerCase())) sourceFiles.push(rel);
    }
  }
  visit(source);
  const sourceSet = new Set(sourceFiles);
  let copied = 0;
  for (const rel of sourceFiles) {
    const ext = path.extname(rel).toLowerCase();
    if ([".rpyc", ".rpymc"].includes(ext)) {
      const sourceRel = rel.slice(0, -1);
      if (!sourceSet.has(sourceRel)) fs.rmSync(path.join(destination, sourceRel), { force: true });
      continue;
    }
    const target = path.join(destination, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, rel), target);
    copied++;
  }
  return copied;
}

function readPhaseReport(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 8 * 1024 * 1024) throw new Error("Ren'Py tool report exceeds size limits.");
    const report = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(report.results)) throw new Error("Invalid Ren'Py tool report.");
    return report;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function performExtraction({ gameDir, extractRoot, userDataDir, renpyVersion = null, mode = "auto",
  tryHarder = false, runCommand, buildCommand = buildUnrenCommand, logger } = {}) {
  if (!["auto", "current", "legacy"].includes(mode)) throw new Error("Decompile mode must be auto, current or legacy.");
  if (typeof tryHarder !== "boolean") throw new Error("tryHarder must be a boolean.");
  if (!gameDir || !existsDir(gameDir) || !extractRoot) throw new Error("Game or extraction directory missing.");
  const relativeOutput = path.relative(path.resolve(gameDir), path.resolve(extractRoot));
  if (!relativeOutput || (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== ".." && !path.isAbsolute(relativeOutput))) {
    throw new Error("Ren'Py extraction output must be outside the source game directory.");
  }
  if (typeof runCommand !== "function") throw new Error("Ren'Py extraction requires a process runner.");
  const parent = path.dirname(extractRoot);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, ".extract-"));
  const reportsRoot = path.join(staging, ".tool-reports");
  fs.mkdirSync(reportsRoot);
  const report = { schemaVersion: 1, sourcePath: gameDir, startedAt: Date.now(), renpyVersion,
    options: { mode, tryHarder, runtimeFallback: false }, phases: [], state: "running" };
  const failedReportPath = path.join(parent, "extraction-last-failure.json");
  const backup = path.join(parent, `.previous-extract-${randomUUID()}`);
  let movedPrevious = false;
  let promoted = false;
  try {
    const unren = buildCommand({ userDataDir });
    report.pythonSource = unren.source;
    async function phase(id, args) {
      const reportFile = path.join(reportsRoot, `${id}.json`);
      logger?.info?.(`[renpy] ${id} for ${gameDir}`);
      let commandError = null;
      let output;
      try { output = await runCommand(unren.command, [...unren.args, ...args, "--report", reportFile], { env: unren.env }); }
      catch (error) { commandError = error; output = error; }
      const details = readPhaseReport(reportFile);
      report.phases.push({ id, ok: !commandError, error: commandError?.message || null,
        stdout: String(output?.stdout || "").slice(-65536), stderr: String(output?.stderr || "").slice(-65536),
        ...(details || {}) });
      // A normal per-file failure still writes a report. Preserve partial work
      // in this attempt while continuing later phases for useful diagnostics.
      if (!details) throw commandError || new Error(`Ren'Py ${id} did not produce its required tool report.`);
    }
    await phase("archives", ["extract", "--mode", "all", "--output", staging, "--base-dir", gameDir, "--detect-all", gameDir]);
    const options = ["--mode", mode, ...(tryHarder ? ["--try-harder"] : [])];
    await phase("archive-scripts", ["decompile", ...options, "--output", staging, "--base-dir", staging, staging]);
    report.looseSources = copyLooseSources(gameDir, staging);
    await phase("loose-scripts", ["decompile", ...options, "--output", staging, "--base-dir", gameDir, gameDir]);
    report.completedAt = Date.now();
    report.state = report.phases.every(p => p.ok && p.results?.every(r => r.state !== "error")) ? "complete" : "failed";
    report.extractedFiles = report.phases.filter(p => p.command === "extract").flatMap(p => p.results).reduce((n, r) => n + (r.extracted || 0), 0);
    report.decompiledFiles = report.phases.filter(p => p.command === "decompile").flatMap(p => p.results).filter(r => r.state === "ok").length;
    if (report.state !== "complete") {
      fs.writeFileSync(failedReportPath, JSON.stringify(report, null, 2), "utf8");
      const error = new Error(`Ren'Py extraction had file errors. Previous extraction was preserved. Report: ${failedReportPath}`);
      error.report = report;
      error.reportPath = failedReportPath;
      throw error;
    }
    // Staging paths in per-file reports describe this attempt. The durable
    // output path is explicit and remains stable after atomic promotion.
    report.outputRoot = extractRoot;
    report.reportPath = path.join(extractRoot, EXTRACT_REPORT);
    fs.writeFileSync(path.join(staging, EXTRACT_REPORT), JSON.stringify(report, null, 2), "utf8");
    writeExtractionMeta(staging, { sourcePath: gameDir, extractedAt: report.completedAt, state: "complete",
      reportPath: report.reportPath, extractedFiles: report.extractedFiles, decompiledFiles: report.decompiledFiles,
      renpyVersion, options: report.options });
    if (fs.existsSync(extractRoot)) { fs.renameSync(extractRoot, backup); movedPrevious = true; }
    fs.renameSync(staging, extractRoot);
    promoted = true;
    if (movedPrevious) fs.rmSync(backup, { recursive: true, force: true });
    fs.rmSync(failedReportPath, { force: true });
    return report;
  } catch (error) {
    if (movedPrevious && !promoted) fs.renameSync(backup, extractRoot);
    if (report.state !== "failed") {
      report.state = "failed";
      report.error = error.message;
      report.completedAt = Date.now();
      fs.writeFileSync(failedReportPath, JSON.stringify(report, null, 2), "utf8");
      error.reportPath = failedReportPath;
    }
    throw error;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

async function extractRenpyGame(options = {}) {
  const key = options.extractRoot ? path.resolve(options.extractRoot) : null;
  if (key && extractionLocks.has(key)) throw new Error("Ren'Py extraction is already running for this game.");
  if (key) extractionLocks.add(key);
  try { return await performExtraction(options); }
  finally { if (key) extractionLocks.delete(key); }
}

module.exports = {
  EXTRACT_META,
  EXTRACT_REPORT,
  readExtractionMeta,
  resolveExtractionRoot,
  resolveExtractionStatus,
  writeExtractionMeta,
  copyLooseSources,
  extractRenpyGame
};

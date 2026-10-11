const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Worker } = require("node:worker_threads");
const { resolveGameModuleDir } = require("../shared/game-data");
const { createAbortError, throwIfAborted } = require("../shared/runtime/download-utils");
const { getUiServices } = require("../shared/ui-services");

const LIMITS = Object.freeze({ files: 4096, fileBytes: 16 * 1024 * 1024, inputBytes: 128 * 1024 * 1024,
  outputBytes: 256 * 1024 * 1024, fileOutputBytes: 64 * 1024 * 1024, nodes: 2000000, depth: 64, textUnits: 200000 });
const PROJECT_FILE = /^(?:RPG_RT\.(?:ldb|lmt)|Map\d+\.lmu)$/i;

function projectFiles(root) {
  const files = fs.readdirSync(root, { withFileTypes: true })
    .filter(item => item.isFile() && PROJECT_FILE.test(item.name)).map(item => item.name).sort();
  if (!files.length || files.length > LIMITS.files) throw new Error("The project exceeds the supported LCF file count.");
  let total = 0;
  for (const name of files) {
    const stat = fs.lstatSync(path.join(root, name));
    if (!stat.isFile() || stat.size < 1 || stat.size > LIMITS.fileBytes) throw new Error("An LCF project file is empty, linked or larger than 16 MB.");
    total += stat.size;
  }
  if (total > LIMITS.inputBytes) throw new Error("LCF project data exceeds the 128 MB export limit.");
  return files;
}

function runExportWorker(data, context) {
  throwIfAborted(context.signal);
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "tools-worker.js"), { workerData: data,
      resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", cancel);
      worker.terminate().then(() => error ? reject(error) : resolve(result), () => error ? reject(error) : resolve(result));
    };
    const cancel = () => finish(createAbortError("LCF export canceled."));
    const timer = setTimeout(() => finish(new Error("The LCF export exceeded its time limit.")), 5 * 60 * 1000);
    context.signal?.addEventListener("abort", cancel, { once: true });
    worker.on("message", message => {
      if (message.type === "progress") context.onProgress?.({ phase: "export", label: "Export LCF data", current: message.current, total: data.files.length });
      if (message.type === "complete") finish(null, message.result);
      if (message.type === "error") finish(new Error(message.message));
    });
    worker.once("error", error => finish(new Error(`LCF export failed: ${error.message}`)));
    worker.once("exit", code => { if (!settled) finish(new Error(`LCF export stopped before completion (${code}).`)); });
    if (context.signal?.aborted) cancel();
  });
}

async function exportProject(entry, payload, context, mode = "json") {
  throwIfAborted(context.signal);
  if (!["json", "text"].includes(mode)) throw new Error("Unknown LCF export format.");
  if (!/^[A-Za-z0-9_-]+$/.test(entry?.gameId || "") || !path.isAbsolute(context?.userDataDir || ""))
    throw new Error("LCF exports require a saved game entry and launcher data directory.");
  const root = fs.realpathSync(entry.contentRootDir || entry.gamePath);
  const files = projectFiles(root);
  const exports = path.join(resolveGameModuleDir(context.userDataDir, entry.gameId, "easyrpg"), "exports");
  fs.mkdirSync(exports, { recursive: true });
  const staging = fs.mkdtempSync(path.join(exports, ".export-"));
  const final = path.join(exports, `${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`);
  try {
    const requestedEngine = payload?.engine || context.runtimeSettings?.engine;
    const engine = requestedEngine && requestedEngine !== "auto"
      ? /^rpg2k3/.test(requestedEngine) || requestedEngine === "2k3" ? "2k3" : /^rpg2k/.test(requestedEngine) || requestedEngine === "2k" ? "2k" : null
      : null;
    if (requestedEngine && requestedEngine !== "auto" && !engine) throw new Error("Invalid RPG Maker export engine mode.");
    const encoding = payload?.encoding || context.runtimeSettings?.encoding || entry.moduleData?.encoding || null;
    if (encoding && (typeof encoding !== "string" || encoding.length > 128 || encoding.includes("\0"))) throw new Error("Invalid LCF export encoding.");
    const result = await runExportWorker({ root, files, staging, mode, engine, encoding, limits: LIMITS }, context);
    throwIfAborted(context.signal);
    fs.renameSync(staging, final);
    entry.moduleData = { ...entry.moduleData, exportRoot: final, exportFormat: mode, exportFileCount: result.fileCount };
    context.onEntryChange?.(entry);
    return { ...result, exportRoot: final, format: mode, tool: "rpgrt 0.2.0" };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

function revealExport(entry, _payload, context) {
  const directory = entry.moduleData?.exportRoot;
  const owned = path.join(resolveGameModuleDir(context.userDataDir, entry.gameId, "easyrpg"), "exports");
  let available = false;
  try {
    available = typeof directory === "string" && path.resolve(directory).startsWith(path.resolve(owned) + path.sep) &&
      fs.lstatSync(directory).isDirectory() && fs.realpathSync(directory).startsWith(fs.realpathSync(owned) + path.sep);
  } catch { /* A removed export is unavailable. */ }
  if (!available) throw new Error("No LCF export is available. Export project data or game text first.");
  getUiServices(context).shell.showItemInFolder(directory);
  return { revealed: true };
}

module.exports = { LIMITS, PROJECT_FILE, projectFiles, exportProject, revealExport };

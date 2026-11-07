const fs = require("node:fs");
const path = require("node:path");
const AppBundle = require("../modules/shared/runtime/app-bundle");
const { throwIfAborted } = require("../modules/shared/runtime/download-utils");

// A selected folder with no recognized game at its top level, or with more than
// one possible game, is searched for games it holds. Every module's ordinary
// detection runs on each subfolder, breadth first, to a fixed depth. A folder
// that is a game is offered and not entered; a folder with several possible
// games offers each choice its module names. Choices for one game share its
// gamePath, so only offers with distinct game paths are separate games. The
// search only reads.
const LIMITS = Object.freeze({ depth: 3, folders: 32, choices: 8, games: 16 });
const SEARCHED = new Set(["DETECTION_UNSUPPORTED", "DETECTION_CONFLICT"]);

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function subfolders(directory) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return []; }
  return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
    .map(entry => path.join(directory, entry.name))
    // Application and other macOS bundles are detected by their parent folder.
    .filter(folder => !AppBundle.readInfoPlist(folder)?.CFBundlePackageType)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

// A choice whose name appears in the folders that lead to it comes first.
function rankChoices(root, choices) {
  const route = file => path.relative(root, path.dirname(file)).toLowerCase();
  const named = file => route(file).includes(path.basename(file, path.extname(file)).toLowerCase());
  return [...choices].sort((a, b) => Number(named(b)) - Number(named(a)) ||
    path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true, sensitivity: "base" }));
}

// A choice is named after its file; a folder after the game detected in it.
function offer(root, inputPath, report, choice) {
  const detected = report.detected;
  return { inputPath, relativePath: path.relative(root, inputPath), gamePath: detected.gamePath || inputPath,
    name: choice ? path.basename(inputPath, path.extname(inputPath)) : detected.name || path.basename(inputPath),
    moduleId: report.selectedModuleId || detected.moduleId || null,
    label: report.candidates?.find(candidate => candidate.moduleId === report.selectedModuleId)?.label || null };
}

async function findNestedGames(inputPath, error, { detect, signal, limits = LIMITS } = {}) {
  if (!SEARCHED.has(error?.code) || typeof detect !== "function") return [];
  let root;
  try {
    if (!fs.statSync(inputPath).isDirectory() || AppBundle.readInfoPlist(inputPath)?.CFBundlePackageType) return [];
    root = fs.realpathSync(inputPath);
  } catch { return []; }
  const games = [], seen = new Set();
  let detections = 0;
  const add = (candidate, report, choice = false) => {
    const key = choice ? candidate : `${report.selectedModuleId}\0${path.resolve(report.detected.gamePath || candidate)}`;
    if (seen.has(key) || games.length >= limits.games) return;
    seen.add(key);
    games.push(offer(inputPath, candidate, report, choice));
  };
  async function explain(candidate) {
    throwIfAborted(signal);
    detections++;
    try { return await detect(candidate, { workerMode: "inline" }); } catch { return null; }
  }
  async function offerChoices(choices) {
    for (const choice of rankChoices(inputPath, choices.filter(file => typeof file === "string" && inside(root, safeRealpath(file)))).slice(0, limits.choices)) {
      const report = await explain(choice);
      if (report?.detected) add(choice, report, true);
    }
  }
  // The selected folder's own conflict already names its choices.
  if (error.code === "DETECTION_CONFLICT") {
    await offerChoices(error.choices || error.detection?.error?.choices || []);
    return games;
  }
  const pending = subfolders(inputPath);
  while (pending.length && detections < limits.folders && games.length < limits.games) {
    const folder = pending.shift();
    if (!inside(root, safeRealpath(folder))) continue;
    const report = await explain(folder);
    if (!report) continue;
    if (report.detected) { add(folder, report); continue; }
    if (report.error?.code === "DETECTION_CONFLICT") { await offerChoices(report.error.choices || []); continue; }
    if (report.error?.code !== "DETECTION_UNSUPPORTED") continue;
    // Detection already entered folders that hold a single item.
    const searched = report.input?.resolvedPath || folder;
    const level = path.relative(inputPath, searched).split(path.sep).length;
    if (level < limits.depth) pending.push(...subfolders(searched));
  }
  return games;
}

function safeRealpath(file) {
  try { return fs.realpathSync(file); } catch { return ""; }
}

module.exports = { LIMITS, findNestedGames };

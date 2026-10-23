const fs = require("node:fs");
const path = require("node:path");
const { inspectGame } = require("./inspect");
const { readGoBuildInfo } = require("./go-build-info");

function isDirectory(directory) {
  try { return fs.statSync(directory).isDirectory(); } catch { return false; }
}
function validMotif(root, value) {
  const relative = String(value || "").trim().replace(/^"|"$/g, "").replace(/\\/g, "/");
  if (!relative || relative.includes("\0") || path.isAbsolute(relative)) return null;
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(path.resolve(root) + path.sep)) return null;
  try {
    const text = fs.readFileSync(absolute, "utf8");
    return /\[Info\]/i.test(text) && /\[Files\]/i.test(text) ? path.relative(root, absolute) : null;
  } catch { return null; }
}
function detectGame(context) {
  let root = context.isAppBundle ? path.dirname(context.rootDir) : context.rootDir;
  if (!isDirectory(path.join(root, "chars")) || !isDirectory(path.join(root, "stages")) || !isDirectory(path.join(root, "data"))) return null;
  let motif = null;
  const mugenConfig = path.join(root, "data", "mugen.cfg");
  try {
    const value = fs.readFileSync(mugenConfig, "utf8").match(/^\s*motif\s*=\s*([^;\r\n]+)/im)?.[1];
    if (value) motif = validMotif(root, value);
  } catch {}
  motif ||= validMotif(root, "data/system.def");
  if (!motif) {
    const candidates = [];
    for (const name of fs.readdirSync(path.join(root, "data"))) {
      const relative = validMotif(root, `data/${name}/system.def`);
      if (relative) candidates.push(relative);
    }
    if (candidates.length === 1) motif = candidates[0];
  }
  if (!motif) return null;
  const runnerCandidates = context.stat?.isFile() && /\.exe$/i.test(context.inputPath)
    ? [context.inputPath] : fs.readdirSync(root).filter(name => /\.exe$/i.test(name)).sort().slice(0, 4).map(name => path.join(root, name));
  let sourceRunner = null;
  for (const candidate of runnerCandidates) { sourceRunner = readGoBuildInfo(candidate, { detection: context.detection }); if (sourceRunner) break; }
  return { moduleId: "ikemen", engine: "ikemen", gamePath: root, contentRootDir: root,
    name: path.basename(root), runtimeId: "ikemen", moduleData: { motifRelative: motif,
      ...inspectGame(root, motif),
      sourceRunner,
      sourceKind: fs.existsSync(path.join(root, "external", "script", "main.lua")) ? "ikemen" : "mugen" } };
}

module.exports = { detectGame, validMotif };

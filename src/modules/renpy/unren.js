const fs = require("node:fs");
const path = require("node:path");

const { resolvePythonBinary } = require("../shared/runtime/python");

const isElectron = Boolean(process.versions && process.versions.electron);
const isPackaged = isElectron && !process.defaultApp;

function existsDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function resolveUnrenRoot() {
  const candidates = [];
  if (isPackaged && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "unren"));
    candidates.push(path.join(process.resourcesPath, "resources", "unren"));
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked", "unren"));
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked", "resources", "unren"));
  }
  candidates.push(path.resolve(__dirname, "resources", "unren"));
  if (!isPackaged && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "unren"));
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (existsDir(candidate)) return candidate;
  }
  return null;
}

function buildUnrenCommand({ userDataDir } = {}) {
  const resolved = resolvePythonBinary({ userDataDir });
  const unrenRoot = resolveUnrenRoot();
  if (!unrenRoot) throw new Error("UnRen tools not found.");
  const env = {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: "1"
  };
  const pythonPathParts = [path.dirname(unrenRoot), env.PYTHONPATH || ""].filter(Boolean);
  env.PYTHONPATH = pythonPathParts.join(path.delimiter);
  return {
    command: resolved.pythonPath,
    args: ["-m", "unren"],
    env,
    source: resolved.source,
    unrenRoot
  };
}

module.exports = {
  resolveUnrenRoot,
  buildUnrenCommand
};

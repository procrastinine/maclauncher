const fs = require("node:fs");
const path = require("node:path");

const isElectron = Boolean(process.versions && process.versions.electron);
const isPackaged = isElectron && !process.defaultApp;

function resolvePackagedResourcePath(...segments) {
  if (!process.resourcesPath) return null;
  const candidates = [
    path.join(process.resourcesPath, ...segments),
    path.join(process.resourcesPath, "app.asar.unpacked", ...segments),
    path.join(process.resourcesPath, "app.asar.unpacked", "src", ...segments)
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

function resolvePackagedPythonRoot() {
  return (
    resolvePackagedResourcePath("python") ||
    resolvePackagedResourcePath("resources", "python")
  );
}

function resolvePackagedEvbunpackRoot() {
  return (
    resolvePackagedResourcePath("external", "evbunpack") ||
    resolvePackagedResourcePath("src", "external", "evbunpack")
  );
}

function resolveEmbeddedPythonRoot() {
  const candidates = [];
  if (isPackaged) {
    const packaged = resolvePackagedPythonRoot();
    if (packaged) candidates.push(packaged);
  }
  candidates.push(path.resolve(__dirname, "../../../resources/python"));
  if (!isPackaged) {
    const packaged = resolvePackagedPythonRoot();
    if (packaged) candidates.push(packaged);
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

function resolveEmbeddedPythonBinary(rootDir) {
  if (!rootDir) return null;
  const candidates = ["python3", "python"].map(name => path.join(rootDir, "bin", name));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

function resolveEvbunpackRoot() {
  if (isPackaged) {
    const packaged = resolvePackagedEvbunpackRoot();
    if (packaged) return packaged;
  }
  return path.resolve(__dirname, "../../../external/evbunpack");
}

function resolveEvbunpackVenvDir(userDataDir) {
  if (!userDataDir) return null;
  return path.join(userDataDir, "runtimes", "python", "evbunpack", "venv");
}

function resolvePythonBinary({ userDataDir } = {}) {
  const venvDir = resolveEvbunpackVenvDir(userDataDir);
  if (venvDir) {
    const candidate = path.join(venvDir, "bin", "python3");
    if (fs.existsSync(candidate)) {
      return { pythonPath: candidate, source: "managed" };
    }
  }
  const embeddedRoot = resolveEmbeddedPythonRoot();
  const embeddedBinary = resolveEmbeddedPythonBinary(embeddedRoot);
  if (embeddedBinary) {
    return { pythonPath: embeddedBinary, source: "embedded" };
  }
  if (process.env.PYTHON3 && String(process.env.PYTHON3).trim()) {
    return { pythonPath: String(process.env.PYTHON3).trim(), source: "env" };
  }
  if (process.env.PYTHON && String(process.env.PYTHON).trim()) {
    return { pythonPath: String(process.env.PYTHON).trim(), source: "env" };
  }
  return { pythonPath: "python3", source: "system" };
}

function buildEvbunpackCommand({ userDataDir } = {}) {
  const resolved = resolvePythonBinary({ userDataDir });
  const evbunpackRoot = resolveEvbunpackRoot();
  const env = {
    ...process.env,
    PYTHONPATH: [evbunpackRoot, process.env.PYTHONPATH || ""]
      .filter(Boolean)
      .join(path.delimiter)
  };
  return {
    command: resolved.pythonPath,
    args: ["-m", "evbunpack"],
    env,
    source: resolved.source,
    evbunpackRoot
  };
}

module.exports = {
  resolveEmbeddedPythonRoot,
  resolveEmbeddedPythonBinary,
  resolveEvbunpackRoot,
  resolveEvbunpackVenvDir,
  resolvePythonBinary,
  buildEvbunpackCommand
};

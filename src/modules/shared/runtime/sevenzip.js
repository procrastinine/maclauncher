const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveCommandOnPath(name) {
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsFile(candidate)) return candidate;
  }
  return null;
}

function resolveSevenZipBinary() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "7zip", "7zz"));
  }
  candidates.push(path.resolve(__dirname, "../../../resources/7zip/7zz"));

  for (const candidate of candidates) {
    if (existsFile(candidate)) return candidate;
  }

  for (const name of ["7zz", "7z", "7za"]) {
    const resolved = resolveCommandOnPath(name);
    if (resolved) return resolved;
  }

  return null;
}

function parseSevenZipList(output, archivePath) {
  const entries = [];
  const lines = String(output || "").split(/\r?\n/);
  let current = null;

  for (const line of lines) {
    if (line.startsWith("Path = ")) {
      if (current && current.path) entries.push(current);
      const raw = line.slice(7).trim();
      const normalized = raw.replace(/\\/g, "/");
      current = { path: normalized, isDirectory: false };
      continue;
    }
    if (line.startsWith("Folder = ") && current) {
      current.isDirectory = line.slice(9).trim() === "+";
    }
  }

  if (current && current.path) entries.push(current);

  return entries.filter(entry => entry.path && entry.path !== archivePath);
}

function listArchiveEntriesSync(archivePath, binaryPath = null) {
  const sevenZip = binaryPath || resolveSevenZipBinary();
  if (!sevenZip) return null;
  const res = spawnSync(sevenZip, ["l", "-ba", "-slt", archivePath], { encoding: "utf8" });
  if (res.status !== 0) return null;
  return parseSevenZipList(res.stdout, archivePath);
}

function runCommand(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", buf => {
      stderr += buf.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) return resolve(true);
      const err = new Error(`${cmd} failed (${code})`);
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function extractArchive(archivePath, destDir, binaryPath = null) {
  const sevenZip = binaryPath || resolveSevenZipBinary();
  if (!sevenZip) throw new Error("7-Zip binary not found.");
  await runCommand(sevenZip, ["x", "-y", `-o${destDir}`, archivePath]);
  return true;
}

module.exports = {
  resolveSevenZipBinary,
  listArchiveEntriesSync,
  extractArchive
};

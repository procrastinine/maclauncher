const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const EXTRACT_META = ".maclauncher-rgss-decrypt.json";
const ARCHIVE_EXTS = [".rgss3a", ".rgss2a", ".rgssad"];
const SKIP_DIRS = new Set([".git", "node_modules", "__MACOSX"]);

function stableIdForPath(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex").slice(0, 12);
}

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function existsDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function resolveDecrypterBinary() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "RPGMakerDecrypter", "RPGMakerDecrypter-cli"));
    candidates.push(path.join(process.resourcesPath, "resources", "RPGMakerDecrypter", "RPGMakerDecrypter-cli"));
    candidates.push(
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "resources",
        "RPGMakerDecrypter",
        "RPGMakerDecrypter-cli"
      )
    );
    candidates.push(
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "RPGMakerDecrypter",
        "RPGMakerDecrypter-cli"
      )
    );
  }
  candidates.push(
    path.resolve(__dirname, "..", "..", "resources", "RPGMakerDecrypter", "RPGMakerDecrypter-cli")
  );

  for (const candidate of candidates) {
    if (candidate && existsFile(candidate)) return candidate;
  }
  return null;
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function pickArchive(candidates, preferredNames = []) {
  if (!candidates.length) return null;
  const preferred = Array.from(
    new Set((preferredNames || []).map(normalizeName).filter(Boolean))
  );
  for (const name of preferred) {
    const matches = candidates.filter(entry => entry.base === name);
    if (matches.length) {
      matches.sort((a, b) => a.depth - b.depth || b.size - a.size);
      return matches[0].path;
    }
  }
  candidates.sort((a, b) => a.depth - b.depth || b.size - a.size);
  return candidates[0].path;
}

function listArchiveCandidates(rootDir) {
  const matches = [];
  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length) {
    const current = queue.pop();
    if (!current) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const name = entry.name || "";
      if (!name) continue;
      const fullPath = path.join(current.dir, name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        queue.push({ dir: fullPath, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(name).toLowerCase();
      if (!ARCHIVE_EXTS.includes(ext)) continue;
      let size = 0;
      try {
        const stat = fs.statSync(fullPath);
        size = stat.size || 0;
      } catch {}
      matches.push({
        path: fullPath,
        ext,
        base: path.basename(name, ext).toLowerCase(),
        size,
        depth: current.depth
      });
    }
  }
  return matches;
}

function resolveArchivePath(entry) {
  const rootDir = entry?.contentRootDir || entry?.gamePath;
  if (!rootDir) return null;
  const matches = listArchiveCandidates(rootDir);
  if (!matches.length) return null;
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const rgssVersion = moduleData.rgssVersion;
  const execName = normalizeName(moduleData.execName);
  const preferredNames = execName ? [execName, "game"] : ["game"];
  const preferredExt =
    rgssVersion === "RGSS3" ? ".rgss3a" : rgssVersion === "RGSS2" ? ".rgss2a" : rgssVersion === "RGSS1" ? ".rgssad" : null;
  const orderedExts = preferredExt
    ? [preferredExt, ...ARCHIVE_EXTS.filter(ext => ext !== preferredExt)]
    : ARCHIVE_EXTS;

  for (const ext of orderedExts) {
    const subset = matches.filter(match => match.ext === ext);
    const picked = pickArchive(subset, preferredNames);
    if (picked) return picked;
  }

  return pickArchive(matches, preferredNames);
}

function readExtractionMeta(extractRoot) {
  const metaPath = path.join(extractRoot, EXTRACT_META);
  if (!existsFile(metaPath)) return null;
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
  try {
    fs.writeFileSync(metaPath, JSON.stringify(payload, null, 2), "utf8");
  } catch {}
}

function resolveExtractionRoot({ entry, userDataDir }) {
  const key = entry?.gamePath || entry?.contentRootDir || entry?.importPath || "";
  const id = stableIdForPath(key);
  return path.join(userDataDir, "modules", "rgss", "extracted", id);
}

function resolveExtractionStatus({ entry, userDataDir } = {}) {
  if (!userDataDir) {
    return {
      decryptedReady: false,
      decryptedRoot: null,
      decryptedAt: null,
      archivePath: null,
      mode: null,
      sourcePath: null
    };
  }

  const archivePath = resolveArchivePath(entry);
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const extractRoot = moduleData.decryptedRoot || resolveExtractionRoot({ entry, userDataDir });
  if (!existsDir(extractRoot)) {
    return {
      decryptedReady: false,
      decryptedRoot: extractRoot,
      decryptedAt: null,
      archivePath,
      mode: null,
      sourcePath: null
    };
  }

  const meta = readExtractionMeta(extractRoot);
  const extractedAt = meta?.extractedAt || null;
  const recordedSource = meta?.sourcePath || null;
  if (archivePath && recordedSource) {
    try {
      if (path.resolve(archivePath) !== path.resolve(recordedSource)) {
        return {
          decryptedReady: false,
          decryptedRoot: extractRoot,
          decryptedAt: extractedAt,
          archivePath,
          mode: meta?.mode || null,
          sourcePath: recordedSource
        };
      }
    } catch {}
  }

  return {
    decryptedReady: true,
    decryptedRoot: extractRoot,
    decryptedAt: extractedAt,
    archivePath,
    mode: meta?.mode || null,
    sourcePath: recordedSource
  };
}

function runCommand(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", buf => {
      stdout += buf.toString("utf8");
    });
    child.stderr.on("data", buf => {
      stderr += buf.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) return resolve(true);
      const err = new Error(`${cmd} failed (${code})`);
      err.stderr = stderr;
      err.stdout = stdout;
      reject(err);
    });
  });
}

async function runDecrypter({ archivePath, outputDir, reconstruct = false, logger } = {}) {
  const cli = resolveDecrypterBinary();
  if (!cli) throw new Error("RPGMakerDecrypter CLI not found.");
  const args = [archivePath, "--overwrite"];
  if (reconstruct) args.push("--reconstruct-project");
  args.push(`--output=${outputDir}`);
  logger?.info?.(`[rgss] running RPGMakerDecrypter`, { cli, args });
  await runCommand(cli, args, { env: process.env });
  return true;
}

module.exports = {
  EXTRACT_META,
  resolveArchivePath,
  resolveExtractionRoot,
  resolveExtractionStatus,
  readExtractionMeta,
  writeExtractionMeta,
  runDecrypter,
  stableIdForPath
};

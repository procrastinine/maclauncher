const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GameData = require("../game-data");
const EXTRACT_META = ".maclauncher-mvmz-decrypt.json";

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

function resolveSourceRoot(entry) {
  if (entry?.contentRootDir) return entry.contentRootDir;
  if (entry?.gamePath) return entry.gamePath;
  if (entry?.indexDir) return entry.indexDir;
  if (entry?.indexHtml) return path.dirname(entry.indexHtml);
  return null;
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
    path.resolve(__dirname, "..", "..", "..", "resources", "RPGMakerDecrypter", "RPGMakerDecrypter-cli")
  );

  for (const candidate of candidates) {
    if (candidate && existsFile(candidate)) return candidate;
  }
  return null;
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

function resolveExtractionRoot({ entry, userDataDir, moduleId } = {}) {
  const moduleKey = moduleId || entry?.moduleId || "mvmz";
  if (!userDataDir) return null;
  const gameId = entry?.gameId;
  if (!gameId) throw new Error("Missing gameId for extraction root.");
  return path.join(GameData.resolveGameModuleDir(userDataDir, gameId, moduleKey), "extracted");
}

function resolveExtractionStatus({ entry, userDataDir, sourcePath, moduleId } = {}) {
  if (!userDataDir) {
    return {
      decryptedReady: false,
      decryptedRoot: null,
      decryptedAt: null,
      sourcePath: null,
      mode: null
    };
  }

  const resolvedSource = sourcePath || resolveSourceRoot(entry);
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const extractRoot = moduleData.decryptedRoot || resolveExtractionRoot({ entry, userDataDir, moduleId });
  if (!existsDir(extractRoot)) {
    return {
      decryptedReady: false,
      decryptedRoot: extractRoot,
      decryptedAt: null,
      sourcePath: resolvedSource || null,
      mode: null
    };
  }

  const meta = readExtractionMeta(extractRoot);
  const extractedAt = meta?.extractedAt || null;
  const recordedSource = meta?.sourcePath || null;
  if (resolvedSource && recordedSource) {
    try {
      if (path.resolve(resolvedSource) !== path.resolve(recordedSource)) {
        return {
          decryptedReady: false,
          decryptedRoot: extractRoot,
          decryptedAt: extractedAt,
          sourcePath: recordedSource,
          mode: meta?.mode || null
        };
      }
    } catch {}
  }

  return {
    decryptedReady: true,
    decryptedRoot: extractRoot,
    decryptedAt: extractedAt,
    sourcePath: recordedSource || resolvedSource || null,
    mode: meta?.mode || null
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

async function runDecrypter({ sourcePath, outputDir, reconstruct = false, logger } = {}) {
  const cli = resolveDecrypterBinary();
  if (!cli) throw new Error("RPGMakerDecrypter CLI not found.");
  if (!sourcePath) throw new Error("Missing RPG Maker source path.");
  const args = [sourcePath, "--overwrite"];
  if (reconstruct) args.push("--reconstruct-project");
  if (outputDir) args.push(`--output=${outputDir}`);
  logger?.info?.("[mvmz] running RPGMakerDecrypter", { cli, args });
  await runCommand(cli, args, { env: process.env });
  return true;
}

module.exports = {
  EXTRACT_META,
  resolveSourceRoot,
  resolveExtractionRoot,
  resolveExtractionStatus,
  readExtractionMeta,
  writeExtractionMeta,
  runDecrypter
};

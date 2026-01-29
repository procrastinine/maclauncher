const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  attachAbortSignal,
  createAbortError,
  downloadToFile,
  throwIfAborted
} = require("../../shared/runtime/download-utils");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function normalizeVersion(input) {
  const v = String(input ?? "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error(`Invalid Ren'Py version: ${String(input ?? "")}`);
  }
  return v;
}

function getDownloadUrl(version) {
  const v = normalizeVersion(version);
  return `https://www.renpy.org/dl/${v}/renpy-${v}-sdk.zip`;
}

function runCommand(cmd, args, options) {
  const { signal, ...spawnOptions } = options || {};
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const removeAbort = attachAbortSignal(signal, () => {
      try {
        child.kill("SIGTERM");
      } catch {}
    });
    child.stdout.on("data", b => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", b => {
      stderr += b.toString("utf8");
    });
    child.on("error", err => {
      removeAbort();
      reject(err);
    });
    child.on("close", code => {
      removeAbort();
      if (signal?.aborted) return reject(createAbortError());
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${cmd} failed (exit ${code})`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

function looksLikeSdkRoot(dir) {
  const markers = ["renpy.app", "Ren'Py.app", "renpy.sh", "renpy.py"];
  return markers.some(name => fs.existsSync(path.join(dir, name)));
}

function findSdkRoot(extractDir, version) {
  if (looksLikeSdkRoot(extractDir)) return extractDir;

  let entries = [];
  try {
    entries = fs.readdirSync(extractDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    entries = [];
  }

  let best = null;
  let bestScore = -1;
  for (const entry of entries) {
    const full = path.join(extractDir, entry.name);
    if (!looksLikeSdkRoot(full)) continue;
    const name = entry.name.toLowerCase();
    let score = 0;
    if (name.includes("renpy")) score += 1;
    if (name.includes("sdk")) score += 1;
    if (version && name.includes(String(version).toLowerCase())) score += 2;
    if (score > bestScore) {
      best = full;
      bestScore = score;
    }
  }

  if (!best) throw new Error("Ren'Py SDK not found in zip");
  return best;
}

async function preparePatchSdk({ version, logger, onProgress, signal }) {
  const v = normalizeVersion(version);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-renpy-patch-"));
  const zipPath = path.join(tmpDir, `renpy-${v}-sdk.zip`);
  const extractDir = path.join(tmpDir, "extract");
  ensureDir(extractDir);

  try {
    const url = getDownloadUrl(v);
    logger?.info?.(`[renpy] downloading patch SDK zip ${url}`);
    await downloadToFile(url, zipPath, { onProgress, signal });
    throwIfAborted(signal);

    const ditto = fs.existsSync("/usr/bin/ditto") ? "/usr/bin/ditto" : "ditto";
    await runCommand(ditto, ["-x", "-k", zipPath, extractDir], { signal });
    const sdkRoot = findSdkRoot(extractDir, v);
    return {
      sdkRoot,
      sdkVersion: v,
      cleanup: () => safeRm(tmpDir)
    };
  } catch (e) {
    safeRm(tmpDir);
    throw e;
  }
}

module.exports = {
  preparePatchSdk
};

const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

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

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => resolve(res));
    req.on("error", reject);
    req.end();
  });
}

async function downloadToFile(url, destPath, onProgress, redirectDepth = 0) {
  if (redirectDepth > 5) throw new Error("Too many redirects while downloading Ren'Py");

  const res = await httpGet(url);
  const status = Number(res.statusCode || 0);

  if ([301, 302, 303, 307, 308].includes(status)) {
    const loc = res.headers.location;
    res.resume();
    if (!loc) throw new Error(`Redirect missing location: ${url}`);
    const nextUrl = new URL(loc, url).toString();
    return downloadToFile(nextUrl, destPath, onProgress, redirectDepth + 1);
  }

  if (status !== 200) {
    res.resume();
    const err = new Error(`Download failed (${status})`);
    err.statusCode = status;
    throw err;
  }

  const total = Number(res.headers["content-length"] || 0) || null;
  ensureDir(path.dirname(destPath));
  const out = fs.createWriteStream(destPath);

  return new Promise((resolve, reject) => {
    let downloaded = 0;
    const cleanup = e => {
      try {
        out.close();
      } catch {}
      safeRm(destPath);
      reject(e);
    };

    res.on("data", chunk => {
      downloaded += chunk.length || 0;
      try {
        onProgress?.({ downloaded, total });
      } catch {}
    });
    res.on("error", cleanup);
    out.on("error", cleanup);
    out.on("finish", () => resolve({ downloaded, total }));
    res.pipe(out);
  });
}

function runCommand(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", b => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", b => {
      stderr += b.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", code => {
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

async function preparePatchSdk({ version, logger, onProgress }) {
  const v = normalizeVersion(version);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-renpy-patch-"));
  const zipPath = path.join(tmpDir, `renpy-${v}-sdk.zip`);
  const extractDir = path.join(tmpDir, "extract");
  ensureDir(extractDir);

  try {
    const url = getDownloadUrl(v);
    logger?.info?.(`[renpy] downloading patch SDK zip ${url}`);
    await downloadToFile(url, zipPath, onProgress);

    const ditto = fs.existsSync("/usr/bin/ditto") ? "/usr/bin/ditto" : "ditto";
    await runCommand(ditto, ["-x", "-k", zipPath, extractDir]);
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

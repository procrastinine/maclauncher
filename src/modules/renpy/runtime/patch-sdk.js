const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ReleaseFiles = require("../../shared/runtime/release-files");
const Sdk = require("./sdk-manager");
const { throwIfAborted } = require("../../shared/runtime/download-utils");

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

async function preparePatchSdk({ version, logger, onProgress, signal }) {
  const v = normalizeVersion(version);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-renpy-patch-"));
  const extractDir = path.join(tmpDir, "extract");
  ensureDir(extractDir);

  try {
    // The SDK ZIP the version folder lists, or another SDK archive there; a
    // SHA-256 from the folder's checksums.txt is checked.
    const file = await Sdk.sdkDownload(v, { signal, formats: [".zip", ".tar.bz2"] });
    const zipPath = path.join(tmpDir, file.name);
    logger?.info?.(`[renpy] downloading patch SDK ${file.url}`);
    await Sdk.source.download(file, zipPath, { onProgress, signal });
    throwIfAborted(signal);

    await ReleaseFiles.extractArchive(zipPath, extractDir, signal);
    const sdkRoot = Sdk.findSdkRoot(extractDir, v);
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

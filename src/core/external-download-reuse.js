const fs = require("node:fs"), path = require("node:path");

async function reuseCompletedDownload(record, existing, { signal, onChange, onDownloaded } = {}) {
  signal?.throwIfAborted();
  const root = fs.realpathSync(existing.path);
  let importPath = root;
  try {
    const candidate = fs.realpathSync(existing.importPath || root), relative = path.relative(root, candidate);
    if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) importPath = candidate;
  } catch {}
  Object.assign(record, { path: root, importPath, buildId: existing.buildId ?? null, version: existing.version || existing.versionName || record.version,
    versionName: existing.versionName || existing.version || record.versionName, versionId: existing.versionId || record.versionId,
    downloadIdentity: existing.downloadIdentity || record.downloadIdentity, reused: true, status: "completed", downloaded: 0, total: 0,
    detail: "Using existing download", completedAt: new Date().toISOString() });
  onChange?.();
  if (record.autoImport && onDownloaded) {
    try { await onDownloaded(JSON.parse(JSON.stringify(record))); record.imported = true; }
    catch { record.importError = "The existing download could not be imported. Import the downloaded files manually."; }
  }
  return JSON.parse(JSON.stringify(record));
}

module.exports = { reuseCompletedDownload };

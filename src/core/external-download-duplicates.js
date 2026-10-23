const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const stores = new Set(['steam', 'epic', 'gog', 'itch', 'google-play', 'fdroid', 'izzy']);
function createDownloadIdentity({ store, appId, platform, versionId, depots } = {}) {
  if (!stores.has(store) || !appId || !['windows', 'macos', 'linux', 'web', 'android'].includes(platform)) return null;
  const content = Array.isArray(depots) && depots.length ? depots.map(item => [String(item.depotId ?? item.id), String(item.manifestId ?? item.manifest)]).sort((a, b) => a[0].localeCompare(b[0])) : String(versionId || '');
  if (!content.length) return null;
  return crypto.createHash('sha256').update(JSON.stringify({ schema: 1, store, appId: String(appId), platform, content })).digest('hex');
}
async function readJson(file) {
  try {
    const stat = await fs.lstat(file); if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch { return null; }
}
function inside(root, candidate) { const relative = path.relative(root, candidate); return !relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); }
function savedVersionId(store, metadata) {
  if (metadata.versionId) return metadata.versionId;
  if (store === 'itch') return metadata.branch;
  if (store === 'epic' && metadata.manifestBuildId) return `manifest:${metadata.manifestBuildId}:${metadata.platform}`;
  if (store === 'epic' && metadata.buildId && metadata.version && metadata.buildId !== metadata.version) return `manifest:${metadata.buildId}:${metadata.platform}`;
  if (store === 'epic' && metadata.branch !== 'manifest') return `${metadata.version || metadata.buildId || ''}:${metadata.platform}`;
  if (store === 'gog') return metadata.branch?.startsWith('galaxy:') ? `galaxy:${metadata.buildId}:${metadata.language || 'en'}` : `${metadata.branch || ''}:${metadata.language || 'en'}`;
  return null;
}
async function checkExistingDownload({ userDataDir, store, appId, platform, versionId, depots, destination, confirmDuplicate, signal } = {}) {
  signal?.throwIfAborted();
  // A chosen custom parent is a separate collection under explicit user control.
  if (destination || !path.isAbsolute(userDataDir || '') || !stores.has(store)) return null;
  const wanted = createDownloadIdentity({ store, appId, platform, versionId, depots }); if (!wanted) return null;
  const index = await readJson(path.join(userDataDir, store === 'steam' ? 'steam/installations.json' : 'external/installations.json'));
  if (!Array.isArray(index)) return null;
  const roots = [path.join(userDataDir, 'external/downloads', store), ...(store === 'steam' ? [path.join(userDataDir, 'steam/downloads')] : [])];
  const realRoots = (await Promise.all(roots.map(root => fs.realpath(root).catch(() => null)))).filter(Boolean);
  for (const row of [...index].reverse().slice(0, 16384)) {
    const location = typeof row === 'string' ? row : row?.path;
    if (!path.isAbsolute(location || '')) continue;
    let real; try { real = await fs.realpath(location); if (!(await fs.stat(real)).isDirectory()) continue; } catch { continue; }
    if (!realRoots.some(root => real !== root && inside(root, real))) continue;
    const metadata = await readJson(path.join(real, store === 'steam' ? '.maclauncher-steam.json' : '.maclauncher-external.json'));
    if (metadata?.complete !== true || String(metadata.appId) !== String(appId) || metadata.platform !== platform ||
      (metadata.store && metadata.store !== store) || await fs.realpath(metadata.path || '').catch(() => null) !== real) continue;
    const identity = metadata.downloadIdentity || createDownloadIdentity({ store, appId, platform, depots: store === 'steam' ? metadata.depots : undefined, versionId: savedVersionId(store, metadata) });
    if (identity !== wanted) continue;
    const existing = { ...metadata, path: real };
    if (existing.importPath) {
      const input = await fs.realpath(existing.importPath).catch(() => null);
      existing.importPath = input && inside(real, input) ? input : real;
    } else if (existing.filename) {
      const input = await fs.realpath(path.resolve(real, existing.filename)).catch(() => null);
      existing.importPath = input && inside(real, input) ? input : real;
    }
    if (typeof confirmDuplicate !== 'function') throw new Error('This exact version is already downloaded. Open Downloaded to use the existing copy.');
    signal?.throwIfAborted();
    const decision = await confirmDuplicate(existing, { signal });
    signal?.throwIfAborted();
    if (decision === 'use-existing') return existing;
    if (decision === 'download-again') return null;
    throw Object.assign(new Error('Download cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
  }
  return null;
}
module.exports = { createDownloadIdentity, checkExistingDownload };

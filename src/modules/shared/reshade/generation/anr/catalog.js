// Copyright (c) MacLauncher contributors. MIT license.
// Apex releases that publish a macOS kit. Refresh reads them from GitHub; the
// release's GitHub SHA-256 is the kit archive's identity. Without a refreshed
// list, the kit declared in source.json is the one listed version.
const Upstream = require('../../../runtime/upstream'), Catalog = require('../../../runtime/runtime-catalog');
const Source = require('./source.json'), repository = 'apex-compute/ANR';
const sourceUrl = 'https://github.com/' + repository + '/releases', KIT = /^anr-fg-.+-kit-macos\.tar\.gz$/i;
const LIMIT = 1024 * 1024 * 1024;
const validVersion = version => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version || '') && !/\.json$/i.test(version);
const declared = Object.freeze({version: Source.version, sourceUrl: Source.sourceUrl, url: Source.url, filename: Source.asset,
  archiveBytes: Source.bytes, archiveSha256: Source.sha256});
const upstream = Upstream.github({repository, prerelease: false, allArchitectures: true,
  recognize: release => {
    const version = String(release.tag_name || '');
    const assets = (release.assets || []).filter(asset => KIT.test(asset.name || ''));
    return validVersion(version) && assets.length === 1 ? {version, assets} : null;
  }});
const validEntry = row => validVersion(row?.version) && typeof row.url === 'string' &&
  row.url.startsWith('https://github.com/' + repository + '/releases/download/') && KIT.test(row.filename || '') &&
  /^[a-f0-9]{64}$/.test(row.archiveSha256 || '') && Number.isSafeInteger(row.archiveBytes) && row.archiveBytes > 0 && row.archiveBytes <= LIMIT &&
  // The declared kit keeps its declared identity.
  (row.version !== Source.version || row.archiveSha256 === Source.sha256 && row.archiveBytes === Source.bytes);
const newest = (a, b) => b.version.localeCompare(a.version, undefined, {numeric: true, sensitivity: 'base'});
function read(userDataDir) { try { return Catalog.readRuntimeCatalog({userDataDir, managerId: Source.managerId, validateEntry: validEntry}); } catch { return null; } }
function sources(userDataDir) { const rows = read(userDataDir)?.entries; return rows?.length ? rows : [declared]; }
function source(userDataDir, version) { return sources(userDataDir).find(row => row.version === version) || (version === Source.version ? declared : null); }
async function refresh(context = {}, dependencies = {}) {
  const rows = await (dependencies.discover || upstream.discover)({signal: context.signal});
  const entries = rows.flatMap(row => row.files.length === 1 ? [{version: row.version, sourceUrl: row.sourceUrl || sourceUrl, url: row.files[0].url,
    filename: row.files[0].name, archiveBytes: row.files[0].bytes, assetId: row.files[0].id,
    archiveSha256: row.files[0].digest?.algorithm === 'sha256' ? row.files[0].digest.value : undefined,
    ...(row.publishedAt ? {publishedAt: row.publishedAt} : {})}] : []).filter(validEntry).sort(newest);
  if (!entries.length) throw Error('No Apex Neural Rendering releases with a macOS kit were returned. Installed models remain available.');
  return Catalog.writeRuntimeCatalog({userDataDir: context.userDataDir, managerId: Source.managerId, source: sourceUrl, entries});
}
module.exports = {upstream, sourceUrl, declared, validVersion, validEntry, read, sources, source, refresh, newest};

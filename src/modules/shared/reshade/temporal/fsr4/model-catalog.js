// Copyright (c) MacLauncher contributors. MIT license.
const Upstream = require('../../../runtime/upstream'), Catalog = require('../../../runtime/runtime-catalog');
const legacy = require('./model.json'), repository = 'UzenUPoZiTiV4ik/fsr4-native-macos';
const sourceUrl = 'https://github.com/' + repository + '/releases';
const validVersion = version => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version || '');
const upstream = Upstream.github({repository, prerelease: true, allArchitectures: true,
  recognize: release => {
    const version = String(release.tag_name || '').replace(/^crossover-v/, '');
    if (!validVersion(version)) return null;
    const assets = (release.assets || []).filter(asset => /^fsr4-mac-.+-crossover\.zip$/i.test(asset.name));
    return assets.length === 1 ? {version, assets} : null;
  }});
const validEntry = row => validVersion(row?.version) && typeof row.url === 'string' && row.url.startsWith('https://github.com/' + repository + '/releases/download/') &&
  (/^[a-f0-9]{64}$/.test(row.archiveSha256 || '') || row.archiveSha256 === undefined &&
    (row.integrity === 'recorded-local' && row.digest === undefined || row.integrity === 'publisher-digest' && Boolean(Upstream.readDigest(row.digest)))) &&
  (row.digest === undefined || Boolean(Upstream.readDigest(row.digest))) &&
  Number.isSafeInteger(row.archiveBytes) && row.archiveBytes > 0 && row.archiveBytes <= 256 * 1024 * 1024;
function read(userDataDir) { return Catalog.readRuntimeCatalog({userDataDir, managerId: legacy.managerId, validateEntry: validEntry}); }
function sources(userDataDir) { return read(userDataDir)?.entries || [legacy]; }
async function refresh(context = {}, dependencies = {}) {
  const rows = await (dependencies.discover || upstream.discover)({signal: context.signal});
  const entries = rows.flatMap(row => row.files.length === 1 ? [{
    ...legacy, version: row.version, sourceUrl: row.sourceUrl, url: row.files[0].url,
    archiveBytes: row.files[0].bytes, archiveSha256: row.files[0].digest?.algorithm === 'sha256' ? row.files[0].digest.value : undefined,
    ...(row.files[0].digest ? {digest: row.files[0].digest} : {}), assetId: row.files[0].id, integrity: row.files[0].digest ? 'publisher-digest' : 'recorded-local'}] : []).filter(validEntry);
  if (!entries.length) throw Error('No compatible FSR 4 release archives were returned. Existing model data remains available.');
  return Catalog.writeRuntimeCatalog({userDataDir: context.userDataDir, managerId: legacy.managerId, source: sourceUrl, entries});
}
module.exports = {upstream, sourceUrl, validVersion, validEntry, read, sources, refresh};

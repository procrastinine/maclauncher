// Copyright (c) MacLauncher contributors. MIT license.
const fs = require('node:fs'), path = require('node:path');
const Catalog = require('../runtime/runtime-catalog'), Upstream = require('../runtime/upstream');
const History = require('../../../core/steam-version-history');
const {APP_ID, DEPOT_ID} = require('./steam-client-models');
const ID = 'graphics-models', sourceUrl = History.historyUrl(APP_ID, DEPOT_ID);
const validManifest = value => /^[1-9]\d{0,19}$/.test(value || '') && BigInt(value) <= 0xffffffffffffffffn;
const validEntry = row => row?.version === 'steam-manifest-' + row.manifestId && validManifest(row.manifestId) && row.depotId === DEPOT_ID;
const upstream = Upstream.index({locations: [sourceUrl], hosts: ['steamdb.info'], allArchitectures: true,
  parse: ([document]) => History.parseManifestHistory(document.text, DEPOT_ID).map(row => ({
    version: 'steam-manifest-' + row.manifestId, label: 'Steam manifest ' + row.manifestId,
    sourceUrl, publishedAt: row.date, details: {manifestId: row.manifestId, depotId: DEPOT_ID}, files: []}))});
function read(userDataDir) { return Catalog.readRuntimeCatalog({userDataDir, managerId: ID, sourceId: 'steam', validateEntry: validEntry}); }
async function refresh(context = {}, dependencies = {}) {
  const rows = await (dependencies.discover || upstream.discover)({signal: context.signal});
  const entries = rows.map(row => ({version: row.version, versionLabel: row.label, ...row.details})).filter(validEntry);
  if (!entries.length) throw Error('No Lossless Scaling manifests were returned. Open the SteamDB manifest history or import an installed DLL.');
  return Catalog.writeRuntimeCatalog({userDataDir: context.userDataDir, managerId: ID, sourceId: 'steam',
    source: sourceUrl, entries});
}
function installedManifest(row) {
  try {
    const file = path.join(row.installDir, 'steam-source.json'), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record.version === row.version && record.appId === APP_ID && record.depotId === DEPOT_ID && validManifest(record.manifestId) ? record.manifestId : null;
  } catch { return null; }
}
function recordInstalled(row, manifestId) {
  if (!row?.installDir || !validManifest(manifestId)) throw Error('The downloaded Steam model has no valid manifest identity.');
  const file = path.join(row.installDir, 'steam-source.json');
  // Identical model bytes can occur in several depots. Keep their first actual
  // download provenance; its content hash, rather than the manifest, is the install identity.
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({version: row.version, appId: APP_ID, depotId: DEPOT_ID, manifestId}) + '\n', {flag: 'wx', mode: 0o444});
  return row;
}
module.exports = {upstream, sourceUrl, read, refresh, validEntry, installedManifest, recordInstalled};

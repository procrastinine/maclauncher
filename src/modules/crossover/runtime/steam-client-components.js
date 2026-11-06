const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const execute = promisify(require('node:child_process').execFile);
const Upstream = require('../../shared/runtime/upstream');
const Writable = require('../../shared/writable-input');
const { parseSteamVdf } = require('../../../core/steam-installed-games');
const { readJsonObject, writeJsonAtomic } = require('../../../core/json-files');
const ORIGIN = 'https://client-update.akamai.steamstatic.com';
const MANIFEST = ORIGIN + '/steam_client_ubuntu12';
const source = Upstream.service({ hosts: [new URL(ORIGIN).hostname] });
const digest = (file, algorithm = 'sha256') => { const h = crypto.createHash(algorithm), fd = fs.openSync(file, 'r'), b = Buffer.alloc(1024 * 1024); try { let n; while ((n = fs.readSync(fd, b, 0, b.length, null))) h.update(b.subarray(0, n)); } finally { fs.closeSync(fd); } return h.digest('hex'); };
const store = userDataDir => path.join(userDataDir, 'runtimes/steam-client-components');
function resolveManifest(text) {
  const value = parseSteamVdf(text), pending = [value], matches = [];
  while (pending.length) for (const [key, row] of Object.entries(pending.shift())) {
    if (!row || typeof row !== 'object') continue;
    const filename = row.file;
    if (typeof filename === 'string' && /^bins_misc_ubuntu12\.zip\.[a-f0-9]{40}$/.test(filename)) {
      const bytes = Number(row.size); matches.push({ filename, url: ORIGIN + '/' + filename, sha1: filename.slice(-40), ...(Number.isSafeInteger(bytes) && bytes > 0 ? { bytes } : {}) });
    } else pending.push(row);
  }
  if (matches.length !== 1) throw new Error('Valve did not list one Windows Steam client component archive.');
  return matches[0];
}
function current(userDataDir) {
  const root = store(userDataDir), record = readJsonObject(path.join(root, 'active.json'));
  if (!record || !/^[a-f0-9]{40}$/.test(record.archiveSha1 || '') || !record.files || !record.clients) return null;
  const directory = path.join(root, record.archiveSha1);
  try {
    for (const item of record.files) {
      if (!/^[A-Za-z0-9._-]+$/.test(item.path) || fs.lstatSync(path.join(directory, item.path)).isSymbolicLink() || digest(path.join(directory, item.path)) !== item.sha256) return null;
    }
    for (const name of Object.values(record.clients)) if (!record.files.some(item => item.path === name)) return null;
    return { ...record, root: directory };
  } catch { return null; }
}
// Called only from the consented managed-install action. Discovery/status use current().
async function install({ userDataDir, signal, onProgress, resolved, archiveFile } = {}) {
  const existing = current(userDataDir); if (existing) return existing;
  if (!resolved) {
    const response = await source.request(MANIFEST, { signal, maxBytes: 2 * 1024 * 1024, maxRedirects: 0 });
    if (response.status !== 200) throw new Error('Valve client component metadata is unavailable.');
    resolved = resolveManifest(response.body.toString('utf8'));
  }
  const expected = /^bins_misc_ubuntu12\.zip\.([a-f0-9]{40})$/.exec(resolved.filename || '');
  if (!expected || resolved.url !== ORIGIN + '/' + resolved.filename) throw new Error('Valve components require an official content-addressed archive.');
  const root = store(userDataDir); Writable.assertOwnDirectory(userDataDir, root);
  const stage = fs.mkdtempSync(path.join(root, '.install-'));
  try {
    const archive = path.join(stage, 'client.zip');
    if (archiveFile) fs.copyFileSync(archiveFile, archive);
    else await Upstream.download({ url: resolved.url, name: resolved.filename, ...(resolved.bytes ? { bytes: resolved.bytes } : {}), digest: { algorithm: 'sha1', value: expected[1] } }, archive, { signal, onProgress });
    if (digest(archive, 'sha1') !== expected[1]) throw new Error('Valve component archive differs from its content address.');
    const extracted = path.join(stage, 'extracted'); fs.mkdirSync(extracted);
    await execute('/usr/bin/unzip', ['-q', archive, 'steamclient64.dll', 'legacycompat/steamclient.dll', '-d', extracted], { signal, timeout: 120000 });
    const clients = { x86_64: 'steamclient64.dll', i386: 'steamclient.dll' }, payload = path.join(stage, 'payload'); fs.mkdirSync(payload);
    const files = Object.entries(clients).map(([arch, name]) => {
      fs.renameSync(path.join(extracted, arch === 'i386' ? 'legacycompat/steamclient.dll' : name), path.join(payload, name));
      fs.chmodSync(path.join(payload, name), 0o644);
      return { path: name, sha256: digest(path.join(payload, name)), size: fs.statSync(path.join(payload, name)).size };
    });
    const directory = path.join(root, expected[1]);
    if (fs.existsSync(directory)) { if (current(userDataDir)?.archiveSha1 !== expected[1]) throw new Error('A retained Valve component directory needs repair.'); }
    else fs.renameSync(payload, directory);
    writeJsonAtomic(path.join(root, 'active.json'), { archiveSha1: expected[1], source: resolved.url, clients, files });
    return current(userDataDir);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
module.exports = { current, install, resolveManifest, MANIFEST };

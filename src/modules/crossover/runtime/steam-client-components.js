const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { hashFile } = require('../../shared/runtime/pinned-native-manager');
const { promisify } = require('node:util');
const execute = promisify(require('node:child_process').execFile);
const Upstream = require('../../shared/runtime/upstream');
const Writable = require('../../shared/writable-input');
const { parseSteamVdf } = require('../../../core/steam-installed-games');
const { readJsonObject, writeJsonAtomic } = require('../../../core/json-files');
const ORIGIN = 'https://client-update.akamai.steamstatic.com';
const MANIFEST = ORIGIN + '/steam_client_ubuntu12';
const source = Upstream.service({ hosts: [new URL(ORIGIN).hostname] });
const verified = new Map();
const store = userDataDir => path.join(userDataDir, 'runtimes/steam-client-components');
function resolveManifest(text) {
  const value = parseSteamVdf(text), pending = [value], matches = [];
  while (pending.length) for (const [key, row] of Object.entries(pending.shift())) {
    if (!row || typeof row !== 'object') continue;
    const filename = row.file;
    if (typeof filename === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip\.[a-f0-9]{40}$/.test(filename)) {
      const bytes = Number(row.size); matches.push({ filename, url: ORIGIN + '/' + filename, sha1: filename.slice(-40), ...(Number.isSafeInteger(bytes) && bytes > 0 ? { bytes } : {}) });
    } else pending.push(row);
  }
  if (!matches.length) throw new Error('Valve did not list content-addressed client archives.');
  return matches;
}
function current(userDataDir) {
  const root = store(userDataDir), record = readJsonObject(path.join(root, 'active.json'));
  if (!record || !/^[a-f0-9]{40}$/.test(record.archiveSha1 || '') || !record.files || !record.clients) return null;
  const directory = path.join(root, record.archiveSha1);
  try {
    for (const item of record.files) {
      if (!/^[A-Za-z0-9._-]+$/.test(item.path)) return null;
      const file = path.join(directory, item.path), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const stamp = JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, item.sha256]);
      if (verified.get(file) !== stamp) {
        if (hashFile(file) !== item.sha256) { verified.delete(file); return null; }
        verified.set(file, stamp);
      }
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
  for (const candidate of Array.isArray(resolved) ? resolved : [resolved]) {
  const expected = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip\.([a-f0-9]{40})$/.exec(candidate.filename || '');
  resolved = candidate;
  if (!expected || resolved.url !== ORIGIN + '/' + resolved.filename) throw new Error('Valve components require an official content-addressed archive.');
  const root = store(userDataDir); Writable.assertOwnDirectory(userDataDir, root);
  const stage = fs.mkdtempSync(path.join(root, '.install-'));
  try {
    const archive = path.join(stage, 'client.zip');
    if (archiveFile) fs.copyFileSync(archiveFile, archive);
    else await Upstream.download({ url: resolved.url, name: resolved.filename, ...(resolved.bytes ? { bytes: resolved.bytes } : {}), digest: { algorithm: 'sha1', value: expected[1] } }, archive, { signal, onProgress });
    if (hashFile(archive, 'sha1') !== expected[1]) throw new Error('Valve component archive differs from its content address.');
    const listing = await execute('/usr/bin/unzip', ['-Z1', archive], { signal, timeout: 120000 });
    const members = listing.stdout.trim().split('\n');
    const selected = ['steamclient64.dll', 'steamclient.dll'].map(name => members.filter(member => path.posix.basename(member).toLowerCase() === name));
    if (selected.some(matches => !matches.length)) continue;
    if (selected.some(matches => matches.length !== 1)) throw new Error('Valve client archive has ambiguous client filenames.');
    const paths = selected.map(matches => matches[0]);
    if (paths.some(member => member.startsWith('/') || member.includes('\\') || member.split('/').some(part => part === '..' || part === '.')))
      throw new Error('Valve client archive contains an unsafe client path.');
    const extracted = path.join(stage, 'extracted'); fs.mkdirSync(extracted);
    await execute('/usr/bin/unzip', ['-q', archive, ...paths, '-d', extracted], { signal, timeout: 120000 });
    const clients = { x86_64: 'steamclient64.dll', i386: 'steamclient.dll' }, payload = path.join(stage, 'payload'); fs.mkdirSync(payload);
    const files = Object.entries(clients).map(([arch, name]) => {
      fs.renameSync(path.join(extracted, paths[arch === 'i386' ? 1 : 0]), path.join(payload, name));
      fs.chmodSync(path.join(payload, name), 0o644);
      return { path: name, sha256: hashFile(path.join(payload, name)), size: fs.statSync(path.join(payload, name)).size };
    });
    const directory = path.join(root, expected[1]);
    const valid = fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() && files.every(item => {
      try { const file = path.join(directory, item.path); return fs.lstatSync(file).isFile() && hashFile(file) === item.sha256; }
      catch { return false; }
    });
    if (!valid) {
      const damaged = directory + '.damaged-' + randomUUID();
      const retained = fs.lstatSync(directory, { throwIfNoEntry: false });
      if (retained) fs.renameSync(directory, damaged);
      try { fs.renameSync(payload, directory); }
      catch (error) { if (retained) fs.renameSync(damaged, directory); throw error; }
    }
    writeJsonAtomic(path.join(root, 'active.json'), { archiveSha1: expected[1], source: resolved.url, clients, files });
    return current(userDataDir);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  throw new Error('Valve archives did not contain the Windows Steam client DLLs.');
}
module.exports = { current, install, resolveManifest, MANIFEST };

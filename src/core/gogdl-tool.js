const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Upstream = require('../modules/shared/runtime/upstream');
const { assetArchitecture } = require('../modules/shared/runtime/architecture');
const { isMacName } = require('../modules/shared/runtime/archive');

const GOGDL = Object.freeze({ owner: 'Heroic-Games-Launcher', repo: 'heroic-gogdl', source: 'https://github.com/Heroic-Games-Launcher/heroic-gogdl', license: 'GPL-3.0' });
// Heroic publishes a self-contained gogdl_macos_<cpu> executable with each
// release. A renamed Mac executable, or one universal build, is used as well;
// the current name wins.
function macExecutable(assets, arch) {
  const exact = `gogdl_macos_${arch === 'x64' ? 'x86_64' : 'arm64'}`;
  const candidates = (assets || []).filter(asset => /gogdl/i.test(asset?.name || '') && isMacName(asset.name) && !/\.[a-z0-9]{1,8}$/i.test(asset.name) &&
    !/debug|symbols|dsym/i.test(asset.name) && [arch, 'universal', null].includes(assetArchitecture(asset.name)));
  const rank = asset => asset.name === exact ? 0 : assetArchitecture(asset.name) === arch ? 1 : 2;
  return candidates.sort((a, b) => rank(a) - rank(b))[0] || null;
}
// One row per CPU with a Mac executable in the release.
function recognize(release) {
  const version = String(release.tag_name || '').replace(/^v(?=\d)/, '');
  if (!/^\d+(?:\.\d+)+$/.test(version)) return [];
  return ['arm64', 'x64'].flatMap(arch => {
    const asset = macExecutable(release.assets, arch);
    return asset ? [{ version, architecture: arch, assets: [asset] }] : [];
  });
}
const source = Upstream.github({ repository: `${GOGDL.owner}/${GOGDL.repo}`, allArchitectures: true, recognize });

const pending = new Map();
const newer = (a, b) => b.version.localeCompare(a.version, undefined, { numeric: true });
async function valid(file, record) {
  try {
    const stat = await fs.promises.lstat(file); if (!stat.isFile() || stat.size !== record.size || !(stat.mode & 0o111)) return false;
    const hash = crypto.createHash('sha256'); for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
    return hash.digest('hex') === record.sha256;
  } catch { return false; }
}
// Installed helpers record their version, size and SHA-256 in source.json.
async function installed(parent, arch) {
  let names = [];
  try { names = (await fs.promises.readdir(parent)).filter(name => name.startsWith('gogdl-') && name.includes(`-${arch}-`)); } catch {}
  const rows = [];
  for (const name of names) {
    try {
      const record = JSON.parse(await fs.promises.readFile(path.join(parent, name, 'source.json'), 'utf8')), executablePath = path.join(parent, name, 'gogdl');
      const size = record.size ?? (await fs.promises.lstat(executablePath)).size;
      if (typeof record.version === 'string' && /^[a-f0-9]{64}$/.test(record.sha256 || '') && await valid(executablePath, { size, sha256: record.sha256 }))
        rows.push({ ...record, size, executablePath });
    } catch {}
  }
  return rows.sort(newer);
}
// The newest release with a build for this Mac. A file the publisher replaced
// is checked against GitHub's current digest; without one, the download's own
// SHA-256 is recorded. When the release list is unavailable, the newest
// installed helper is used.
// The default publisher build follows the launcher CPU, independently of physical hardware.
async function ensureGogdl({ userDataDir, signal, onProgress, arch = process.arch, platform = process.platform, logger } = {}) {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch) || !path.isAbsolute(userDataDir || '')) throw new Error('The GOG game download helper requires a supported Mac.');
  const parent = path.join(userDataDir, 'external/tools');
  signal?.throwIfAborted();
  let release;
  try {
    const row = (await source.discover({ signal, logger })).filter(item => item.architecture === arch).sort(newer)[0];
    release = row && { version: row.version, revision: row.revision, file: row.files[0], url: row.files[0]?.url,
      sha256: row.files[0]?.digest?.algorithm === 'sha256' ? row.files[0].digest.value : null };
  }
  catch (error) {
    signal?.throwIfAborted();
    const [present] = await installed(parent, arch);
    if (present) return { executablePath: present.executablePath, version: present.version };
    throw new Error(`The GOG download helper is unavailable: ${error.message || error}`);
  }
  if (!release?.file) {
    const [present] = await installed(parent, arch);
    if (present) return { executablePath: present.executablePath, version: present.version };
    throw new Error('The GOG download helper has no published build for this Mac.');
  }
  const current = (await installed(parent, arch)).find(row => row.url === release.url && row.version === release.version && (!release.sha256 || row.sha256 === release.sha256));
  if (current) return { executablePath: current.executablePath, version: current.version };
  const key = JSON.stringify([parent, release.url, release.sha256]);
  if (pending.has(key)) return pending.get(key);
  const operation = (async () => {
    await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
    const stage = await fs.promises.mkdtemp(path.join(parent, '.gogdl-setup-'));
    try {
      onProgress?.({ detail: `Downloading GOG download helper ${release.version}`, downloaded: 0, total: release.file.bytes ?? null });
      const executable = path.join(stage, 'gogdl');
      const { sha256, bytes, integrity } = await Upstream.download(release.file, executable, { signal,
        onProgress: progress => onProgress?.({ detail: `Downloading GOG download helper ${release.version}`, ...progress }) });
      if (!bytes) throw new Error('The GOG download helper download is empty.');
      await fs.promises.chmod(executable, 0o755);
      await fs.promises.writeFile(path.join(stage, 'source.json'), JSON.stringify({ version: release.version, source: GOGDL.source,
        revision: release.revision, license: GOGDL.license, url: release.url, sha256, size: bytes, integrity }), { mode: 0o600, flag: 'wx' });
      const target = path.join(parent, `gogdl-${release.version}-${arch}-${sha256.slice(0, 12)}`);
      await fs.promises.rm(target, { recursive: true, force: true });
      await fs.promises.rename(stage, target);
      return { executablePath: path.join(target, 'gogdl'), version: release.version };
    } finally { await fs.promises.rm(stage, { recursive: true, force: true }); }
  })();
  pending.set(key, operation);
  try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
}
module.exports = { GOGDL, ensureGogdl, installed, macExecutable, source };

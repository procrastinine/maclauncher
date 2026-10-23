const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fetchUrlBuffer } = require('../modules/shared/runtime/download-utils');

const GOGDL = Object.freeze({ version: '1.3.1', source: 'https://github.com/Heroic-Games-Launcher/heroic-gogdl',
  revision: 'ac1580aeb004dda75557c97be9cc3105d50eeecb', license: 'GPL-3.0',
  artifacts: {
    arm64: { url: 'https://github.com/Heroic-Games-Launcher/heroic-gogdl/releases/download/v1.3.1/gogdl_macos_arm64', size: 11031600,
      sha256: '33a6d9b329c35f1caa7968009bf2f4f0a6f57cd00f749a4d2cb2204f3e794d2e', minimumMacOS: '11.0' },
    x64: { url: 'https://github.com/Heroic-Games-Launcher/heroic-gogdl/releases/download/v1.3.1/gogdl_macos_x86_64', size: 11652592,
      sha256: '9f78f5916141692704f9587e6519082abc2b12c5f8825548fe4d1dee1e46180c' }
  }
});
const pending = new Map();
async function valid(file, artifact) {
  try {
    const stat = await fs.promises.lstat(file); if (!stat.isFile() || stat.size !== artifact.size || !(stat.mode & 0o111)) return false;
    const hash = crypto.createHash('sha256'); for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
    return hash.digest('hex') === artifact.sha256;
  } catch { return false; }
}
async function ensureGogdl({ userDataDir, signal, onProgress, arch = process.arch, platform = process.platform,
  fetchBytes = fetchUrlBuffer, catalog = GOGDL } = {}) {
  const artifact = catalog.artifacts[arch];
  if (platform !== 'darwin' || !artifact || !path.isAbsolute(userDataDir || '')) throw new Error('The GOG game download helper requires a supported Mac.');
  const parent = path.join(userDataDir, 'external/tools'), target = path.join(parent, `gogdl-${catalog.version}-${arch}-${artifact.sha256.slice(0, 12)}`), executablePath = path.join(target, 'gogdl');
  signal?.throwIfAborted();
  if (await valid(executablePath, artifact)) return { executablePath, version: catalog.version };
  if (pending.has(target)) return pending.get(target);
  const operation = (async () => {
    await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
    const stage = await fs.promises.mkdtemp(path.join(parent, '.gogdl-setup-'));
    try {
      onProgress?.({ detail: `Downloading GOG download helper ${catalog.version}`, downloaded: 0, total: artifact.size });
      const result = await fetchBytes(artifact.url, { signal, maxBytes: artifact.size });
      const bytes = result.body;
      if (!Buffer.isBuffer(bytes) || bytes.length !== artifact.size || crypto.createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
        throw new Error('The GOG download helper failed its integrity check.');
      signal?.throwIfAborted();
      await fs.promises.writeFile(path.join(stage, 'gogdl'), bytes, { mode: 0o755, flag: 'wx' });
      await fs.promises.writeFile(path.join(stage, 'source.json'), JSON.stringify({ version: catalog.version, source: catalog.source,
        revision: catalog.revision, license: catalog.license, url: artifact.url, sha256: artifact.sha256 }), { mode: 0o600, flag: 'wx' });
      if (fs.existsSync(target)) {
        await fs.promises.rm(target, { recursive: true, force: true });
      }
      await fs.promises.rename(stage, target);
      return { executablePath, version: catalog.version };
    } finally { await fs.promises.rm(stage, { recursive: true, force: true }); }
  })();
  pending.set(target, operation);
  try { return await operation; } finally { if (pending.get(target) === operation) pending.delete(target); }
}
module.exports = { GOGDL, ensureGogdl };

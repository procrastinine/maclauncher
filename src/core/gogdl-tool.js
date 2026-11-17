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
// Ordinary store actions use the same installed/default/custom selection as
// Runtimes. A missing helper is discovered and installed only after consent.
async function ensureGogdl(options = {}) {
  const { userDataDir, arch = process.arch, platform = process.platform } = options;
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch) || !path.isAbsolute(userDataDir || '')) throw new Error('The GOG game download helper requires a supported Mac.');
  return require('../modules/shared/stores/runtime/gogdl-manager').ensure({ ...options, arch });
}
module.exports = { GOGDL, ensureGogdl, installed, macExecutable, source };

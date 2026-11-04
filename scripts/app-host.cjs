// Read the installed Electron supplier without importing its downloading entry point.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const B = require('../src/modules/shared/runtime/bundled-native');
const ROOT = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readHost({ repoRoot = ROOT, arch = process.arch, archivePath, cacheRoot } = {}) {
  repoRoot = path.resolve(repoRoot);
  const packageFile = path.join(repoRoot, 'node_modules/electron/package.json');
  const metadata = B.readRegular(packageFile, B.LIMITS.manifestBytes), pkg = JSON.parse(metadata.bytes);
  const configured = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).devDependencies?.electron;
  const lock = require('js-yaml').load(fs.readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8'));
  const pin = lock?.importers?.['.']?.devDependencies?.electron;
  const integrity = lock?.packages?.[`electron@${pkg.version}`]?.resolution?.integrity;
  if (pkg.name !== 'electron' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version) || pin?.specifier !== configured || pin?.version?.split('(')[0] !== pkg.version ||
      !/^(?:sha256|sha512)-[A-Za-z0-9+/=]+$/.test(integrity || '') ||
      !['arm64', 'x64'].includes(arch)) throw new Error('The installed Electron package differs from its exact npm dependency.');
  const checksums = B.readRegular(path.join(path.dirname(packageFile), 'checksums.json'), B.LIMITS.manifestBytes);
  const filename = `electron-v${pkg.version}-darwin-${arch}.zip`, digest = JSON.parse(checksums.bytes)[filename];
  if (!/^[a-f0-9]{64}$/.test(digest || '')) throw new Error('The npm Electron package has no checksum for the Mac archive.');
  const url = `https://github.com/electron/electron/releases/download/v${pkg.version}/${filename}`;
  const directory = new URL(url); directory.pathname = path.posix.dirname(directory.pathname);
  const cache = cacheRoot || process.env.electron_config_cache || path.join(os.homedir(), 'Library/Caches/electron');
  const archive = archivePath || path.join(cache, hash(Buffer.from(directory.toString())), filename);
  if (!fs.existsSync(archive)) throw new Error('The Electron publisher archive is absent from its cache. Run pnpm electron:install explicitly.');
  const stored = B.readRegular(archive, B.LIMITS.bytes);
  if (stored.sha256 !== digest) throw new Error('The cached Electron archive differs from its npm publisher checksum.');
  const record = { id: 'electron', version: pkg.version, arch, source: pkg.repository,
    npm: { name: pkg.name, version: pkg.version, integrity, packageSha256: metadata.sha256, checksumsSha256: checksums.sha256 },
    asset: { filename, url, sha256: digest, bytes: fs.statSync(archive).size } };
  return { repoRoot, record, root: path.dirname(packageFile), archive };
}

module.exports = { readHost };

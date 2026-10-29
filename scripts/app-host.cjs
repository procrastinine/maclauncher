// Read the installed Electron supplier without importing its downloading entry point.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const B = require('../src/modules/shared/runtime/bundled-native');
const Zip = require('../src/modules/shared/runtime/zip');
const MachO = require('../src/modules/shared/runtime/macho-load-commands');
const ROOT = path.resolve(__dirname, '..');
const inventories = new Map();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function archiveInventory(archive, { version, arch, sha256 }) {
  const stored = B.readRegular(archive, B.LIMITS.bytes);
  if (stored.sha256 !== sha256) throw new Error('The cached Electron archive differs from its npm publisher checksum.');
  const key = [version, arch, sha256].join('/');
  if (inventories.has(key)) return inventories.get(key);
  const fd = fs.openSync(archive, 'r'); let directory, entries;
  try {
    directory = Zip.findZipEocd(fd);
    if (!directory || directory.zipBase !== 0) throw new Error('The Electron publisher ZIP is invalid.');
    entries = Zip.readCentralDirectory(fd, directory, { metadata: true });
  } finally { fs.closeSync(fd); }
  if (entries.length !== directory.entries || entries.length > B.LIMITS.files * 2) throw new Error('The Electron ZIP directory is incomplete.');
  const names = new Set(), files = [], notices = []; let total = 0, native = 0, archiveVersion;
  for (const entry of entries) {
    const name = B.relativeFile(entry.name.replace(/\/$/, '')), folded = name.normalize('NFC').toLowerCase();
    const type = (entry.externalAttributes >>> 16) & 0xf000;
    if (names.has(folded) || !['Electron.app', 'LICENSE', 'LICENSES.chromium.html', 'version'].includes(name.split('/')[0]) ||
        entry.flags & 1 || ![0, 8].includes(entry.compressionMethod) || ![0, 0x4000, 0x8000, 0xa000].includes(type))
      throw new Error('The Electron ZIP has an unsupported member.');
    names.add(folded); total += entry.uncompressedSize;
    if (total > B.LIMITS.bytes) throw new Error('The Electron ZIP exceeds its expanded size limit.');
    if (entry.name.endsWith('/')) continue;
    const bytes = Zip.readZipEntry(archive, entry, { maxOutputBytes: B.LIMITS.fileBytes });
    if (!bytes || bytes.length !== entry.uncompressedSize) throw new Error('The Electron ZIP has an unreadable member.');
    if (name === 'version') archiveVersion = bytes.toString('utf8').trim();
    if (name === 'LICENSE' || name === 'LICENSES.chromium.html') notices.push({ path: name,
      size: bytes.length, sha256: hash(bytes), resource: name === 'LICENSE' ? 'LICENSE.electron.txt' : name });
    if (!name.startsWith('Electron.app/')) continue;
    const relative = B.relativeFile(name.slice('Electron.app/'.length));
    if (type === 0xa000) {
      const target = bytes.toString('utf8');
      if (!target || path.posix.isAbsolute(target) || target.includes('\\') || /[\x00-\x1f]/.test(target))
        throw new Error('The Electron ZIP has an unsafe alias.');
      B.relativeFile(path.posix.normalize(path.posix.join(path.posix.dirname(relative), target)));
      files.push({ path: relative, type: 'symlink', target });
    } else {
      const file = { path: relative, type: 'file', size: bytes.length,
        mode: (entry.externalAttributes >>> 16) & 0o777, sha256: hash(bytes) };
      const magic = bytes.length >= 4 ? bytes.readUInt32BE(0) : 0;
      if ([0xcafebabe, 0xcafebabf, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) {
        const image = MachO.parseMachOLoadCommands(bytes);
        if (!image.architectures.includes(arch === 'x64' ? 'x86_64' : arch) ||
            image.slices.some(slice => slice.platform !== 1 || !slice.minimumMacOS))
          throw new Error('The Electron publisher binary has an incompatible Mac CPU or platform.');
        file.architectures = image.architectures; native++;
      }
      files.push(file);
    }
  }
  if (archiveVersion !== version || !native || !files.some(file => file.path === 'Contents/MacOS/Electron'))
    throw new Error('The Electron ZIP differs from its npm version or executable.');
  if (notices.length !== 2) throw new Error('The Electron ZIP is missing its publisher license notices.');
  const inventory = { version, arch, files, notices };
  inventories.set(key, inventory);
  return inventory;
}

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
  const inventory = archiveInventory(archive, { version: pkg.version, arch, sha256: digest });
  const record = { id: 'electron', version: pkg.version, arch, source: pkg.repository,
    npm: { name: pkg.name, version: pkg.version, integrity, packageSha256: metadata.sha256, checksumsSha256: checksums.sha256 },
    asset: { filename, url, sha256: digest, bytes: fs.statSync(archive).size },
    sourceAppRelative: 'node_modules/electron/dist/Electron.app' };
  return { repoRoot, record, inventory, root: path.dirname(packageFile), archive };
}

function sourceAppRelative(record) { return B.relativeFile(record.sourceAppRelative); }
function verifyElectronApp(app, inventory) {
  app = fs.realpathSync(app); const expected = new Map(inventory.files.map(file => [file.path, file])), seen = new Set();
  function walk(relative) {
    for (const item of fs.readdirSync(path.join(app, relative), { withFileTypes: true })) {
      const name = B.relativeFile(relative ? relative + '/' + item.name : item.name), file = path.join(app, name);
      if (item.isDirectory()) { walk(name); continue; }
      const record = expected.get(name);
      if (!record || seen.has(name)) throw new Error(`Electron contains an unlisted app member: ${name}.`);
      seen.add(name);
      if (record.type === 'symlink') {
        if (!item.isSymbolicLink() || fs.readlinkSync(file) !== record.target || !fs.realpathSync(file).startsWith(app + path.sep))
          throw new Error(`Electron alias differs from its publisher archive: ${name}.`);
      } else {
        if (!item.isFile()) throw new Error(`Electron file type differs from its publisher archive: ${name}.`);
        const actual = B.readRegular(file, record.size);
        if (actual.size !== record.size || actual.sha256 !== record.sha256 || actual.mode !== record.mode)
          throw new Error(`Electron source differs from its publisher archive: ${name}.`);
      }
    }
  }
  walk('');
  if (seen.size !== expected.size) throw new Error('Electron is missing a publisher archive member.');
  return { files: seen.size };
}
module.exports = { readHost, sourceAppRelative, verifyElectronApp, archiveInventory };

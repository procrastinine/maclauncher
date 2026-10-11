#!/usr/bin/env node
// Explicit release tooling only. Native runtime policy remains in module metadata.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const B = require('../src/modules/shared/runtime/bundled-native');
const S = require('./native-supplementals.cjs');
const Sources = require('./native-source-artifacts.cjs');
const Model = require('./distribution-model.cjs');

const LIMITS = Object.freeze({ archiveBytes: 4 * 1024 ** 3, expandedBytes: 8 * 1024 ** 3, metadataBytes: 1024 ** 2, packages: 128, entries: 300000 });
const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MANAGER = /^[a-z0-9-]+$/;
const PRIVATE_PART = /^(?:\.git|\.local|\.env(?:\..*)?|localconfig.*\.json|__pycache__|\.DS_Store|\._.*)$|\.(?:log|har|pcap|heapsnapshot|pyc|pyo)$/i;

function configuration({ arch, maximumMacOS }) {
  return Model.configuration({ arch, maximumMacOS });
}
function publishedUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('An explicit published HTTPS payload URL is required.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname) throw new Error('Payload URLs must use HTTPS without embedded credentials or fragments.');
  return url.href;
}
function safeFile(value) {
  const file = B.relativeFile(value);
  if (file.split('/').some(part => PRIVATE_PART.test(part))) throw new Error('Native payloads cannot contain private files, caches or diagnostics.');
  return file;
}
function catalog(dependencies) { return dependencies?.managers ? dependencies.managers() : require('./stage-native-runtimes.cjs').managers(); }
function requirementInventory(config, dependencies) {
  return Model.nativeRequirements(config, dependencies);
}
function validateInventory(value, config, dependencies) {
  if (!value || value.schemaVersion !== 1 || value.launcherArch !== config.arch || value.maximumMacOS !== config.maximumMacOS ||
      !Array.isArray(value.packages) || !value.packages.length || value.packages.length > LIMITS.packages || !Array.isArray(value.supplementals) ||
      value.packages.length + value.supplementals.length > LIMITS.packages) throw new Error('Payload inventory does not match the requested architecture and native-runtime floor.');
  if (Object.keys(value).some(key => !['schemaVersion', 'launcherArch', 'maximumMacOS', 'packages', 'supplementals', 'sourceArtifacts', 'sourceDownload'].includes(key))) throw new Error('Unknown native inventory metadata.');
  if (value.sourceDownload) {
    const source = value.sourceDownload;
    if (Object.keys(source).sort().join(',') !== 'sha256,url' || !SHA.test(source.sha256 || '') || publishedUrl(source.url) !== source.url) throw new Error('Separate runtime sources require an exact HTTPS URL and SHA-256.');
  }
  const required = requirementInventory(config, dependencies), managers = catalog(dependencies), seen = new Set();
  const { distributionArchitectures } = require('./verify-native-runtimes.cjs');
  const requiredIds = new Set(required.map(item => item.managerId));
  const requiredKeys = new Set(required.map(item => `${item.managerId}/${item.version}/${item.arch}`));
  for (const item of value.packages) {
    if (!item || !MANAGER.test(item.managerId) || !VERSION.test(item.version) || !['arm64', 'x64'].includes(item.arch) ||
      !SHA.test(item.manifestSha256 || '') || !Number.isSafeInteger(item.manifestSize) || item.manifestSize < 1 || item.manifestSize > B.LIMITS.manifestBytes) throw new Error('Invalid package identity or manifest checksum in payload inventory.');
    if (Object.keys(item).some(key => !['managerId', 'version', 'arch', 'upstreamRevision', 'minimumMacOS', 'directoryRelative', 'manifestSize', 'manifestSha256'].includes(key))) throw new Error('Unknown native package metadata.');
    const key = `${item.managerId}/${item.version}/${item.arch}`, manager = managers.get(item.managerId);
    const pin = manager?.core.catalog.find(entry => entry.version === item.version);
    if (!requiredIds.has(item.managerId) || !requiredKeys.has(key) || !pin || pin.upstreamRevision !== item.upstreamRevision ||
      !distributionArchitectures(manager, config.arch).includes(item.arch) || item.directoryRelative !== key || seen.has(key)) throw new Error('Payload contains a duplicate, unexpected, or incorrectly pinned runtime package.');
    configuration({ arch: item.arch, maximumMacOS: item.minimumMacOS });
    if (!B.versionAtLeast(config.maximumMacOS, item.minimumMacOS)) throw new Error(`${item.managerId}: native payload exceeds the explicitly selected macOS floor.`);
    seen.add(key);
  }
  for (const item of required) if (!seen.has(`${item.managerId}/${item.version}/${item.arch}`)) throw new Error(`Missing required native package: ${item.managerId}/${item.version}/${item.arch}`);
  S.validateInventory(value.supplementals, config, dependencies);
  Sources.validateInventory(value.sourceArtifacts, required, managers, value.supplementals);
  for (const item of value.supplementals) {
    if (value.packages.some(record => record.managerId === item.id)) throw new Error('Supplemental native resources cannot overlap runtime-manager directories.');
    for (const file of item.files) safeFile(`native-runtimes/${item.directoryRelative}/${file.path}`);
  }
  S.validatePublicMetadata(value);
  return value;
}

function tarHeader(name, size, mode) {
  safeFile(name);
  let prefix = '', base = name;
  if (Buffer.byteLength(base) > 100) {
    const candidates = [...name.matchAll(/\//g)].map(match => match.index).reverse();
    const split = candidates.find(index => Buffer.byteLength(name.slice(0, index)) <= 155 && Buffer.byteLength(name.slice(index + 1)) <= 100);
    if (split === undefined) throw new Error('A native payload path exceeds portable tar limits.');
    prefix = name.slice(0, split); base = name.slice(split + 1);
  }
  const header = Buffer.alloc(512);
  header.write(base, 0, 100); header.write(prefix, 345, 155);
  function number(value, offset, length) {
    const encoded = value.toString(8);
    if (!Number.isSafeInteger(value) || value < 0 || encoded.length >= length) throw new Error('Native payload exceeds portable tar numeric limits.');
    header.write(encoded.padStart(length - 1, '0') + '\0', offset, length);
  }
  number(mode, 100, 8); number(0, 108, 8); number(0, 116, 8); number(size, 124, 12); number(0, 136, 12);
  header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257, 6); header.write('00', 263, 2);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}
async function checksum(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function writeArchive(entries, output) {
  if (entries.length > LIMITS.entries) throw new Error('Native payload has too many archive entries.');
  const archive = path.resolve(output);
  B.realDirectory(path.dirname(archive), { create: true });
  if (fs.existsSync(archive)) throw new Error('Choose a new archive path; existing release artifacts are preserved.');
  let started = false;
  async function* blocks() {
    let total = 0;
    for (const entry of entries) {
      total += 512 + Math.ceil(entry.size / 512) * 512;
      if (total > LIMITS.expandedBytes) throw new Error('Expanded native payload exceeds its aggregate limit.');
      yield tarHeader(entry.name, entry.size, entry.mode);
      const hash = crypto.createHash('sha256'); let size = 0;
      const stream = entry.bytes ? Readable.from([entry.bytes]) : fs.createReadStream(entry.file, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) });
      for await (const chunk of stream) { size += chunk.length; if (size > entry.size) throw new Error('Native payload changed during export.'); hash.update(chunk); yield chunk; }
      if (size !== entry.size || hash.digest('hex') !== entry.sha256) throw new Error('Native payload changed during export.');
      if (size % 512) yield Buffer.alloc(512 - size % 512);
    }
    yield Buffer.alloc(1024);
  }
  try {
    const target = fs.createWriteStream(archive, { flags: 'wx', mode: 0o600 });
    target.once('open', () => { started = true; });
    await pipeline(Readable.from(blocks()), zlib.createGzip({ level: 6 }), target);
    if (fs.statSync(archive).size > LIMITS.archiveBytes) throw new Error('Native archive exceeds its download limit.');
    return { archive: path.basename(archive), sha256: await checksum(archive), bytes: fs.statSync(archive).size };
  } catch (error) { if (started) fs.rmSync(archive, { force: true }); throw error; }
}
async function exportPayload({ resourceRoot, sourceRoot, sourceDownload, output, arch, maximumMacOS, dependencies } = {}) {
  const config = configuration({ arch, maximumMacOS });
  Model.assertPublishable(Model.createPlan({ ...config, dependencies }));
  const root = path.resolve(resourceRoot || path.join(__dirname, '../src/resources/native-runtimes'));
  const required = requirementInventory(config, dependencies);
  const sourceArtifacts = Sources.requirements(required, catalog(dependencies), S.requirements(config, dependencies));
  const sourceDirectory = path.resolve(sourceRoot || path.join(path.dirname(root), 'native-runtime-sources'));
  if (sourceDirectory === root || sourceDirectory.startsWith(root + path.sep) || root.startsWith(sourceDirectory + path.sep)) throw new Error('Native resources and corresponding-source storage must be separate.');
  const ids = [...new Set(required.map(item => item.managerId))];
  const verified = require('./verify-native-runtimes.cjs').verifyPackages({ resourceRoot: root, architectures: [arch], maximumMacOS, managerIds: ids, requiredOnly: true, dependencies })
    .sort((a, b) => a.directoryRelative.localeCompare(b.directoryRelative));
  const packages = [], manifests = [], files = [];
  for (const item of verified) {
    const directory = path.join(root, item.directoryRelative), stored = B.readRegular(path.join(directory, 'manifest.json'), B.LIMITS.manifestBytes);
    if (stored.sha256 !== item.manifestSha256) throw new Error('Native manifest changed after verification.');
    const manifest = JSON.parse(stored.bytes);
    S.validatePublicMetadata(manifest);
    const relative = `${item.managerId}/${item.version}/${item.arch}`;
    packages.push({ managerId: item.managerId, version: item.version, arch: item.arch, upstreamRevision: manifest.upstreamRevision,
      minimumMacOS: manifest.minimumMacOS, directoryRelative: relative, manifestSize: stored.size, manifestSha256: stored.sha256 });
    manifests.push({ name: `native-runtimes/${relative}/manifest.json`, bytes: stored.bytes, size: stored.size, sha256: stored.sha256, mode: 0o644 });
    for (const file of manifest.files) files.push({ name: safeFile(`native-runtimes/${relative}/files/${file.path}`),
      file: path.join(directory, 'files', file.path), size: file.size, sha256: file.sha256, mode: file.mode });
  }
  const supplementals = S.verifySupplementals({ resourceRoot: root, arch, maximumMacOS, dependencies });
  for (const item of supplementals) for (const file of item.files) files.push({ name: safeFile(`native-runtimes/${item.directoryRelative}/${file.path}`),
    file: path.join(root, item.directoryRelative, file.path), size: file.size, sha256: file.sha256, mode: file.mode });
  for (const { item, file } of sourceDownload ? [] : Sources.verify(sourceDirectory, sourceArtifacts)) files.push({ name: safeFile(`native-sources/${item.directoryRelative}`),
    file, size: item.bytes, sha256: item.sha256, mode: 0o644 });
  const inventory = validateInventory({ schemaVersion: 1, launcherArch: arch, maximumMacOS, packages, supplementals, sourceArtifacts,
    ...(sourceDownload ? { sourceDownload } : {}) }, config, dependencies);
  const metadata = Buffer.from(JSON.stringify(inventory, null, 2) + '\n');
  if (metadata.length > LIMITS.metadataBytes) throw new Error('Native inventory exceeds its limit.');
  const result = await writeArchive([{ name: 'native-payload.json', bytes: metadata, size: metadata.length, sha256: B.digest(metadata), mode: 0o644 }, ...manifests, ...files], output);
  return { ...result, inventory };
}

class ArchiveReader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.buffer = Buffer.alloc(0); this.total = 0; }
  async read(size, optional = false) {
    while (this.buffer.length < size) {
      const next = await this.iterator.next();
      if (next.done) { if (optional && !this.buffer.length) return null; throw new Error('Truncated native payload archive.'); }
      this.total += next.value.length;
      if (this.total > LIMITS.expandedBytes) throw new Error('Expanded native payload exceeds its aggregate limit.');
      this.buffer = Buffer.concat([this.buffer, next.value]);
    }
    const result = this.buffer.subarray(0, size); this.buffer = this.buffer.subarray(size); return result;
  }
  async end() {
    if (this.buffer.some(byte => byte !== 0)) throw new Error('Unexpected data after native archive terminator.');
    let trailing = this.buffer.length;
    for await (const chunk of { [Symbol.asyncIterator]: () => this.iterator }) {
      trailing += chunk.length;
      if (trailing > LIMITS.metadataBytes || chunk.some(byte => byte !== 0)) throw new Error('Unexpected data after native archive terminator.');
    }
  }
}
function parseHeader(header) {
  const string = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
  const number = (start, length) => { const value = string(start, length).trim(); if (!/^[0-7]+$/.test(value)) throw new Error('Invalid native tar numeric field.'); const result = parseInt(value, 8); if (!Number.isSafeInteger(result)) throw new Error('Native tar number exceeds its limit.'); return result; };
  const expected = number(148, 8), copy = Buffer.from(header); copy.fill(32, 148, 156);
  if (copy.reduce((sum, byte) => sum + byte, 0) !== expected || string(257, 6) !== 'ustar' || ![0, 48].includes(header[156]) || string(157, 100)) throw new Error('Native payload must contain checksummed portable tar regular files only.');
  const prefix = string(345, 155), name = safeFile((prefix ? prefix + '/' : '') + string(0, 100));
  return { name, size: number(124, 12), mode: number(100, 8) };
}
async function extractPayload(archive, staging, config, dependencies) {
  const input = fs.createReadStream(archive), stream = zlib.createGunzip();
  input.on('error', error => stream.destroy(error)); input.pipe(stream);
  const reader = new ArchiveReader(stream), allowed = new Map(), seen = new Set();
  let inventory = null, entries = 0, total = 0;
  try {
    while (true) {
      const header = await reader.read(512);
      if (header.every(byte => byte === 0)) { if (!(await reader.read(512)).every(byte => byte === 0)) throw new Error('Invalid native tar terminator.'); await reader.end(); break; }
      if (++entries > LIMITS.entries) throw new Error('Native payload has too many archive entries.');
      const entry = parseHeader(header);
      if (seen.has(entry.name)) throw new Error('Duplicate native payload archive entry.');
      seen.add(entry.name); total += entry.size;
      if (total > LIMITS.expandedBytes) throw new Error('Native payload exceeds its aggregate file limit.');
      if (!inventory) {
        if (entry.name !== 'native-payload.json' || entry.mode !== 0o644 || entry.size > LIMITS.metadataBytes) throw new Error('Native inventory must be the first regular archive entry.');
        inventory = validateInventory(JSON.parse((await reader.read(entry.size)).toString('utf8')), config, dependencies);
        for (const item of inventory.packages) allowed.set(`native-runtimes/${item.directoryRelative}/manifest.json`, { size: item.manifestSize, sha256: item.manifestSha256, mode: 0o644, package: item });
        for (const item of inventory.supplementals) for (const file of item.files) {
          const name = safeFile(`native-runtimes/${item.directoryRelative}/${file.path}`);
          if (allowed.has(name)) throw new Error('Overlapping native payload inventory paths.');
          allowed.set(name, { size: file.size, sha256: file.sha256, mode: file.mode });
        }
        for (const item of inventory.sourceDownload ? [] : inventory.sourceArtifacts || []) allowed.set(safeFile(`native-sources/${item.directoryRelative}`),
          { size: item.bytes, sha256: item.sha256, mode: 0o644 });
      } else {
        const expected = allowed.get(entry.name);
        if (!expected || entry.size !== expected.size || entry.mode !== expected.mode) throw new Error('Native archive file is outside its sealed inventory or differs in size/mode.');
        const destination = path.join(staging, entry.name); B.realDirectory(path.dirname(destination), { create: true });
        const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), entry.mode);
        const hash = crypto.createHash('sha256'); let remaining = entry.size;
        try { while (remaining) { const chunk = await reader.read(Math.min(remaining, 65536)); hash.update(chunk); fs.writeFileSync(fd, chunk); remaining -= chunk.length; } fs.fchmodSync(fd, entry.mode); }
        finally { fs.closeSync(fd); }
        if (hash.digest('hex') !== expected.sha256) throw new Error('Native archive file checksum differs from its sealed inventory.');
        if (expected.package) {
          const manifest = B.validateManifest(JSON.parse(fs.readFileSync(destination, 'utf8')), expected.package);
          if (manifest.minimumMacOS !== expected.package.minimumMacOS) throw new Error('Native manifest floor differs from the payload inventory.');
          S.validatePublicMetadata(manifest);
          for (const file of manifest.files) {
            const name = safeFile(`native-runtimes/${expected.package.directoryRelative}/files/${file.path}`);
            if (allowed.has(name)) throw new Error('Overlapping native payload inventory paths.');
            allowed.set(name, { size: file.size, sha256: file.sha256, mode: file.mode });
            if (allowed.size > LIMITS.entries) throw new Error('Native inventory has too many files.');
          }
        }
      }
      if (entry.size % 512 && (await reader.read(512 - entry.size % 512)).some(byte => byte !== 0)) throw new Error('Invalid native tar padding.');
    }
    if (!inventory || [...allowed.keys()].some(name => !seen.has(name))) throw new Error('Native archive is missing sealed payload files.');
    return inventory;
  } finally { input.destroy(); stream.destroy(); }
}
async function downloadPayload(url, output, dependencies) {
  let current = publishedUrl(url);
  const request = dependencies?.fetch || fetch;
  for (let redirects = 0; redirects <= 8; redirects++) {
    const response = await request(current, { redirect: 'manual', signal: AbortSignal.timeout(15 * 60 * 1000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw new Error('Native payload redirect has no destination.');
      current = publishedUrl(new URL(location, current).href); continue;
    }
    if (!response.ok || !response.body) throw new Error(`Native payload download failed (HTTP ${response.status}).`);
    const size = response.headers.get('content-length');
    if (size && (!/^\d+$/.test(size) || Number(size) > LIMITS.archiveBytes)) { await response.body.cancel(); throw new Error('Native payload download exceeds its limit.'); }
    let bytes = 0;
    async function* chunks() { for await (const chunk of Readable.fromWeb(response.body)) { bytes += chunk.length; if (bytes > LIMITS.archiveBytes) throw new Error('Native payload download exceeds its limit.'); yield chunk; } }
    await pipeline(Readable.from(chunks()), fs.createWriteStream(output, { flags: 'wx', mode: 0o600 })); return;
  }
  throw new Error('Native payload has too many redirects.');
}
async function importPayload({ archive, url, sha256, resourceRoot, sourceRoot, arch, maximumMacOS, dependencies } = {}) {
  const config = configuration({ arch, maximumMacOS });
  if (!SHA.test(sha256 || '') || Boolean(archive) === Boolean(url)) throw new Error('Choose one explicit local archive or HTTPS URL and its exact lowercase SHA-256.');
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'maclauncher-native-payload-'));
  try {
    const source = path.join(temporary, 'download.tar.gz');
    if (url) await downloadPayload(url, source, dependencies);
    else {
      const original = path.resolve(archive), input = fs.lstatSync(original);
      if (!input.isFile() || input.isSymbolicLink() || input.size > LIMITS.archiveBytes) throw new Error('Choose a contained regular native archive within its byte limit.');
      let copied = 0;
      async function* chunks() { for await (const chunk of fs.createReadStream(original, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) })) { copied += chunk.length; if (copied > LIMITS.archiveBytes) throw new Error('Native archive copy exceeds its byte limit.'); yield chunk; } }
      await pipeline(Readable.from(chunks()), fs.createWriteStream(source, { flags: 'wx', mode: 0o600 }));
    }
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.archiveBytes || await checksum(source) !== sha256) throw new Error('Native archive checksum or file identity differs from the pinned payload.');
    const staging = path.join(temporary, 'staged'); B.realDirectory(staging, { create: true });
    const inventory = await extractPayload(source, staging, config, dependencies);
    const destination = path.resolve(resourceRoot || path.join(__dirname, '../src/resources/native-runtimes'));
    const sourceDestination = path.resolve(sourceRoot || path.join(path.dirname(destination), 'native-runtime-sources'));
    if (sourceDestination === destination || sourceDestination.startsWith(destination + path.sep) || destination.startsWith(sourceDestination + path.sep)) throw new Error('Native resources and corresponding-source storage must be separate.');
    const sourcePublication = inventory.sourceDownload ? null : Sources.preparePublication(path.join(staging, 'native-sources'), sourceDestination, inventory.sourceArtifacts || []);
    try {
      const published = require('./publish-native-runtimes.cjs').publishPackages({ sourceRoot: path.join(staging, 'native-runtimes'), resourceRoot: destination,
        architectures: [arch], maximumMacOS, managerIds: [...new Set(inventory.packages.map(item => item.managerId))], supplementals: inventory.supplementals, dependencies });
      return { sha256, inventory, published, publishedSourceArtifacts: inventory.sourceDownload ? [] : inventory.sourceArtifacts || [],
        publishedSupplementals: S.verifySupplementals({ resourceRoot: destination, arch, maximumMacOS, items: inventory.supplementals, dependencies }) };
    } catch (error) { sourcePublication?.rollback(); throw error; }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
async function main(args) {
  const [command, ...rest] = args, options = {};
  const keys = new Set(['--arch', '--maximum-macos', '--resources', '--sources', '--sources-url', '--sources-sha256', '--output', '--archive', '--url', '--sha256']);
  for (let index = 0; index < rest.length; index += 2) {
    if (!keys.has(rest[index]) || !rest[index + 1] || options[rest[index]]) throw new Error('Use explicit unique native-payload options.');
    options[rest[index]] = rest[index + 1];
  }
  const config = { arch: options['--arch'], maximumMacOS: options['--maximum-macos'], resourceRoot: options['--resources'], sourceRoot: options['--sources'] };
  if (command === 'export') { if (!options['--output']) throw new Error('Export needs a new --output archive path.');
    const sourceDownload = options['--sources-url'] || options['--sources-sha256']
      ? { url: options['--sources-url'], sha256: options['--sources-sha256'] } : undefined;
    return exportPayload({ ...config, sourceDownload, output: options['--output'] }); }
  if (command === 'fetch') return importPayload({ ...config, archive: options['--archive'], url: options['--url'], sha256: options['--sha256'] });
  if (command === 'required') { const packages = requirementInventory(configuration(config)), supplementals = S.requirements(configuration(config));
    return { packages, supplementals, sourceArtifacts: Sources.requirements(packages, catalog(), supplementals) }; }
  throw new Error('Usage: node scripts/native-payload.cjs export|fetch|required --arch arm64|x64 --maximum-macos <floor> [--resources <directory>] [--sources <directory>] [--output <new.tar.gz> | --archive <local.tar.gz> | --url <published-https-url> --sha256 <exact-sha256>]');
}
if (require.main === module) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { LIMITS, configuration, publishedUrl, safeFile, requirementInventory, validateInventory, tarHeader, parseHeader, writeArchive, checksum, exportPayload, extractPayload, downloadPayload, importPayload, main };

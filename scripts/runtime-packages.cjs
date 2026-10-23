#!/usr/bin/env node
// Exact release inputs for the application; managed game runtimes are separate.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const B = require('../src/modules/shared/runtime/bundled-native');
const Catalog = require('../src/modules/shared/runtime/maclauncher-builds');
const Model = require('./distribution-model.cjs');
const Payload = require('./native-payload.cjs');

const ROOT = path.resolve(__dirname, '..');
const LOCK = 'build/runtime-packages.json';
const PUBLISHED_CATALOGS = 'src/modules/shared/runtime/published-catalogs.json';
const key = item => `${item.id || item.managerId}/${item.version}/${item.arch}`;

function validateLock(value, { plan, dependencies } = {}) {
  if (!value || value.schemaVersion !== 1 || typeof value.repository !== 'string' || !Array.isArray(value.packages))
    throw new Error('Application runtime inputs require a versioned package lock.');
  const config = Model.configuration(value);
  plan ||= Model.assertPublishable(Model.createPlan({ ...config, dependencies }));
  if (plan.launcherArch !== value.arch || plan.maximumNativeMacOS !== value.maximumMacOS)
    throw new Error('The package lock differs from the application architecture or macOS floor.');
  const required = [...plan.packages, ...plan.supplementals], selected = new Map();
  for (const input of value.packages) {
    const record = Catalog.validateProjectCatalog({ schemaVersion: 2, projectId: input?.id, updatePolicy: 'manual', packages: [input] },
      { projectId: input?.id, repository: value.repository, architecture: value.arch }).packages[0];
    if (!record || selected.has(key(record)) || !B.versionAtLeast(value.maximumMacOS, record.minimumMacOS))
      throw new Error('The package lock contains an incompatible or repeated runtime.');
    selected.set(key(record), record);
  }
  if (required.length !== selected.size || required.some(item => !selected.has(key(item))))
    throw new Error('The package lock must cover exactly the included application packages.');
  for (const item of plan.supplementals) {
    const record = selected.get(key(item));
    if (record.manifestRelative !== item.manifestRelative || record.manifestSha256 !== item.manifestSha256 ||
        record.sourceSha256 !== item.sourceSha256 || record.minimumMacOS !== item.minimumMacOS)
      throw new Error('A locked helper differs from its module declaration.');
  }
  for (const source of plan.sourceArtifacts) for (const record of selected.values()) {
    if (record.id === source.managerId && record.version === source.version && record.sourceAsset &&
        (record.sourceAsset.sha256 !== source.sha256 || record.sourceAsset.bytes !== source.bytes))
      throw new Error('A runtime source download differs from its source identity.');
  }
  return { schemaVersion: 1, repository: value.repository, ...config, packages: [...selected.values()] };
}

function readLock({ repoRoot = ROOT, dependencies } = {}) {
  return validateLock(JSON.parse(B.readRegular(path.join(repoRoot, LOCK), 4 * 1024 ** 2).bytes), { dependencies });
}

function createLock({ catalogs, arch = 'arm64', maximumMacOS, repository = 'procrastinine/maclauncher-builds', dependencies } = {}) {
  let plan = Model.assertPublishable(Model.createPlan({ arch, maximumMacOS: maximumMacOS || '13.0', dependencies }));
  const packages = [...plan.packages, ...plan.supplementals].map(item => {
    const id = item.id || item.managerId;
    const catalog = JSON.parse(B.readRegular(path.join(catalogs, id + '.json'), 2 * 1024 ** 2).bytes);
    const record = Catalog.validateProjectCatalog(catalog, { projectId: id, repository, architecture: arch }).packages
      .find(record => record.version === item.version && record.arch === item.arch);
    if (!record) throw new Error(`Missing published package identity: ${key(item)}.`);
    return record;
  });
  if (maximumMacOS === undefined) {
    maximumMacOS = packages.reduce((floor, record) => B.versionAtLeast(record.minimumMacOS, floor) ? record.minimumMacOS : floor,
      plan.launcherMinimumMacOS);
    plan = Model.createPlan({ arch, maximumMacOS, dependencies });
  }
  return validateLock({ schemaVersion: 1, repository, arch, maximumMacOS, packages }, { plan, dependencies });
}

function writePublishedCatalogs({ catalogs, repository = 'procrastinine/maclauncher-builds', repoRoot = ROOT }) {
  const snapshot = {};
  for (const filename of fs.readdirSync(catalogs).sort()) {
    if (!filename.endsWith('.json') || filename === 'index.json') continue;
    const projectId = filename.slice(0, -5);
    const catalog = JSON.parse(B.readRegular(path.join(catalogs, filename), 2 * 1024 ** 2).bytes);
    Catalog.validateProjectCatalog(catalog, { projectId, repository });
    snapshot[projectId] = catalog;
  }
  fs.writeFileSync(path.join(repoRoot, PUBLISHED_CATALOGS), JSON.stringify({ schemaVersion: 1, repository, catalogs: snapshot }, null, 2) + '\n');
  return { projects: Object.keys(snapshot).length };
}

async function extractPackage(archive, destination, record) {
  const stat = fs.lstatSync(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.asset.bytes || await Payload.checksum(archive) !== record.asset.sha256)
    throw new Error('Application package archive checksum or size differs from its lock.');
  const input = fs.createReadStream(archive), stream = zlib.createGunzip();
  input.on('error', error => stream.destroy(error)); input.pipe(stream);
  const reader = new Payload.ArchiveReader(stream), seen = new Set();
  let declaration, expected;
  try {
    for (;;) {
      const header = await reader.read(512);
      if (header.every(byte => byte === 0)) {
        if (!(await reader.read(512)).every(byte => byte === 0)) throw new Error('Invalid package archive terminator.');
        await reader.end(); break;
      }
      const entry = Payload.parseHeader(header);
      if (seen.has(entry.name) || seen.size >= B.LIMITS.files + 1) throw new Error('Repeated or excessive package archive members.');
      seen.add(entry.name);
      if (!declaration) {
        if (entry.name !== 'runtime-package.json' || entry.mode !== 0o644 || entry.size > B.LIMITS.manifestBytes)
          throw new Error('The package declaration must be the first archive member.');
        declaration = JSON.parse((await reader.read(entry.size)).toString('utf8'));
        if (['id', 'version', 'arch', 'minimumMacOS', 'manifestRelative', 'manifestSha256', 'sourceSha256'].some(field => declaration[field] !== record[field]) ||
            declaration.directoryRelative !== key(record) ||
            declaration.sourceRelative === undefined && !declaration.sourceArtifact ||
            JSON.stringify(declaration.launcherArchitectures) !== JSON.stringify(record.launcherArchitectures) ||
            !Array.isArray(declaration.files) || !declaration.files.length || declaration.files.length > B.LIMITS.files)
          throw new Error('The archive declaration differs from the locked runtime identity.');
        expected = new Map();
        for (const file of declaration.files) {
          const name = Payload.safeFile(file.path);
          if (expected.has('files/' + name) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > B.LIMITS.fileBytes ||
              ![0o640, 0o644, 0o755].includes(file.mode) || !/^[a-f0-9]{64}$/.test(file.sha256 || ''))
            throw new Error('Invalid sealed application package inventory.');
          expected.set('files/' + name, file);
        }
        if (expected.get('files/' + record.manifestRelative)?.sha256 !== record.manifestSha256 ||
            declaration.sourceRelative != null && expected.get('files/' + declaration.sourceRelative)?.sha256 !== record.sourceSha256 ||
            declaration.sourceArtifact && record.sourceAsset && (declaration.sourceArtifact.sha256 !== record.sourceAsset.sha256 ||
              declaration.sourceArtifact.bytes !== record.sourceAsset?.bytes ||
              path.posix.basename(declaration.sourceArtifact.directoryRelative || '') !== record.sourceAsset?.filename))
          throw new Error('The locked manifest is missing from the package inventory.');
      } else {
        const file = expected.get(entry.name);
        if (!file || file.size !== entry.size || file.mode !== entry.mode) throw new Error('Unexpected application package archive member.');
        const target = path.join(destination, file.path);
        B.realDirectory(path.dirname(target), { create: true });
        const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), file.mode);
        const hash = crypto.createHash('sha256'); let remaining = entry.size;
        try {
          while (remaining) { const chunk = await reader.read(Math.min(remaining, 65536)); fs.writeFileSync(fd, chunk); hash.update(chunk); remaining -= chunk.length; }
          fs.fchmodSync(fd, file.mode);
        } finally { fs.closeSync(fd); }
        if (hash.digest('hex') !== file.sha256) throw new Error('An application package member failed checksum verification.');
      }
      if (entry.size % 512 && (await reader.read(512 - entry.size % 512)).some(byte => byte !== 0)) throw new Error('Invalid package archive padding.');
    }
    if (!declaration || [...expected.keys()].some(name => !seen.has(name))) throw new Error('Application package archive is incomplete.');
    return declaration;
  } finally { input.destroy(); stream.destroy(); }
}

async function fetchPackages({ lock = readLock(), repoRoot = ROOT, dependencies = {} } = {}) {
  lock = validateLock(lock, { dependencies: dependencies.model });
  const root = path.join(repoRoot, 'src/resources/native-runtimes'), cache = path.join(repoRoot, 'dist/runtime-downloads');
  B.realDirectory(root, { create: true }); B.realDirectory(cache, { create: true });
  const declarations = [];
  for (const record of lock.packages) {
    const archive = path.join(cache, record.asset.filename);
    if (!fs.existsSync(archive)) await (dependencies.download || Payload.downloadPayload)(record.asset.url, archive);
    const parent = path.join(root, record.id, record.version), destination = path.join(parent, record.arch);
    B.realDirectory(parent, { create: true });
    const staging = fs.mkdtempSync(path.join(parent, '.install-'));
    try {
      const declaration = await extractPackage(archive, staging, record);
      if (fs.existsSync(destination)) B.verifyPayload(destination, declaration);
      else fs.renameSync(staging, destination);
      declarations.push(declaration);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  const config = { arch: lock.arch, maximumMacOS: lock.maximumMacOS };
  const plan = Model.createPlan({ ...config, dependencies: dependencies.model });
  const packages = plan.packages.map(item => {
    const record = lock.packages.find(record => key(record) === key(item));
    const stored = B.readRegular(path.join(root, item.directoryRelative, 'manifest.json'), B.LIMITS.manifestBytes);
    const manifest = B.validateManifest(JSON.parse(stored.bytes), item);
    if (stored.sha256 !== record.manifestSha256) throw new Error('An included runtime differs from its locked manifest.');
    return { ...item, minimumMacOS: manifest.minimumMacOS, manifestSize: stored.size, manifestSha256: stored.sha256 };
  });
  const inventory = { schemaVersion: 1, launcherArch: lock.arch, maximumMacOS: lock.maximumMacOS, packages,
    supplementals: plan.supplementals, sourceArtifacts: plan.sourceArtifacts, projectPackages: lock.packages,
    packageRepository: lock.repository };
  Payload.validateInventory(inventory, config, dependencies.model);
  return { inventory, packages: declarations.length };
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === 'lock' && rest.length === 1) {
    const result = createLock({ catalogs: path.resolve(rest[0]) });
    writePublishedCatalogs({ catalogs: path.resolve(rest[0]), repository: result.repository });
    fs.writeFileSync(path.join(ROOT, LOCK), JSON.stringify(result, null, 2) + '\n'); return result;
  }
  if (command === 'check' && !rest.length) { const result = readLock(); return { packages: result.packages.length, arch: result.arch, maximumMacOS: result.maximumMacOS }; }
  throw new Error('Usage: node scripts/runtime-packages.cjs lock <catalog-directory>|check');
}
module.exports = { LOCK, PUBLISHED_CATALOGS, validateLock, readLock, createLock, writePublishedCatalogs, extractPackage, fetchPackages, main };
if (require.main === module) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });

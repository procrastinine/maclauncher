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
const key = item => `${item.id || item.managerId}/${item.version}/${item.arch}`;

const ARCHITECTURES = Object.freeze(['arm64', 'x64']);

// One compatible package per version, preferring a separate build for this
// launcher CPU over Universal while preserving other included versions.
function selectArchitecture(lock, arch) {
  if (!lock?.architectures?.includes(arch)) throw new Error('The package lock does not cover this launcher architecture.');
  return { repository: lock.repository, arch, maximumMacOS: lock.maximumMacOS,
    packages: require('../src/modules/shared/runtime/included-helpers').preferredIncludedBuilds(lock.packages, arch) };
}

function validateSelection(value, { plan, dependencies } = {}) {
  if (!value || typeof value.repository !== 'string' || !Array.isArray(value.packages))
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
  return { repository: value.repository, ...config, packages: [...selected.values()] };
}

// The lock lists every included package for every launcher CPU that is built.
function validateLock(value, { plans = {}, dependencies } = {}) {
  if (!value || value.schemaVersion !== 2 || typeof value.repository !== 'string' || !Array.isArray(value.packages) ||
      !Array.isArray(value.architectures) || !value.architectures.length ||
      value.architectures.some((arch, index) => arch !== ARCHITECTURES.filter(item => value.architectures.includes(item))[index]))
    throw new Error('Application runtime inputs require a versioned package lock for explicit launcher architectures.');
  const used = new Set();
  for (const arch of value.architectures) {
    const selection = validateSelection(selectArchitecture(value, arch), { plan: plans[arch], dependencies });
    for (const record of selection.packages) used.add(key(record));
  }
  if (used.size !== value.packages.length) throw new Error('The package lock contains a runtime that no launcher architecture includes.');
  return { schemaVersion: 2, repository: value.repository, architectures: [...value.architectures], maximumMacOS: value.maximumMacOS,
    packages: value.packages.map(record => Catalog.validateProjectRecord(record, { projectId: record.id, repository: value.repository })) };
}

function readLock({ repoRoot = ROOT, arch, dependencies } = {}) {
  const lock = validateLock(JSON.parse(B.readRegular(path.join(repoRoot, LOCK), 4 * 1024 ** 2).bytes), { dependencies });
  return arch === undefined ? lock : validateSelection(selectArchitecture(lock, arch), { dependencies });
}

function createLock({ catalogs, architectures = ARCHITECTURES, maximumMacOS, repository = 'procrastinine/maclauncher-builds', dependencies } = {}) {
  const records = new Map();
  let floor = '0.0';
  for (const arch of architectures) {
    const plan = Model.assertPublishable(Model.createPlan({ arch, maximumMacOS: maximumMacOS || '13.0', dependencies }));
    if (B.versionAtLeast(plan.launcherMinimumMacOS, floor)) floor = plan.launcherMinimumMacOS;
    for (const item of [...plan.packages, ...plan.supplementals]) {
      const id = item.id || item.managerId;
      if (records.has(key(item))) continue;
      const catalog = JSON.parse(B.readRegular(path.join(catalogs, id + '.json'), 2 * 1024 ** 2).bytes);
      const record = Catalog.validateProjectCatalog(catalog, { projectId: id, repository, architecture: arch }).packages
        .find(record => record.version === item.version && record.arch === item.arch);
      if (!record) throw new Error(`Missing published package identity: ${key(item)}.`);
      records.set(key(item), record);
    }
  }
  maximumMacOS ??= [...records.values()].reduce((value, record) => B.versionAtLeast(record.minimumMacOS, value) ? record.minimumMacOS : value, floor);
  const packages = [...records.values()].sort((a, b) => key(a).localeCompare(key(b)));
  return validateLock({ schemaVersion: 2, repository, architectures: ARCHITECTURES.filter(arch => architectures.includes(arch)),
    maximumMacOS, packages }, { dependencies });
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

// Host-shared virtio-fs volumes can keep reporting freshly removed directory
// entries after their contents are deleted. Retry the stage cleanup briefly
// before treating such races as real failures of the package fetch.
async function removeStaging(staging) {
  for (let attempt = 0; ; attempt++) {
    try { return fs.rmSync(staging, { recursive: true, force: true }); }
    catch (error) {
      if ((error.code !== 'ENOTEMPTY' && error.code !== 'EBUSY') || attempt >= 8) throw error;
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

const PACKAGE_ARCHITECTURES = ['arm64', 'x64', 'universal'], ARCHIVE = /^(.+)-(arm64|x64|universal)\.tar\.gz$/;

// Earlier fetched versions of locked package ids that no lock record for any
// launcher CPU references. A folder is recognized only in the installed layout
// <id>/<version>/<arch>/<locked manifest> with its downloaded archive
// <id>-<version>-<arch>.tar.gz beside the current ones. Local stages without an
// archive, links, dot entries, other files, ids outside the lock, generation
// caches with leases and folders named by a running command line stay. An
// archive stays while its unrecognized folder does.
function unlockedPackages({ lock, selection, repoRoot = ROOT, processes }) {
  const root = path.join(repoRoot, 'src/resources/native-runtimes'), cache = path.join(repoRoot, 'dist/runtime-downloads');
  const ids = new Map(), assets = new Set();
  for (const record of [...lock.packages, ...(selection?.packages || [])]) {
    if (!ids.has(record.id)) ids.set(record.id, { versions: new Set(), manifests: new Set() });
    ids.get(record.id).versions.add(record.version); ids.get(record.id).manifests.add(record.manifestRelative);
    assets.add(record.asset.filename);
  }
  const regular = file => { try { return fs.lstatSync(file).isFile(); } catch { return false; } };
  const archived = new Map();
  if (B.realDirectory(cache)) for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
    const match = ARCHIVE.exec(entry.name);
    const id = match && [...ids.keys()].filter(id => match[1].startsWith(id + '-')).sort((a, b) => b.length - a.length)[0];
    if (entry.isFile() && id && !assets.has(entry.name)) archived.set(entry.name, path.join(id, match[1].slice(id.length + 1), match[2]));
  }
  const folders = [];
  for (const [id, { versions, manifests }] of processes === null ? [] : ids) {
    const parent = path.join(root, id), leases = path.join(parent, '.generation-leases');
    if (!B.realDirectory(parent) || fs.existsSync(leases) && (!B.realDirectory(leases) || fs.readdirSync(leases).length)) continue;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || versions.has(entry.name)) continue;
      const folder = path.join(parent, entry.name), children = fs.readdirSync(folder, { withFileTypes: true });
      if (!children.length || children.some(child => !child.isDirectory() || !PACKAGE_ARCHITECTURES.includes(child.name) ||
          !archived.has(`${id}-${entry.name}-${child.name}.tar.gz`) ||
          ![...manifests].some(manifest => regular(path.join(folder, child.name, manifest)))) ||
          processes.includes(folder + path.sep) || processes.split('\n').some(line => line.endsWith(folder)))
        continue;
      folders.push(folder);
    }
  }
  const archives = [...archived].filter(([, relative]) => {
    const folder = path.join(root, path.dirname(relative));
    return !fs.existsSync(folder) || folders.includes(folder);
  }).map(([name]) => path.join(cache, name));
  return { folders, archives };
}

async function pruneUnlockedPackages(options) {
  const { folders, archives } = unlockedPackages(options);
  for (const folder of folders) await removeStaging(folder);
  for (const archive of archives) fs.rmSync(archive, { force: true });
  const base = options.repoRoot || ROOT;
  return [...folders, ...archives].map(file => path.relative(base, file));
}

// Offline comparison of the installed manifests with the lock for one launcher
// CPU. It reads only local files and returns one line when anything differs.
function includedPackagesHint({ repoRoot = ROOT, arch = process.arch } = {}) {
  let packages;
  try { packages = selectArchitecture(JSON.parse(fs.readFileSync(path.join(repoRoot, LOCK), 'utf8')), arch).packages; }
  catch { return null; }
  const root = path.join(repoRoot, 'src/resources/native-runtimes');
  const current = record => {
    try { return B.readRegular(path.join(root, key(record), record.manifestRelative), B.LIMITS.manifestBytes).sha256 === record.manifestSha256; }
    catch { return false; }
  };
  return packages.every(current) ? null : `The included packages differ from ${LOCK}. Run pnpm install to update them.`;
}

async function fetchPackages({ lock = readLock({ arch: process.arch }), repoRoot = ROOT, dependencies = {}, packageLock } = {}) {
  lock = validateSelection(lock, { dependencies: dependencies.model });
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
    } finally { await removeStaging(staging); }
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
  // The full lock covers `setup:dev --arch x64` in the same folder. Cleanup
  // after a complete fetch reports problems without failing the install.
  let removed = [];
  try {
    const processes = (dependencies.processes || (await import('./generation-cache.mjs')).generationProcesses)();
    removed = await pruneUnlockedPackages({ lock: packageLock || readLock({ repoRoot, dependencies: dependencies.model }),
      selection: lock, repoRoot, processes });
    if (removed.length) console.log('Removed earlier included packages: ' + removed.join(', '));
  } catch (error) { console.warn('Included package cleanup: ' + error.message); }
  return { inventory, packages: declarations.length, removed };
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === 'lock' && rest.length === 1) {
    const result = createLock({ catalogs: path.resolve(rest[0]) });
    fs.writeFileSync(path.join(ROOT, LOCK), JSON.stringify(result, null, 2) + '\n'); return result;
  }
  if (command === 'check' && !rest.length) { const result = readLock(); return { packages: result.packages.length, architectures: result.architectures, maximumMacOS: result.maximumMacOS }; }
  throw new Error('Usage: node scripts/runtime-packages.cjs lock <catalog-directory>|check');
}
module.exports = { LOCK, ARCHITECTURES, selectArchitecture, validateSelection, validateLock, readLock, createLock, extractPackage,
  unlockedPackages, pruneUnlockedPackages, includedPackagesHint, fetchPackages, main };
if (require.main === module) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });

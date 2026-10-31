// Production native inputs come from publisher archives or Runtime build attestations.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const workflow = repository => repository + '/.github/workflows/runtime-build.yml';
function assertArchive(file, record) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) throw new Error('A pinned publisher or Runtime build archive is missing: ' + path.basename(file) + '. Run the app CI fetch step.');
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.bytes || digest(fs.readFileSync(file)) !== record.sha256)
    throw new Error('A published input differs from its pinned archive: ' + path.basename(file) + '.');
  return file;
}
function buildInputs(repoRoot, lock) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(lock.repository || '')) throw new Error('Published builds require their GitHub repository.');
  return lock.packages.map(record => {
    if (path.basename(record.asset.filename) !== record.asset.filename) throw new Error('Invalid published archive filename.');
    const archive = path.join(repoRoot, 'dist/runtime-downloads', record.asset.filename);
    assertArchive(archive, record.asset);
    return { record, archive, bundle: path.join(repoRoot, 'dist/runtime-attestations', 'sha256:' + record.asset.sha256 + '.jsonl') };
  });
}
function downloadBuildAttestations({ repoRoot = ROOT, lock, tool = execFileSync }) {
  const cache = path.join(repoRoot, 'dist/runtime-attestations'); fs.mkdirSync(cache, { recursive: true });
  for (const item of buildInputs(repoRoot, lock)) {
    if (!fs.existsSync(item.bundle)) tool('gh', ['attestation', 'download', item.archive, '--repo', lock.repository],
      { cwd: cache, stdio: 'pipe', timeout: 120000 });
    if (!fs.existsSync(item.bundle)) throw new Error('Runtime build attestation was not downloaded for ' + item.record.id + '.');
  }
}
function verifyBuildAttestations({ repoRoot = ROOT, lock, tool = execFileSync }) {
  return buildInputs(repoRoot, lock).map(item => {
    if (!fs.existsSync(item.bundle)) throw new Error('A GitHub Runtime build attestation is required for ' + item.record.id + '. Run the app CI fetch step.');
    const result = JSON.parse(tool('gh', ['attestation', 'verify', item.archive, '--bundle', item.bundle,
      '--repo', lock.repository, '--signer-workflow', workflow(lock.repository), '--deny-self-hosted-runners', '--format', 'json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 16 * 1024 ** 2 }));
    if (!Array.isArray(result) || !result.length) throw new Error('The Runtime build has no verified provenance.');
    return { id: item.record.id, version: item.record.version, arch: item.record.arch, sha256: item.record.asset.sha256,
      url: item.record.asset.url, workflow: workflow(lock.repository),
      statements: result.map(entry => entry.verificationResult.statement) };
  });
}
async function prepareSevenZip({ repoRoot = ROOT, download = require('./native-payload.cjs').downloadPayload, tool = execFileSync } = {}) {
  const root = path.join(repoRoot, 'src/resources/7zip'), pin = JSON.parse(fs.readFileSync(path.join(root, 'source.json')));
  if (!/^https:\/\/github.com\/ip7z\/7zip\/releases\/download\//.test(pin.url)) throw new Error('7-Zip requires its publisher release.');
  const cache = path.join(repoRoot, 'dist/upstream-downloads'); fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, pin.sha256 + '.tar.xz');
  if (!fs.existsSync(archive)) await download(pin.url, archive);
  assertArchive(archive, pin);
  const executable = tool('/usr/bin/tar', ['-xOf', archive, '7zz'], { maxBuffer: 16 * 1024 ** 2 });
  if (digest(executable) !== pin.executableSha256) throw new Error('7-Zip publisher executable differs from its pin.');
  const license = tool('/usr/bin/tar', ['-xOf', archive, 'License.txt']);
  for (const [name, bytes, mode] of [['7zz', executable, 0o755], ['LICENSE.txt', license, 0o644]]) {
    const target = path.join(root, name), stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat?.isFile() && fs.readFileSync(target).equals(bytes)) {
      if ((stat.mode & 0o777) !== mode) fs.chmodSync(target, mode);
      continue;
    }
    // Replacing a signed executable in place invalidates macOS's cached code
    // signature for its inode, even when the replacement bytes are identical.
    const temporary = path.join(root, '.' + name + '-' + crypto.randomUUID());
    try {
      fs.writeFileSync(temporary, bytes, { flag: 'wx', mode });
      fs.chmodSync(temporary, mode);
      fs.renameSync(temporary, target);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  return { version: pin.version, architecture: 'universal' };
}
async function prepareDeclaredPublishers({ repoRoot = ROOT, download = require('./native-payload.cjs').downloadPayload } = {}) {
  const cache = path.join(repoRoot, 'dist/upstream-downloads'); fs.mkdirSync(cache, { recursive: true });
  let files = 0;
  async function visit(root) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name === 'binary.json') {
        const pin = JSON.parse(fs.readFileSync(file));
        if (!/^https:\/\//.test(pin.url || '') || !Array.isArray(pin.files)) throw new Error('A declared publisher download is invalid.');
        for (const item of pin.files) {
          if (!/^[a-f0-9]{64}$/.test(item.sha256 || '') || !Number.isSafeInteger(item.size) || item.size < 1)
            throw new Error('A declared publisher download needs an exact size and checksum.');
          const target = path.join(cache, item.sha256 + '.bin');
          if (!fs.existsSync(target)) await download(item.url || pin.url, target);
          assertArchive(target, { sha256: item.sha256, bytes: item.size }); files++;
        }
      }
    }
  }
  await visit(path.join(repoRoot, 'src/modules'));
  return { files };
}
function verifyPublisherNativeInputs(selected, { tool = execFileSync } = {}) {
  const native = [...selected.sources.values()].filter(record => record.owner === 'upstream' && record.binary);
  const python = native.filter(record => record.supplier.name === 'python');
  if (python.length) {
    const pin = require('../src/modules/shared/runtime/python').embeddedPythonProfile(selected.plan.launcherArch);
    const archive = path.join(selected.repoRoot, 'dist/upstream-downloads', pin.sha256 + '.tar.gz');
    assertArchive(archive, pin);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'maclauncher-publisher-'));
    try {
      tool('/usr/bin/tar', ['-xzf', archive, '-C', temporary], { timeout: 30000, stdio: 'pipe' });
      for (const record of python) {
        const name = record.sourceRelative.slice('src/resources/python/'.length), source = path.join(temporary, 'python', name);
        if (!fs.existsSync(source) || digest(fs.readFileSync(source)) !== record.sha256)
          throw new Error('Embedded Python native code differs from its publisher archive: ' + name + '.');
      }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  for (const record of native.filter(item => item.supplier.name === '7zip')) {
    const pin = record.supplier, archive = path.join(selected.repoRoot, 'dist/upstream-downloads', pin.sha256 + '.tar.xz');
    assertArchive(archive, pin);
    const bytes = tool('/usr/bin/tar', ['-xOf', archive, '7zz'], { maxBuffer: 16 * 1024 ** 2 });
    if (digest(bytes) !== record.sha256) throw new Error('7-Zip native code differs from its publisher archive.');
  }
  for (const record of native.filter(item => !['python', '7zip'].includes(item.supplier.name))) {
    const pin = record.supplier.file;
    if (!pin) throw new Error('Native publisher inputs require a verified release download.');
    const file = path.join(selected.repoRoot, 'dist/upstream-downloads', pin.sha256 + '.bin');
    assertArchive(file, { sha256: pin.sha256, bytes: pin.size });
    if (record.sha256 !== pin.sha256) throw new Error('Native code differs from its publisher download.');
  }
  return { nativeFiles: native.length };
}
function verifyProductionInputs(selected, { tool = execFileSync } = {}) {
  const lock = require('./runtime-packages.cjs').readLock({ repoRoot: selected.repoRoot, arch: selected.plan.launcherArch });
  const builds = verifyBuildAttestations({ repoRoot: selected.repoRoot, lock, tool });
  return { builds, publishers: verifyPublisherNativeInputs(selected, { tool }) };
}
module.exports = { assertArchive, downloadBuildAttestations, verifyBuildAttestations, prepareSevenZip, prepareDeclaredPublishers, verifyPublisherNativeInputs, verifyProductionInputs };

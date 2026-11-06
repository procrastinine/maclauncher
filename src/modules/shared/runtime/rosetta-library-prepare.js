const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const execute = require('node:util').promisify(require('node:child_process').execFile);
const Bundled = require('./bundled-native'), Rosetta = require('./rosetta');
const { readMachOLoadCommands } = require('./macho-load-commands');
const { fileDigest } = require('./verified-identity');
const { containsPath } = require('../../../core/runtime-coordinator');

// Called only after an explicit installation has reached its final location.
async function prepareInstalledLibraries(selected, installed, { signal, logger, onProgress, architecture } = {}, {
  platform = process.platform, hardwareArch = require('./host-capabilities').getHostCapabilities().hardwareArch,
  rosettaPresent = () => fs.statSync(Rosetta.RUNTIME_PATH, { throwIfNoEntry: false })?.isFile() === true, run = execute,
  helperPath = [process.resourcesPath && path.join(process.resourcesPath, 'rosetta-library-load-x64'),
    path.resolve(__dirname, '../../../resources/rosetta-library-load-x64')].filter(Boolean).find(file => fs.existsSync(file))
} = {}) {
  const target = require('./architecture').normalizeArchitecture(architecture) || require('./architecture').recordArchitecture(installed);
  if (platform !== 'darwin' || hardwareArch !== 'arm64' || target !== 'x64') return;
  let identity;
  try {
    // An optional load must never invoke Rosetta's installer or missing-runtime probe.
    if (!rosettaPresent()) return { rosettaLoad: { status: 'not-loaded', reason: 'Rosetta is not installed.' } };
    const packages = [...selected.resolveDependency?.packages || [], { root: selected.root, declaration: selected.declaration }];
    const roots = packages.map(item => fs.realpathSync(item.root)), files = new Map();
    for (const item of packages) for (const fact of item.declaration.files || []) {
      if (!Bundled.localMachO(fact) || !fact.architectures.includes('x86_64')) continue;
      const file = fs.realpathSync(path.join(item.root, Bundled.relativeFile(fact.path)));
      if (!roots.some(root => containsPath(root, file))) throw new Error('A library is outside its installed package or dependencies.');
      const image = readMachOLoadCommands(file, { architecture: 'x86_64', signal }).slices[0];
      if (image?.fileType === 6) files.set(file, fileDigest(file).sha256);
    }
    const inputs = [...files];
    if (!inputs.length) return { rosettaLoad: { status: 'not-loaded', reason: 'No declared Intel libraries.' } };
    identity = crypto.createHash('sha256').update(JSON.stringify({ archiveSha256: installed.archiveSha256,
      architecture: target, dependencies: packages.slice(0, -1).map(item => [item.record?.id, item.record?.asset?.sha256]), inputs })).digest('hex');
    if (installed.installationMetadata?.rosettaLoad?.identity === identity && installed.installationMetadata.rosettaLoad.status === 'loaded')
      return { rosettaLoad: installed.installationMetadata.rosettaLoad };
    if (!helperPath) throw new Error('The Intel library preparation helper is unavailable.');
    onProgress?.({ phase: 'prepare', detail: 'Loading Intel runtime libraries…' });
    const result = await run(helperPath, inputs.map(([file]) => file), { signal, timeout: 120000, killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024, env: Rosetta.systemEnvironment() });
    const loaded = JSON.parse(result.stdout);
    if (loaded.failed_index !== -1 || loaded.loaded !== inputs.length) throw new Error(loaded.error || 'The Intel libraries were not all loaded.');
    return { rosettaLoad: { identity, status: 'loaded', requested: inputs.length, loaded: loaded.loaded,
      ...(Number.isFinite(loaded.load_ms) ? { loadMs: loaded.load_ms } : {}) } };
  } catch (error) {
    let report;
    try { report = JSON.parse(error.stdout); } catch {}
    const reason = signal?.aborted ? 'Intel library preparation was cancelled.' : typeof report?.error === 'string' ? report.error : error.message;
    require('../graphics-warning')(logger, '[runtime] ' + reason);
    return { rosettaLoad: { ...(identity ? { identity } : {}), status: 'not-loaded', reason,
      ...(Number.isFinite(report?.loaded) ? { loaded: report.loaded } : {}),
      ...(Number.isFinite(report?.failed_index) ? { failedIndex: report.failed_index } : {}),
      ...(Number.isFinite(report?.load_ms) ? { loadMs: report.load_ms } : {}) } };
  }
}
module.exports = { prepareInstalledLibraries };

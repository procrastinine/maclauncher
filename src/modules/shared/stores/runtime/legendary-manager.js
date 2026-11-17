const fs = require('node:fs'), path = require('node:path');
const Core = require('../../../../core/external-store-downloads');
const Native = require('../../runtime/local-native'), Python = require('../../runtime/python');
const { createPinnedNativeManager } = require('../../runtime/pinned-native-manager');
const { fileDigest } = require('../../runtime/verified-identity');
const { confirmToolInstall } = require('../../runtime/tool-install');
const Architecture = require('../../runtime/architecture'), Custom = require('../../runtime/custom-runtime');
const { managerDefaultVersion } = require('../../runtime/version-choices');
const Coordination = require('../../../../core/coordinated-runtime-managers');
const RECEIPT = '.maclauncher-tools.json';
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function createManager(dependencies = {}) {
  const pythonPath = () => dependencies.pythonPath || Python.resolveEmbeddedPythonBinary(Python.resolveEmbeddedPythonRoot());
  const execute = dependencies.execute || Core.launch;
  function inspect({ runtimePath, runtimeVersion, expectedSha256, arch, hostArchitecture, expectedFiles } = {}) {
    const file = fs.statSync(runtimePath).isDirectory() ? path.join(runtimePath, 'legendary/cli.py') : runtimePath;
    if (path.basename(file) !== 'cli.py' || path.basename(path.dirname(file)) !== 'legendary') throw new Error('Select Legendary cli.py or its complete package folder.');
    const root = path.dirname(path.dirname(file));
    for (const relative of ['legendary/cli.py', 'legendary/core.py', 'legendary/__init__.py'])
      if (!fs.lstatSync(path.join(root, relative)).isFile()) throw new Error('The Legendary package is missing ' + relative + '.');
    const metadata = fs.readdirSync(root).filter(name => /^legendary[_-]gl-.*\.dist-info$/i.test(name))
      .map(name => fs.readFileSync(path.join(root, name, 'METADATA'), 'utf8'));
    const version = metadata.map(text => /^Version:\s*(\S+)/m.exec(text)?.[1]).find(Boolean);
    if (!version || metadata.length !== 1 || runtimeVersion && runtimeVersion !== 'custom' && runtimeVersion !== version)
      throw new Error('Legendary requires matching package version metadata.');
    const record = read(path.join(root, RECEIPT));
    const files = Core.legendaryFiles(root), retained = expectedFiles || record?.files;
    if (retained && JSON.stringify(files) !== JSON.stringify(retained)) throw new Error('Legendary package files changed or are incomplete.');
    const native = Native.resolveLocalRuntime({ runtimePath: pythonPath(), runtimeVersion: version, upstreamRevision: 'python',
      arch, hostArchitecture: hostArchitecture || dependencies.hostArch });
    let architectures = native.architectures;
    for (const item of files.filter(item => /\.(?:so|dylib)$/i.test(item.path))) {
      const measured = Native.readMachOArchitectures(path.join(root, item.path), { allowLibrary: true });
      architectures = architectures.filter(cpu => measured.includes(cpu));
    }
    if (!architectures.length) throw new Error('Legendary dependencies do not support the included Python CPU.');
    const digest = fileDigest(file, { noFollow: true });
    if (expectedSha256 && digest.sha256 !== expectedSha256) throw new Error('Legendary cli.py changed; register the package again.');
    return { executablePath: file, pythonPath: pythonPath(), packagesPath: root, architectures, needsRosetta: native.needsRosetta,
      runtimeVersion: version, versionLabel: version, upstreamRevision: 'pypi', sha256: digest.sha256,
      confirmsBuilds: record?.confirmsBuilds !== false, root, payloadRoot: root };
  }
  const discoverCatalog = Object.assign(async options => {
    const python = Core.wheelTool(pythonPath(), execute, options.signal), rows = await Core.LEGENDARY.discover(options), result = [];
    const slices = Native.readMachOArchitectures(pythonPath()), architecture = slices.includes('arm64') && slices.includes('x86_64')
      ? 'universal' : Architecture.normalizeArchitecture(slices[0]);
    for (const row of rows) {
      options.signal?.throwIfAborted();
      const selected = await python({ mode: 'select', allowPrereleases: true, releases: [{ version: row.version,
        files: row.files.map(item => ({ name: item.name, requiresPython: row.details?.requiresPython?.[item.name] || '' })) }] });
      const file = row.files.find(item => item.name === selected?.name && selected.version === row.version);
      if (file) result.push({ version: row.version, upstreamRevision: String(row.revision || row.version), architecture,
        ...(selected.prerelease ? { prerelease: true } : {}),
        asset: require('../../runtime/upstream').asset(file) });
    }
    return result;
  }, { allArchitectures: true });
  const manager = createPinnedNativeManager({ id: 'legendary', label: 'Legendary', discoverCatalog, maxEntries: 2000,
    sourceUrl: 'https://pypi.org/project/legendary-gl/', resolveExecutable: root => path.join(root, 'legendary/cli.py'), inspectRuntime: inspect,
    prepareInstall: async ({ unpacked, pin, signal, onProgress }) => {
      const result = await Core.installLegendary({ parent: path.dirname(unpacked), destination: unpacked,
        firstArchive: path.join(unpacked, '.legendary.whl'), embedded: pythonPath(), execute, signal, onProgress,
        first: { version: pin.version, file: require('../../runtime/upstream').listedFile(pin.asset), source: Core.LEGENDARY } });
      return { confirmsBuilds: result.confirmsBuilds };
    }, dependencies: { extractArchive: async (file, root) => fs.copyFileSync(file, path.join(root, '.legendary.whl')), ...dependencies } });
  manager.ui = { groupId: 'tools', tabLabel: 'Tools', sectionLabel: 'Legendary', order: 100, memberOrder: 171, management: 'managed' };
  Custom.configure(manager, { async prepare(input, context) {
    const installed = inspect({ runtimePath: input, runtimeVersion: 'custom' });
    const base = path.join(context.userDataDir, 'runtimes'); fs.mkdirSync(base, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(base, '.legendary-check-'));
    try {
      const checked = await execute(pythonPath(), ['-c', Core.LEGENDARY_CHECK], { signal: context.signal,
        env: { ...process.env, PYTHONPATH: installed.packagesPath, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', LEGENDARY_CONFIG_PATH: temporary } });
      return { files: Core.legendaryFiles(installed.packagesPath), confirmsBuilds: /^true\b/.test(String(checked.stdout || '').trim()) };
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }, inspect(input, { data } = {}) {
    return { ...inspect({ runtimePath: input, runtimeVersion: 'custom', expectedFiles: data?.files }), ...(data ? { confirmsBuilds: data.confirmsBuilds } : {}) };
  } });
  const prepare = manager.prepareLocalState;
  manager.prepareLocalState = async function(context = {}) {
    await prepare?.call(this, context);
    for (const row of Core.installedLegendary(path.join(context.userDataDir, 'external/tools'))) {
      context.signal?.throwIfAborted();
      try {
        const installed = inspect({ runtimePath: row.packagesPath, runtimeVersion: row.version });
        const architecture = Architecture.normalizeArchitecture(installed.architectures[0]);
        if (!manager.core.resolveInstalled({ userDataDir: context.userDataDir, version: row.version, architecture }) &&
          !fs.existsSync(path.join(manager.core.getInstallDir({ userDataDir: context.userDataDir, version: row.version, architecture }), 'runtime.json')))
          manager.core.registerLocal({ userDataDir: context.userDataDir, version: row.version, runtimePath: installed.executablePath, architecture });
      } catch (error) {
        context.signal?.throwIfAborted();
        context.logger?.warn?.(`[external] Earlier Legendary ${row.version} is unavailable: ${error.message}`);
      }
    }
  };
  manager.ensure = async function(context = {}) {
    await manager.prepareLocalState(context);
    const select = () => {
      const state = manager.getState({ userDataDir: context.userDataDir, settings: context.settings?.runtimes?.[manager.id] });
      const installed = state.installed.filter(row => row.ready && row.confirmsBuilds).map(row => row.version);
      const compatible = context.requiresConfirmedBuilds && state.defaultSource === 'manager' && installed.length
        ? managerDefaultVersion({ listed: state.catalog?.versions || [], installed }) : null;
      return manager.resolveSelection({}, context.settings, context.userDataDir, { version: context.version || compatible });
    };
    let selected = select();
    if (!selected.ready) {
      await confirmToolInstall(context, { manager, version: selected.version, requiresDownload: true, detail: 'Required for this Epic Games Store action.' });
      if (!selected.version || selected.discoveryRequired) await manager.refreshCatalog({ ...context, force: false });
      context.signal?.throwIfAborted(); selected = select();
      if (!selected.version) throw new Error('PyPI lists no Legendary release for the included Python.');
      const installed = await manager.installRuntime({ ...context, version: selected.version, automatic: selected.automatic });
      context.onRuntimeStateChange?.(); return { ...installed, managerId: manager.id };
    }
    return { ...selected.install, managerId: manager.id };
  };
  Coordination.instrumentRuntimeManagers([manager]);
  const remove = manager.uninstallRuntime;
  manager.uninstallRuntime = async function(context = {}) {
    return Coordination.withRuntimeMutation({ managerId: manager.id, version: context.version }, async () => {
      const installed = manager.core.resolveInstalled(context);
      const legacy = installed && Core.installedLegendary(path.join(context.userDataDir, 'external/tools')).find(row => path.join(row.packagesPath, 'legendary/cli.py') === installed.runtimePath);
      const result = await remove.call(this, context);
      if (result !== false && legacy) fs.rmSync(legacy.packagesPath, { recursive: true, force: true });
      return result;
    }, { userDataDir: context.userDataDir, coordinator: context.runtimeCoordinator });
  };
  return manager;
}
module.exports = Object.assign(createManager(), { createManager });

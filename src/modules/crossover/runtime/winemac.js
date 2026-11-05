const Architecture = require('../../shared/runtime/architecture');
const { createProjectBuildManager } = require('../../shared/runtime/project-build-manager');
const Bundled = require('../../shared/runtime/bundled-native');
const { compareRuntimeVersions } = require('../../shared/runtime/pinned-native-manager');

const id = 'maclauncher-crossover-winemac';
function matches(profile, installation) {
  return profile?.product === 'CrossOver' && typeof profile.version === 'string' && typeof profile.build === 'string' &&
    profile.version === installation?.upstreamVersion && profile.build === installation?.buildVersion;
}
function capabilities(value) { return value?.projectPackage?.capabilities || value?.capabilities || value; }
function create({ dependencies = {}, applications = userDataDir => require('./manager').core.listInstalled(userDataDir) } = {}) {
  const base = createProjectBuildManager({ projectId: id, label: 'CrossOver graphics integration',
    repository: 'procrastinine/maclauncher-builds', manifestRelative: 'manifest.json', sourceRelative: 'provenance.json',
    executableRelative: manifest => manifest.libraries['x86_64-unix'], nativeLibrary: true, supportsDefault: false,
    validateManifest(manifest) {
      const facts = manifest.capabilities;
      if (facts?.role !== 'crossover-vulkan-driver' || facts.optional !== true ||
          !matches(facts.runtimeProfile, { upstreamVersion: manifest.runtimeProfile?.version, buildVersion: manifest.runtimeProfile?.build }) ||
          facts.libraries?.['x86_64-unix'] !== manifest.libraries?.['x86_64-unix'])
        throw new Error('The CrossOver integration package has no matching release declaration.');
    },
    async verifyPayload(selected) { Bundled.verifyPayload(selected.root, selected.declaration, selected.resolveDependency); }, dependencies });
  const options = { architecture: 'x64' };
  const rows = userDataDir => Architecture.withArchitecture('x64', () => base.core.listInstalled(userDataDir)).map(row => {
    const selected = base.resolveSelection(null, {}, userDataDir, { ...options, version: row.version });
    return selected.ready ? selected.install : null;
  }).filter(Boolean);
  function installed(installation, userDataDir) {
    return rows(userDataDir).filter(row => matches(row.manifest.capabilities.runtimeProfile, installation))
      .sort((a, b) => compareRuntimeVersions(a.version, b.version))[0] || null;
  }
  const manager = { ...base, ui: { hidden: true }, distributionRequired: false };
  async function prune(userDataDir) {
    const registered = applications(userDataDir);
    // An unavailable registered application has no observable release. Retain
    // its package until that application is available or unregistered.
    if (registered.some(row => row.ready === false)) return;
    const retained = new Set();
    for (const installation of registered) {
      const current = installed(installation, userDataDir);
      if (current) retained.add(current.version);
    }
    for (const row of rows(userDataDir)) if (!retained.has(row.version)) {
      try {
        await require('../../../core/coordinated-runtime-managers').withRuntimeMutation(
          { managerId: id, version: row.version, sourcePath: row.installDir },
          () => manager.uninstallRuntime({ userDataDir, version: row.version, ...options }), { userDataDir });
      } catch (error) { if (error.code !== 'RUNTIME_IN_USE') throw error; }
    }
  }
  async function requirements(entry, context) {
    try { await prune(context.userDataDir); }
    catch (error) { if (context.signal?.aborted) throw error; }
    const plan = context.translatorPlan;
    if (plan?.runtime !== 'crossover' || !plan.components?.['vulkan-driver']?.used) return [];
    const installation = context.wineEnvironment?.install || require('./manager').resolveSelection(entry, context.settings, context.userDataDir, context.runtimeSettings).install;
    if (!installation?.buildVersion) return [];
    const current = installed(installation, context.userDataDir);
    if (current) return [];
    const pin = base.core.listDiscoveredCatalog({ userDataDir: context.userDataDir })
      .filter(pin => matches(capabilities(pin).runtimeProfile, installation))
      .sort((a, b) => compareRuntimeVersions(a.version, b.version))[0];
    if (!pin && base.getState({ userDataDir: context.userDataDir }).catalog?.status === 'success') return [];
    return [{ managerId: id, version: pin?.version || null, ...(!pin ? { discoveryRequired: true } : {}),
      installOptions: options, optional: true, silentFallback: true, groupConsent: true,
      label: manager.label, ...(pin?.asset?.bytes ? { bytes: pin.asset.bytes } : {}) }];
  }
  async function select(installation, context) {
    try {
      if (context.translatorPlan?.runtime !== 'crossover' || !context.translatorPlan.components?.['vulkan-driver']?.used ||
          context.translatorPlan.layout?.unixName !== 'x86_64-unix') return null;
      const current = installed(installation, context.userDataDir);
      if (!current) return null;
      const selected = manager.resolveSelection(null, context.settings, context.userDataDir, { ...options, version: current.version, verification: 'full' });
      if (!selected.ready || !matches(selected.install.manifest.capabilities.runtimeProfile, installation)) return null;
      Bundled.verifyPayload(selected.install.root, selected.install.declaration, selected.install.resolveDependency);
      await context.useRuntime?.({ managerId: id, version: current.version, sourcePath: selected.install.installDir });
      return { path: selected.install.executablePath, sha256: selected.install.manifest.files.find(file => file.path === selected.install.manifest.libraries['x86_64-unix'])?.sha256 };
    } catch (error) { if (context.signal?.aborted) throw error; return null; }
  }
  const refresh = manager.refreshCatalog;
  manager.refreshCatalog = async function (input = {}) { await prune(input.userDataDir); return refresh.call(this, input); };
  const install = manager.installRuntime;
  manager.installRuntime = async function (input = {}) {
    const result = await install.call(this, input);
    await prune(input.userDataDir);
    return result;
  };
  return Object.assign(manager, { requirements, select, prune, matches });
}
module.exports = Object.assign(create(), { create, matches });

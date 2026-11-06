const path = require('node:path');
const Architecture = require('../../shared/runtime/architecture');
const { createProjectBuildManager } = require('../../shared/runtime/project-build-manager');
const Bundled = require('../../shared/runtime/bundled-native');
const { compareRuntimeVersions } = require('../../shared/runtime/pinned-native-manager');
const { readJsonObject, writeJsonAtomic } = require('../../../core/json-files');

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
  // Installed packages are listed by their records; the graphics loader
  // checks the bytes of the library that a launch links.
  const rows = userDataDir => Architecture.withArchitecture('x64', () => base.core.listInstalled(userDataDir)).map(row => {
    const selected = base.resolveSelection(null, {}, userDataDir, { ...options, version: row.version, verification: 'status' });
    return selected.ready ? selected.install : null;
  }).filter(Boolean);
  function installed(installation, list) {
    return list.filter(row => matches(row.manifest.capabilities.runtimeProfile, installation))
      .sort((a, b) => compareRuntimeVersions(a.version, b.version))[0] || null;
  }
  // A declined or failed download is remembered for its CrossOver release and
  // build, so Play offers it again only for another release or after an
  // explicit CrossOver Refresh.
  const skippedFile = userDataDir => path.join(userDataDir, 'runtimes', 'crossover-graphics-integration-skipped.json');
  const releaseKey = installation => JSON.stringify([installation?.upstreamVersion, installation?.buildVersion]);
  function skippedReleases(userDataDir) {
    const releases = userDataDir && readJsonObject(skippedFile(userDataDir))?.releases;
    return Array.isArray(releases) ? releases.filter(value => typeof value === 'string') : [];
  }
  function keepSkipped(userDataDir, releases) {
    if (releases.length || skippedReleases(userDataDir).length) writeJsonAtomic(skippedFile(userDataDir), { schemaVersion: 1, releases: [...new Set(releases)] });
  }
  function skipOptional(plan, { userDataDir } = {}) {
    if (!userDataDir || !plan?.release) return;
    keepSkipped(userDataDir, [...skippedReleases(userDataDir), releaseKey({ upstreamVersion: plan.release.version, buildVersion: plan.release.build })]);
  }
  function clearSkipped(userDataDir) { if (userDataDir) keepSkipped(userDataDir, []); }
  const manager = { ...base, ui: { hidden: true, management: 'managed' }, distributionRequired: false };
  // One package is kept for each registered CrossOver release: the newest
  // revision. Nothing is inspected while no package is installed.
  async function prune(userDataDir) {
    const list = rows(userDataDir), skipped = skippedReleases(userDataDir);
    if (!list.length && !skipped.length) return;
    const registered = applications(userDataDir);
    // An unavailable registered application has no observable release. Retain
    // its package until that application is available or unregistered.
    if (registered.some(row => row.ready === false)) return;
    const releases = new Set(registered.map(releaseKey));
    if (skipped.some(release => !releases.has(release))) keepSkipped(userDataDir, skipped.filter(release => releases.has(release)));
    const retained = new Set(registered.map(installation => installed(installation, list)?.version).filter(Boolean));
    for (const row of list) if (!retained.has(row.version)) {
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
    if (installed(installation, rows(context.userDataDir)) || skippedReleases(context.userDataDir).includes(releaseKey(installation))) return [];
    const pin = base.core.listDiscoveredCatalog({ userDataDir: context.userDataDir })
      .filter(pin => matches(capabilities(pin).runtimeProfile, installation))
      .sort((a, b) => compareRuntimeVersions(a.version, b.version))[0];
    if (!pin && base.getState({ userDataDir: context.userDataDir }).catalog?.status === 'success') return [];
    const size = pin?.asset?.bytes > 0 ? ` Download size: ${Math.max(0.1, pin.asset.bytes / 1048576).toFixed(1)} MB.` : '';
    const summary = `Adds Vulkan external memory, semaphore and fence sharing to CrossOver ${installation.upstreamVersion} (build ${installation.buildVersion}).`;
    return [{ managerId: id, version: pin?.version || null, ...(!pin ? { discoveryRequired: true } : {}),
      installOptions: options, optional: true, silentFallback: true, companion: true,
      release: { version: installation.upstreamVersion, build: installation.buildVersion },
      label: manager.label, ...(pin?.asset?.bytes ? { bytes: pin.asset.bytes } : {}), summary, cancelLabel: 'Play Without It',
      detail: `${summary}${size} ${entry?.name || 'The game'} also starts without it, with CrossOver's own Mac driver.` }];
  }
  async function select(installation, context) {
    try {
      if (context.translatorPlan?.runtime !== 'crossover' || !context.translatorPlan.components?.['vulkan-driver']?.used ||
          context.translatorPlan.layout?.unixName !== 'x86_64-unix') return null;
      const current = installed(installation, rows(context.userDataDir));
      if (!current) return null;
      await context.useRuntime?.({ managerId: id, version: current.version, sourcePath: current.installDir });
      return { path: current.executablePath, sha256: current.manifest.files.find(file => file.path === current.manifest.libraries['x86_64-unix'])?.sha256 };
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
  return Object.assign(manager, { requirements, select, prune, matches, skipOptional, clearSkipped });
}
module.exports = Object.assign(create(), { create, matches });

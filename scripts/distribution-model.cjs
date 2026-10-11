// One offline model for runtime delivery and application resource selection.
const B = require('../src/modules/shared/runtime/bundled-native');

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function configuration({ arch, maximumMacOS }) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Choose an explicit launcher architecture: arm64 or x64.');
  if (typeof maximumMacOS !== 'string' || !/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(maximumMacOS)) throw new Error('An explicit maximum native-runtime macOS floor is required.');
  return { arch, maximumMacOS };
}
function managers(dependencies) {
  return dependencies?.managers ? dependencies.managers() : require('./stage-native-runtimes.cjs').managers();
}
function requiresDistribution(manager) {
  // Source/build availability is not a request to ship a binary. Included
  // packages are selected explicitly under the download-first policy.
  return manager?.distributionRequired === true;
}
function distributionArchitectures(manager, requestedArch) {
  if (!['arm64', 'x64'].includes(requestedArch)) throw new Error('Unsupported launcher distribution architecture.');
  const mapping = manager.distributionArchitectures;
  if (mapping === undefined) return [requestedArch];
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.entries(mapping).some(([host, targets]) =>
    !['arm64', 'x64'].includes(host) || !Array.isArray(targets) || targets.length > 2 ||
    targets.some(target => !['arm64', 'x64'].includes(target)) || new Set(targets).size !== targets.length) ||
    !Object.values(mapping).some(targets => targets.length) || !Object.hasOwn(mapping, requestedArch)) {
    throw new Error('Runtime distribution needs an explicit supported host-to-artifact architecture mapping.');
  }
  return mapping[requestedArch];
}
function requiredVersions(manager) {
  const versions = manager.distributionVersions;
  if (!Array.isArray(versions) || !versions.length || new Set(versions).size !== versions.length ||
      versions.some(version => typeof version !== 'string' || !VERSION.test(version) || !manager.core?.catalog?.some(pin => pin.version === version))) {
    throw new Error(`${manager.id}: required package versions are missing, ambiguous or outside its pinned catalog.`);
  }
  return versions;
}
function nativeRequirements(config, dependencies) {
  configuration(config);
  const result = [];
  for (const manager of managers(dependencies).values()) {
    if (!requiresDistribution(manager)) continue;
    const versions = requiredVersions(manager);
    for (const arch of distributionArchitectures(manager, config.arch)) for (const version of versions) {
      const pin = manager.core.catalog.find(item => item.version === version);
      result.push({ managerId: manager.id, version, arch, upstreamRevision: pin.upstreamRevision });
    }
  }
  if (!result.length) throw new Error('No required native managers were discovered.');
  return result.sort((a, b) => `${a.managerId}/${a.version}/${a.arch}`.localeCompare(`${b.managerId}/${b.version}/${b.arch}`));
}
function createPlan({ arch, maximumMacOS, packageConfig = require('../package.json'), dependencies } = {}) {
  const config = configuration({ arch, maximumMacOS }), catalog = managers(dependencies);
  const packages = nativeRequirements(config, { ...dependencies, managers: () => catalog })
    .map(item => ({ ...item, directoryRelative: `${item.managerId}/${item.version}/${item.arch}` }));
  const supplementals = require('./native-supplementals.cjs').requirements(config, dependencies);
  const sourceArtifacts = require('./native-source-artifacts.cjs').requirements(packages, catalog, supplementals);
  const runtimes = [...catalog.values()].map(manager => {
    const pins = manager.core?.catalog || [], included = packages.filter(item => item.managerId === manager.id);
    return { managerId: manager.id, includedVersions: [...new Set(included.map(item => item.version))].sort(),
      includedExecution: included.length ? manager.delivery?.included || manager.bundledExecution || 'managed' : 'none',
      download: { pinnedVersions: pins.filter(pin => pin.asset || pin.publishedBinary || pin.packages).map(pin => pin.version).sort(),
        catalogQuery: manager.delivery?.catalog === 'remote' || typeof manager.core?.fetchAvailableVersions === 'function',
        authenticatedUpdatesOptional: manager.delivery?.authenticatedUpdatesOptional === true },
      import: typeof manager.importRuntime === 'function', localRegistration: typeof manager.core?.registerLocal === 'function',
      sourceBuild: manager.delivery?.sourceBuild === true,
      refresh: typeof manager.refreshCatalog === 'function' };
  }).sort((a, b) => a.managerId.localeCompare(b.managerId));
  const modules = dependencies?.modules ? dependencies.modules() : dependencies?.managers ? [] : require('../src/modules/registry').listModules();
  const gameHosts = modules.flatMap(info => (info.runtime?.supported || []).map(runtimeId => ({ moduleId: info.id, runtimeId,
    managerId: typeof info.runtime.manager === 'string' ? info.runtime.manager : info.runtime.manager?.[runtimeId] || null })))
    .sort((a, b) => `${a.moduleId}/${a.runtimeId}`.localeCompare(`${b.moduleId}/${b.runtimeId}`));
  const plan = { schemaVersion: 1, product: packageConfig.build.productName, version: packageConfig.version,
    platform: 'darwin', launcherArch: arch, launcherMinimumMacOS: packageConfig.build.mac.minimumSystemVersion,
    maximumNativeMacOS: maximumMacOS, packages, supplementals, sourceArtifacts, runtimes, gameHosts,
    resourceMappings: packageConfig.build.extraResources.map(rule => ({ from: rule.from, to: rule.to })),
    distributionBlockers: supplementals.filter(item => item.redistribution === 'local-only')
      .map(item => ({ resource: item.directoryRelative, reason: 'This native resource is restricted to local use.' })) };
  // Builder filters remain executable configuration, not release metadata.
  Object.defineProperty(plan, 'resourceRules', { value: packageConfig.build.extraResources, enumerable: false });
  for (const rule of plan.resourceRules) {
    if (!rule || typeof rule.from !== 'string' || B.relativeFile(rule.from) !== rule.from ||
        typeof rule.to !== 'string' || rule.to !== '.' && B.relativeFile(rule.to) !== rule.to || !Array.isArray(rule.filter)) {
      throw new Error('Application resources require relative source/destination paths and explicit filters.');
    }
  }
  const { resourceRules: filters, ...publicPlan } = plan;
  require('./native-supplementals.cjs').validatePublicMetadata(publicPlan);
  return plan;
}
function assertPublishable(plan) {
  if (plan.distributionBlockers.length) throw new Error(`Native resources restricted to local use cannot be packaged: ${plan.distributionBlockers.map(item => item.resource).join(', ')}.`);
  return plan;
}
function resourceRules(plan, rules = plan.resourceRules) {
  const selected = [...plan.packages.map(item => item.directoryRelative), ...plan.supplementals.map(item => item.directoryRelative)]
    .sort().map(directory => `native-runtimes/${directory}/**`);
  let found = false;
  const result = rules.map(rule => {
    if (rule.from !== 'src/resources' || rule.to !== '.' && rule.to !== undefined) return rule;
    if (!Array.isArray(rule.filter) || !rule.filter.some(pattern => pattern.startsWith('native-runtimes/'))) throw new Error('Native application resources need an explicit resource rule.');
    found = true;
    return { ...rule, filter: [...selected, ...rule.filter.filter(pattern => !pattern.startsWith('native-runtimes/'))] };
  });
  if (!found) throw new Error('Native application resources are not configured.');
  return result;
}

module.exports = { configuration, managers, requiresDistribution, distributionArchitectures, requiredVersions,
  nativeRequirements, createPlan, assertPublishable, resourceRules };

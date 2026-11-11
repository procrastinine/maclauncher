const Architecture = require("./architecture");
const ReadPass = require("./read-pass");
const { architectureSupport } = require("./host-capabilities");
const { selectRuntimeVersion } = require("./version-choices");
const ARCHITECTURES = ["arm64", "x64"];
const variantArchitecture = value => typeof value === "string" && value.startsWith("architecture:")
  ? Architecture.normalizeArchitecture(value.slice(13)) : null;

// Each CPU has its own catalog and installation identities. The facade keeps
// the manager API shared while an explicit build choice travels with an action.
function createArchitectureManager(config, createManager) {
  const instances = new Map();
  const discoveries = new Map();
  const shareDiscovery = (discover, complete = false) => options => {
    const key = JSON.stringify([options.sourceId, options.latestOnly]);
    const architecture = options.arch;
    if (!discoveries.has(key)) discoveries.set(key, {architecture, promise: Promise.resolve(discover(options))});
    const discovered = discoveries.get(key);
    return discovered.architecture === architecture ? discovered.promise : discovered.promise.then(rows => {
      if (complete === true || options.sourceId === "builds" || discover.allArchitectures === true) return rows;
      const cpus = new Set(rows.flatMap(row => Architecture.recordArchitecture(row) === "universal" ? ARCHITECTURES
        : Architecture.recordArchitecture(row) ? [Architecture.recordArchitecture(row)] : row.hostArchitectures || []));
      return cpus.size === 0 || cpus.has(architecture) ? rows : discover(options);
    });
  };
  let facade;
  let customRuntimeOverrides;
  function instance(architecture) {
    if (!instances.has(architecture)) {
      const manager = Architecture.withArchitecture(architecture,
        () => createManager({ ...config, installationArchitecture: architecture, shareDiscovery,
          ...(config.buildRuntime ? {buildRuntime: args => config.buildRuntime({...args, manager: facade})} : {}) }));
      instances.set(architecture, manager);
      if (customRuntimeOverrides) require("./custom-runtime").configure(manager, customRuntimeOverrides);
    }
    return instances.get(architecture);
  }
  const current = Architecture.selectedArchitecture();
  const primary = instance(current);
  facade = { ...primary };
  facade.configureCustomRuntime = ({ providers, ...overrides }) => {
    customRuntimeOverrides = { ...customRuntimeOverrides, ...overrides };
    for (const manager of instances.values()) require("./custom-runtime").configure(manager, customRuntimeOverrides);
  };
  const selected = payload => Architecture.requestedArchitecture(payload) || Architecture.selectedArchitecture();
  // A CPU offers a build when its list or its installations hold one this Mac
  // can use; a manager's included packages count through `includedBuilds`.
  const offers = options => architecture => typeof instance(architecture).offersBuild !== "function" ||
    Boolean(call(architecture, "offersBuild", [options]) ||
      typeof config.includedBuilds === "function" && Architecture.withArchitecture(architecture, () => config.includedBuilds(options)));
  const runtimeSettings = settings => !settings || settings.runtimes ? settings : { runtimes: { [config.id]: settings } };
  // Play, Runtimes and the inspector share this choice: an explicit request,
  // then saved CPU choices, then an installed copy of the selected version,
  // then the launcher's catalog CPU or another CPU this Mac runs.
  facade.chooseArchitecture = (entry, settings, userDataDir, options = {}) => {
    const configured = runtimeSettings(settings);
    let version = selectRuntimeVersion({ manual: options.version,
      recommended: entry?.runtimeData?.[config.runtimeId || config.id]?.version,
      defaultVersion: configured?.runtimes?.[config.id]?.defaultVersion }).version;
    if (!version) {
      const automatic = Architecture.chooseArchitecture({ request: options, entry, settings: configured, managerId: config.id,
        launcher: current, offers: offers({ userDataDir }), host: config.dependencies?.hostCapabilities });
      if (typeof instance(automatic).resolveSelection === "function")
        version = call(automatic, "resolveSelection", [entry, settings, userDataDir, { ...options, verification: "status" }])?.version;
    }
    return Architecture.chooseArchitecture({ request: options, entry,
      saved: entry?.runtimeData?.[config.runtimeId || config.id]?.architecture,
      settings: configured, managerId: config.id, launcher: current, offers: offers({ userDataDir }),
      ...(version ? { installed: architecture => {
        if (typeof instance(architecture).resolveSelection !== "function") return false;
        const selection = call(architecture, "resolveSelection", [entry, settings, userDataDir,
          { ...options, version, verification: "status" }]);
        return selection?.ready === true && Boolean(selection.install) && Architecture.matchesArchitecture(selection.install, architecture);
      } } : {}), host: config.dependencies?.hostCapabilities });
  };
  facade.offersBuild = (options = {}) => offers(options)(selected(options));
  facade.launcherArchitecture = current;
  const call = (architecture, method, args) => Architecture.withArchitecture(architecture,
    () => instance(architecture)[method](...args));
  facade.core = new Proxy(primary.core, {get(_target, key) {
    const architecture = Architecture.selectedArchitecture(), core = instance(architecture).core;
    const value = core[key];
    return typeof value === "function" ? (...args) => {
      const requested = Architecture.requestedArchitecture(args[0]) || architecture, target = instance(requested).core;
      return Architecture.withArchitecture(requested, () => requested === architecture ? value.apply(core, args) : target[key](...args));
    } : value;
  }});
  const tagged = (row, architecture) => ({ ...Architecture.tagInstall(row, architecture), variant: row.variant || `architecture:${architecture}` });
  facade.getState = (options = {}) => ReadPass.within(() => stateOfAll(options));
  function stateOfAll(options) {
    const states = ARCHITECTURES.map(architecture => ({ architecture, state: call(architecture, "getState", [options]) }));
    // The automatic list is the one Play uses without a saved build choice.
    const automatic = facade.chooseArchitecture(null, null, options.userDataDir);
    const initial = states.find(item => item.architecture === automatic).state;
    function merge(section, sectionId) {
      const rows = states.map(item => ({ architecture: item.architecture,
        section: sectionId ? item.state.sections?.find(section => section.id === sectionId) : item.state }));
      const installed = rows.flatMap(({architecture, section}) => (section?.installed || []).map(row => tagged(row, architecture)));
      const unique = installed.filter((row, index) => installed.findIndex(other =>
        other.installDir && other.installDir === row.installDir || !other.installDir && other.version === row.version && other.architecture === row.architecture) === index);
      const architectureCatalogs = Object.fromEntries(rows.filter(row => row.section?.catalog).map(row => [row.architecture,
        { ...row.section.catalog, architecture: row.architecture }]));
      return { ...section, launcherArchitecture: current, automaticArchitecture: automatic,
        defaultArchitecture: Architecture.targetArchitecture(options.settings?.defaultArchitecture) || automatic, installed: unique,
        catalog: section.catalog ? { ...section.catalog, architecture: automatic, architectureCatalogs } : section.catalog };
    }
    return { ...merge(initial), sections: initial.sections?.map(section => merge(section, section.id)) };
  }
  for (const method of ["refreshCatalog", "installRuntime", "uninstallRuntime", "importRuntime", "registerCustomRuntime", "performInstalledAction", "performSetupAction"]) {
    if (typeof primary[method] !== "function") continue;
    facade[method] = (payload = {}, ...args) => {
      // An installation without a build choice uses the build Play would use.
      const architecture = method === "installRuntime" && !Architecture.requestedArchitecture(payload) && Architecture.selectedArchitecture() === current
        ? facade.chooseArchitecture(null, payload.settings, payload.userDataDir, { version: payload.version }) : selected(payload);
      const next = { ...payload, architecture,
        ...(variantArchitecture(payload.variant) ? { variant: undefined } : {}) };
      return call(architecture, method, [next, ...args]);
    };
  }
  facade.refreshCatalog = async (payload = {}) => {
    try {
      const results = await Promise.allSettled(ARCHITECTURES.map(architecture => call(architecture, "refreshCatalog", [{...payload, architecture}])));
      const result = results[ARCHITECTURES.indexOf(selected(payload))];
      if (result.status === "rejected") throw result.reason;
      return result.value;
    } finally { discoveries.clear(); }
  };
  facade.resolveSelection = (entry, settings, userDataDir, options = {}) => ReadPass.within(() => {
    const architecture = facade.chooseArchitecture(entry, settings, userDataDir, options);
    const result = call(architecture, "resolveSelection", [entry, settings, userDataDir, options]);
    if (!result?.install) return { ...result, architecture };
    const actual = Architecture.recordArchitecture(result.install) || architecture;
    const support = architectureSupport(actual);
    return { ...result, architecture, install: tagged(result.install, architecture),
      ...(support.supported ? { requiresRosetta: Architecture.requiresRosetta(actual) } : { ready: false, reason: support.reason }) };
  });
  facade.normalizeSettings = settings => ({ ...primary.normalizeSettings(settings),
    ...(Architecture.targetArchitecture(settings?.defaultArchitecture) ? { defaultArchitecture: Architecture.targetArchitecture(settings.defaultArchitecture) } : {}) });
  facade.applySettingsUpdate = (action, payload, settings, options = {}) => {
    // A version from the automatic list keeps the build choice automatic; one
    // from another CPU's list saves that CPU as the manager's build choice.
    const automatic = action === "setDefault" && payload?.version ? facade.chooseArchitecture(null, null, options.userDataDir) : current;
    const architecture = Architecture.requestedArchitecture(payload) || (action === "setDefault" && payload?.version ? automatic : selected(payload));
    const result = call(architecture, "applySettingsUpdate", [action, payload, settings, options]);
    return action === "setDefault" && payload?.version && architecture !== automatic ? { ...result, defaultArchitecture: architecture }
      : action === "setDefault" ? (({defaultArchitecture, ...rest}) => rest)(result) : result;
  };
  return facade;
}
module.exports = { createArchitectureManager };

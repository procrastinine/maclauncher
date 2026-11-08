const fs = require("node:fs"), path = require("node:path");
const { managers, definitions, inspect } = require("./libraries");
const { hashFile, compareRuntimeVersions } = require("../runtime/pinned-native-manager");
const { readMachOLoadCommands } = require("../runtime/macho-load-commands");
const managed = require("./managed");
const Custom = require("../runtime/custom-runtime");
const Architecture = require("../runtime/architecture");
const Requirements = require("../runtime/feature-requirements");
const Host = require("../runtime/host-capabilities");

function unavailableReason(backend, dependencies) {
  if (backend !== "kosmickrisp" && backend !== managed.projectId) return null;
  const support = Requirements.requirementSupport(Requirements.METAL4, dependencies.hostCapabilities || Host.getHostCapabilities());
  return support.supported === false ? support.reason : null;
}
// The Intel KosmicKrisp offer names its build. Settings entries share their
// consumer's CPU (dependencies.architecture, the slice installed() checked),
// so they do not repeat it.
function offerLabel(label, dependencies) {
  return label + " (" + Architecture.architectureLabel(dependencies.architecture || Architecture.selectedArchitecture()) + ")";
}
function consumerContext(context, dependencies, projectId) {
  if (!dependencies.architecture) return context;
  return { ...context, settings: { ...context.settings, runtimes: { ...context.settings?.runtimes,
    [projectId]: { ...context.settings?.runtimes?.[projectId], defaultArchitecture: dependencies.architecture } } } };
}
// The saved Vulkan choice of a consumer; a value that is not a choice is Automatic.
function savedChoice(context) {
  const saved = context.runtimeSettings?.vulkanRuntime;
  return typeof saved === "string" && saved ? saved : "auto";
}
// Whether every source of a completed catalog refresh answered for this CPU
// and listed no build. A catalog never fetched, or a source that failed, leaves
// the answer to consented discovery.
function catalogListsNoBuild(manager, context, architecture) {
  const state = manager.getState({ userDataDir: context.userDataDir, settings: context.settings?.runtimes?.[manager.id] });
  const catalog = state.catalog?.architectureCatalogs?.[architecture] || state.catalog;
  if (!catalog || (catalog.installableVersions || catalog.versions || []).length) return false;
  const sources = Object.values(catalog.sourceStates || {});
  return (sources.length ? sources : [catalog]).every(source => source?.status === "success" && Number.isFinite(source.fetchedAt));
}
function managedSelection(provider, context, dependencies, version, available) {
  const manager = dependencies.adaptedManager || provider.manager;
  const options = { version, verification: "status", ...(dependencies.architecture ? { architecture: dependencies.architecture } : {}) };
  const selection = manager.resolveSelection(null, context.settings, context.userDataDir, options);
  if (version || !dependencies.architecture) return selection;
  // An unversioned library choice belongs to the consuming process. A runtime
  // this Mac can execute may still have no library slice for that process.
  const usable = (available || installed(context, dependencies)).filter(item => item.projectId === provider.projectId);
  const present = usable.find(item => item.version === selection.version);
  if (present) return present.version === selection.version ? selection
    : manager.resolveSelection(null, context.settings, context.userDataDir, { ...options, version: present.version });
  const state = manager.getState({ userDataDir: context.userDataDir, settings: context.settings?.runtimes?.[manager.id] });
  const catalog = state.catalog?.architectureCatalogs?.[dependencies.architecture] || state.catalog;
  const pins = manager.core.listCatalog({ userDataDir: context.userDataDir, architecture: dependencies.architecture });
  const listed = catalog?.installableVersions || catalog?.versions || [];
  const candidates = listed.filter(value => {
    const pin = pins.find(item => item.version === value);
    return pin && !pin.deprecated && !pin.installReason && Architecture.matchesArchitecture(pin, dependencies.architecture) &&
      !catalog.versionRequirements?.[value]?.installReason;
  });
  // Keep a compatible saved/default version even if another version is
  // installed. Only a wrong-CPU choice gives way to a different version.
  const selectedVersion = candidates.includes(selection.version) ? selection.version
    : usable[0]?.version || candidates.sort(compareRuntimeVersions)[0];
  if (!selectedVersion) return { ...selection, version: null, ready: false, install: null, discoveryRequired: !listed.length };
  return selectedVersion === selection.version ? selection
    : manager.resolveSelection(null, context.settings, context.userDataDir, { ...options, version: selectedVersion });
}

function installed(context, dependencies = {}) {
  const result = [];
  for (const manager of dependencies.managers || managers) {
    if (unavailableReason(manager.backend, dependencies)) continue;
    const managerId = manager.id || "vulkan-" + manager.backend, preferred = Custom.defaultVersion(context.settings, managerId);
    const versions = Architecture.withArchitecture(dependencies.architecture || Architecture.selectedArchitecture(),
      () => manager.core.listInstalled(context.userDataDir))
      .sort((a, b) => Number(b.version === preferred) - Number(a.version === preferred));
    for (const install of versions) {
    try {
      const root = fs.realpathSync(install.installDir), definition = definitions[manager.backend];
      const files = install.installationMetadata?.libraries;
      if (!Array.isArray(files) || !files.length) continue;
      const readable = files.map(item => {
        if (path.basename(item.file) !== item.file) throw new Error("Invalid native library path.");
        const file = fs.realpathSync(path.join(root, item.file));
        if (path.dirname(file) !== root) throw new Error("Native library escaped its installation.");
        inspect(file, dependencies);
        if (file !== install.executablePath && hashFile(file) !== item.sha256) throw new Error("Native library differs from its installation.");
        return file;
      });
      const library = manager.backend === "kosmickrisp" ? path.join(root, "libvulkan.1.dylib") : install.custom ? install.executablePath : path.join(root, definition.library);
      const driver = install.custom ? install.executablePath : path.join(root, definition.library);
      if (!readable.includes(library) || !readable.includes(driver)) continue;
      result.push({ id: manager.backend + ":" + install.version, backend: manager.backend, version: install.version,
        label: install.versionLabel || install.catalogEntry?.versionLabel || definition.label + " " + install.version, library, driver, readable });
    } catch (error) { if (dependencies.signal?.aborted) throw error; }
    }
  }
  const adapted = dependencies.adapted ? [{ provider: dependencies.adapted, projectId: managed.projectId }] : managed.providers;
  for (const item of adapted.flatMap(({ provider, projectId }) => provider.installed(consumerContext(context, dependencies, projectId)))) {
    if (unavailableReason(item.backend, dependencies)) continue;
    try {
      if (dependencies.architecture) for (const file of item.readable) readMachOLoadCommands(file, dependencies);
      result.push(item);
    } catch (error) { if (dependencies.signal?.aborted) throw error; }
  }
  return dependencies.preferredBackend ? result.sort((a, b) => Number(b.backend === dependencies.preferredBackend) - Number(a.backend === dependencies.preferredBackend)) : result;
}
function choices(context, dependencies = {}) {
  const available = installed(context, dependencies);
  const rows = available.map(item => ({ value: item.id, label: item.label }));
  const request = savedChoice(context);
  if (request !== "auto" && !rows.some(row => row.value === request)) {
    const owner = managed.providers.find(item => item.selectionId === request || request.startsWith(item.prefix));
    const backend = owner ? owner.selectionId.split(":")[0] : request.split(":")[0];
    const unversioned = owner?.selectionId === request || request === backend + ":auto";
    const selected = unversioned && available.find(item => owner ? item.projectId === owner.projectId : item.backend === backend && !item.projectId);
    if (selected) rows.find(row => row.value === selected.id).value = request;
    else {
      const version = unversioned ? "" : owner ? request.slice(owner.prefix.length) : request.slice(backend.length + 1);
      const label = (owner?.manager.label || definitions[backend]?.label || backend) + (version ? " " + version : "");
      if (!rows.some(row => row.value === request)) rows.push({ value: request, label: label + " (not installed)" });
    }
  }
  return { vulkanRuntimes: [{ value: "auto", label: "Automatic" }, ...rows] };
}
function resolve(context, dependencies = {}) {
  const request = savedChoice(context);
  const reason = unavailableReason(request.split(":")[0], dependencies);
  if (reason) throw new Error(reason);
  const available = installed(context, dependencies);
  const managedRequest = managed.providers.find(item => item.selectionId === request);
  const selected = request === "auto" ? available.find(item => !item.sceneOnly) : request.endsWith(":auto")
    ? available.find(item => item.backend === request.slice(0, -5) && !item.projectId) : managedRequest
    ? available.find(item => item.projectId === managedRequest.projectId) : available.find(item => item.id === request);
  if (!selected && request === "auto") return null;
  if (!selected) throw new Error("The selected Vulkan library is unavailable for this Mac. Select an installed version in game Settings.");
  const owner = managed.providers.find(item => item.projectId === selected.projectId);
  return owner ? (dependencies.adapted || owner.provider).resolve(selected, consumerContext(context, dependencies, owner.projectId)) : selected;
}
function requirements(context, dependencies = {}) {
  const request = savedChoice(context);
  const reason = unavailableReason(request.split(":")[0], dependencies);
  if (reason) throw new Error(reason);
  const managedRequest = managed.providers.find(item => item.selectionId === request || request.startsWith(item.prefix));
  if (!managedRequest) {
    if (!dependencies.required && request === "auto") return [];
    const available = installed(context, dependencies);
    const selected = request === "auto" ? available.find(item => !item.sceneOnly) : request.endsWith(":auto")
      ? available.find(item => item.backend === request.slice(0, -5) && !item.projectId) : available.find(item => item.id === request);
    if (selected) {
      context.recordRuntimeUse?.({ managerId: selected.projectId || "vulkan-" + selected.backend, version: selected.version, sectionId: "default", sourcePath: path.dirname(selected.library) });
      return [];
    }
    const architecture = dependencies.architecture || Architecture.selectedArchitecture();
    const installOptions = dependencies.architecture ? { architecture } : {};
    // An installed driver keeps Play offline. Only a first Intel-program launch
    // offers the managed Intel KosmicKrisp build before MoltenVK.
    if (request === "auto" && architecture === "x64" && dependencies.preferredBackend === "kosmickrisp") {
      const fallback = () => requirements({ ...context, runtimeSettings: { ...context.runtimeSettings, vulkanRuntime: "moltenvk:auto" } }, dependencies);
      const offer = kosmicKrispOffer(context, dependencies);
      return offer ? [{ ...offer, fallback: fallback()[0] }] : fallback();
    }
    const ordered = [...(dependencies.managers || managers)].sort((a, b) => Number(b.backend === dependencies.preferredBackend) - Number(a.backend === dependencies.preferredBackend));
    for (const manager of ordered) {
      if (unavailableReason(manager.backend, dependencies)) continue;
      const name = manager.backend + ":";
      if (request !== "auto" && !request.startsWith(name)) continue;
      const entries = manager.core.listCatalog({ userDataDir: context.userDataDir, architecture });
      const explicit = request === "auto" || request === name + "auto" ? null : request.slice(name.length);
      const state = manager.getState({ settings: context.settings?.runtimes?.[manager.id], userDataDir: context.userDataDir });
      const catalog = state.catalog?.architectureCatalogs?.[architecture] || state.catalog;
      const selected = manager.resolveSelection(null, context.settings, context.userDataDir,
        { version: explicit || undefined, verification: "status", ...installOptions });
      const versions = [selected.version].filter(value => value && value !== "auto");
      // Nothing listed or installed yet: consented preparation discovers versions.
      if (!versions.length && selected.discoveryRequired) return [{ managerId: manager.id, version: null, discoveryRequired: true, requiresDownload: true, installOptions }];
      for (const version of versions) {
        const pin = entries.find(item => item.version === version);
        if (pin?.deprecated || (pin ? !Architecture.matchesArchitecture(pin, architecture) : architecture !== Architecture.selectedArchitecture())) continue;
        if (catalog.versionRequirements?.[version]?.installReason) continue;
        const selection = manager.resolveSelection(null, context.settings, context.userDataDir, { version, verification: "status", ...installOptions });
        if (selection.ready) throw new Error("The selected Vulkan runtime has no compatible " + architecture + " library. Install a compatible version in Runtimes.");
        return [{ managerId: manager.id, version, requiresDownload: true, installOptions }];
      }
    }
    throw new Error("A compatible " + architecture + " Vulkan runtime is unavailable. Select a compatible version in game Settings.");
  }
  const prefix = managedRequest.prefix, manager = dependencies.adaptedManager || managedRequest.manager;
  const version = request.startsWith(prefix) ? request.slice(prefix.length) : undefined;
  const installOptions = dependencies.architecture ? { architecture: dependencies.architecture } : {};
  const available = dependencies.architecture ? installed(context, dependencies) : null;
  const selection = managedSelection(managedRequest, context, dependencies, version, available);
  if (!selection.version && selection.discoveryRequired) return [{ managerId: manager.id, version: null,
    discoveryRequired: true, requiresDownload: true, installOptions }];
  if (!selection.version) throw new Error(selection.reason || "A compatible " + manager.label + " package is unavailable.");
  if (dependencies.architecture && !selection.ready) {
    const pin = manager.core.listCatalog({ userDataDir: context.userDataDir, ...installOptions }).find(item => item.version === selection.version);
    if (pin ? !Architecture.matchesArchitecture(pin, dependencies.architecture) : dependencies.architecture !== Architecture.selectedArchitecture())
      throw new Error("The selected " + manager.label + " runtime has no compatible " + dependencies.architecture + " library.");
  }
  if (selection.ready) {
    if (dependencies.architecture && !available.some(item => item.projectId === managedRequest.projectId && item.version === selection.version))
      throw new Error("The selected " + manager.label + " runtime has no compatible " + dependencies.architecture + " library.");
    context.recordRuntimeUse?.({ managerId: manager.id, version: selection.version, sectionId: "default", sourcePath: selection.install.installDir });
    return [];
  }
  return [{ managerId: manager.id, version: selection.version, requiresDownload: true, installOptions }];
}
// The download of the managed KosmicKrisp build for a consumer CPU, offered
// before MoltenVK on an Apple Silicon Mac with Metal 4. An installed build,
// another Mac, or a refreshed catalog that lists no build for that CPU offers
// nothing.
function kosmicKrispOffer(context, dependencies = {}) {
  const host = dependencies.hostCapabilities || Host.getHostCapabilities();
  if (Requirements.requirementSupport(Requirements.METAL4, host).supported !== true || host.physicalAppleGPU === false) return null;
  let preferred;
  try {
    preferred = requirements({ ...context, runtimeSettings: { ...context.runtimeSettings, vulkanRuntime: managed.selectionId } }, dependencies)[0];
  } catch (error) { context.logger?.warn?.("[runtimes] The Intel KosmicKrisp package is unavailable; using MoltenVK.", error.message); }
  // A refreshed catalog that already lists no build for this CPU offers MoltenVK alone.
  const listedNone = preferred?.discoveryRequired && catalogListsNoBuild(dependencies.adaptedManager ||
    managed.providers.find(item => item.selectionId === managed.selectionId).manager, context, dependencies.architecture || Architecture.selectedArchitecture());
  return preferred && !listedNone ? { ...preferred, optional: true, cancelLabel: "Use MoltenVK",
    label: offerLabel("KosmicKrisp", dependencies), detail: "Intel programs on Apple Silicon. Skipping uses MoltenVK." } : null;
}
function environment(selection, directory) {
  if (!selection) return {};
  const env = { KL_MVK_DYLIB: selection.library };
  if (selection.backend === "kosmickrisp") Object.assign(env, driverEnvironment(selection, directory));
  return env;
}
// Every route that points the Vulkan loader at a driver writes its manifest
// here. A driver's own ICD manifest is used as published. A driver without one,
// such as a KosmicKrisp package, gets a generated manifest. The loader takes a
// driver's Vulkan API version from that manifest, and a 1.0 declaration hides
// KosmicKrisp's Vulkan 1.1+ features (for example shaderDrawParameters) from
// DXVK, so KosmicKrisp is declared as Vulkan 1.4.
function driverEnvironment({ driver, icd, backend }, directory) {
  const apiVersion = backend === 'kosmickrisp' ? '1.4.0' : '1.0.0';
  const descriptor = icd ? JSON.parse(fs.readFileSync(icd, 'utf8')) : { file_format_version: '1.0.0', ICD: { api_version: apiVersion } };
  driver ||= icd && path.resolve(path.dirname(icd), descriptor.ICD.library_path);
  if (!path.isAbsolute(driver || '') || !fs.statSync(driver).isFile()) throw new Error('The selected Vulkan driver is missing.');
  descriptor.ICD = { ...descriptor.ICD, library_path: driver, is_portability_driver: false };
  const file = path.join(directory, 'vulkan-icd.json');
  const text = JSON.stringify(descriptor) + '\n';
  if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || fs.readFileSync(file, 'utf8') !== text)
    require('../writable-input').atomicWrite(file, text, { root: directory });
  return { VK_DRIVER_FILES: file, VK_ICD_FILENAMES: file };
}
module.exports = { installed, choices, resolve, requirements, kosmicKrispOffer, environment, driverEnvironment };

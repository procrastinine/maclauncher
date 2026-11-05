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
  if (backend !== "kosmickrisp" && backend !== "kosmickrisp-gles32") return null;
  const support = Requirements.requirementSupport(Requirements.METAL4, dependencies.hostCapabilities || Host.getHostCapabilities());
  return support.supported === false ? support.reason : null;
}
function choiceLabel(backend, label, dependencies) {
  return backend === "kosmickrisp"
    ? label + " (" + Architecture.architectureLabel(dependencies.architecture || Architecture.selectedArchitecture()) + ")" : label;
}
function consumerContext(context, dependencies, projectId) {
  if (!dependencies.architecture) return context;
  return { ...context, settings: { ...context.settings, runtimes: { ...context.settings?.runtimes,
    [projectId]: { ...context.settings?.runtimes?.[projectId], defaultArchitecture: dependencies.architecture } } } };
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
  const rows = available.map(item => ({ value: item.id, label: choiceLabel(item.backend, item.label, dependencies) }));
  const add = (value, label) => { if (!rows.some(row => row.value === value)) rows.push({ value, label: label + " (download)" }); };
  for (const manager of dependencies.managers || managers) {
    if (unavailableReason(manager.backend, dependencies)) continue;
    const state = manager.getState({ userDataDir: context.userDataDir, settings: context.settings?.runtimes?.[manager.id] });
    const catalog = state.catalog?.architectureCatalogs?.[dependencies.architecture] || state.catalog;
    const listed = catalog?.installableVersions || catalog?.versions || [];
    for (const version of listed) {
      const pin = manager.core.listCatalog({ userDataDir: context.userDataDir, architecture: dependencies.architecture }).find(pin => pin.version === version);
      if (pin?.deprecated || pin && !Architecture.matchesArchitecture(pin, dependencies.architecture || Architecture.selectedArchitecture()) || catalog?.versionRequirements?.[version]?.installReason) continue;
      add(manager.backend + ":" + version, choiceLabel(manager.backend,
        state.versionLabels?.[version] || state.catalog?.versionLabels?.[version] || definitions[manager.backend].label + " " + version, dependencies));
    }
    const automaticId = manager.backend + ":auto";
    if (context.runtimeSettings?.vulkanRuntime === automaticId) {
      const ready = rows.some(row => row.value.startsWith(manager.backend + ":"));
      rows.push({ value: automaticId, label: choiceLabel(manager.backend, definitions[manager.backend].label, dependencies) + (ready ? "" : " (download)") });
    } else if (!listed.length && !rows.some(row => row.value.startsWith(manager.backend + ":")))
      add(automaticId, choiceLabel(manager.backend, definitions[manager.backend].label, dependencies));
  }
  for (const item of managed.providers) {
    if (unavailableReason(item.selectionId.split(":")[0], dependencies)) continue;
    const manager = dependencies.adaptedManager || item.manager;
    const selection = managedSelection(item, context, dependencies, undefined, available);
    const label = choiceLabel(item.selectionId.split(":")[0], manager.label, dependencies);
    if (selection.ready && context.runtimeSettings?.vulkanRuntime === item.selectionId) rows.push({ value: item.selectionId, label });
    else if (!selection.ready && (selection.version || selection.discoveryRequired)) add(item.selectionId, label);
  }
  return { vulkanRuntimes: [{ value: "auto", label: "Automatic" }, ...rows] };
}
function resolve(context, dependencies = {}) {
  const request = context.runtimeSettings?.vulkanRuntime || "auto";
  const reason = unavailableReason(request.split(":")[0], dependencies);
  if (reason) throw new Error(reason);
  const available = installed(context, dependencies);
  const managedRequest = managed.providers.find(item => item.selectionId === request);
  const selected = request === "auto" ? available.find(item => !item.sceneOnly || dependencies.sceneOperations) : request.endsWith(":auto")
    ? available.find(item => item.backend === request.slice(0, -5) && !item.projectId) : managedRequest
    ? available.find(item => item.projectId === managedRequest.projectId) : available.find(item => item.id === request);
  if (!selected && request === "auto") return null;
  if (!selected) throw new Error("The selected Vulkan library is unavailable for this Mac. Select an installed version in game Settings.");
  const owner = managed.providers.find(item => item.projectId === selected.projectId);
  return owner ? (dependencies.adapted || owner.provider).resolve(selected, consumerContext(context, dependencies, owner.projectId)) : selected;
}
function requirements(context, dependencies = {}) {
  const request = context.runtimeSettings?.vulkanRuntime || "auto";
  const reason = unavailableReason(request.split(":")[0], dependencies);
  if (reason) throw new Error(reason);
  const managedRequest = managed.providers.find(item => item.selectionId === request || request.startsWith(item.prefix));
  if (!managedRequest) {
    if (!dependencies.required && request === "auto") return [];
    const available = installed(context, dependencies);
    const selected = request === "auto" ? available.find(item => !item.sceneOnly || dependencies.sceneOperations) : request.endsWith(":auto")
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
      const host = dependencies.hostCapabilities || Host.getHostCapabilities();
      const fallback = () => requirements({ ...context, runtimeSettings: { ...context.runtimeSettings, vulkanRuntime: "moltenvk:auto" } }, dependencies);
      if (Requirements.requirementSupport(Requirements.METAL4, host).supported === true && host.physicalAppleGPU !== false) {
        let preferred;
        try {
          preferred = requirements({ ...context, runtimeSettings: { ...context.runtimeSettings, vulkanRuntime: managed.selectionId } }, dependencies)[0];
        } catch (error) { context.logger?.warn?.("[runtimes] The Intel KosmicKrisp package is unavailable; using MoltenVK.", error.message); }
        if (preferred) return [{ ...preferred, optional: true, cancelLabel: "Use MoltenVK",
          label: choiceLabel("kosmickrisp", "KosmicKrisp", dependencies),
          detail: "Intel programs on Apple Silicon. Skipping uses MoltenVK.", fallback: fallback()[0] }];
      }
      return fallback();
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
function environment(selection, directory) {
  if (!selection) return {};
  const env = { KL_MVK_DYLIB: selection.library };
  if (selection.backend === "kosmickrisp") {
    const file = path.join(directory, "vulkan-icd.json");
    require("../writable-input").atomicWrite(file, JSON.stringify({ file_format_version: "1.0.0", ICD: { library_path: selection.driver, api_version: "1.4.0" } }) + "\n", { root: directory });
    env.VK_DRIVER_FILES = env.VK_ICD_FILENAMES = file;
  }
  return env;
}
module.exports = { installed, choices, resolve, requirements, environment };

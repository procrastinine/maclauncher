const fs = require("node:fs"), path = require("node:path");
const { managers, definitions, inspect } = require("./libraries");
const { hashFile } = require("../runtime/pinned-native-manager");
const { readMachOLoadCommands } = require("../runtime/macho-load-commands");
const managed = require("./managed");
const Custom = require("../runtime/custom-runtime");

function installed(context, dependencies = {}) {
  const result = [];
  for (const manager of dependencies.managers || managers) {
    const managerId = manager.id || "vulkan-" + manager.backend, preferred = Custom.defaultVersion(context.settings, managerId);
    const versions = manager.core.listInstalled(context.userDataDir)
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
  const adapted = dependencies.adapted ? [dependencies.adapted] : managed.providers.map(item => item.provider);
  for (const item of adapted.flatMap(provider => provider.installed(context))) {
    try {
      if (dependencies.architecture) for (const file of item.readable) readMachOLoadCommands(file, dependencies);
      result.push(item);
    } catch (error) { if (dependencies.signal?.aborted) throw error; }
  }
  return dependencies.preferredBackend ? result.sort((a, b) => Number(b.backend === dependencies.preferredBackend) - Number(a.backend === dependencies.preferredBackend)) : result;
}
function choices(context, dependencies) {
  return { vulkanRuntimes: [{ value: "auto", label: "Automatic" }, ...installed(context, dependencies).map(item => ({ value: item.id, label: item.label }))] };
}
function resolve(context, dependencies = {}) {
  const request = context.runtimeSettings?.vulkanRuntime || "auto", available = installed(context, dependencies);
  const managedRequest = managed.providers.find(item => item.selectionId === request);
  const selected = request === "auto" ? available.find(item => !item.sceneOnly || dependencies.sceneOperations) : managedRequest
    ? available.find(item => item.projectId === managedRequest.projectId) : available.find(item => item.id === request);
  if (!selected && request === "auto") return null;
  if (!selected) throw new Error("The selected Vulkan library is unavailable for this Mac. Select an installed version in game Settings.");
  const owner = managed.providers.find(item => item.projectId === selected.projectId);
  return owner ? (dependencies.adapted || owner.provider).resolve(selected, context) : selected;
}
function requirements(context, dependencies = {}) {
  const request = context.runtimeSettings?.vulkanRuntime || "auto";
  const managedRequest = managed.providers.find(item => item.selectionId === request || request.startsWith(item.prefix));
  if (!managedRequest) {
    if (!dependencies.required) return [];
    const available = installed(context, dependencies);
    const selected = request === "auto" ? available.find(item => !item.sceneOnly || dependencies.sceneOperations) : available.find(item => item.id === request);
    if (selected) {
      context.recordRuntimeUse?.({ managerId: selected.projectId || "vulkan-" + selected.backend, version: selected.version, sectionId: "default", sourcePath: path.dirname(selected.library) });
      return [];
    }
    const architecture = dependencies.architecture || process.arch;
    for (const manager of dependencies.managers || managers) {
      const name = manager.backend + ":";
      if (request !== "auto" && !request.startsWith(name)) continue;
      const entries = manager.core.listCatalog({ userDataDir: context.userDataDir });
      const explicit = request === "auto" ? null : request.slice(name.length);
      const state = manager.getState({ settings: context.settings?.runtimes?.[manager.id], userDataDir: context.userDataDir });
      const selected = manager.resolveSelection(null, context.settings, context.userDataDir,
        { version: explicit || undefined, verification: "status" });
      const versions = [selected.version].filter(value => value && value !== "auto");
      for (const version of versions) {
        const pin = entries.find(item => item.version === version);
        if (pin?.deprecated || pin?.hostArchitectures && !pin.hostArchitectures.includes(architecture) || !pin && architecture !== process.arch) continue;
        if (state.catalog.versionRequirements?.[version]?.installReason) continue;
        const selection = manager.resolveSelection(null, context.settings, context.userDataDir, { version, verification: "status" });
        if (selection.ready) throw new Error("The selected Vulkan runtime has no compatible " + architecture + " library. Install a compatible version in Runtimes.");
        return [{ managerId: manager.id, version, requiresDownload: true, installOptions: {} }];
      }
    }
    throw new Error("A compatible " + architecture + " Vulkan runtime is unavailable. Select a compatible version in game Settings.");
  }
  const prefix = managedRequest.prefix, manager = dependencies.adaptedManager || managedRequest.manager;
  const version = request.startsWith(prefix) ? request.slice(prefix.length) : undefined;
  const selection = manager.resolveSelection(null, context.settings, context.userDataDir, { version, verification: "status" });
  if (!selection.version) throw new Error(selection.reason || "A compatible " + manager.label + " package is unavailable.");
  if (dependencies.architecture && !selection.ready) {
    const pin = manager.core.listCatalog({ userDataDir: context.userDataDir }).find(item => item.version === selection.version);
    if (pin?.hostArchitectures && !pin.hostArchitectures.includes(dependencies.architecture) || !pin && dependencies.architecture !== process.arch)
      throw new Error("The selected " + manager.label + " runtime has no compatible " + dependencies.architecture + " library.");
  }
  if (selection.ready) {
    if (dependencies.architecture && !installed(context, dependencies).some(item => item.projectId === managedRequest.projectId && item.version === selection.version))
      throw new Error("The selected " + manager.label + " runtime has no compatible " + dependencies.architecture + " library.");
    context.recordRuntimeUse?.({ managerId: manager.id, version: selection.version, sectionId: "default", sourcePath: selection.install.installDir });
    return [];
  }
  return [{ managerId: manager.id, version: selection.version, requiresDownload: true, installOptions: {} }];
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

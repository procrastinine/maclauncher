const fs = require("node:fs"), path = require("node:path");
const { managers, definitions, inspect } = require("./libraries");
const { hashFile } = require("../runtime/pinned-native-manager");
const included = require("./included");

function installed(context, dependencies = {}) {
  const result = [];
  for (const manager of dependencies.managers || managers) {
    const preferred = context.settings?.runtimes?.[manager.id || "vulkan-" + manager.backend]?.defaultVersion;
    const versions = manager.core.listInstalled(context.userDataDir).slice().sort((a, b) => Number(b.version === preferred) - Number(a.version === preferred));
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
      const library = path.join(root, manager.backend === "kosmickrisp" ? "libvulkan.1.dylib" : definition.library);
      if (!readable.includes(library) || !readable.includes(path.join(root, definition.library))) continue;
      result.push({ id: manager.backend + ":" + install.version, backend: manager.backend, version: install.version,
        label: install.catalogEntry?.versionLabel || definition.label + " " + install.version, library, driver: path.join(root, definition.library), readable });
    } catch (error) { if (dependencies.signal?.aborted) throw error; }
    }
  }
  // Stock managed versions keep their established preference and default order.
  result.push(...(dependencies.included || included).installed(context));
  return result;
}
function choices(context, dependencies) {
  return { vulkanRuntimes: [{ value: "auto", label: "Automatic" }, ...installed(context, dependencies).map(item => ({ value: item.id, label: item.label }))] };
}
function resolve(context, dependencies = {}) {
  const request = context.runtimeSettings?.vulkanRuntime || "auto", available = installed(context, dependencies);
  const selected = request === "auto" ? available[0] : available.find(item => item.id === request);
  if (!selected && request === "auto") return null;
  if (!selected) throw new Error("The selected Vulkan library is unavailable for this Mac. Select an installed version in game Settings.");
  return selected.included ? (dependencies.included || included).resolve(selected, context) : selected;
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
module.exports = { installed, choices, resolve, environment };

const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../../shared/runtime/local-native");
const Files = require("../../../shared/runtime/bundled-native");
const Binary = require("../../../../core/binary-arch");
const { createPinnedNativeManager } = require("../../../shared/runtime/pinned-native-manager");
const { confirmToolInstall } = require("../../../shared/runtime/tool-install");

const id = "winevulkan-scene";
function descriptor(manifest) {
  const provider = manifest?.provider;
  if (manifest?.managerId !== id || provider?.schema !== 1 || provider.provider !== id ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > Files.LIMITS.files ||
      !provider.libraries || typeof provider.libraries !== "object" || Array.isArray(provider.libraries) ||
      !(/^\d+\.\d+(?:\.\d+)?$/.test(provider.runtimeProfile?.wineVersion || "") ||
        Array.isArray(provider.runtimeProfile?.files) && provider.runtimeProfile.files.length))
    throw Error("The WineVulkan module has no complete library and Wine interface declaration.");
  const names = new Set();
  for (const file of manifest.files) {
    Files.relativeFile(file.path);
    if (names.has(file.path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(file.sha256 || "") ||
        !Number.isSafeInteger(file.size) || file.size < 0 || file.size > Files.LIMITS.fileBytes)
      throw Error("The WineVulkan module file inventory is invalid.");
    names.add(file.path.toLowerCase());
  }
  // A Wine release binding; an older module lists its Wine files by digest.
  for (const file of provider.runtimeProfile.files || []) {
    Files.relativeFile(file.relative);
    if (!/^[a-f0-9]{64}$/.test(file.sha256 || "")) throw Error("The WineVulkan Wine interface binding is invalid.");
  }
  for (const [directory, file] of Object.entries(provider.libraries)) {
    if (!/^[a-z0-9_]+-(?:unix|windows)$/.test(directory)) throw Error("The WineVulkan library role is invalid.");
    Files.relativeFile(file);
    if (!manifest.files.some(row => row.path === file)) throw Error("A WineVulkan library is absent from the module inventory.");
  }
  if (!Array.isArray(provider.files) || provider.files.length !== manifest.files.length ||
      provider.files.some(file => !manifest.files.some(row => row.path === file.path && row.size === file.size && row.sha256 === file.sha256)))
    throw Error("The WineVulkan provider and module inventories differ.");
  return provider;
}

// The selected file may be anywhere within an ordinary completed module. Its
// manifest, rather than the enclosing directory name, identifies the payload.
function payloadRoot(input) {
  let directory = fs.statSync(input).isDirectory() ? input : path.dirname(input);
  for (let depth = 0; depth < 12; depth++) {
    const file = path.join(directory, "manifest.json");
    if (fs.existsSync(file)) {
      const manifest = JSON.parse(Files.readRegular(file, Files.LIMITS.manifestBytes).bytes);
      if (manifest.managerId === id) return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw Error("Choose a complete WineVulkan module folder or its native library.");
}

function inspectPayload(input) {
  const root = payloadRoot(input), manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(Files.readRegular(manifestPath, Files.LIMITS.manifestBytes).bytes);
  const provider = descriptor(manifest), facts = new Map();
  for (const row of manifest.files) {
    const file = path.join(root, row.path), actual = Files.readRegular(file, row.size, { digestOnly: true });
    if (actual.size !== row.size || actual.sha256 !== row.sha256) throw Error("The WineVulkan module file changed: " + row.path);
    if (Object.values(provider.libraries).includes(row.path)) facts.set(row.path, Binary.inspectBinary(file));
  }
  for (const [directory, relative] of Object.entries(provider.libraries)) {
    if (directory.endsWith("-unix")) {
      if (facts.get(relative)?.format !== "macho") throw Error("The WineVulkan Unix library is not a Mach-O image.");
    } else {
      const pe = require("../../../shared/runtime/pe-exports").readPeExports(path.join(root, relative));
      if (!pe?.isDll || pe.form !== "builtin" || !pe.exports.get("vkCreateInstance")?.executable || !pe.exports.get("vkGetInstanceProcAddr")?.executable)
        throw Error("The WineVulkan client is not a complete Wine builtin DLL.");
    }
  }
  const pairs = [];
  for (const [directory, relative] of Object.entries(provider.libraries).filter(([name]) => name.endsWith("-unix"))) {
    const image = facts.get(relative);
    if (image?.format !== "macho") throw Error("The WineVulkan Unix library is not a Mach-O image.");
    const windows = directory.slice(0, -5) + "-windows", client = provider.libraries[windows];
    if (!client) continue;
    const pe = facts.get(client), code = pe?.hybrid?.codeArchitectures || [pe?.machine];
    if (pe?.format !== "pe" || !image.architectures.some(cpu => code.includes(cpu)))
      throw Error("The WineVulkan PE and Unix library CPUs do not match.");
    const entry = file => ({ file: path.join(root, file), sha256: manifest.files.find(row => row.path === file).sha256 });
    pairs.push({ client: entry(client), native: entry(relative), runtimeProfile: provider.runtimeProfile });
  }
  if (!pairs.length || !Object.values(provider.libraries).includes(manifest.executableRelative))
    throw Error("The WineVulkan module has no matching PE and Unix library pair.");
  return { root, manifest, provider, pairs };
}

function inspectRuntime(options) {
  const selected = inspectPayload(options.runtimePath);
  const executablePath = path.join(selected.root, Files.relativeFile(selected.manifest.executableRelative));
  if (fs.realpathSync(options.runtimePath) !== fs.realpathSync(executablePath))
    throw Error("Choose the WineVulkan module's declared native library.");
  return { ...Native.resolveLocalRuntime({ ...options, runtimePath: executablePath, allowLibrary: true }),
    modulePayloadRoot: selected.root, manifest: selected.manifest, provider: selected.provider };
}

function createManager(dependencies = {}) {
  const manager = createPinnedNativeManager({ id, label: "WineVulkan helper", nativeLibrary: true, supportsDefault: true,
    projectBuilds: { projectId: id, repository: "procrastinine/maclauncher-builds", validateManifest: descriptor },
    sourceUrl: "https://github.com/metalsharp/MetalSharp-Wine", inspectRuntime,
    resolveExecutable: root => {
      const selected = inspectPayload(root);
      return path.join(selected.root, Files.relativeFile(selected.manifest.executableRelative));
    }, dependencies });
  manager.ui = { groupId: "tools", tabLabel: "Tools", sectionLabel: "WineVulkan helper", order: 100, memberOrder: 130, management: "managed" };
  manager.ensure = async (entry = {}, payload = {}, context = {}) => {
    let selected = manager.resolveSelection(entry, context.settings, context.userDataDir, { version: payload.toolVersion });
    if (selected.ready) return selected.install;
    await confirmToolInstall(context, { manager, version: selected.version, requiresDownload: true,
      detail: "Required for the selected Wine graphics module." });
    if (!selected.version || selected.discoveryRequired) {
      await manager.refreshCatalog({ ...context, force: false });
      context.onRuntimeStateChange?.(); context.signal?.throwIfAborted();
      selected = manager.resolveSelection(entry, context.settings, context.userDataDir, { version: payload.toolVersion });
    }
    if (!selected.version) throw Error("No compatible WineVulkan helper versions are available.");
    const installed = await manager.installRuntime({ ...context, version: selected.version,
      automatic: typeof context.automatic === "boolean" ? context.automatic : selected.automatic === true });
    context.onRuntimeStateChange?.();
    return installed;
  };
  manager.inspectPayload = inspectPayload;
  return manager;
}

module.exports = Object.assign(createManager(), { createManager, inspectPayload });

const fs = require("node:fs"), path = require("node:path");
const Custom = require("./custom-runtime");

// A component root is retained intact: libraries, notices and future companion
// files belong to the publisher, rather than a launcher inventory.
function componentRoot(input, { names, library }) {
  const stat = fs.statSync(input);
  if (stat.isFile()) return library ? input : path.dirname(input);
  const matches = name => names.includes(name.toLowerCase().replace(/\.framework$/, ""));
  if (matches(path.basename(input))) return input;
  const files = require("./translator-description").describeTranslator(input, { engine: "dxvk" }).files;
  for (const file of files) {
    const parts = file.relative.split(path.sep), index = parts.findIndex(matches);
    if (index >= 0) return path.join(input, ...parts.slice(0, index + 1));
  }
  const selected = library && files.filter(file => library.test(path.basename(file.path)))
    .sort((a, b) => a.relative.split(path.sep).length - b.relative.split(path.sep).length)[0];
  if (selected) return selected.path;
  if (/\.app$/i.test(input)) throw Error("The application's translator component could not be identified. Select its component folder or library.");
  return input;
}
function registrationSource(input, root = input) {
  for (let current = fs.realpathSync(input);; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, "Contents/SharedSupport/CrossOver")))
      return { kind: "crossover", id: current, runtime: "crossover", label: "CrossOver" };
    if (["SharedSupport", "Frameworks"].some(directory => fs.existsSync(path.join(current, "Contents", directory, "renderer"))))
      return { kind: "sikarugir", id: current, runtime: "sikarugir", label: "Sikarugir" };
    if (current === path.dirname(current)) break;
  }
  return /(?:^|\/)(?:Frameworks|SharedSupport)\/renderer(?:\/|$)/.test(root)
    ? { kind: "sikarugir", id: input, runtime: "sikarugir", label: "Sikarugir" } : "custom";
}
function description(root, definition, options = {}) {
  const result = require("./translator-description").describeTranslator(root, { engine: definition.engine, ...options });
  if (definition.pluginDirectory) {
    const directories = [...new Set(result.files.filter(file => file.format === "macho" &&
      (!file.slices?.length || file.slices.some(slice => slice.fileType !== 2)) && path.basename(path.dirname(file.path)) === definition.pluginDirectory)
      .map(file => path.dirname(file.relative)).filter(directory => directory !== "."))];
    if (directories.length) result.pluginDirectories = directories;
  }
  return result;
}
function inspected(root, definition, options) {
  const translator = description(root, definition, options);
  const file = definition.entryLibrary && translator.files.find(file => path.basename(file.path) === definition.entryLibrary) ||
    translator.files.find(file => file.format === "macho" || file.format === "pe");
  if (!file) throw Error("The component contains no loadable library.");
  const executablePath = path.resolve(root, file.path);
  return { executablePath, installDir: root, root, payloadRoot: root, translatorRoot: root, translator,
    architectures: [...new Set(translator.files.flatMap(file => file.architectures || file.cpuSlices || file.slices?.map(slice => slice.architecture) || []))],
    versionLabel: translator.version, baseRoot: fs.existsSync(path.join(root, "wine")) ? path.join(root, "wine") : root };
}
function configure(manager, definition) {
  Custom.configure(manager, { prepare: prepareArchive, inspect(input, { data } = {}) {
    const root = componentRoot(data?.root || input, definition);
    const source = data?.source || registrationSource(input, root);
    return inspected(root, definition, { source });
  } });
  const selection = manager.resolveSelection;
  manager.resolveSelection = function(...args) {
    const result = selection.apply(this, args);
    if (!result?.install || result.install.translator) return result;
    const root = componentRoot(result.install.installDir, definition);
    return { ...result, install: { ...result.install, ...inspected(root, definition, { source: result.install.catalogEntry?.catalogSourceId || "upstream" }) } };
  };
  return manager;
}
// Source-owned copies are presentation references, never managed installations.
// The host manifest supplies the runtime/manager associations; the shared Wine
// reader supplies every component path, version and binary fact.
function includedReferences(engine, options = {}) {
  if (!options.userDataDir) return [];
  const owner = require("../../registry").getModule("crossover"), rows = new Map(), hostsByReference = new Map();
  const Wine = require("./wine-translators"), Description = require("./translator-description");
  const warn = message => require("../graphics-warning")(options.logger || console, `[translators] ${message}`);
  for (const [runtime, managerId] of Object.entries(owner?.manifest?.runtime?.manager || {})) {
    const manager = owner.runtimeManagers.find(item => item.id === managerId);
    if (!manager) continue;
    let hosts;
    try {
      hosts = [...manager.core.listInstalled(options.userDataDir), ...Custom.forManager(manager).list(options.userDataDir)];
    } catch (error) { warn(`${runtime}: ${error.message}`); continue; }
    const seen = new Set();
    for (const host of hosts) {
      if (host.ready === false) continue;
      const sourcePath = host.appPath || host.installDir || host.engineRoot;
      if (seen.has(sourcePath)) continue;
      seen.add(sourcePath);
      try {
        const inventory = Wine.includedTranslators(host, runtime, { engine });
        for (const message of inventory.warnings) warn(`${sourcePath}: ${message}`);
        for (const value of inventory.included) {
          if (value.engine !== engine) continue;
          const version = `reference:${JSON.stringify([runtime, sourcePath, value.engine, value.root])}`;
          const architectures = [...new Set(value.files.flatMap(file => file.cpuSlices || (file.architecture ? [file.architecture] : [])))];
          const templateVersion = host.templateVersion || host.catalogEntry?.template?.version;
          const wineVersion = host.engineVersion || host.wineVersion || host.catalogEntry?.engineVersion;
          const sourceLabel = runtime === "crossover" ? `CrossOver ${host.upstreamVersion || ""}`.trim()
            : templateVersion ? `Template ${templateVersion}${wineVersion ? ` (Wine ${wineVersion})` : ""}` : "Sikarugir";
          const component = value.engine === "dxvk" && value.templateComponent ? value.templateComponent.toUpperCase() : Description.label({ engine: value.engine });
          const label = runtime === "crossover" ? `${component} (${sourceLabel})` : `${component} · ${sourceLabel}`;
          rows.set(version, { version, versionLabel: label, ready: true, included: true, readOnly: true, removable: false, supportsDefault: false,
            reference: { managerId, version: host.version, path: sourcePath }, source: value.source, installDir: value.root,
            minimumMacOS: value.macosFloor, architectures, apis: value.apis, platformKey: architectures.join(", "), detail: value.version ? `Component ${value.version}` : sourceLabel });
          hostsByReference.set(version, { version: templateVersion || host.upstreamVersion || "", wineVersion: wineVersion || "",
            name: host.displayName || host.name || path.basename(sourcePath) });
        }
      } catch (error) { warn(`${sourcePath}: ${error.message}`); }
    }
  }
  const result = [...rows.values()], counts = new Map();
  for (const row of result) counts.set(row.versionLabel, (counts.get(row.versionLabel) || 0) + 1);
  for (const row of result) if (counts.get(row.versionLabel) > 1) row.versionLabel += ` · ${hostsByReference.get(row.version).name}`;
  const order = require("./version-order").compareVersions;
  return result.sort((a, b) => order(hostsByReference.get(b.version).version, hostsByReference.get(a.version).version) ||
    order(hostsByReference.get(b.version).wineVersion, hostsByReference.get(a.version).wineVersion));
}
function withIncludedReferences(manager) {
  manager.referenceManagerIds = [...new Set(Object.values(require("../../crossover/manifest.json").runtime.manager))];
  const getState = manager.getState;
  manager.getState = function(options = {}) {
    const state = getState.call(this, options), references = includedReferences(manager.translatorEngine, options);
    if (!references.length) return state;
    const display = section => ({ ...section, references, versionLabels: { ...section.versionLabels,
      ...Object.fromEntries(references.map(row => [row.version, row.versionLabel])) } });
    return { ...display(state), sections: state.sections?.map(display) };
  };
  return manager;
}
module.exports = { componentRoot, registrationSource, description, inspected, configure, includedReferences, withIncludedReferences };

// A downloaded local container is unpacked once into shared launcher storage.
// Directory registrations stay at the supplied location and remain references.
async function prepareArchive(input, { userDataDir } = {}) {
  if (!require("./release-files").archiveFormat(input)) return {};
  const sha256 = require("./pinned-native-manager").hashFile(input);
  const base = path.join(userDataDir, "runtimes", "imports"), root = path.join(base, sha256);
  if (!fs.existsSync(root)) {
    fs.mkdirSync(base, { recursive: true });const staging = fs.mkdtempSync(path.join(base, ".import-"));
    try {
      if (/\.dmg$/i.test(input)) await require("./dmg").extractDmg(input, staging);
      else await require("./safe-archive").extractArchive(input, staging);
      fs.renameSync(staging, root);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  return { root, source: "custom" };
}
module.exports.prepareArchive = prepareArchive;

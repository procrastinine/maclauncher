const fs = require("node:fs"), path = require("node:path");
const Custom = require("./custom-runtime");
const { componentLabel, componentVersion, hostLabel, label: translatorLabel } = require("./translator-label");

const componentName = names => name => names.includes(name.toLowerCase().replace(/\.framework$/, ""));
// A component root is retained intact: libraries, notices and future companion
// files belong to the publisher, rather than a launcher inventory.
// The outermost folder named for the component is its root. Real paths count
// as well, so a linked alias of that folder, such as a Template's apple_gptk
// link to d3dmetal, cannot select a narrower bundle nested inside it.
function componentRoot(input, { names, library, entryLibrary }, translator) {
  const stat = fs.statSync(input);
  if (stat.isFile()) return entryLibrary ? path.dirname(fs.realpathSync(input)) : library ? input : path.dirname(input);
  const name = value => value.toLowerCase().replace(/\.framework$/, ""), matches = componentName(names);
  if (matches(path.basename(input))) return input;
  const files = (translator || require("./translator-description").describeTranslator(input, { engine: "dxvk" })).files;
  const real = fs.realpathSync(input);
  let found = null;
  for (const file of files) for (const [base, candidate] of [[input, file.path], [real, file.realPath]]) {
    const relative = candidate && path.relative(base, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const parts = relative.split(path.sep), index = parts.findIndex(matches);
    if (index < 0) continue;
    const rank = [index, names.indexOf(name(parts[index]))];
    if (!found || rank[0] < found.rank[0] || rank[0] === found.rank[0] && rank[1] < found.rank[1])
      found = { rank, parts: parts.slice(0, index + 1) };
  }
  if (found) return path.join(input, ...found.parts);
  const selected = library && files.filter(file => library.test(path.basename(file.path)))
    .sort((a, b) => a.relative.split(path.sep).length - b.relative.split(path.sep).length)[0];
  if (selected) return entryLibrary ? path.dirname(selected.realPath || fs.realpathSync(selected.path)) : selected.path;
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
  const { translator, ...selection } = options;
  const result = translator || require("./translator-description").describeTranslator(root, { engine: definition.engine, ...selection });
  if (definition.pluginDirectory) {
    const directories = [...new Set(result.files.filter(file => file.format === "macho" &&
      (!file.slices?.length || file.slices.some(slice => slice.fileType !== 2)) && path.basename(path.dirname(file.path)) === definition.pluginDirectory)
      .map(file => path.dirname(file.relative)).filter(directory => directory !== "."))];
    if (directories.length) result.pluginDirectories = directories;
  }
  return result;
}
function inspected(root, definition, options = {}) {
  const translator = description(root, definition, options);
  const file = definition.entryLibrary && translator.files.find(file => path.basename(file.path) === definition.entryLibrary) ||
    translator.files.find(file => file.format === "macho" || file.format === "pe");
  if (!file) throw Error("The component contains no loadable library.");
  const executablePath = path.resolve(root, file.path);
  return { executablePath, installDir: root, root, payloadRoot: root, translatorRoot: root, translator,
    architectures: [...new Set(translator.files.flatMap(file => file.architectures || file.cpuSlices || file.slices?.map(slice => slice.architecture) || []))],
    versionLabel: translator.version, baseRoot: fs.existsSync(path.join(root, "wine")) ? path.join(root, "wine") : root };
}
function withCatalogFacts(translator, supplied = {}, sourceId = "upstream") {
  const original = translator.source;
  if (original === "custom" || original?.kind === "custom") return translator;
  const source = original && typeof original === "object"
    ? { ...supplied.source, ...original,
      label: original.label && original.label !== sourceId ? original.label : supplied.source?.label || original.label }
    : !original || original === sourceId ? supplied.source || original : original;
  return { ...supplied, ...translator, version: translator.version || supplied.version || "", source };
}
function configure(manager, definition) {
  const Description = require("./translator-description");
  const prepareComponent = async (input, options, data = {}) => {
    let root = data.root || input;
    const source = data.source || registrationSource(input, root);
    const facts = { engine: definition.engine, source, userDataDir: options.userDataDir, signal: options.signal, logger: options.logger };
    const all = await Description.prepareTranslator(root, facts), selected = componentRoot(root, definition, all);
    if (selected !== root) { root = selected; await Description.prepareTranslator(root, facts); }
    return { ...data, root, source };
  };
  Custom.configure(manager, { async prepare(input, options) {
    return prepareComponent(input, options, await prepareArchive(input, { ...options, names: definition.names, licence: definition.importLicence, component: definition.label }));
  }, inspect(input, context = {}) {
    const { data, userDataDir, verification } = context;
    let root = data?.root || input;
    const source = data?.source || registrationSource(input, root);
    if (verification === "status") {
      const selection = { engine: definition.engine, source, userDataDir };
      const outer = Description.cachedTranslator(root, selection);
      if (outer) root = componentRoot(root, definition, outer);
      const translator = outer && Description.cachedTranslator(root, selection);
      if (!translator) {
        fs.statSync(root);
        return { installDir: root, ready: false, reason: "Local component details are being prepared." };
      }
      return inspected(root, definition, { translator });
    }
    root = componentRoot(root, definition);
    return definition.inspect ? definition.inspect(root, { ...context, source }) : inspected(root, definition, { source });
  } });
  const prepare = manager.prepareLocalState;
  manager.prepareLocalState = async function(options = {}) {
    await prepare?.call(this, options);
    options.signal?.throwIfAborted();
    const results = await Promise.allSettled(Custom.forManager(manager).records(options.userDataDir)
      .map(row => prepareComponent(row.path, options, row.data)));
    options.signal?.throwIfAborted();
    for (const result of results) if (result.status === "rejected") require("../graphics-warning")(options.logger || console,
      `[translators] ${result.reason?.message || result.reason}`);
  };
  const selection = manager.resolveSelection;
  manager.resolveSelection = function(...args) {
    const result = selection.apply(this, args);
    const install = result?.install;
    if (!install || install.custom || install.source === "custom") return result;
    const pin = install.catalogEntry || manager.core?.catalog?.find(row => row.version === install.version);
    const supplied = definition.catalogDescription?.(pin) || {};
    const translator = install.translator || install.installationMetadata?.translator;
    if (translator) return { ...result, install: { ...install,
      translator: withCatalogFacts(translator, supplied, pin?.catalogSourceId) } };
    const root = componentRoot(install.installDir, definition);
    return { ...result, install: { ...install, ...inspected(root, definition, supplied) } };
  };
  return manager;
}
// Source-owned components retain their host's installation identity rather
// than becoming managed translator installations.
// The host manifest supplies the runtime/manager associations; the shared Wine
// reader supplies every component path, version and binary fact.
function referencedComponents(engine, options = {}) {
  if (!options.userDataDir) return [];
  const owner = require("../../registry").getModule("crossover"), result = [];
  const Wine = require("./wine-translators"), Description = require("./translator-description");
  const describe = options.describe || ((root, selection) => Description.cachedTranslator(root, { ...selection,
    userDataDir: options.userDataDir, logger: options.logger }));
  const warn = message => require("../graphics-warning")(options.logger || console, `[translators] ${message}`);
  for (const [runtime, managerId] of Object.entries(owner?.manifest?.runtime?.manager || {})) {
    const manager = owner.runtimeManagers.find(item => item.id === managerId);
    if (!manager) continue;
    let state;
    try {
      state = options.referenceStates?.get(managerId);
      if (!state) {
        // Host rows are read for their files; their translator summaries are not needed here.
        state = manager.getState({ ...options, settings: options.settings?.runtimes?.[managerId], componentSummaries: false });
        options.referenceStates?.set(managerId, state);
      }
    } catch (error) { warn(`${runtime}: ${error.message}`); continue; }
    const seen = new Set();
    for (const host of state.installed || []) {
      const sourcePath = host.appPath || host.installDir || host.engineRoot;
      if (!sourcePath || seen.has(sourcePath)) continue;
      seen.add(sourcePath);
      try {
        const inventory = Wine.includedTranslators(host, runtime, { engine, describe });
        for (const message of inventory.warnings) warn(`${sourcePath}: ${message}`);
        for (const value of inventory.included) {
          if (value.engine !== engine) continue;
          result.push({ id: `reference:${JSON.stringify([runtime, sourcePath, value.engine, value.root])}`,
            description: value, reference: { managerId, version: host.version, path: sourcePath }, install: host, runtime,
            hostVersionLabel: state.versionLabels?.[host.version] });
        }
      } catch (error) { warn(`${sourcePath}: ${error.message}`); }
    }
  }
  return result;
}
function includedReferences(engine, options = {}) {
  const rows = new Map(), hostsByReference = new Map();
  for (const { id: version, description: value, reference, install: host, hostVersionLabel } of referencedComponents(engine, options)) {
    const architectures = [...new Set(value.files.flatMap(file => file.cpuSlices || (file.architecture ? [file.architecture] : [])))];
    const templateVersion = host.templateVersion || host.catalogEntry?.template?.version;
    const wineVersion = host.engineVersion || host.wineVersion || host.catalogEntry?.engineVersion;
    const sourceLabel = hostLabel(host, value.source), sortVersion = componentVersion(value);
    rows.set(version, { version, versionLabel: translatorLabel(value, host), ready: true, included: true, readOnly: true, removable: false, supportsDefault: false,
      ...(sortVersion ? { sortVersion } : {}),
      ...(templateVersion || host.upstreamVersion ? { sortHostVersion: templateVersion || host.upstreamVersion } : {}),
      ...(templateVersion ? { templateVersion } : {}), ...(value.templateComponent ? { templateComponent: value.templateComponent } : {}),
      reference, source: value.source, installDir: value.root, minimumMacOS: value.macosFloor, architectures, apis: value.apis,
      platformKey: architectures.join(", "), detail: value.version ? `Component ${value.version.replace(/\s+/g, " ")}` : sourceLabel });
    hostsByReference.set(version, { version: templateVersion || host.upstreamVersion || "", wineVersion: wineVersion || "",
      name: host.displayName || host.name, folder: value.templateComponent, hostVersionLabel,
      translator: value, install: host, qualifiers: {} });
  }
  const result = [...rows.values()], folders = new Map();
  for (const row of result) {
    const variants = folders.get(row.versionLabel) || new Set();
    variants.add(hostsByReference.get(row.version).folder);
    folders.set(row.versionLabel, variants);
  }
  for (const row of result) if (folders.get(row.versionLabel).size > 1) {
    const host = hostsByReference.get(row.version);
    host.qualifiers.folder = host.folder;
    row.versionLabel = translatorLabel(host.translator, host.install, host.qualifiers);
  }
  const counts = new Map();
  for (const row of result) counts.set(row.versionLabel, (counts.get(row.versionLabel) || 0) + 1);
  for (const row of result) if (counts.get(row.versionLabel) > 1) {
    const host = hostsByReference.get(row.version);
    // The shared producer omits host provenance already stated in the label.
    host.qualifiers.hostVersionLabel = host.hostVersionLabel || host.name || "";
    row.versionLabel = translatorLabel(host.translator, host.install, host.qualifiers);
  }
  counts.clear();
  for (const row of result) {
    const host = hostsByReference.get(row.version);
    const key = JSON.stringify([row.versionLabel, host.qualifiers.hostVersionLabel]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const row of result) {
    const host = hostsByReference.get(row.version);
    if (counts.get(JSON.stringify([row.versionLabel, host.qualifiers.hostVersionLabel])) < 2) continue;
    host.qualifiers.hostName = host.name;
    row.versionLabel = translatorLabel(host.translator, host.install, host.qualifiers);
  }
  const order = require("./version-order.mjs").compareVersions;
  return result.sort((a, b) => order(hostsByReference.get(b.version).version, hostsByReference.get(a.version).version) ||
    order(hostsByReference.get(b.version).wineVersion, hostsByReference.get(a.version).wineVersion));
}
function withIncludedReferences(manager) {
  manager.referenceManagerIds = [...new Set(Object.values(require("../../crossover/manifest.json").runtime.manager))];
  const prepare = manager.prepareLocalState;
  manager.prepareLocalState = async function(options = {}) {
    await prepare?.call(this, options);
    options.signal?.throwIfAborted();
    const Description = require("./translator-description"), pending = new Map();
    referencedComponents(manager.translatorEngine, { ...options, describe(root, selection) {
      const facts = { ...selection, userDataDir: options.userDataDir, logger: options.logger, signal: options.signal };
      const cached = Description.cachedTranslator(root, facts);
      if (!cached) {
        const key = JSON.stringify([root, selection]);
        if (!pending.has(key)) pending.set(key, Description.prepareTranslator(root, facts));
      }
      return cached;
    } });
    const results = await Promise.allSettled(pending.values());
    options.signal?.throwIfAborted();
    // An installation without one of the optional included components is not a warning.
    for (const result of results) if (result.status === "rejected" && result.reason?.code !== "ENOENT") require("../graphics-warning")(options.logger || console,
      `[translators] ${result.reason?.message || result.reason}`);
  };
  const getState = manager.getState;
  // The references are read first, so catalog labels can name the component
  // versions that installed hosts already show for the same release.
  manager.getState = function(options = {}) {
    const references = includedReferences(manager.translatorEngine, options), state = getState.call(this, { ...options, includedReferences: references });
    if (!references.length) return state;
    const display = section => ({ ...section, references, versionLabels: { ...section.versionLabels,
      ...Object.fromEntries(references.map(row => [row.version, row.versionLabel])) } });
    return { ...display(state), sections: state.sections?.map(display) };
  };
  return manager;
}
module.exports = { componentRoot, registrationSource, description, inspected, configure, withCatalogFacts, componentLabel, hostLabel,
  referencedComponents, includedReferences, withIncludedReferences };

// A downloaded local container is unpacked once into shared launcher storage.
// Directory registrations stay at the supplied location and remain references.
async function prepareArchive(input, { userDataDir, names, signal, licence, ...consent } = {}) {
  if (!require("./release-files").archiveFormat(input)) return {};
  const sha256 = require("./pinned-native-manager").hashFile(input);
  const base = path.join(userDataDir, "runtimes", "imports"), root = path.join(base, sha256);
  const confirm = async directory => { if (licence) await confirmLicence(directory, licence, { userDataDir, ...consent }); };
  if (fs.existsSync(root)) await confirm(root);
  else {
    fs.mkdirSync(base, { recursive: true });const staging = fs.mkdtempSync(path.join(base, ".import-"));
    try {
      if (/\.dmg$/i.test(input)) await importDmg(input, staging, names, signal, confirm);
      else { await require("./safe-archive").extractArchive(input, staging); await confirm(staging); }
      fs.renameSync(staging, root);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  return { root, source: "custom" };
}
// The licence an imported container carries at its top, such as Apple's
// License.rtf in the Game Porting Toolkit, is shown as text through the runtime
// consent. A disk image volume is shown while attached, before anything is
// copied; an archive is shown once extracted to staging, before the import is
// kept. Declining cancels the import. Agreement
// is recorded by the licence file's SHA-256, so only a different licence text
// is shown again; an agreement that cannot be recorded is asked again later.
async function confirmLicence(directory, owner, { userDataDir, confirmRuntimeInstall, logger, run, component } = {}) {
  const name = fs.readdirSync(directory).filter(item => /^licen[cs]e\b/i.test(item) && fs.statSync(path.join(directory, item)).isFile()).sort()[0];
  if (!name) return;
  const file = path.join(directory, name), bytes = fs.readFileSync(file), id = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  const Json = require("../../../core/json-files"), store = path.join(userDataDir, "runtimes", "accepted-licences.json");
  let accepted = {};
  try { accepted = Json.readJsonObject(store)?.accepted || {}; } catch {}
  if (accepted[id]) return;
  let text = bytes.toString("utf8");
  if (/\.rtf$/i.test(name)) {
    try { text = (await (run || require("node:util").promisify(require("node:child_process").execFile))("/usr/bin/textutil",
      ["-convert", "txt", "-stdout", file], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 })).stdout; }
    catch { text = text.replace(/\\par[d]?\b/g, "\n").replace(/\\'[0-9a-f]{2}|\\[a-z]+-?\d* ?|[{}]/gi, ""); }
  }
  const consent = typeof confirmRuntimeInstall === "function" ? await confirmRuntimeInstall({ kind: "licence", label: owner, component,
    message: `Agree to the ${owner} license?`, detail: text.trim(), licenseRequired: true, confirmLabel: "Agree and Import", cancelLabel: "Cancel" }) : false;
  if (consent !== true && consent?.approved !== true) throw require("./download-utils").createAbortError(`The ${owner} import was canceled.`);
  try { Json.writeJsonAtomic(store, { schemaVersion: 1, accepted: { ...accepted, [id]: new Date().toISOString() } }); }
  catch (error) { (logger || console).warn?.(`[translators] The licence agreement was not recorded: ${error.message}`); }
}
// A disk image volume that holds the component is copied whole, with the
// publisher's notices. A distribution volume without the component, such as
// Apple's Game Porting Toolkit, is searched for a disk image at its top level
// that holds the component, and only that image's volume is copied. `ready`
// receives the volume that is about to be copied.
async function importDmg(image, destination, names, signal, ready = async () => {}, nested = false) {
  const Dmg = require("./dmg");
  return Dmg.withMountedDmg(image, signal, {}, async volume => {
    if (!names?.length || holdsComponent(volume, names)) { await ready(volume); await Dmg.copyVolume(volume, destination, signal); return true; }
    if (nested) return false;
    for (const item of fs.readdirSync(volume, { withFileTypes: true }))
      if (item.isFile() && !item.name.startsWith(".") && /\.dmg$/i.test(item.name) &&
        await importDmg(path.join(volume, item.name), destination, names, signal, ready, true)) return true;
    await ready(volume); await Dmg.copyVolume(volume, destination, signal);
    return true;
  });
}
function holdsComponent(directory, names, depth = 6) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.name.startsWith(".") || item.isSymbolicLink()) continue;
    if (componentName(names)(item.name)) return true;
    if (depth > 1 && item.isDirectory() && holdsComponent(path.join(directory, item.name), names, depth - 1)) return true;
  }
  return false;
}
module.exports.prepareArchive = prepareArchive;

const fs = require('node:fs'), path = require('node:path');
const Description = require('./translator-description'), Plan = require('../../../core/runtime-resolution/translator-plan');
const { wineLayout, wineRoot } = require('./wine-layout');
const Binary = require('./binary-compatibility');
const { systemVersionSync } = require('./bundled-native');
const warn = require('../graphics-warning');
const Architecture = require('./architecture');
const Roles = require('./translator-roles');
const Requirements = require('./feature-requirements');
const Pairing = require('../../../core/runtime-resolution/translator-pairing');
const ReadPass = require('./read-pass');
const { compareRuntimeVersions } = require('./pinned-native-manager');
const SETTINGS = Object.freeze({ 'd3d-renderer': 'translatorRenderer', 'vulkan-driver': 'translatorVulkan', d3d12: 'translatorD3D12', video: 'translatorVideo' });

const Sources = () => require('../../crossover/sources');
const sourceFor = runtime => Sources().get(runtime) || Sources().get('sikarugir');
function includedTranslators(install, runtime, { engine: requestedEngine, describe } = {}) {
  const layout = wineLayout(install), result = [], warnings = [], nativeRoots = [], wine = sourceFor(runtime);
  const source = { kind: runtime, id: install.version || layout.root, runtime,
    label: require('./translator-label').hostLabel(install, { label: wine.labels.source }) };
  const add = (root, engine, component, extra = {}) => {
    if (requestedEngine && engine !== requestedEngine) return;
    if (!fs.existsSync(root)) return;
    try {
      let value = (describe || Description.describeTranslator)(root, { engine, component, source, ...extra });
      if (!value) return;
      // A supplied version is the reader's fallback; the component's own version text precedes it.
      value = Pairing.completeSets({ ...value, included: true, id: `included:${component}:${extra.templateComponent || engine}`, ...extra, version: value.version });
      const embed=wine.source?.included?.find(embed=>embed.engine===engine&&(!extra.templateComponent||embed.parts.some(part=>part.name===extra.templateComponent)));
      if(embed){value.sourceId=embed.id;value.embedId=embed.id;}
      if (!value.version && wine.includedVersion) value.version = wine.includedVersion(engine, layout, Description);
      result.push(value);
      if (engine === 'd3dmetal' && component === 'd3d-renderer') result.push({ ...value, component: 'd3d12', id: 'included:d3d12:d3dmetal' });
    } catch (error) { warnings.push(`${engine}: ${error.message}`); }
  };
  // GStreamer's release, read from its core library for a source whose
  // plugins folder carries no version text.
  const gstreamerVersion = core => {
    try {
      const value = (describe || Description.describeTranslator)(core, { engine: 'gstreamer', component: 'video', source, form: 'dylib' });
      return value ? value.version || require('./gstreamer-source').libraryVersion(value) : '';
    } catch (error) { if (error.code !== 'ENOENT') warnings.push(`gstreamer: ${error.message}`); return ''; }
  };
  wine.includedTranslators(install, add, { layout, describe, source, requestedEngine, warnings, nativeRoots, result, Description, gstreamerVersion });
  const direct3DWindows = [layout.primaryWindows, ...layout.windows.filter(name => name !== layout.primaryWindows)].filter(Boolean);
  const direct3DFiles = (!requestedEngine || requestedEngine === 'wined3d' || requestedEngine === 'vkd3d') ? direct3DWindows.flatMap(windows => fs.readdirSync(path.join(layout.dllRoot, windows)).filter(name => /^(?:d3d\d.*|dxgi)\.dll$/i.test(name)).map(name => {
    const file = path.join(layout.dllRoot, windows, name), relative = `${windows}/${name}`;
    const facts = describe ? describe(file, { engine: 'wined3d', component: 'd3d-renderer', source, form: 'builtin' })?.files[0] : Description.inspectFile({ path: file, relative });
    return facts && { ...facts, relative };
  }).filter(Boolean)) : [];
  const d3d12Files = direct3DFiles.filter(file => Roles.fileApis(file).includes('Direct3D 12'));
  if (!requestedEngine || requestedEngine === 'wined3d') result.push(Description.description({ id: 'included:d3d-renderer:wined3d', included: true, component: 'd3d-renderer', engine: 'wined3d', source,
    version: install.wineVersion || install.engineVersion || '', form: 'builtin', root: layout.root, files: direct3DFiles.filter(file => !d3d12Files.includes(file)) }));
  if ((!requestedEngine || requestedEngine === 'vkd3d') && d3d12Files.length) result.push(Description.description({ id: 'included:d3d12:vkd3d', included: true, component: 'd3d12', engine: 'vkd3d', source,
    version: d3d12Files[0].version || '', form: 'builtin', root: layout.root, files: d3d12Files }));
  return { included: result, warnings, layout, nativeRoots };
}
const SUMMARY_ORDER = Object.freeze(['dxmt', 'dxvk', 'd3dmetal', 'vkd3d-proton', 'moltenvk', 'kosmickrisp', 'gstreamer']);
const MACHINE_GAMES = Object.freeze({ 0x14c: '32-bit', 0x8664: '64-bit', 0xaa64: 'ARM64' });
// An installed Wine runtime names the translator versions it includes, from
// descriptions already prepared for its files; a component not described yet
// is left out until local preparation reads it. Wine's own WineD3D and vkd3d
// follow the Wine version.
function includedSummary(install, runtime, { userDataDir, logger } = {}) {
  if (!install || !userDataDir) return '';
  let included;
  try {
    included = includedTranslators(install, runtime, { describe: (root, selection) =>
      Description.cachedTranslator(root, { ...selection, userDataDir, logger }) }).included;
  } catch { return ''; }
  // Engines follow one order on every Wine source, newest version first
  // within an engine; Template folders are named when one engine has several
  // versions. A set complete only for some game architectures names them.
  const order = engine => (i => i < 0 ? SUMMARY_ORDER.length : i)(SUMMARY_ORDER.indexOf(engine));
  included = included.slice().sort((a, b) => order(a.engine) - order(b.engine) || compareRuntimeVersions(a.version || '', b.version || ''));
  const labels = new Map(), engines = new Map();
  for (const value of included) {
    if (value.hiddenChoice || value.engine === 'wined3d' || value.engine === 'vkd3d') continue;
    const games = value.incompleteMachines?.length && [...new Set(value.files.filter(file => file.format === 'pe').map(file => MACHINE_GAMES[file.machine]).filter(Boolean))];
    const text = require('./translator-label').componentLabel(value) + (games?.length ? ` for ${games.join(' and ')} games` : '');
    const group = labels.get(text) || { engine: value.engine, folders: new Set() };
    if (value.templateComponent) group.folders.add(value.templateComponent);
    labels.set(text, group);
    engines.set(value.engine, (engines.get(value.engine) || new Set()).add(text));
  }
  return [...labels].map(([text, { engine, folders }]) => engines.get(engine).size > 1 && folders.size ? `${text} (${[...folders].join(', ')})` : text).join(' · ');
}
function runtimeManagers() {
  const registry = require('../../registry');
  return [...registry.listSharedRuntimeManagers(), ...registry.listModuleIds().flatMap(id => registry.getModule(id)?.runtimeManagers || [])];
}
function managedTranslators(context, runtime, managers = runtimeManagers(), architecture, describe = Description.describeTranslator) {
  const choices = [], consumer = Architecture.targetArchitecture(architecture);
  for (const manager of managers.filter(manager => manager.translatorEngine || manager.translator?.engine)) {
    const inspect = () => {
    const state = manager.getState({ userDataDir: context.userDataDir, settings: context.settings?.runtimes?.[manager.id],
      runtimeSettings: context.settings?.runtimes, referenceStates: context.referenceStates });
    for (const version of new Set((state.installed || []).map(item => item.version))) {
      const selection = manager.resolveSelection?.(null, context.settings, context.userDataDir, { version, ...(consumer ? { architecture: consumer } : {}), verification: 'status' });
      let install = selection?.install || (!manager.resolveSelection && state.installed.find(item => item.version === version && (!consumer || Architecture.matchesArchitecture(item, consumer))));
      if (!install) continue;
      let description = install.translator || install.installationMetadata?.translator;
      if (!description) {
        try {
          description = describe(install.translatorRoot || install.payloadRoot || install.root || install.installDir,
            { engine: manager.translatorEngine || manager.translator.engine, version: install.versionLabel || install.version, source: manager.id });
        } catch (error) { warn(context.logger, `[translators] ${manager.label || manager.id}: ${error.message}`); continue; }
        // A description that is still being prepared joins the next read.
        if (!description) continue;
      }
      if (description.source?.runtime && description.source.runtime !== runtime && Sources().get(description.source.runtime)?.ownComponents) continue;
      const root = install.translatorRoot || install.payloadRoot || (install.installDir && path.join(install.installDir, install.installationMetadata?.translatorRelative || '')) || install.root;
      const value = { ...description, id: `${manager.id}:${install.version}`, root, entryPoint: install.executablePath || description.entryPoint,
        aliases: [...(description.aliases || []), ...(manager.formerIds || []).map(id => `${id}:${install.version}`)],
        managerId: manager.id, settingsEngine: manager.translatorEngine || manager.translator?.engine, runtimeVersion: install.version, architecture: Architecture.recordArchitecture(install) || selection?.architecture,
        variant: install.variant, sectionId: install.sectionId || selection?.sectionId || 'default', buildKey: install.buildKey,
        files: description.files.map(file => ({ ...file, path: path.resolve(root, file.path) })) };
      const declaration=manager.sources?.find(source=>source.manager?.sectionId===value.sectionId)||manager.sources?.[0];
      if(declaration)value.sourceId=declaration.id;
      // What this release's source declares: the Vulkan features it requires of
      // the driver, the DXGI it presents through, and the source's order.
      const catalogSource = typeof description.source === 'object' ? description.source?.id : null;
      const declared = require('./translator-managers').sourceDeclaration(value.settingsEngine, catalogSource) || declaration;
      if (declared?.id) value.sourceId = declared.id;
      const vulkanRequires = require('./vulkan-features').required(declared, description.version);
      if (vulkanRequires.length) value.vulkanRequires = vulkanRequires;
      if (declared?.dxgi) value.dxgiRequires = { ...declared.dxgi };
      if (Number.isFinite(declared?.order)) value.sourceOrder = declared.order;
      choices.push(value);
      if (value.engine === 'd3dmetal') choices.push({ ...value, id: value.id + ':d3d12', component: 'd3d12' });
    }
    };
    // One pass reads the manager's installed versions once for its state and
    // every version's selection.
    ReadPass.within(() => consumer ? Architecture.withArchitecture(consumer, inspect) : inspect());
  }
  return choices;
}
function inventory(install, runtime, context, dependencies = {}) {
  const remembered = item => ({ ...item, ...Description.cachedVulkanFeatures(item, context) });
  const included = dependencies.includedInventory || (install ? includedTranslators(install, runtime) : { included: [], warnings: [], layout: null });
  const result = { ...included, included: included.included.map(remembered) };
  const managers = dependencies.managers || runtimeManagers();
  const consumerArchitecture = result.layout?.architecture || dependencies.consumerArchitecture;
  const choices = (dependencies.choices || managedTranslators(context, runtime, managers, consumerArchitecture)).map(remembered);
  for (const manager of managers.filter(manager => choices.some(item => item.managerId === manager.id))) {
    const entry = { ...dependencies.entry, runtimeId: manager.id };
    if (!entry.runtimeData?.[manager.id]?.version && !require('./custom-runtime').defaultVersion(context.settings, manager.id)) continue;
    const preferred = manager.resolveSelection?.(entry, context.settings, context.userDataDir, {
      ...(Architecture.targetArchitecture(consumerArchitecture) ? { architecture: Architecture.targetArchitecture(consumerArchitecture) } : {}), verification: 'status' });
    if (!preferred?.ready || !preferred.install) continue;
    const install = preferred.install, root = install.translatorRoot || install.payloadRoot ||
      (install.installDir && path.join(install.installDir, install.installationMetadata?.translatorRelative || '')) || install.root;
    for (const item of choices) if (item.managerId === manager.id && item.runtimeVersion === install.version && item.root === root &&
        (!item.architecture || !Architecture.recordArchitecture(install) || item.architecture === Architecture.recordArchitecture(install))) item.preferred = true;
  }
  const current = context.wineEnvironment;
  const environment = current ? { label: sourceFor(runtime).labels.environment, selections: {} } : null;
  if (current) for (const [component, key] of [['d3d-renderer', 'graphicsBackend'], ['vulkan-driver', 'vulkanBackend']]) {
    const engine = current.settings?.[key];
    environment.selections[component] = result.included.find(item => item.component === component && item.engine === engine &&
      (!item.templateComponent || item.templateComponent === engine)) ||
      (engine && engine !== 'auto' && engine !== 'automatic' ? { component, engine, version: '', source: current.name, files: [] } : null);
  }
  const selections = Object.fromEntries(Object.entries(SETTINGS).map(([component, key]) => [component, context.runtimeSettings?.[key] || (current ? Plan.INHERIT : Plan.AUTOMATIC)]));
  // Existing explicit backend choices keep their saved meaning; no override stays automatic.
  if (!context.runtimeSettings?.translatorRenderer && !current && context.runtimeSettings?.graphicsBackend && context.runtimeSettings.graphicsBackend !== 'auto')
    selections['d3d-renderer'] = result.included.find(item => item.component === 'd3d-renderer' && (item.templateComponent || item.engine) === context.runtimeSettings.graphicsBackend)?.id || Plan.AUTOMATIC;
  if (!context.runtimeSettings?.translatorVulkan && !current && context.runtimeSettings?.vulkanBackend && context.runtimeSettings.vulkanBackend !== 'auto')
    selections['vulkan-driver'] = result.included.find(item => item.component === 'vulkan-driver' && item.engine === context.runtimeSettings.vulkanBackend)?.id || Plan.AUTOMATIC;
  const legacyBackend = context.runtimeSettings?.graphicsBackend || 'auto';
  if (!context.runtimeSettings?.translatorRenderer && selections['d3d-renderer'] !== Plan.INHERIT &&
      (legacyBackend === 'dxmt' || !sourceFor(runtime).graphicsSelector && legacyBackend === 'auto')) {
    const manager = managers.find(item => item.translatorEngine === 'dxmt' || item.translator?.engine === 'dxmt');
    const entry = dependencies.entry;
    const version = context.runtimeSettings?.graphicsBridgeVersion;
    const explicit = version && version !== 'auto' || entry?.runtimeData?.[manager?.id]?.version || context.settings?.runtimes?.[manager?.id]?.defaultVersion;
    if (manager && explicit) {
      const selected = manager.resolveSelection(entry, context.settings, context.userDataDir, { version: version && version !== 'auto' ? version : undefined,
        ...(Architecture.targetArchitecture(consumerArchitecture) ? { architecture: Architecture.targetArchitecture(consumerArchitecture) } : {}), verification: 'status' });
      const legacy = choices.find(item => item.managerId === manager.id && item.runtimeVersion === selected.version);
      selections['d3d-renderer'] = legacy?.id || `${manager.id}:${selected.version}`;
    }
  }
  return { ...result, choices, environment, selections, runtime };
}
// Settings enumerate recorded facts. Actual load checks and native preparation
// remain in resolve(), after Play has selected its runtime and executable.
async function optionsInventory(install, runtime, context, dependencies = {}) {
  context = { ...context, referenceStates: new Map() };
  const managers = dependencies.managers || runtimeManagers();
  const key = dependencies.reuse ? reusableKey(install, runtime, context, dependencies) : null;
  let facts;
  if (key) {
    let pending = reusable.get(key);
    if (!pending) {
      pending = inventoryFacts(install, runtime, context, { ...dependencies, managers });
      reusable.set(key, pending);
      while (reusable.size > 8) reusable.delete(reusable.keys().next().value);
      pending.catch(() => { if (reusable.get(key) === pending) reusable.delete(key); });
    }
    try { facts = structuredClone(await pending); }
    catch (error) {
      // Another request's cancellation does not cancel this one.
      if (error?.name !== 'AbortError' || context.signal?.aborted) throw error;
      facts = await inventoryFacts(install, runtime, context, { ...dependencies, managers });
    }
  } else facts = await inventoryFacts(install, runtime, context, { ...dependencies, managers });
  return inventory(install, runtime, context, { ...dependencies, managers, includedInventory: facts.includedInventory, choices: facts.choices });
}
// Display inventories are reused within a backend lane until its runtime
// inventory revision changes, so one selection's status, choices and effects
// read installed runtimes once. Play always reads them again.
const reusable = new Map();
function reusableKey(install, runtime, context, dependencies) {
  const revision = require('../../../core/runtime-inventory-revision').current();
  if (revision === null || dependencies.choices) return null;
  const host = install && ['executablePath', 'installDir', 'crossoverRoot', 'templateRoot', 'supportRoot', 'version', 'versionLabel', 'upstreamVersion', 'engineVersion', 'architecture']
    .map(field => install[field] ?? null);
  // An installed Wine's own layout selects the translator CPU; the consumer's
  // CPU applies only without one.
  return JSON.stringify([revision, runtime, host, context.userDataDir || null, context.settings?.runtimes ?? null, install ? null : dependencies.consumerArchitecture ?? null]);
}
// Reads an installed Wine runtime's included translators, preparing each
// description that is not retained yet. This runs in a backend lane.
async function describedIncluded(install, runtime, context) {
  const pending = new Map(), options = { userDataDir: context.userDataDir, logger: context.logger };
  const describe = (root, selection) => {
    const value = Description.cachedTranslator(root, { ...selection, ...options });
    if (!value) {
      const key = JSON.stringify([root, selection]);
      if (!pending.has(key)) pending.set(key, () => Description.prepareTranslator(root, { ...selection, ...options }));
    }
    return value;
  };
  // Yield between independent
  // roots, so a cold inventory can be canceled without holding up other work.
  const attempted = new Set();
  let includedInventory;
  for (;;) {
    includedInventory = install ? includedTranslators(install, runtime, { describe }) : { included: [], warnings: [], layout: null };
    const missing = [...pending].filter(([key]) => !attempted.has(key));
    if (!missing.length) break;
    for (const [key, prepare] of missing) {
      attempted.add(key);
      context.signal?.throwIfAborted();
      // An optional library that is absent, such as a runtime's codec core, is not a warning.
      try { await prepare(); } catch (error) { if (error.code !== 'ENOENT') warn(context.logger, `[translators] ${error.message}`); }
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  return includedInventory;
}
// Managed translator installs without a recorded description are read like
// included ones: from the facts retained under the profile, prepared once when
// missing, so a new backend lane or launcher start reads no translator
// binaries. A description that could not be retained is read directly.
async function describedManaged(context, runtime, managers, architecture) {
  if (!context.userDataDir) return managedTranslators(context, runtime, managers, architecture);
  const pending = new Map(), attempted = new Set(), options = { userDataDir: context.userDataDir, logger: context.logger };
  const describe = (root, selection) => {
    const value = Description.cachedTranslator(root, { ...selection, ...options }), key = JSON.stringify([root, selection]);
    if (value) return value;
    if (attempted.has(key)) return Description.describeTranslator(root, selection);
    if (!pending.has(key)) pending.set(key, () => Description.prepareTranslator(root, { ...selection, ...options }));
    return null;
  };
  for (;;) {
    // Launcher-start preparation lets queued requests run between managers'
    // state reads; it never waits for them, since a request may be waiting
    // for this inventory.
    const choices = [], groups = context.preparing
      ? managers.filter(manager => manager.translatorEngine || manager.translator?.engine).map(manager => [manager]) : [managers];
    for (const group of groups) {
      choices.push(...managedTranslators(context, runtime, group, architecture, describe));
      if (context.preparing) await new Promise(resolve => setImmediate(resolve));
    }
    const missing = [...pending].filter(([key]) => !attempted.has(key));
    if (!missing.length) return choices;
    for (const [key, prepare] of missing) {
      attempted.add(key);
      context.signal?.throwIfAborted();
      // A failure is reported by the direct read on the next pass.
      try { await prepare(); } catch {}
      await new Promise(resolve => setImmediate(resolve));
    }
  }
}
async function inventoryFacts(install, runtime, context, dependencies) {
  const { managers } = dependencies;
  if(dependencies.readOnly){
    const describe=(root,selection)=>Description.cachedTranslator(root,{...selection,userDataDir:context.userDataDir});
    const includedInventory=install?includedTranslators(install,runtime,{describe}):{included:[],warnings:[],layout:null};
    return {includedInventory,choices:dependencies.choices||managedTranslators(context,runtime,managers,includedInventory.layout?.architecture||dependencies.consumerArchitecture,describe)};
  }
  if (!dependencies.choices) for (const manager of managers.filter(item => item.translatorEngine || item.translator?.engine))
    if (manager.prepareLocalState) await manager.prepareLocalState({ ...context, settings: context.settings?.runtimes?.[manager.id], runtimeSettings: context.settings?.runtimes });
  const includedInventory = await describedIncluded(install, runtime, context);
  if (dependencies.choices) return { includedInventory, choices: dependencies.choices };
  const Component = require('./component-runtime');
  const choices = await describedManaged(context, runtime, managers, includedInventory.layout?.architecture || dependencies.consumerArchitecture);
  const seen = new Set(choices.map(item => item.id));
  for (const manager of managers.filter(item => item.referenceManagerIds?.length))
    for (const item of Component.referencedComponents(manager.translatorEngine || manager.translator.engine, context)) {
      const value = item.description;
      if (value.source?.runtime && value.source.runtime !== runtime && Sources().get(value.source.runtime)?.ownComponents || seen.has(item.id)) continue;
      seen.add(item.id);
      choices.push({ ...value, id: item.id, included: false, managerId: item.reference.managerId,
        runtimeVersion: item.reference.version, architecture: Architecture.recordArchitecture(item.install),
        variant: item.install.variant, sectionId: item.install.sectionId || 'default', buildKey: item.install.buildKey,
        reference: item.reference });
    }
  return { includedInventory, choices };
}
function optionsPlan(input, context) {
  return Plan.resolveApiRoles(Plan.resolvePlan(input), { ...input,
    selections: Object.fromEntries(Roles.DIRECT3D_ROLES.map(role => [role.id, context.runtimeSettings?.[role.settingsKey]])) });
}
function requirement(plan, context, { managers = runtimeManagers() } = {}) {
  const engine = plan.requiredTranslators?.[0];
  if (!engine) {
    if (plan.pairingError) throw new Error(plan.pairingError);
    return null;
  }
  const manager = managers.find(item => (item.translatorEngine || item.translator?.engine) === engine);
  if (!manager) throw new Error(plan.pairingError);
  const architecture = Architecture.targetArchitecture(plan.layout?.architecture);
  const installOptions = architecture ? { architecture } : {};
  const selected = manager.resolveSelection(null, context.settings, context.userDataDir, { ...installOptions, verification: 'status' });
  if (selected.ready) throw new Error(`${plan.pairingError} The installed ${manager.label || engine} has no compatible libraries. Choose a compatible translator in Runtime Settings.`);
  if (!selected.version && !selected.discoveryRequired) throw new Error(selected.reason || plan.pairingError);
  return { managerId: manager.id, version: selected.version || null, requiresDownload: true, installOptions,
    ...(selected.discoveryRequired ? { discoveryRequired: true } : {}), detail: plan.pairingError };
}
function environmentContext(context, install) {
  const value = context.runtimeSettings?.environmentReference;
  if (value === undefined) return context;
  const reader = require('./wine-environment');
  const reference = reader.environmentReference(value);
  if (!reference) return context.wineEnvironment ? { ...context, wineEnvironment: null } : context;
  if (context.wineEnvironment?.reference?.path === reference.path && context.wineEnvironment?.kind === reference.kind) return context;
  return reference ? { ...context, wineEnvironment: reader.readEnvironment(reference, { userDataDir: context.userDataDir, crossoverRoot: install?.crossoverRoot }) } : context;
}
let resolverInstance;
const wineResolver=()=>resolverInstance ||= require('../../../core/runtime-resolution/wine-plan').createWineResolver({optionsInventory,sourceFor});
const resolve=(...args)=>wineResolver().resolve(...args);
const driverRequirements=(context, options = {})=>wineResolver().driverRequirements(context, { ...options, managers: options.managers || runtimeManagers() });
function engines(plan) {
  const result = Object.fromEntries(Object.entries(plan.components).map(([component, row]) => [component, row.used?.engine || null]));
  const used = [...new Set(Roles.usedRenderers(plan).map(item => item.settingsEngine || item.engine))];
  result['d3d-renderer'] = used.length === 1 ? used[0] : used.length ? used : null;
  return result;
}
// Translator environments of a launch: the Wine runtime's own, then each
// translator engine the plan uses.
function environmentIds(plan, runtime) {
  return [...new Set([runtime, ...Object.values(plan ? engines(plan) : {}).flatMap(engine => [].concat(engine || []))])];
}
function settingsForPlan(settings, plan) {
  const result = { ...settings }, renderer = plan.components['d3d-renderer'].used, vulkan = plan.components['vulkan-driver'].used;
  const files = require('./translator-files');
  if (plan.apiMode || files.placesDirect3D(plan)) result.graphicsBackend = files.placedGraphicsBackend(plan);
  else if (renderer) result.graphicsBackend = renderer.engine;
  else if (settings.translatorRenderer === Plan.AUTOMATIC || plan.components['d3d-renderer'].fallback) result.graphicsBackend = 'auto';
  if (vulkan) result.vulkanBackend = vulkan.engine;
  else if (settings.translatorVulkan === Plan.AUTOMATIC || plan.components['vulkan-driver'].fallback) result.vulkanBackend = 'auto';
  return result;
}
function withSettings(manifest) {
  const result = structuredClone(manifest);
  const controls = [{ label: 'Default Direct3D engine', settingsKey: SETTINGS['d3d-renderer'],
    optionsKey: SETTINGS['d3d-renderer'] + 'Options', description: 'Sets the renderer for Direct3D versions without an override.' },
    ...Roles.ROLES.map(role => ({ ...role, description: role.apis.length ? 'Chooses the installed translator for this Direct3D version. Shared libraries can also update linked Direct3D choices.' :
      role.id === 'vulkan-driver' ? 'Chooses the Vulkan driver used by translators that render through Vulkan.' : "Adds codec plugins to the runtime's video support." }))];
  for (const runtime of Object.keys(result.runtime.entries)) {
    const schema = result.runtime.entries[runtime].settings;
    schema.visibilityAction = 'listRuntimeRoles';
    schema.environmentAction = 'listRuntimeRoles';
    const index = schema.fields.findIndex(field => field.key === 'graphicsBackend');
    // Retain saved legacy values for existing games, without a second editable
    // selector.
    for (const field of schema.fields) if (['graphicsBackend', 'vulkanBackend', 'graphicsBridgeVersion'].includes(field.key)) field.hidden = true;
    for (const role of controls) schema.defaults[role.settingsKey] = '';
    schema.fields.splice(Math.max(0, index), 0, ...controls.map(role => {
      return { key: role.settingsKey, type: 'select', label: role.label, optionsAction: 'listRuntimeRoles', optionsKey: role.optionsKey,
        options: [{ value: '', label: sourceFor(runtime).labels.automatic }],
        inheritFrom: 'environmentReference', inheritanceInOptions: true, section: 'Basic',
        description: role.description };
    }));
  }
  return result;
}
// A Vulkan driver loads as the slice of the Wine process's CPU: the one
// wine-layout.js inspects, managedTranslators selects its build for and Play
// checks before loading. The inspector names that build; settings menus share
// it across every entry, so they do not repeat it.
function nativeBuildSuffix(description, layout, host) {
  if (description?.component !== 'vulkan-driver' || !description.files?.some(file => file.format === 'macho')) return '';
  const build = Architecture.cpuBuildLabel(layout?.architecture, host ? { host } : {});
  return build ? ` · ${build}` : '';
}
function optionLists(install, runtime, context, dependencies = {}) {
  const input = dependencies.inventory || inventory(install, runtime, context, dependencies), plan = dependencies.plan || Plan.resolvePlan(input);
  // A Direct3D set with no complete libraries for the game's architecture is not offered.
  const machine = Binary.requiredMachine(dependencies.executableArchitecture);
  if (machine) for (const key of ['included', 'choices']) input[key] = input[key].filter(item => !['d3d-renderer', 'd3d12'].includes(item.component) ||
    !item.files?.some(file => file.format === 'pe' && file.machine) || item.files.some(file => file.format === 'pe' && file.machine === machine));
  if (plan.compatibility) for (const key of ['included', 'choices']) input[key] = input[key].map(item => {
    const files = plan.compatibility[item.id]?.files || plan.compatibility[item.id]?.inspectedFiles || item.files;
    return { ...item, files, ...(['d3d-renderer', 'd3d12'].includes(item.component) && files.some(file => file.format === 'pe') ? { apis: Roles.apisForFiles(files) } : {}) };
  });
  // A Vulkan driver whose measured features lack one that a used translator requires is not offered.
  const roles = plan.components.d3d11 ? plan : Plan.projectRoles(plan);
  const vulkanRequires = [...new Set(Object.values(roles.components).flatMap(row => row?.used?.vulkanRequires || []))];
  const legacy = Object.fromEntries(Object.entries(SETTINGS).map(([component, key]) => {
    const rows = Plan.options({ ...input, component, included: input.included.filter(item => !item.hiddenChoice), vulkanRequires });
    if (!context.runtimeSettings?.[key]) {
      const current = rows.find(row => row.value === (plan.components[component].selected?.id || input.selections[component]));
      if (current) current.value = ''; // The unset control preserves its existing saved backend.
    }
    return [key + 'Options', rows];
  }));
  return { ...legacy, ...Plan.apiOptions(roles, { ...input,
    selections: Object.fromEntries(Roles.DIRECT3D_ROLES.map(role => [role.id, context.runtimeSettings?.[role.settingsKey]])) }) };
}
// The settings and Wine installation that decide a translator plan. Rows
// recorded at Play describe the current settings while these are unchanged.
function planInputs(settings = {}, install) {
  return { wine: [install?.executablePath || null, install?.versionLabel || install?.upstreamVersion || install?.engineVersion || null],
    environmentReference: settings.environmentReference ?? null,
    settings: Object.fromEntries([SETTINGS['d3d-renderer'], ...Roles.ROLES.map(role => role.settingsKey)].map(key => [key, settings[key] ?? ''])) };
}
const samePlanInputs = (recorded, settings, install) => Boolean(recorded) && JSON.stringify(recorded) === JSON.stringify(planInputs(settings, install));
// Rows recorded at an earlier Play are worded as current rows are.
function presentInspectorRows(rows) {
  const { presentLabel } = require('./translator-label');
  return rows.map(row => {
    const reasonCode = row.reasonCode || (row.fallback ? 'recorded-fallback' : null);
    return { ...row, reasonCode, used: typeof row.used === 'string' ? presentLabel(row.used) : row.used,
      selected: reasonCode === 'missing-choice' ? Plan.UNAVAILABLE_CHOICE_LABEL : typeof row.selected === 'string' ? presentLabel(row.selected) : row.selected,
      reason: row.fallback && reasonCode !== 'load-impossible' ? Plan.fallbackNotice(reasonCode, { roles: row.conflictRoles }) : row.reason };
  });
}
function inspectorRows(plan, { host } = {}) {
  const labels = { 'd3d-renderer': 'Direct3D', 'vulkan-driver': 'Vulkan', d3d12: 'Direct3D 12', video: 'Video codecs' };
  const entries = plan.components.d3d11 ? Roles.ROLES.map(role => [role.id, role.settingsKey]) : Object.entries(SETTINGS);
  const automatic = sourceFor(plan.runtime).labels.automatic;
  // Placed Direct3D libraries switch CrossOver to WineD3D, which then serves
  // every Direct3D API that has no placed library of its own.
  const builtin = plan.builtinRenderer && require('./translator-files').placesDirect3D(plan) ? Description.label(plan.builtinRenderer) : null;
  return presentInspectorRows(entries.map(([component, key]) => {
    const row = plan.components[component], direct3D = Roles.DIRECT3D_ROLES.some(role => role.id === component);
    // A default Direct3D engine without this API, such as DXMT for Direct3D 9,
    // leaves the API to the runtime's automatic choice.
    const apis = Roles.ROLES.find(role => role.id === component)?.apis;
    const selected = row.selected && (!apis?.length || !row.selected.apis?.length || row.selected.apis.some(api => apis.includes(api))) ? row.selected : null;
    const used = row.used ? Description.label(row.used) + nativeBuildSuffix(row.used, plan.layout, host) : direct3D && builtin || automatic;
    // An automatic selection reads "Automatic" before the component it uses,
    // as the Version row does; left to the runtime, its choice reads once.
    return { id: key, component, label: labels[component] || Roles.ROLES.find(role => role.id === component)?.label,
      selected: selected ? Description.label(selected) : row.fallback ? Plan.UNAVAILABLE_CHOICE_LABEL : row.inherited ? 'Inherited' : used === automatic ? automatic : 'Automatic',
      used, reason: row.reason, reasonCode: row.reasonCode, fallback: row.fallback,
      ...(row.conflictRoles?.length ? { conflictRoles: row.conflictRoles } : {}) };
  }));
}
module.exports = { SETTINGS, includedTranslators, includedSummary, describedIncluded, managedTranslators, inventory, optionsInventory, optionsPlan, requirement, driverRequirements, resolve, engines, environmentIds, settingsForPlan, wineRoot, withSettings, optionLists, inspectorRows, presentInspectorRows, planInputs, samePlanInputs, environmentContext };

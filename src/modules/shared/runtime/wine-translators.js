const fs = require('node:fs'), path = require('node:path');
const Description = require('./translator-description'), Plan = require('./translator-plan');
const { wineLayout, wineRoot } = require('./wine-layout');
const Binary = require('./binary-compatibility');
const { systemVersionSync } = require('./bundled-native');
const warn = require('../graphics-warning');
const Architecture = require('./architecture');
const Roles = require('./translator-roles');
const SETTINGS = Object.freeze({ 'd3d-renderer': 'translatorRenderer', 'vulkan-driver': 'translatorVulkan', d3d12: 'translatorD3D12', video: 'translatorVideo' });

function includedTranslators(install, runtime, { engine: requestedEngine, describe } = {}) {
  const layout = wineLayout(install), result = [], warnings = [], nativeRoots = [];
  const source = { kind: runtime, id: install.version || layout.root, runtime,
    label: require('./translator-label').hostLabel(install, { label: runtime === 'crossover' ? 'CrossOver' : 'Sikarugir Template' }) };
  const add = (root, engine, component, extra = {}) => {
    if (requestedEngine && engine !== requestedEngine) return;
    if (!fs.existsSync(root)) return;
    try {
      let value = (describe || Description.describeTranslator)(root, { engine, component, source, ...extra });
      if (!value) return;
      // A supplied version is the reader's fallback; the component's own version text precedes it.
      value = { ...value, included: true, id: `included:${component}:${extra.templateComponent || engine}`, ...extra, version: value.version };
      if (!value.version && runtime === 'crossover') {
        try {
          const name = Description.label({ engine }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          value.version = fs.readFileSync(path.join(layout.root, 'changelog.html'), 'utf8').match(new RegExp(`Update to ${name}\\s+v?(\\d+(?:\\.\\d+)+(?:[a-z]\\d*)?)`, 'i'))?.[1] || '';
        } catch {}
      }
      result.push(value);
      if (engine === 'd3dmetal' && component === 'd3d-renderer') result.push({ ...value, component: 'd3d12', id: 'included:d3d12:d3dmetal' });
    } catch (error) { warnings.push(`${engine}: ${error.message}`); }
  };
  if (runtime === 'crossover') {
    for (const engine of ['dxmt', 'dxvk']) add(path.join(layout.root, 'lib', engine), engine, 'd3d-renderer');
    add(path.join(layout.root, 'lib64/apple_gptk'), 'd3dmetal', 'd3d-renderer');
    add(path.join(layout.root, 'lib64/libMoltenVK.dylib'), 'moltenvk', 'vulkan-driver', { form: 'dylib' });
    if (!requestedEngine || requestedEngine === 'gstreamer') {
      let version = '';
      try {
        const core = (describe || Description.describeTranslator)(path.join(layout.root, 'lib64/libgstreamer-1.0.0.dylib'),
          { engine: 'gstreamer', component: 'video', source, form: 'dylib' });
        if (core) version = core.version || require('./gstreamer-source').libraryVersion(core);
      } catch (error) { if (error.code !== 'ENOENT') warnings.push(`gstreamer: ${error.message}`); }
      add(path.join(layout.root, 'lib64/gstreamer-1.0'), 'gstreamer', 'video', { form: 'dylib', version });
    }
  } else {
    const { RELATIVE_PATHS, templateRenderers, gstreamerPaths } = require('../../crossover/sikarugir/graphics/closure');
    const support = install.templateRoot || install.supportRoot || path.join(install.installDir, 'support');
    const gstreamer = gstreamerPaths(support);
    add(gstreamer.plugins, 'gstreamer', 'video', { form: 'dylib', frameworkRoot: gstreamer.root });
    // This is the same explicit DYLD root used by the Sikarugir launcher.
    if (fs.existsSync(gstreamer.lib)) nativeRoots.push(gstreamer.lib);
    const rendererPath = fs.existsSync(path.join(support, RELATIVE_PATHS.renderers)) ? RELATIVE_PATHS.renderers : templateRenderers(support, install.templateVersion);
    const renderers = rendererPath && path.join(support, rendererPath);
    if (renderers) for (const name of fs.readdirSync(renderers).sort()) {
      const engine = /^(?:dxvk|d9vk)/.test(name) ? 'dxvk' : name;
      if (['dxmt', 'dxvk', 'd3dmetal', 'cnc_ddraw'].includes(engine)) add(path.join(renderers, name), engine, 'd3d-renderer', { templateComponent: name, hiddenChoice: engine === 'cnc_ddraw' });
    }
    const vulkan = path.join(support, RELATIVE_PATHS.vulkan);
    if (fs.existsSync(vulkan)) for (const name of fs.readdirSync(vulkan).filter(name => name.endsWith('.json'))) {
      const engine = /kosmickrisp/i.test(name) ? 'kosmickrisp' : /moltenvk/i.test(name) ? 'moltenvk' : null;
      if (requestedEngine && engine !== requestedEngine) continue;
      try {
        const descriptor = JSON.parse(fs.readFileSync(path.join(vulkan, name), 'utf8')), library = path.resolve(vulkan, descriptor.ICD.library_path);
        if (engine) {
          const before = result.length; add(library, engine, 'vulkan-driver', { form: 'icd' });
          if (result.length > before) {
            const description = result.at(-1); description.icd = path.join(vulkan, name);
            const relative = path.join(RELATIVE_PATHS.frameworks, 'libvulkan.1.dylib'), loader = path.join(support, relative);
            if (fs.existsSync(loader)) {
              const file = describe ? describe(loader, { engine, component: 'vulkan-driver', source, form: 'dylib' })?.files[0] : Description.inspectFile({ path: loader, relative });
              if (file) description.files.push({ ...file, relative });
            }
          }
        }
      } catch (error) { warnings.push(error.message); }
    }
  }
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
  // Template folders are named when one engine has several versions.
  const labels = new Map(), engines = new Map();
  for (const value of included) {
    if (value.hiddenChoice || value.engine === 'wined3d' || value.engine === 'vkd3d') continue;
    const text = require('./translator-label').componentLabel(value), group = labels.get(text) || { engine: value.engine, folders: new Set() };
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
function managedTranslators(context, runtime, managers = runtimeManagers(), architecture) {
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
          description = install.translator || install.installationMetadata?.translator || Description.describeTranslator(install.translatorRoot || install.payloadRoot || install.root || install.installDir,
            { engine: manager.translatorEngine || manager.translator.engine, version: install.versionLabel || install.version, source: manager.id });
        } catch (error) { warn(context.logger, `[translators] ${manager.label || manager.id}: ${error.message}`); continue; }
      }
      if (description.source?.runtime === 'crossover' && runtime !== 'crossover') continue;
      const root = install.translatorRoot || install.payloadRoot || (install.installDir && path.join(install.installDir, install.installationMetadata?.translatorRelative || '')) || install.root;
      const value = { ...description, id: `${manager.id}:${install.version}`, root, entryPoint: install.executablePath || description.entryPoint,
        aliases: [...(description.aliases || []), ...(manager.formerIds || []).map(id => `${id}:${install.version}`)],
        managerId: manager.id, settingsEngine: manager.translatorEngine || manager.translator?.engine, runtimeVersion: install.version, architecture: Architecture.recordArchitecture(install) || selection?.architecture,
        variant: install.variant, sectionId: install.sectionId || selection?.sectionId || 'default', buildKey: install.buildKey,
        files: description.files.map(file => ({ ...file, path: path.resolve(root, file.path) })) };
      choices.push(value);
      if (value.engine === 'd3dmetal') choices.push({ ...value, id: value.id + ':d3d12', component: 'd3d12' });
    }
    };
    if (consumer) Architecture.withArchitecture(consumer, inspect);
    else inspect();
  }
  return choices;
}
function inventory(install, runtime, context, dependencies = {}) {
  const result = dependencies.includedInventory || (install ? includedTranslators(install, runtime) : { included: [], warnings: [], layout: null });
  const managers = dependencies.managers || runtimeManagers();
  const consumerArchitecture = result.layout?.architecture || dependencies.consumerArchitecture;
  const choices = dependencies.choices || managedTranslators(context, runtime, managers, consumerArchitecture);
  const current = context.wineEnvironment;
  const environment = current ? { label: runtime === 'crossover' ? 'Bottle setting' : 'Wrapper setting', selections: {} } : null;
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
      (legacyBackend === 'dxmt' || runtime === 'sikarugir' && legacyBackend === 'auto')) {
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
async function inventoryFacts(install, runtime, context, dependencies) {
  const { managers } = dependencies;
  if (!dependencies.choices) for (const manager of managers.filter(item => item.translatorEngine || item.translator?.engine))
    if (manager.prepareLocalState) await manager.prepareLocalState({ ...context, settings: context.settings?.runtimes?.[manager.id], runtimeSettings: context.settings?.runtimes });
  const includedInventory = await describedIncluded(install, runtime, context);
  if (dependencies.choices) return { includedInventory, choices: dependencies.choices };
  const Component = require('./component-runtime');
  const choices = managedTranslators(context, runtime, managers, includedInventory.layout?.architecture || dependencies.consumerArchitecture);
  const seen = new Set(choices.map(item => item.id));
  for (const manager of managers.filter(item => item.referenceManagerIds?.length))
    for (const item of Component.referencedComponents(manager.translatorEngine || manager.translator.engine, context)) {
      const value = item.description;
      if (value.source?.runtime === 'crossover' && runtime !== 'crossover' || seen.has(item.id)) continue;
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
function environmentContext(context, install) {
  const value = context.runtimeSettings?.environmentReference;
  if (value === undefined) return context;
  const reader = require('./wine-environment');
  const reference = reader.environmentReference(value);
  if (!reference) return context.wineEnvironment ? { ...context, wineEnvironment: null } : context;
  if (context.wineEnvironment?.reference?.path === reference.path && context.wineEnvironment?.kind === reference.kind) return context;
  return reference ? { ...context, wineEnvironment: reader.readEnvironment(reference, { userDataDir: context.userDataDir, crossoverRoot: install?.crossoverRoot }) } : context;
}
async function resolve(install, runtime, context, { executableArchitecture, host = {}, ...dependencies } = {}) {
  const input = await optionsInventory(install, runtime, context, dependencies);
  // Display records omit native symbols. Play completes those facts before
  // checking Wine imports; video completes its own selected plugin closure.
  const complete = item => item.component === 'video' ? item : { ...item, files: item.files.map(file =>
    file.format === 'macho' && file.slices?.some(slice => slice.importsComplete !== true) && fs.existsSync(file.path)
      ? Description.inspectFile(file) : file) };
  input.included = input.included.map(complete); input.choices = input.choices.map(complete);
  const record = await Binary.wineCompatibilityRecord(install), compatibility = {};
  for (const description of [...input.included, ...input.choices]) compatibility[description.id] = Binary.compatibility(description, record,
    { executableArchitecture, macOSVersion: host.macOSVersion || systemVersionSync() });
  const roleRequested = Roles.DIRECT3D_ROLES.some(role => role.id !== 'd3d12' && context.runtimeSettings?.[role.settingsKey]);
  const actual = item => {
    const files = !roleRequested && compatibility[item.id]?.files || item.files.map(file => fs.existsSync(file.path) ? Description.inspectFile(file) : file);
    compatibility[item.id].inspectedFiles = files;
    return { ...item, files, ...(['d3d-renderer', 'd3d12'].includes(item.component) && files.some(file => file.format === 'pe') ? { apis: Roles.apisForFiles(files) } : {}) };
  };
  input.included = input.included.map(actual); input.choices = input.choices.map(actual);
  const apiCompatibility = roleRequested ? Object.fromEntries(Roles.DIRECT3D_ROLES.map(role => [role.id,
    Object.fromEntries([...input.included, ...input.choices].filter(item => ['d3d-renderer', 'd3d12'].includes(item.component)).map(item => {
      const files = Plan.filesForRole(item, role), primary = files.filter(file => Roles.fileApis(file).some(api => role.apis.includes(api)));
      const imports = new Set(primary.flatMap(file => file.peImports || []));
      const requiredPaths = files.filter(file => primary.includes(file) || imports.has(path.basename(file.path).toLowerCase())).map(file => file.path);
      return [item.id, Binary.compatibility({ ...item, files, requiredPaths }, record,
        { executableArchitecture, macOSVersion: host.macOSVersion || systemVersionSync() })];
    }))])) : {};
  const plan = { ...Plan.resolvePlan({ ...input, compatibility }), layout: input.layout, compatibility, record };
  const videoRow = plan.components.video, selectedVideo = videoRow.selected || videoRow.used;
  if (selectedVideo && fs.existsSync(selectedVideo.root) && !(videoRow.inherited && !videoRow.fallback)) {
    // Only an actual video preparation needs the extra host-native closure.
    // Its roots come from the real launcher, never exploratory package names.
    await Binary.completeWineNativeLibraries(record, install, { nativeRoots: input.nativeRoots });
    const video = await require('./native-plugin-libraries').resolvePluginLibraries(selectedVideo, record,
      { executableArchitecture, macOSVersion: host.macOSVersion || systemVersionSync() });
    compatibility[selectedVideo.id] = { ...compatibility[selectedVideo.id], compatible: true, reason: null,
      warnings: video.warnings, files: video.description.files };
    videoRow.used = video.description; videoRow.fallback = false; videoRow.reason = null;
  }
  let automaticRenderer = null, automaticAdditional = [];
  if (runtime === 'sikarugir') {
    const automatic = row => row.value === Plan.AUTOMATIC || (row.fallback || row.inherited) && !row.used;
    // Preserve the Template's existing automatic composition in this one plan.
    const choose = (component, engine, templateComponent) => input.included.find(item => item.component === component && item.engine === engine &&
      (!templateComponent || item.templateComponent === templateComponent) && compatibility[item.id]?.compatible !== false);
    let hardware = host;
    if (automatic(plan.components['vulkan-driver']) && host.physicalAppleGPU == null && choose('vulkan-driver', 'kosmickrisp'))
      hardware = await require('./graphics-hardware').graphicsHardware(host, { signal: context.signal });
    const vulkan = plan.components['vulkan-driver'];
    if (automatic(vulkan)) vulkan.used = hardware.physicalAppleGPU === true ? choose('vulkan-driver', 'kosmickrisp') || choose('vulkan-driver', 'moltenvk') : choose('vulkan-driver', 'moltenvk');
    const renderer = plan.components['d3d-renderer'];
    automaticRenderer = choose('d3d-renderer', 'dxmt') || choose('d3d-renderer', 'wined3d');
    const automaticD9 = context.wineEnvironment?.settings.d9vk !== false && vulkan.used?.engine === 'kosmickrisp' && choose('d3d-renderer', 'dxvk', 'd9vk');
    automaticAdditional = automaticD9 ? [automaticD9] : [];
    if (automatic(renderer)) {
      renderer.used = automaticRenderer;
      const d9vk = automaticD9;
      plan.additional = d9vk ? [{ ...d9vk, inherited: renderer.inherited && !renderer.fallback }] : [];
    }
    if (!context.runtimeSettings?.translatorRenderer && context.runtimeSettings?.graphicsBackend === 'dxvk') {
      const selected = choose('d3d-renderer', 'dxvk', vulkan.used?.engine === 'kosmickrisp' ? 'dxvk3' : 'dxvk') || renderer.used;
      renderer.selected = selected; renderer.used = selected;
    }
    if ((context.runtimeSettings?.cncDdraw === Plan.INHERIT ? context.wineEnvironment?.settings.cncDdraw : context.runtimeSettings?.cncDdraw) === true) {
      if (executableArchitecture && !['x86', 'i386'].includes(executableArchitecture)) throw new Error('DirectDraw compatibility requires a 32-bit Windows executable.');
      const directDraw = input.included.find(item => item.templateComponent === 'cnc_ddraw');
      if (!directDraw) throw new Error('The selected Template has no DirectDraw compatibility libraries.');
      plan.additional = [...(plan.additional || []), { ...directDraw, inherited: context.runtimeSettings?.cncDdraw === Plan.INHERIT }];
    }
  }
  for (const row of Object.values(plan.components)) if (row.used && compatibility[row.used.id]?.files) {
    const files = compatibility[row.used.id].files;
    row.used = { ...row.used, files, form: files.find(file => file.format === 'pe')?.form || row.used.form };
  }
  const automatic = Object.fromEntries(Roles.DIRECT3D_ROLES.map(role => [role.id,
    role.id === 'd3d12' ? null : [...automaticAdditional, ...(automaticRenderer ? [automaticRenderer] : [])].find(item =>
      !item.apis?.length || item.apis.some(api => role.apis.includes(api))) ||
      (runtime === 'sikarugir' ? input.included.find(item => item.engine === 'wined3d') : null) || null]));
  Plan.resolveApiRoles(plan, { ...input, compatibility, apiCompatibility, automatic,
    selections: Object.fromEntries(Roles.DIRECT3D_ROLES.map(role => [role.id, context.runtimeSettings?.[role.settingsKey]])),
    environment: context.wineEnvironment ? Object.fromEntries(Roles.DIRECT3D_ROLES.map(role => [role.id,
      role.id === 'd3d12' ? null : [input.environment?.selections?.['d3d-renderer']].find(item => item &&
        (!item.apis?.length || item.apis.some(api => role.apis.includes(api)))) || null])) : null });
  plan.warnings = Plan.fallbackWarnings(plan);
  plan.warnings.push(...(plan.components.video.used?.videoPreparation?.warnings || []));
  if (plan.components.d3d12.used?.engine === 'vkd3d-proton' && plan.components['vulkan-driver'].used?.engine !== 'kosmickrisp')
    plan.warnings.push('KosmicKrisp is recommended for vkd3d-proton. The saved selection is being used with the selected Vulkan driver.');
  const used = value => JSON.stringify([value.apiMode, Object.values(value.components).map(row => [row.used?.id, row.used?.engine, row.used?.form, row.used?.root, row.used?.files?.map(file => [file.path, file.machine])]),
    value.placements?.map(item => [item.file.path, item.file.machine, item.roles])]);
  const previous = context.translatorPlan;
  context.translatorPlan = plan;
  if (previous && used(previous) !== used(plan)) context.invalidateGraphicsPreparation?.();
  for (const warning of plan.warnings) warn(context.logger, `[translators] ${warning}`);
  const uses = plan.apiMode ? [...plan.placements.map(item => item.description), ...['vulkan-driver', 'video'].map(key => plan.components[key].used)] : Object.values(plan.components).map(row => row.used);
  const recorded = new Set();
  for (const item of uses) if (item?.managerId) {
    const key = JSON.stringify([item.managerId, item.runtimeVersion, item.architecture, item.variant, item.root]);
    if (recorded.has(key)) continue; recorded.add(key);
    context.recordRuntimeUse?.({ managerId: item.managerId, version: item.runtimeVersion,
      architecture: item.architecture, variant: item.variant, sectionId: item.sectionId, buildKey: item.buildKey, sourcePath: item.root });
  }
  return plan;
}
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
  if (plan.apiMode || require('./translator-files').placesDirect3D(plan)) result.graphicsBackend = 'wined3d';
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
    ...Roles.ROLES.map(role => ({ ...role, description: role.apis.length ? `Chooses the installed translator for ${role.label}. Shared libraries can also update linked Direct3D choices.` :
      role.id === 'vulkan-driver' ? 'Chooses the Vulkan driver used by translators that render through Vulkan.' : 'Adds codec plugins to the runtime’s video support.' }))];
  for (const runtime of ['crossover', 'sikarugir']) {
    const schema = result.runtime.entries[runtime].settings;
    schema.visibilityAction = 'listTranslatorOptions';
    schema.environmentAction = 'listTranslatorOptions';
    const index = schema.fields.findIndex(field => field.key === 'graphicsBackend');
    // Retain saved legacy values for existing games, without a second editable
    // selector.
    for (const field of schema.fields) if (['graphicsBackend', 'vulkanBackend', 'graphicsBridgeVersion'].includes(field.key)) field.hidden = true;
    for (const role of controls) schema.defaults[role.settingsKey] = '';
    schema.fields.splice(Math.max(0, index), 0, ...controls.map(role => {
      return { key: role.settingsKey, type: 'select', label: role.label, optionsAction: 'listTranslatorOptions', optionsKey: role.optionsKey,
        options: [{ value: '', label: runtime === 'crossover' ? "CrossOver's automatic choice" : "Template's automatic choice" }],
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
  if (plan.compatibility) for (const key of ['included', 'choices']) input[key] = input[key].map(item => {
    const files = plan.compatibility[item.id]?.files || plan.compatibility[item.id]?.inspectedFiles || item.files;
    return { ...item, files, ...(['d3d-renderer', 'd3d12'].includes(item.component) && files.some(file => file.format === 'pe') ? { apis: Roles.apisForFiles(files) } : {}) };
  });
  const legacy = Object.fromEntries(Object.entries(SETTINGS).map(([component, key]) => {
    const rows = Plan.options({ ...input, component, included: input.included.filter(item => !item.hiddenChoice) });
    if (!context.runtimeSettings?.[key]) {
      const current = rows.find(row => row.value === (plan.components[component].selected?.id || input.selections[component]));
      if (current) current.value = ''; // The unset control preserves its existing saved backend.
    }
    return [key + 'Options', rows];
  }));
  return { ...legacy, ...Plan.apiOptions(plan.components.d3d11 ? plan : Plan.projectRoles(plan), { ...input,
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
function presentInspectorRows(rows) {
  return rows.map(row => {
    const reasonCode = row.reasonCode || (row.fallback ? 'recorded-fallback' : null);
    return { ...row, reasonCode, selected: reasonCode === 'missing-choice' ? Plan.UNAVAILABLE_CHOICE_LABEL : row.selected,
      reason: row.fallback && reasonCode !== 'load-impossible' ? Plan.fallbackNotice(reasonCode, { roles: row.conflictRoles }) : row.reason };
  });
}
function inspectorRows(plan, { host } = {}) {
  const labels = { 'd3d-renderer': 'Direct3D', 'vulkan-driver': 'Vulkan', d3d12: 'Direct3D 12', video: 'Video codecs' };
  const entries = plan.components.d3d11 ? Roles.ROLES.map(role => [role.id, role.settingsKey]) : Object.entries(SETTINGS);
  const automatic = plan.runtime === 'crossover' ? "CrossOver's automatic choice" : "Template's automatic choice";
  // Placed Direct3D libraries switch CrossOver to WineD3D, which then serves
  // every Direct3D API that has no placed library of its own.
  const builtin = plan.builtinRenderer && require('./translator-files').placesDirect3D(plan) ? Description.label(plan.builtinRenderer) : null;
  return presentInspectorRows(entries.map(([component, key]) => {
    const row = plan.components[component], direct3D = Roles.DIRECT3D_ROLES.some(role => role.id === component);
    return { id: key, component, label: labels[component] || Roles.ROLES.find(role => role.id === component)?.label, selected: row.selected ? Description.label(row.selected) : row.fallback ? Plan.UNAVAILABLE_CHOICE_LABEL : row.inherited ? 'Inherited' : automatic,
      used: row.used ? Description.label(row.used) + nativeBuildSuffix(row.used, plan.layout, host) : direct3D && builtin || automatic, reason: row.reason, reasonCode: row.reasonCode, fallback: row.fallback,
      ...(row.conflictRoles?.length ? { conflictRoles: row.conflictRoles } : {}) };
  }));
}
module.exports = { SETTINGS, includedTranslators, includedSummary, describedIncluded, managedTranslators, inventory, optionsInventory, optionsPlan, resolve, engines, environmentIds, settingsForPlan, wineRoot, withSettings, optionLists, inspectorRows, presentInspectorRows, planInputs, samePlanInputs, environmentContext };

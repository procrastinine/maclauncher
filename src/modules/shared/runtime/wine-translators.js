const fs = require('node:fs'), path = require('node:path');
const Description = require('./translator-description'), Plan = require('./translator-plan');
const { wineLayout, wineRoot } = require('./wine-layout');
const Binary = require('./binary-compatibility');
const { systemVersionSync } = require('./bundled-native');
const warn = require('../graphics-warning');
const Architecture = require('./architecture');
const Roles = require('./translator-roles');
const SETTINGS = Object.freeze({ 'd3d-renderer': 'translatorRenderer', 'vulkan-driver': 'translatorVulkan', d3d12: 'translatorD3D12', video: 'translatorVideo' });

function includedTranslators(install, runtime, { engine: requestedEngine } = {}) {
  const layout = wineLayout(install), result = [], warnings = [], nativeRoots = [];
  const source = { kind: runtime, id: install.version || layout.root, runtime,
    label: require('./translator-label').hostLabel(install, { label: runtime === 'crossover' ? 'CrossOver' : 'Sikarugir Template' }) };
  const add = (root, engine, component, extra = {}) => {
    if (requestedEngine && engine !== requestedEngine) return;
    if (!fs.existsSync(root)) return;
    try {
      let value = Description.describeTranslator(root, { engine, component, source, ...extra });
      value = { ...value, included: true, id: `included:${component}:${extra.templateComponent || engine}`, ...extra };
      if (!value.version) {
        const framework = value.files.find(file => /D3DMetal\.framework/.test(file.path));
        if (framework) {
          const plist = path.join(framework.path.slice(0, framework.path.indexOf('D3DMetal.framework')), 'D3DMetal.framework/Versions/A/Resources/version.plist');
          try { value.version = fs.readFileSync(plist, 'utf8').match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || ''; } catch {}
        }
        if (!value.version && runtime === 'crossover') {
          try {
            const name = Description.label({ engine }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            value.version = fs.readFileSync(path.join(layout.root, 'changelog.html'), 'utf8').match(new RegExp(`Update to ${name}\\s+v?(\\d+(?:\\.\\d+)+(?:[a-z]\\d*)?)`, 'i'))?.[1] || '';
          } catch {}
        }
      }
      result.push(value);
      if (engine === 'd3dmetal' && component === 'd3d-renderer') result.push({ ...value, component: 'd3d12', id: 'included:d3d12:d3dmetal' });
    } catch (error) { warnings.push(`${engine}: ${error.message}`); }
  };
  if (runtime === 'crossover') {
    for (const engine of ['dxmt', 'dxvk']) add(path.join(layout.root, 'lib', engine), engine, 'd3d-renderer');
    add(path.join(layout.root, 'lib64/apple_gptk'), 'd3dmetal', 'd3d-renderer');
    add(path.join(layout.root, 'lib64/libMoltenVK.dylib'), 'moltenvk', 'vulkan-driver', { form: 'dylib' });
    add(path.join(layout.root, 'lib64/gstreamer-1.0'), 'gstreamer', 'video', { form: 'dylib' });
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
            if (fs.existsSync(loader)) description.files.push(Description.inspectFile({ path: loader, relative }));
          }
        }
      } catch (error) { warnings.push(error.message); }
    }
  }
  const direct3DFiles = (!requestedEngine || requestedEngine === 'wined3d' || requestedEngine === 'vkd3d') && layout.primaryWindowsRoot && fs.existsSync(layout.primaryWindowsRoot) ? fs.readdirSync(layout.primaryWindowsRoot).filter(name => /^(?:d3d\d.*|dxgi)\.dll$/i.test(name)).map(name => Description.inspectFile({ path: path.join(layout.primaryWindowsRoot, name), relative: `${layout.primaryWindows}/${name}` })) : [];
  const d3d12Files = direct3DFiles.filter(file => Roles.fileApis(file).includes('Direct3D 12'));
  if (!requestedEngine || requestedEngine === 'wined3d') result.push(Description.description({ id: 'included:d3d-renderer:wined3d', included: true, component: 'd3d-renderer', engine: 'wined3d', source,
    version: install.wineVersion || install.engineVersion || '', form: 'builtin', root: layout.root, files: direct3DFiles.filter(file => !d3d12Files.includes(file)) }));
  if ((!requestedEngine || requestedEngine === 'vkd3d') && d3d12Files.length) result.push(Description.description({ id: 'included:d3d12:vkd3d', included: true, component: 'd3d12', engine: 'vkd3d', source,
    version: d3d12Files[0].version || '', form: 'builtin', root: layout.root, files: d3d12Files }));
  return { included: result, warnings, layout, nativeRoots };
}
function runtimeManagers() {
  const registry = require('../../registry');
  return [...registry.listSharedRuntimeManagers(), ...registry.listModuleIds().flatMap(id => registry.getModule(id)?.runtimeManagers || [])];
}
function managedTranslators(context, runtime, managers = runtimeManagers(), architecture) {
  const choices = [], consumer = Architecture.normalizeArchitecture(architecture) || Architecture.selectedArchitecture();
  for (const manager of managers.filter(manager => manager.translatorEngine || manager.translator?.engine)) {
    const inspect = () => {
    const state = manager.getState({ userDataDir: context.userDataDir, settings: context.settings?.runtimes?.[manager.id] });
    for (const version of new Set((state.installed || []).map(item => item.version))) {
      const selection = manager.resolveSelection?.(null, context.settings, context.userDataDir, { version, architecture: consumer, verification: 'status' });
      let install = selection?.install || state.installed.find(item => item.version === version && Architecture.matchesArchitecture(item, consumer));
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
    Architecture.withArchitecture(consumer, inspect);
  }
  return choices;
}
function inventory(install, runtime, context, dependencies = {}) {
  const result = install ? includedTranslators(install, runtime) : { included: [], warnings: [], layout: null };
  const managers = dependencies.managers || runtimeManagers();
  const choices = dependencies.choices || managedTranslators(context, runtime, managers, result.layout?.architecture);
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
        architecture: Architecture.normalizeArchitecture(result.layout?.architecture), verification: 'status' });
      const legacy = choices.find(item => item.managerId === manager.id && item.runtimeVersion === selected.version);
      selections['d3d-renderer'] = legacy?.id || `${manager.id}:${selected.version}`;
    }
  }
  return { ...result, choices, environment, selections, runtime };
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
  const input = inventory(install, runtime, context, dependencies);
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
function settingsForPlan(settings, plan) {
  const result = { ...settings }, renderer = plan.components['d3d-renderer'].used, vulkan = plan.components['vulkan-driver'].used;
  if (plan.apiMode) result.graphicsBackend = 'wined3d';
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
    const index = schema.fields.findIndex(field => field.key === 'graphicsBackend');
    // Retain saved legacy values for existing games, without a second editable selector.
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
function optionLists(install, runtime, context, dependencies = {}) {
  const input = inventory(install, runtime, context, dependencies), plan = dependencies.plan || Plan.resolvePlan(input);
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
function inspectorRows(plan) {
  const labels = { 'd3d-renderer': 'Direct3D', 'vulkan-driver': 'Vulkan', d3d12: 'Direct3D 12', video: 'Video codecs' };
  const entries = plan.components.d3d11 ? Roles.ROLES.map(role => [role.id, role.settingsKey]) : Object.entries(SETTINGS);
  return entries.map(([component, key]) => {
    const row = plan.components[component];
    return { id: key, component, label: labels[component] || Roles.ROLES.find(role => role.id === component)?.label, selected: row.selected ? Description.label(row.selected) : row.fallback ? row.value : row.inherited ? 'Inherited' : plan.runtime === 'crossover' ? "CrossOver's automatic choice" : "Template's automatic choice",
      used: row.used ? Description.label(row.used) : plan.runtime === 'crossover' ? "CrossOver's automatic choice" : "Template's automatic choice", reason: row.reason, fallback: row.fallback };
  });
}
module.exports = { SETTINGS, includedTranslators, managedTranslators, inventory, resolve, engines, settingsForPlan, wineRoot, withSettings, optionLists, inspectorRows, environmentContext };

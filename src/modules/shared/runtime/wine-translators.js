const fs = require('node:fs'), path = require('node:path');
const Description = require('./translator-description'), Plan = require('./translator-plan');
const { wineLayout, wineRoot } = require('./wine-layout');
const Binary = require('./binary-compatibility');
const { systemVersionSync } = require('./bundled-native');
const warn = require('../graphics-warning');
const Architecture = require('./architecture');
const SETTINGS = Object.freeze({ 'd3d-renderer': 'translatorRenderer', 'vulkan-driver': 'translatorVulkan', d3d12: 'translatorD3D12', video: 'translatorVideo' });

function includedTranslators(install, runtime) {
  const layout = wineLayout(install), result = [], warnings = [];
  const source = { kind: runtime, id: install.version || layout.root, runtime, label: runtime === 'crossover' ? `CrossOver ${install.upstreamVersion || ''}`.trim() : `Sikarugir Template ${install.templateVersion || ''}`.trim() };
  const add = (root, engine, component, extra = {}) => {
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
  } else {
    const support = install.templateRoot || install.supportRoot || path.join(install.installDir, 'support');
    const renderers = ['Frameworks/renderer', 'SharedSupport/renderer'].map(relative => path.join(support, relative)).find(file => fs.existsSync(file));
    if (renderers) for (const name of fs.readdirSync(renderers).sort()) {
      const engine = /^(?:dxvk|d9vk)/.test(name) ? 'dxvk' : name;
      if (['dxmt', 'dxvk', 'd3dmetal', 'cnc_ddraw'].includes(engine)) add(path.join(renderers, name), engine, 'd3d-renderer', { templateComponent: name, hiddenChoice: engine === 'cnc_ddraw' });
    }
    const vulkan = path.join(support, 'Resources/vulkan');
    if (fs.existsSync(vulkan)) for (const name of fs.readdirSync(vulkan).filter(name => name.endsWith('.json'))) {
      try {
        const descriptor = JSON.parse(fs.readFileSync(path.join(vulkan, name), 'utf8')), library = path.resolve(vulkan, descriptor.ICD.library_path);
        const engine = /kosmickrisp/i.test(name) ? 'kosmickrisp' : /moltenvk/i.test(name) ? 'moltenvk' : null;
        if (engine) {
          const before = result.length; add(library, engine, 'vulkan-driver', { form: 'icd' });
          if (result.length > before) {
            const description = result.at(-1); description.icd = path.join(vulkan, name);
            const loader = path.join(support, 'Frameworks/libvulkan.1.dylib');
            if (fs.existsSync(loader)) description.files.push(Description.inspectFile({ path: loader, relative: 'Frameworks/libvulkan.1.dylib' }));
          }
        }
      } catch (error) { warnings.push(error.message); }
    }
  }
  result.push(Description.description({ id: 'included:d3d-renderer:wined3d', included: true, component: 'd3d-renderer', engine: 'wined3d', source,
    version: install.wineVersion || install.engineVersion || '', form: 'builtin', root: layout.root, files: [] }));
  const d3d12Files = layout.primaryWindowsRoot && fs.existsSync(layout.primaryWindowsRoot) ? fs.readdirSync(layout.primaryWindowsRoot).filter(name => /^d3d12.*\.dll$/i.test(name)).map(name => Description.inspectFile({ path: path.join(layout.primaryWindowsRoot, name), relative: `${layout.primaryWindows}/${name}` })) : [];
  if (d3d12Files.length) result.push(Description.description({ id: 'included:d3d12:vkd3d', included: true, component: 'd3d12', engine: 'vkd3d', source,
    version: d3d12Files[0].version || '', form: 'builtin', root: layout.root, files: d3d12Files }));
  return { included: result, warnings, layout };
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
        managerId: manager.id, runtimeVersion: install.version, architecture: Architecture.recordArchitecture(install) || selection?.architecture,
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
  const result = includedTranslators(install, runtime), managers = dependencies.managers || runtimeManagers();
  const choices = dependencies.choices || managedTranslators(context, runtime, managers, result.layout.architecture);
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
        architecture: Architecture.normalizeArchitecture(result.layout.architecture), verification: 'status' });
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
  const input = inventory(install, runtime, context, dependencies), record = await Binary.wineCompatibilityRecord(install), compatibility = {};
  for (const description of [...input.included, ...input.choices]) compatibility[description.id] = Binary.compatibility(description, record,
    { executableArchitecture, macOSVersion: host.macOSVersion || systemVersionSync() });
  const plan = { ...Plan.resolvePlan({ ...input, compatibility }), layout: input.layout, compatibility, record };
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
    if (automatic(renderer)) {
      renderer.used = choose('d3d-renderer', 'dxmt') || choose('d3d-renderer', 'wined3d');
      const d9vk = context.wineEnvironment?.settings.d9vk !== false && vulkan.used?.engine === 'kosmickrisp' && choose('d3d-renderer', 'dxvk', 'd9vk');
      plan.additional = d9vk ? [d9vk] : [];
    }
    if (!context.runtimeSettings?.translatorRenderer && context.runtimeSettings?.graphicsBackend === 'dxvk') {
      const selected = choose('d3d-renderer', 'dxvk', vulkan.used?.engine === 'kosmickrisp' ? 'dxvk3' : 'dxvk') || renderer.used;
      renderer.selected = selected; renderer.used = selected;
    }
    if ((context.runtimeSettings?.cncDdraw === Plan.INHERIT ? context.wineEnvironment?.settings.cncDdraw : context.runtimeSettings?.cncDdraw) === true) {
      if (executableArchitecture && !['x86', 'i386'].includes(executableArchitecture)) throw new Error('DirectDraw compatibility requires a 32-bit Windows executable.');
      const directDraw = input.included.find(item => item.templateComponent === 'cnc_ddraw');
      if (!directDraw) throw new Error('The selected Template has no DirectDraw compatibility libraries.');
      plan.additional = [...(plan.additional || []), directDraw];
    }
  }
  for (const row of Object.values(plan.components)) if (row.used && compatibility[row.used.id]?.files) {
    const files = compatibility[row.used.id].files;
    row.used = { ...row.used, files, form: files.find(file => file.format === 'pe')?.form || row.used.form };
  }
  plan.warnings = Plan.fallbackWarnings(plan);
  if (plan.components.d3d12.used?.engine === 'vkd3d-proton' && plan.components['vulkan-driver'].used?.engine !== 'kosmickrisp')
    plan.warnings.push('KosmicKrisp is recommended for vkd3d-proton. The saved selection is being used with the selected Vulkan driver.');
  const used = value => JSON.stringify(Object.values(value.components).map(row => [row.used?.id, row.used?.engine, row.used?.form, row.used?.root, row.used?.files?.map(file => [file.path, file.machine])]));
  const previous = context.translatorPlan;
  context.translatorPlan = plan;
  if (previous && used(previous) !== used(plan)) context.invalidateGraphicsPreparation?.();
  for (const warning of plan.warnings) warn(context.logger, `[translators] ${warning}`);
  for (const row of Object.values(plan.components)) if (row.used?.managerId) context.recordRuntimeUse?.({ managerId: row.used.managerId, version: row.used.runtimeVersion,
    architecture: row.used.architecture, variant: row.used.variant, sectionId: row.used.sectionId, buildKey: row.used.buildKey, sourcePath: row.used.root });
  return plan;
}
function engines(plan) { return Object.fromEntries(Object.entries(plan.components).map(([component, row]) => [component, row.used?.engine || null])); }
function settingsForPlan(settings, plan) {
  const result = { ...settings }, renderer = plan.components['d3d-renderer'].used, vulkan = plan.components['vulkan-driver'].used;
  if (renderer) result.graphicsBackend = renderer.engine;
  else if (settings.translatorRenderer === Plan.AUTOMATIC || plan.components['d3d-renderer'].fallback) result.graphicsBackend = 'auto';
  if (vulkan) result.vulkanBackend = vulkan.engine;
  else if (settings.translatorVulkan === Plan.AUTOMATIC || plan.components['vulkan-driver'].fallback) result.vulkanBackend = 'auto';
  return result;
}
function withSettings(manifest) {
  const result = structuredClone(manifest);
  for (const runtime of ['crossover', 'sikarugir']) {
    const schema = result.runtime.entries[runtime].settings;
    schema.visibilityAction = 'listTranslatorOptions';
    const index = schema.fields.findIndex(field => field.key === 'graphicsBackend');
    // Retain saved legacy values for existing games, without a second editable selector.
    for (const field of schema.fields) if (['graphicsBackend', 'vulkanBackend', 'graphicsBridgeVersion'].includes(field.key)) field.hidden = true;
    const labels = { 'd3d-renderer': 'Direct3D engine', 'vulkan-driver': 'Vulkan driver', d3d12: 'Direct3D 12', video: 'Video codecs' };
    for (const key of Object.values(SETTINGS)) schema.defaults[key] = '';
    schema.fields.splice(Math.max(0, index), 0, ...Object.entries(SETTINGS).map(([component, key]) => ({ key, type: 'select', label: labels[component],
      optionsAction: 'listTranslatorOptions', optionsKey: key + 'Options', options: [{ value: '', label: runtime === 'crossover' ? "CrossOver's automatic choice" : "Template's automatic choice" }],
      inheritFrom: 'environmentReference', inheritanceInOptions: true, section: 'Basic',
      description: 'Versions and sources are read from installed files. Changes apply on the next launch.' })));
  }
  return result;
}
function optionLists(install, runtime, context, dependencies = {}) {
  const input = inventory(install, runtime, context, dependencies), plan = dependencies.plan || Plan.resolvePlan(input);
  return Object.fromEntries(Object.entries(SETTINGS).map(([component, key]) => {
    const rows = Plan.options({ ...input, component, included: input.included.filter(item => !item.hiddenChoice) });
    if (!context.runtimeSettings?.[key]) {
      const current = rows.find(row => row.value === (plan.components[component].selected?.id || input.selections[component]));
      if (current) current.value = ''; // The unset control preserves its existing saved backend.
    }
    return [key + 'Options', rows];
  }));
}
function inspectorRows(plan) {
  const labels = { 'd3d-renderer': 'Direct3D', 'vulkan-driver': 'Vulkan', d3d12: 'Direct3D 12', video: 'Video codecs' };
  return Object.entries(SETTINGS).map(([component, key]) => {
    const row = plan.components[component];
    return { id: key, component, label: labels[component], selected: row.selected ? Description.label(row.selected) : row.fallback ? row.value : row.inherited ? 'Inherited' : plan.runtime === 'crossover' ? "CrossOver's automatic choice" : "Template's automatic choice",
      used: row.used ? Description.label(row.used) : plan.runtime === 'crossover' ? "CrossOver's automatic choice" : "Template's automatic choice", reason: row.reason, fallback: row.fallback };
  });
}
module.exports = { SETTINGS, includedTranslators, managedTranslators, inventory, resolve, engines, settingsForPlan, wineRoot, withSettings, optionLists, inspectorRows, environmentContext };

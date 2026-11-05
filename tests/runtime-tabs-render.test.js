const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { build } = require('vite');
const { react, componentHarness } = require('./helpers/renderer-component');
let RuntimesView, SettingsView, CreditsView, GameDetails, ReShadeFilterLibrary, RuntimeSettingsWindow, RuntimeCatalogSources;
test('cached runtime refresh failures show their failure date and redact errors and install tooltips', () => {
  const failedAt = Date.UTC(2026, 9, 24, 12), fetchedAt = Date.UTC(2026, 9, 20, 12);
  const error = 'request to https://fixture-user:fixture-password@github.com/example/runtime failed ECONNREFUSED';
  const runtime = manager('cached-failure', {}, { status: 'error', error, failedAt, fetchedAt,
    versions: ['1'], installable: false, versionRequirements: { '1': { installReason: error } } });
  const markup = render([runtime]);
  assert.ok(markup.includes(`Last refresh failed on ${new Date(failedAt).toLocaleString()}.`));
  assert.match(markup, /Could not connect to GitHub/);
  assert.doesNotMatch(markup, /fixture-user|fixture-password/);
  delete runtime.catalog.failedAt;
  assert.match(render([runtime]), /Last refresh failed \(date unavailable\)/);
  runtime.catalog.status = 'loading';
  assert.doesNotMatch(render([runtime]), /Last refresh failed/);
  runtime.catalog.status = 'success'; runtime.catalog.error = null;
  assert.doesNotMatch(render([runtime]), /Last refresh failed/);
});
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, 'runtime-tabs-components.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'runtime-components.cjs'), module);
  compiled.paths = module.paths;
  compiled.require = id => id === 'react' ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  ({ RuntimesView, SettingsView, CreditsView, GameDetails, ReShadeFilterLibrary, RuntimeSettingsWindow, RuntimeCatalogSources } = compiled.exports);
});
const manager = (id, ui, catalog = {}, installed = []) => ({ id, label: `Backend ${id}`, ui,
  catalog: { status: 'idle', versions: [], ...catalog }, installed });
test('download selectors exclude code-only tags while retaining Mac packages with host requirements', () => {
  const runtime = manager('native-preview', {}, { status: 'success', source: 'https://github.com/example/engine/releases',
    versions: ['source-only', 'native-preview', 'newer-macos'], latestAvailableVersion: 'source-only',
    installableVersions: ['native-preview'], versionRequirements: {
      'source-only': { requiresDownload: false, requiresBuild: false, available: false, installable: false },
      'native-preview': { requiresDownload: true, requiresBuild: false, available: false },
      'newer-macos': { requiresDownload: true, requiresBuild: false, available: false, installable: false, minimumMacOS: '27.0' }
    } });
  const markup = render([runtime]);
  assert.doesNotMatch(markup, /<option[^>]*value="source-only"/);
  assert.match(markup, /<option[^>]*value="native-preview"/);
  assert.match(markup, /<option[^>]*value="newer-macos"/);
  assert.doesNotMatch(markup, /Latest available source-only/);
  assert.match(markup, /2 versions/);
});
test('an installed provider version is not described as an unavailable download', () => {
  const catalog = { status: 'success', versions: ['1.0-MCLv1'],
    installable: false, installableVersions: [], installReason: 'No compatible download is available from this source.',
    versionRequirements: { '1.0-MCLv1': { available: true, requiresDownload: false, requiresBuild: false } } };
  const runtime = manager('native-installed', {}, { ...catalog, sources: [{ ...catalog, id: 'builds',
    label: 'MacLauncher Builds', source: 'https://procrastinine.github.io/maclauncher-builds/#native-installed' }] },
    [{ version: '1.0-MCLv1', ready: true }]);
  const markup = render([runtime]);
  assert.match(markup, />Installed<\/button>/);
  assert.doesNotMatch(markup, /No compatible download|No compatible macOS/);
  assert.match(markup, /title="This version is installed\."/);
});
test('download controls replace an unavailable saved variant with the section variant', () => {
  const runtime = { ...manager('legacy-engine', {}, { versions: ['2.1.6'], installable: true,
    versionRequirements: { '2.1.6': { variants: { standard: { installable: true }, mono: { installable: false } } } } }),
    variants: [{ id: 'standard', label: 'Standard' }], defaultVariant: 'standard' };
  const markup = render([runtime], runtime.id, { runtimeUi: { [runtime.id]: {
    remoteOpen: {}, installedSort: {}, installVersion: {}, installVariant: { default: 'mono' }, pendingActions: {}, messages: {}, sourceErrors: {}
  } } });
  assert.match(markup, /<button class="btn primary">Install<\/button>/);
  assert.doesNotMatch(markup, /No compatible macOS download/);
});
function render(managers, selected = managers[0]?.id, overrides = {}) {
  const noNetwork = () => { throw new Error('Rendering must not request a runtime or source URL'); };
  return renderToStaticMarkup(React.createElement(RuntimesView, {
    runtimeManagers: managers, runtimeUi: {}, runtimeManagerId: selected, runtimeSectionId: 'default',
    downloadTasks: [], downloadsOpen: false, setDownloadsOpen() {}, setRuntimeManagerId() {},
    setRuntimeSectionId() {}, updateRuntimeUiSection() {}, onRuntimeRefresh: noNetwork,
    onRuntimeInstall: noNetwork, onRuntimeSetDefault() {}, onRuntimeUninstall() {}, onCancelDownload() {},
    onOpenSource: noNetwork, ...overrides
  }));
}

test('recommended installation uses the declared exact version without selecting or changing a default', t => {
  const runtime = manager('recommended-runtime', {}, { versions: ['3.0', '1.5'], recommendedVersion: '1.5',
    installableVersions: ['3.0', '1.5'] }, [{ version: '1.0', ready: true }]);
  runtime.defaultVersion = '1.0';
  const calls = [], ui = { remoteOpen: {}, installVersion: { default: '3.0' }, installVariant: {}, installedSort: {} };
  const props = { runtimeManagers: [runtime], runtimeUi: { [runtime.id]: ui }, runtimeManagerId: runtime.id,
    runtimeSectionId: 'default', downloadTasks: [], downloadsOpen: false, setDownloadsOpen() {},
    setRuntimeManagerId() {}, setRuntimeSectionId() {}, updateRuntimeUiSection() { assert.fail('Install does not select a version'); },
    onRuntimeRefresh() { assert.fail('Rendering/install action does not refresh'); },
    onRuntimeInstall: (...args) => calls.push(args), onRuntimeSetDefault() { assert.fail('Install does not call Set default'); },
    onRuntimeUninstall() {}, onCancelDownload() {} };
  const harness = componentHarness(RuntimesView, props); t.after(() => harness.close());
  const find = (node, predicate) => {
    if (!React.isValidElement(node)) return null;
    if (predicate(node)) return node;
    for (const child of React.Children.toArray(node.props.children)) { const result = find(child, predicate); if (result) return result; }
    return null;
  };
  const source = find(harness.render(), element => element.type?.name === 'RuntimeCatalogSources');
  assert.ok(source);
  const button = find(source.type(source.props), element => element.type === 'button' && element.props.children === 'Install recommended version');
  assert.ok(button); assert.equal(button.props.disabled, false); button.props.onClick();
  assert.deepEqual(calls, [[runtime.id, 'default', '1.5', undefined]]);
  assert.equal(ui.installVersion.default, '3.0'); assert.equal(runtime.defaultVersion, '1.0');
  assert.match(render([runtime]), /<option value="1.5" selected="">/, 'The committed recommended preselection is display-only');
  assert.match(render([{ ...runtime, catalog: { ...runtime.catalog, recommendedVersion: null } }]), /<option value="3.0" selected="">/,
    'The committed first download row is displayed when no recommendation exists');
  assert.doesNotMatch(render([{ ...runtime, catalog: { ...runtime.catalog, recommendedVersion: null } }]), /Install recommended version/);
  assert.doesNotMatch(render([{ ...runtime, installed: [{ version: '1.5', ready: true }] }]), /Install recommended version/);
  const blocked = find(source.type({ ...source.props, section: { ...source.props.section,
    catalog: { ...source.props.section.catalog, versionRequirements: { '1.5': { installable: false, installReason: 'Requires another ABI.' } } } } }),
    element => element.type === 'button' && element.props.children === 'Install recommended version');
  assert.equal(blocked.props.disabled, true, 'Runtime compatibility still controls installation');
});
const sectionTabLabels = markup => [...markup.matchAll(/<button[^>]*id="runtime-section-tab-[^"]*"[^>]*>([^<]+)<\/button>/g)].map(match => match[1]);
test('shader library uses one searchable list and keeps independent collection versions below imported filters', () => {
  const source = require('../src/modules/shared/reshade/runtime/shader-library-manager');
  const data = source.getState(), shaderManager = { ...data, ui: source.ui, sections: data.sections.map((section, index) => ({
    ...section, catalog: { ...section.catalog, versions: [`pack${index}-new`, `pack${index}-old`] }
  })) };
  const filters = [{ id: 'fx', name: 'Own ReShade', path: '/Shaders/local.fx', format: 'fx', available: true },
    { id: 'slang', name: 'Own libretro', path: '/Shaders/local.slangp', format: 'slangp', available: true },
    { id: 'mpv', name: 'Own MPV', path: '/Shaders/local.glsl', format: 'libplacebo', available: true }];
  for (const index of [0, 1]) {
    const markup = render([shaderManager], source.id, { runtimeSectionId: shaderManager.sections[index].id, shaderFilters: filters,
      filterApi: { importReShadeFilters() { assert.fail('Rendering must not open a picker'); } } });
    // Presets joins the Graphics group; shader collections never become tabs.
    assert.deepEqual(sectionTabLabels(markup), ['Shaders', 'Presets']);
    assert.match(markup,/shader-library-search/);assert.doesNotMatch(markup,/shader-family-tab-/);
    assert.match(markup, /class="btn"[^>]*>Import filter…<\/button>/);
    for(const label of ['Own MPV','Own ReShade','Own libretro']) assert.ok(markup.includes(label));
    // Library and Collections are tabs; each collection keeps its own versions.
    assert.match(markup, /role="tab" id="shader-collections-tab"[^>]*>Collections<\/button>/);
    assert.match(markup, /<div role="tabpanel" id="shader-collections-panel"[^>]*><section class="runtimeSectionCard shaderCollections">/);
    assert.ok(markup.indexOf('Import filter…') < markup.indexOf('id="shader-collections-panel"'));
    assert.match(markup, new RegExp(`value="pack${index}-new"`));
    assert.doesNotMatch(markup, new RegExp(`value="pack${1-index}-new"`));
    for (const section of shaderManager.sections.filter(section => section.shaderFamily === 'mpv')) assert.ok(markup.includes(section.label));
  }
});

test('Graphics retains one Shaders tab and native runtime tabs for every shader deep link', () => {
  const source = require('../src/modules/shared/reshade/runtime/shader-library-manager');
  const data = source.getState();
  const shaders = { ...data, ui: source.ui, sections: [...data.sections,
    ...['reshade', 'libretro'].map(family => ({ ...data.sections[0], id: family + '-collection', label: family + ' collection', shaderFamily: family }))] };
  const graphics = manager('models', { groupId: 'graphics', tabLabel: 'Graphics', sectionLabel: 'Upscaling', memberOrder: 0 });
  const vulkan = manager('vulkan', { groupId: 'graphics', tabLabel: 'Graphics', sectionLabel: 'Vulkan', memberOrder: 20 });
  for (const family of ['reshade', 'libretro', 'mpv']) {
    const collection = shaders.sections.find(section => section.shaderFamily === family);
    assert.ok(collection);
    const markup = render([graphics, shaders, vulkan], source.id, { runtimeSectionId: collection.id });
    const topTabs = markup.match(/aria-label="Graphics sections">([\s\S]*?)<\/div>/)[1];
    assert.deepEqual(sectionTabLabels(topTabs), ['Upscaling', 'Shaders', 'Presets', 'Vulkan']);
    assert.match(topTabs, /aria-selected="true"[\s\S]*?>Shaders<\/button>/);
    assert.doesNotMatch(markup, /shader-family-tab-/);assert.match(markup, /shader-library-search/);
    assert.match(markup, new RegExp(`id="runtime-panel-${source.id}-${collection.id}"`));
    for (const section of shaders.sections) assert.ok(!topTabs.includes(`>${section.label}</button>`));
  }
});
test('current module presentations repair cached Android and shader metadata without changing action identities', () => {
  const source = require('../src/modules/shared/reshade/runtime/shader-library-manager');
  const shaders = { ...source.getState(), ui: { groupId: 'graphics', tabLabel: 'Shader library', sectionLabel: 'Shader packs', order: 10, management: 'managed' } };
  shaders.sections = shaders.sections.map(({ shaderFamily, ...section }) => section);
  const cached = ['android', 'macapk', 'android-aim'].map((id, index) => manager(id,
    { tabLabel: 'Android', order: 123 + index, management: 'managed' },
    { versions: [id + '-version'] }, [{ version: id + '-version', ready: true }]));
  cached.push(manager('last-tool', { groupId: 'tools', tabLabel: 'Tools', order: -100, management: 'managed' }));
  cached.push(manager('future', undefined));cached.push(shaders);
  const before = structuredClone(cached);
  for (const id of ['android']) {
    const markup = render(cached, id);
    const names = [...markup.matchAll(/class="launcherSidebarItem[^>]*>([^<]*)<\/button>/g)].map(match => match[1]);
    for (const label of ['MacLauncher Android', 'Mac.apk', 'AIM']) assert.equal(names.filter(name => name === label).length, 1);
    assert.equal(names.includes('Android'), false);assert.equal(names.includes('Android ART'), false);assert.equal(names.at(-1), 'Tools');
    assert.doesNotMatch(markup, /runtime-panel-android-art-/);
    assert.match(markup, new RegExp(`id="runtime-panel-${id}-default"`));
    assert.match(markup, new RegExp(`value="${id}-version"`));
  }
  const markup = render(cached, source.id, { runtimeSectionId: shaders.sections[0].id });
  assert.deepEqual(sectionTabLabels(markup), ['Shaders', 'Presets']);
  assert.match(markup,/shader-library-search/);
  assert.match(markup, /role="tab" id="shader-collections-tab"[^>]*>Collections<\/button>/);assert.match(markup, /shader-collection/);
  assert.deepEqual(cached, before, 'Presentation must not mutate cached manager state, versions or installation identities');
});
test('Runtimes is a plain native-window view while version controls remain reachable', () => {
  const markup = render([manager('included', {}, { versions: ['1.2.3'] }, [{ version: '1.2.3', source: 'bundled', readOnly: true }])]);
  assert.match(markup, /<main class="launcherView runtimesView" aria-labelledby="runtimes-title">/);
  assert.match(markup, /<h1 class="launcherViewTitle" id="runtimes-title">Runtimes<\/h1>/);
  assert.match(markup, /aria-label="Reload versions"/);
  assert.match(markup, /<option value="1.2.3" selected="">/);
  assert.doesNotMatch(markup, /modalBackdrop|aria-modal|role="dialog"|aria-label="Close"|Back to Library/);
});
test('included shaders do not register a runtime manager or shader-pack navigation', () => {
  const registry = require('../src/modules/registry');
  const shaders = registry.listSharedRuntimeManagers().filter(source => source.id === 'reshade-shaders');
  assert.deepEqual(shaders, []);
  const markup = render([manager('other', { tabLabel: 'Other' })]);
  assert.doesNotMatch(markup, /ReShade ·|Shader packs|runtime-panel-reshade-shaders/);
});
test('CrossOver and Sikarugir manage one shared DXMT support download and default under DirectX to Metal', () => {
  const registry = require('../src/modules/registry');
  const source = require('../src/modules/crossover/temporal/support-manager');
  const engineSources = [require('../src/modules/crossover/runtime/manager'),
    require('../src/modules/crossover/sikarugir/runtime/manager')];
  const engines = engineSources.map(engine => ({ ...manager(engine.id, registry.getRuntimeManagerUi(engine.id) || engine.ui), label: engine.label }));
  const state = source.getState(), version = state.catalog.versions[0] || '1.0.21', install = { version, ready: true };
  const bridge = { ...state, id: source.id, label: source.label, ui: registry.getRuntimeManagerUi(source.id) || source.ui,
    // The first source has loaded and lists the installed version.
    sections: state.sections.map(section => ({ ...section, catalog: { ...section.catalog, versions: [version],
      sources: section.catalog.sources.map((item, index) => index ? item : { ...item, status: 'success', versions: [version] }) },
      installed: [install], defaultVersion: null })) };
  assert.deepEqual(engines.map(engine => engine.id), ['crossover', 'sikarugir']);
  assert.equal(bridge.id, 'sikarugir-graphics-bridge');
  const markup = render([...engines, bridge], bridge.id);
  for (const label of ['CrossOver', 'Sikarugir', 'DirectX → Metal']) assert.match(markup, new RegExp(`class="launcherSidebarItem[^>]*>${label}</button>`));
  assert.match(markup, /class="runtimePanelTitle">DXMT<\/div>/);
  assert.match(markup, /id="runtime-group-panel-directx-metal"/);
  assert.match(markup, />Installed<\/button>/);
  assert.match(markup, /Set default/);
  assert.equal(markup.match(/class="runtimePanelTitle">DXMT<\/div>/g).length, 1);
  assert.doesNotMatch(markup, /DXMT · support/);
  for (const engine of engines) assert.doesNotMatch(render([...engines, bridge], engine.id), /class="runtimePanelTitle">DXMT<\/div>/, `${engine.id}: no separate copy`);
});
test('inactive scene adapters stay internally managed without Graphics tabs or phantom Presets', () => {
  const registry = require('../src/modules/registry');
  const providerUi = require('../src/modules/shared/reshade/runtime/provider-library-ui.json');
  const adapters = [...Object.values(require('../src/modules/crossover/temporal/support-manager').apiManagers),
    require('../src/modules/shared/vulkan/managed').sceneManager];
  assert.deepEqual(adapters.map(source => source.id).sort(), ['fidelityfx-api', 'vulkan-moltenvk-scene', 'winevulkan-scene']);
  const registered = new Set([...registry.listSharedRuntimeManagers(),
    ...registry.listModules().flatMap(module => registry.getModule(module.id).runtimeManagers || [])].map(source => source.id));
  for (const source of adapters) {
    assert.ok(registered.has(source.id), `${source.id}: internal registration remains available`);
    assert.equal(source.ui.management, 'managed');
    assert.equal(providerUi[source.id].hidden, true);
    for (const action of ['getState', 'refreshCatalog', 'installRuntime', 'resolveSelection'])
      assert.equal(typeof source[action], 'function', `${source.id}: ${action} remains available internally`);
  }
  const active = manager('graphics-models', { groupId: 'graphics', tabLabel: 'Graphics',
    sectionLabel: 'Lossless Scaling', management: 'managed' }, { versions: ['installed-model'] }, [{ version: 'installed-model', ready: true }]);
  for (const uiFor of [source => source.ui, () => undefined,
    () => ({ groupId: 'graphics', tabLabel: 'Graphics', management: 'managed', hidden: false })]) {
    const runtimes = adapters.map(source => ({ ...manager(source.id, uiFor(source)), label: source.label }));
    const before = structuredClone(runtimes);
    const hidden = render(runtimes);
    assert.doesNotMatch(hidden, /class="launcherSidebarItem[^>]*>Effects<\/button>|runtime-group-panel-graphics|runtime-panel-graphics-presets/);
    for (const source of adapters) assert.ok(!hidden.includes(source.label), `${source.id}: no inactive adapter tab`);
    const markup = render([...runtimes, active], runtimes[0].id);
    assert.match(markup, /class="launcherSidebarItem[^>]*>Effects<\/button>/);
    assert.match(markup, /id="runtime-group-panel-graphics"/);
    assert.deepEqual(sectionTabLabels(markup), ['Providers', 'Presets']);
    assert.match(markup, /id="runtime-panel-graphics-models-default"/);
    for (const source of adapters) assert.ok(!markup.includes(source.label), `${source.id}: active Graphics does not reveal inactive adapters`);
    assert.deepEqual(runtimes, before, 'Current hidden metadata does not mutate cached identities or installation state');
  }
});
test('Settings and Credits use plain native-window content without HTML close or navigation controls', () => {
  const fixture = require('./library-layout-fixture').createLibraryFixture();
  const offline = () => assert.fail('Rendering a utility view must not call the backend');
  const settings = renderToStaticMarkup(React.createElement(SettingsView, { state: fixture, showIcons: true,
    showNonDefaultTags: true, onSetLauncherSettings: offline, onSetModuleSettings: offline }));
  const credits = renderToStaticMarkup(React.createElement(CreditsView, {
    acknowledgments: [{ label: 'Project', url: 'https://example.com/project' }], canOpenExternal: true, onOpenLink: offline
  }));
  assert.match(settings, /<main class="launcherView settingsView"/);
  assert.match(settings, /aria-label="Show game icons"/);
  assert.match(settings, /type="search" aria-label="Search settings"/);
  assert.match(settings, /<nav class="launcherSidebarChoices" aria-label="Settings sections">/);
  assert.doesNotMatch(settings, /Scroll Settings sections/);
  assert.match(credits, /<main class="launcherView creditsView"/);
  assert.match(credits, /https:\/\/example\.com\/project/);
  for (const markup of [settings, credits]) assert.doesNotMatch(markup, /modalBackdrop|aria-modal|role="dialog"|aria-label="Close"|Back to Library/);
});
// Rows show name, format, input → output and origin; each file's full path and
// its Replace action are in the row's Source disclosure.
test('shared filter table exposes editable full names and paths without loading files or requiring a native runtime', t => {
  const offline = () => assert.fail('Rendering the filter library must not call the bridge');
  const filters = [{ id: 'one', name: 'Colour tuning.fx', path: '/Effects/' + 'long-folder/'.repeat(20) + 'Colour.fx', available: true },
    { id: 'two', name: 'Missing.fx', path: '/Effects/Missing.fx', available: false, reason: 'The filter file is unavailable.' },
    { id: 'three', name: 'CRT preset', path: '/Shaders/CRT.slangp', format: 'slangp', available: true },
    { id: 'four', name: 'Single pass', path: '/Shaders/Single.slang', format: 'slang', available: true }];
  const api = { importReShadeFilters: offline, updateReShadeFilter: offline, removeReShadeFilter: offline, pickReShadeFilterPath: offline };
  const markup = renderToStaticMarkup(React.createElement(ReShadeFilterLibrary, { filters, api }));
  assert.match(markup, /<table class="filterLibraryTable">/);
  for (const label of ['Name', 'Input → output', 'Origin / status', 'Actions']) assert.match(markup, new RegExp(`<th scope="col">${label}<`));
  assert.match(markup, /Import filter…/);
  assert.match(markup, /Shaders and filters/);
  assert.deepEqual([...markup.matchAll(/<\/div><span class="filterLibraryFormat">([^<]*)<\/span><\/td>/g)].map(match => match[1]),
    ['ReShade FX', 'ReShade FX', 'Slang preset', 'Slang']);
  assert.match(markup, /aria-label="Filter name: Colour tuning\.fx"/);
  assert.match(markup, /aria-label="Remove filter Missing\.fx"/);
  assert.match(markup, /The filter file is unavailable\./);
  assert.match(markup, /<button type="button" class="btn" disabled="">Download shaders…<\/button>/);
  assert.doesNotMatch(markup, />Install<|native runtime unavailable/i);
  assert.ok(!markup.includes(filters[0].path), 'Paths stay in the closed Source disclosure');
  const harness = componentHarness(ReShadeFilterLibrary, { filters, api }); t.after(() => harness.close());
  const nodes = tree => React.isValidElement(tree) ? [tree, ...React.Children.toArray(tree.props.children).flatMap(nodes)] : [];
  const source = nodes(harness.render()).find(node => node.type === 'button' && node.props['aria-controls'] === 'shader-source-one');
  assert.equal(source.props['aria-expanded'], false);
  source.props.onClick();
  const opened = renderToStaticMarkup(harness.render());
  assert.ok(opened.includes(filters[0].path));
  assert.match(opened, /aria-label="Filter path: Colour tuning\.fx"/);
  assert.match(opened, /aria-label="Replace file for Colour tuning\.fx"/);
  assert.match(opened, /aria-expanded="true" aria-controls="shader-source-one"/);
  const unavailable = renderToStaticMarkup(React.createElement(ReShadeFilterLibrary, { filters: [], filtersError: 'The filter library could not be read.' }));
  assert.match(unavailable, /role="alert">The filter library could not be read\./);
  assert.match(unavailable, /No shaders available\./);
});
test('runtime groups use a searchable sidebar while runtime sub-tabs retain edge controls', () => {
  const runtimes = [manager('first', { groupId: 'one', tabLabel: 'First', sectionLabel: 'Primary' }),
    manager('alternative', { groupId: 'one', tabLabel: 'First', sectionLabel: 'Alternative' }),
    manager('second', { groupId: 'two', tabLabel: 'Second' })];
  const markup = render(runtimes, 'first');
  for (const label of ['First sections']) {
    assert.match(markup, new RegExp(`aria-label="Scroll ${label} left"`));
    assert.match(markup, new RegExp(`aria-label="Scroll ${label} right"`));
  }
  assert.equal((markup.match(/role="tablist"/g) || []).length, 1);
  assert.equal((markup.match(/role="tab"/g) || []).length, 2);
  assert.match(markup, /<input[^>]*type="search" aria-label="Search runtimes"/);
  assert.match(markup, /<nav class="launcherSidebarChoices" aria-label="Runtime groups">/);
  assert.doesNotMatch(markup, /runtimeGroupTabs|runtime-group-tab-/);
  assert.match(markup, /class="scrollableTabStrip runtimeLineTabs"/);
  assert.match(markup, /aria-current="page" aria-controls="runtime-group-panel-one"/);
  assert.match(markup, /role="region" id="runtime-group-panel-one" aria-label="First"/);
});
test('empty catalogs expose a labeled Load versions action without a render-time request', () => {
  const runtime = { ...manager('common', { tabLabel: 'Common runtime' }), customRuntime: true };
  const markup = render([runtime], runtime.id, { onRuntimeRegister() {} });
  assert.match(markup, /<button[^>]*class="btn primary"[^>]*aria-label="Load versions"[^>]*>Load versions<\/button>/);
  assert.doesNotMatch(markup, /No versions loaded|iconOnly runtimeRefresh|<select[^>]*aria-label="Version"/);
  assert.ok(markup.indexOf('>Load versions</button>') < markup.indexOf('>Installed</span>'));
  assert.ok(markup.indexOf('>Installed</span>') < markup.indexOf('>Register custom…</button>'));
  assert.equal((markup.match(/class="saveSectionTitle runtimeInstalledHeader"/g) || []).length, 2);
});
test('all source refresh controls stay above their own selectors without a shared remote refresh', () => {
  const runtime = manager('split', {}, { versions: ['mac-v1', 'stock-v1'], supportsLatestOnly: true,
    sources: [{ id: 'builds', label: 'MacLauncher Builds', source: 'https://example.org/builds', versions: ['mac-v1'], supportsLatestOnly: false },
      { id: 'upstream', label: 'Upstream', source: 'https://example.com/releases', versions: ['stock-v1'], supportsLatestOnly: true }] });
  const markup = render([runtime]);
  const sharedHeader = markup.split('class="saveSectionTitle runtimeInstalledHeader"')[1].split('class="runtimeSectionBody"')[0];
  assert.doesNotMatch(sharedHeader, /runtimeRefresh|All versions/);
  assert.equal((markup.match(/class="runtimeSourceHeader"/g) || []).length, 2);
  assert.equal((markup.match(/class="btn iconOnly runtimeRefresh"/g) || []).length, 2);
  assert.equal((markup.match(/>All versions<\/button>/g) || []).length, 1);
  for (const id of ['builds', 'upstream']) {
    const row = markup.split(`data-runtime-source="${id}"`)[1].split('data-runtime-source=')[0];
    assert.ok(row.indexOf('runtimeRefresh') < row.indexOf('<select'));
    const selectors = row.split('class="runtimeRemote"')[1];
    assert.doesNotMatch(selectors, /runtimeRefresh|All versions/);
  }
  const legacy = render([manager('single', {}, { versions: ['v1'], source: 'https://example.com/releases' })]);
  assert.ok(legacy.indexOf('class="runtimeSourceHeader"') < legacy.indexOf('class="runtimeRemote"'));
  assert.equal((legacy.match(/class="btn iconOnly runtimeRefresh"/g) || []).length, 1);
});
test('concise runtime tabs retain the actual runtime name visibly inside the panel', () => {
  const wine = { ...manager('sikarugir', { tabLabel: 'Wine', management: 'managed' }), label: 'Sikarugir Wine' };
  const other = { ...manager('other', { tabLabel: 'Other', management: 'managed' }), label: 'Other' };
  const markup = render([wine, other], wine.id);
  assert.match(markup, /class="launcherSidebarItem[^>]*>Wine<\/button>/);
  assert.match(markup, /class="runtimePanelTitle">Sikarugir Wine<\/div>/);
  assert.ok(markup.indexOf('class="runtimePanelTitle">Sikarugir Wine') < markup.indexOf('class="runtimeSectionTitle">Versions'));
  assert.match(render([wine, other], other.id), /class="runtimePanelTitle">Other<\/div>/);
  const tools = { ...manager('inspector', { groupId: 'tools', tabLabel: 'Tools', sectionLabel: 'Inspector' }), label: 'Inspector' };
  const secondTool = { ...manager('exporter', { groupId: 'tools', tabLabel: 'Tools', sectionLabel: 'Exporter' }), label: 'Exporter' };
  assert.doesNotMatch(render([tools, secondTool, other], tools.id), /class="runtimePanelTitle"/);
});
test('the Runtimes sidebar heads category sections and a visible tab names its panel', () => {
  const engines = [manager('zeta-engine', { tabLabel: 'Zeta engine', order: 1 }), manager('alpha-engine', { tabLabel: 'Alpha engine', order: 99 })];
  const platform = manager('handheld', { tabLabel: 'Handheld', category: 'platforms', order: 5 });
  const graphics = manager('graphics-models', { groupId: 'graphics', tabLabel: 'Graphics', sectionLabel: 'Lossless Scaling', management: 'managed' },
    { versions: ['model'] }, [{ version: 'model', ready: true }]);
  const tools = [manager('reader', { groupId: 'tools', tabLabel: 'Tools', sectionLabel: 'Reader', memberOrder: 1 }),
    manager('viewer', { groupId: 'tools', tabLabel: 'Tools', sectionLabel: 'Viewer', memberOrder: 2 })];
  const markup = render([...tools, graphics, platform, ...engines], 'reader');
  const sidebar = markup.match(/<nav class="launcherSidebarChoices"[^>]*>([\s\S]*?)<\/nav>/)[1];
  const order = [...sidebar.matchAll(/<h2 class="launcherSidebarHeading"[^>]*>([^<]+)<\/h2>|class="launcherSidebarItem[^>]*>([^<]+)<\/button>/g)]
    .map(match => match[1] ? `# ${match[1]}` : match[2]);
  // Game engines are alphabetical regardless of numeric order; a heading that would repeat its only item is replaced by a rule.
  assert.deepEqual(order, ['# Game engines', 'Alpha engine', 'Zeta engine', '# Consoles and mobile', 'Handheld', 'Graphics', 'Tools']);
  assert.match(sidebar, /role="group" aria-labelledby="([^"]+)"><h2 class="launcherSidebarHeading" id="\1">Game engines<\/h2>/);
  assert.deepEqual([...sidebar.matchAll(/class="launcherSidebarSection unlabeled" role="group" aria-label="([^"]+)"/g)].map(match => match[1]), ['Graphics', 'Tools']);
  assert.match(markup, /role="tab" aria-selected="true"[^>]*title="Backend reader"[^>]*>Reader<\/button>/);
  assert.doesNotMatch(markup, /class="runtimePanelTitle"/);
});
test('fixed built-ins expose no management tab or setup control while managed included fallbacks remain visible', () => {
  const fixed = manager('fixed', { tabLabel: 'Fixed runtime', management: 'built-in' }, { versions: ['fixed-v1'] });
  const managed = manager('managed', { tabLabel: 'Managed runtime', management: 'managed' }, { versions: ['managed-v1'] },
    [{ version: 'managed-v1', included: true, ready: true }]);
  const markup = render([fixed, managed], fixed.id);
  assert.match(markup, /Managed runtime/); assert.match(markup, /managed-v1/);
  assert.doesNotMatch(markup, /Fixed runtime|fixed-v1|runtime-panel-fixed/);
  const mixed = { ...manager('mixed', { tabLabel: 'Mixed runtime', management: 'managed', sectionManagement: { mac: 'built-in', web: 'managed' } }),
    sections: [{ id: 'mac', label: 'Native', catalog: { versions: ['native-v1'] } },
      { id: 'web', label: 'Web', catalog: { versions: ['web-v2'] } }] };
  const web = render([mixed], mixed.id, { runtimeSectionId: 'mac' });
  assert.match(web, /web-v2/); assert.doesNotMatch(web, /native-v1|runtime-panel-mixed-mac/);
});
test('refresh feedback remains visible while waiting and after an unchanged catalog response', () => {
  const runtime = manager('release', { tabLabel: 'Releases' }, { versions: ['1.16', '1.15', '1.14'], supportsLatestOnly: false });
  const busy = render([runtime], runtime.id, { runtimeUi: { release: { remoteOpen: {}, installVersion: {}, installVariant: {}, installedSort: {}, error: null,
    pendingActions: { default: 'refreshCatalog' } } } });
  assert.match(busy, /class="btn iconOnly runtimeRefresh refreshing" disabled="" aria-busy="true"/);
  assert.match(busy, /Refreshing versions…/);
  const completed = render([runtime], runtime.id, { runtimeUi: { release: { remoteOpen: {}, installVersion: {}, installVariant: {}, installedSort: {}, error: null,
    messages: { default: 'Versions updated at 10:42:00' } } } });
  assert.match(completed, /popover="auto" class="helpPopover"><div class="runtimeCatalogDetails"><div>3 versions/);
  assert.match(completed, /Versions updated at 10:42:00/);
  assert.match(completed, /class="dim runtimeActionStatus" role="status">Versions updated\.<\/div>/);
  assert.doesNotMatch(completed, />All versions<\/button>/);
  assert.match(render([manager('slow', {}, { supportsLatestOnly: true })]), />All versions<\/button>/);
});
test('runtime import and optional bootstrap installation are available without a game or loaded versions', () => {
  const runtime = { ...manager('official', { tabLabel: 'GameMaker' }, { importable: true, importLabel: 'Import runtime directory…' }),
    setupActions: [{ id: 'installIgor', label: 'Igor', buttonLabel: 'Install Igor', description: 'Installed automatically when needed.' }] };
  const markup = render([runtime], runtime.id, { onRuntimeImport() {}, onRuntimeSetupAction() {} });
  assert.match(markup, />Import runtime directory…<\/button>/);
  assert.match(markup, />Install Igor<\/button>/);
  assert.match(markup, /Installed automatically when needed/);
});
test('local application versions show paths and independent defaults without download or uninstall controls', () => {
  const versions = ['local-stable', 'local-beta'];
  const runtime = { ...manager('local-apps', { tabLabel: 'Local player' }, {
    delivery: 'local', versions, installable: false, importable: true, importLabel: 'Add application…',
    importDescription: 'Register an installed application.', refreshLabel: 'Find installed applications',
    versionLabels: { 'local-stable': '26.0 · Player.app', 'local-beta': '26.0 · Player Beta.app' }
  }, versions.map((version, index) => ({ version, external: true, ready: true,
    installDir: index ? '/Applications/Player Beta.app' : '/Applications/Player.app' }))), defaultVersion: 'local-beta' };
  const markup = render([runtime], runtime.id, { onRuntimeImport() {} });
  assert.match(markup, /runtimeSectionTitle">Applications/);
  assert.match(markup, /2 applications/);
  assert.match(markup, /Registered applications/);
  assert.match(markup, /26.0 · Player</);
  assert.match(markup, /26.0 · Player Beta<span class="badge badgeAccent">Default/);
  assert.match(markup, /\/Applications\/Player Beta\.app/);
  assert.match(markup, /aria-label="Find installed applications"/);
  assert.match(markup, />Add application…<\/button>/);
  assert.equal((markup.match(/aria-label="Remove"/g) || []).length, 2);
  assert.equal((markup.match(/>Set default<\/button>/g) || []).length, 1);
  assert.doesNotMatch(markup, /Uninstall|class="btn primary"|Latest available|Latest installed|runtimeRemote/);
  const empty = render([{ ...runtime, installed: [], catalog: { ...runtime.catalog, versions: [] } }], runtime.id, { onRuntimeImport() {} });
  assert.match(empty, /No applications registered\./);
  assert.match(empty, />Add application…<\/button>/);
  assert.doesNotMatch(empty, /No versions loaded|No runtime versions installed/);
  const busy = render([runtime], runtime.id, { onRuntimeImport() {}, runtimeUi: { 'local-apps': {
    remoteOpen: {}, installVersion: {}, installVariant: {}, installedSort: {}, error: null,
    pendingActions: { default: 'refreshCatalog' } } } });
  assert.match(busy, /Finding applications…/);
  assert.match(busy, /aria-label="Finding applications"/);
});
test('per-game backend choices honor filtered eligibility and local application labels', () => {
  const state = require('./library-layout-fixture').createLibraryFixture();
  const module = state.modules[0];
  module.runtime.supported.push('local');
  module.runtime.entries.local = { label: 'Local player', settings: { fields: [{ key: 'locale', label: 'Locale', type: 'string' }] } };
  module.runtime.manager.local = 'local-apps';
  state.runtimeManagers['local-apps'] = manager('local-apps', {}, { delivery: 'local', versions: ['copy-a', 'copy-b'],
    versionLabels: { 'copy-a': '26.0 · Player.app', 'copy-b': '26.0 · Player Beta.app' } }, [{ version: 'copy-a' }, { version: 'copy-b' }]);
  state.runtimeManagers['local-apps'].defaultVersion = 'copy-a';
  const renderGame = game => renderToStaticMarkup(React.createElement(GameDetails, {
    g: game, state, moduleInfo: module, actions: {}, cheatsStatus: null, libsStatus: null, runtimeStatusEntry: null,
    cheatsPatchBusy: false, libsPatchBusy: false, moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null
  }));
  const game = { ...state.recents[0], runtimeId: 'local', nativeAppPath: null,
    moduleRuntimeSupport: ['managed', 'local'], runtimeData: { local: { version: 'copy-b' } } };
  const eligible = renderGame(game);
  assert.match(eligible, /<option value="local" selected="">Local player<\/option>/);
  assert.match(eligible, /<option value="copy-a">v26.0 · Player<\/option>/);
  assert.match(eligible, /<option value="copy-b" selected="">v26.0 · Player Beta<\/option>/);
  assert.match(eligible, /aria-label="Runtime settings"/);
  const ineligible = renderGame({ ...game, runtimeId: 'managed', moduleRuntimeSupport: [] });
  const emptyChoices = ineligible.match(/<select aria-label="Runtime"[^>]*>(.*?)<\/select>/)[1];
  assert.match(emptyChoices, /<option value="managed" disabled="" selected="">Managed runtime \(saved; incompatible input\)<\/option>/);
  assert.doesNotMatch(emptyChoices, /<option value="(?:local|native)"/);
  const alternate = renderGame({ ...game, runtimeId: 'managed', moduleRuntimeSupport: ['local'] });
  const alternateChoices = alternate.match(/<select aria-label="Runtime"[^>]*>(.*?)<\/select>/)[1];
  assert.match(alternateChoices, /<option value="managed" disabled="" selected="">/);
  assert.match(alternateChoices, /<option value="local">Local player<\/option>/);
  assert.doesNotMatch(alternateChoices, /<option value="local" selected=""/);
  const native = renderGame({ ...game, runtimeId: 'native', moduleRuntimeSupport: ['native'], nativeAppPath: '/Games/Player.app' });
  assert.match(native, /<option value="native" selected="">Native app<\/option>/);
  assert.doesNotMatch(native, /<option value="local"/);
});
test('runtime setup notices live in anchored version help while errors and reload stay visible', () => {
  const runtime = { ...manager('optional-source', {}, { versions: ['1.2.3'], supportsLatestOnly: true,
    source: 'https://github.com/example/runtime', installHelpUrl: 'https://example.com/setup', installLabel: 'Build' }),
    notice: { title: 'Optional source builds', lines: ['Install the build tools only for other versions.',
      { text: 'brew install cmake', mono: true }] } };
  const markup = render([runtime], runtime.id, { runtimeUi: { 'optional-source': {
    remoteOpen: {}, installVersion: {}, installVariant: {}, installedSort: {}, error: 'Download failed.' } } });
  const help = markup.indexOf('popover="auto" class="helpPopover"');
  const notice = markup.indexOf('class="runtimeNotice"');
  assert.ok(help >= 0 && notice > help);
  assert.ok(markup.indexOf('class="error runtimeError"') < help);
  assert.match(markup.slice(notice), /Install the build tools only for other versions\./);
  assert.match(markup.slice(notice), /class="runtimeNoticeLine mono">brew install cmake/);
  assert.match(markup.slice(help, notice), /href="https:\/\/example.com\/setup"/);
  assert.match(markup, /aria-label="Reload versions"/);
  assert.match(markup, />All versions<\/button>/);
});
test('bundled installation hides source-build setup links and invalid old selection falls back to a real listed version', () => {
  const runtime = manager('bundled', {}, { versions: ['1.16'], installLabel: 'Install', installHelpUrl: 'https://example.com/build' });
  const markup = render([runtime], runtime.id, { runtimeUi: { bundled: { remoteOpen: {}, installVersion: { default: 'snapshot-deleted' }, installVariant: {}, installedSort: {}, error: null } } });
  assert.match(markup, /<option value="1.16" selected="">v1.16<\/option>/);
  assert.doesNotMatch(markup, /Setup instructions|snapshot-deleted/);
});
test('included runtime versions stay selectable without install, removal or repeated resource paths', () => {
  const runtime = manager('included', {}, { versions: ['1.2.3'], includedVersions: ['1.2.3'], installable: false,
    latestAvailableVersion: '1.2.3', latestInstalledVersion: '1.2.3',
    versionRequirements: { '1.2.3': { included: true, available: true, installLabel: 'Included' } } },
    [{ version: '1.2.3', ready: true, source: 'bundled', bundledExecution: 'direct', readOnly: true, removable: false,
      installDir: '/application/resources/native-runtime' }]);
  const markup = render([runtime]);
  assert.match(markup, /v1.2.3 · Included/);
  assert.match(markup, />Included<\/span>/); assert.match(markup, />Set default<\/button>/);
  assert.match(markup, /class="runtimeSectionTitle">Versions/);
  assert.match(markup, /runtimeInstalledHeader"><span>Included<\/span>/);
  assert.doesNotMatch(markup, /Available versions|Latest available|Latest installed|class="btn primary"|aria-label="Uninstall"|\/application\/resources\/native-runtime/);
  const registration = { ...runtime, installed: [{ version: '1.2.3', source: 'local', installDir: '/registered/runtime' }],
    catalog: { ...runtime.catalog, includedVersions: [], versionRequirements: { '1.2.3': { included: false } } } };
  assert.match(render([registration]), /aria-label="Uninstall"/); assert.match(render([registration]), /\/registered\/runtime/);
});
test('a disabled historical install explains the selected release rather than general setup', () => {
  const runtime = manager('history', {}, { versions: ['legacy'], installable: false,
    installReason: 'General setup help.', versionRequirements: {
      legacy: { installReason: 'This release has no reviewed Mac runtime.' }
    } });
  const markup = render([runtime]);
  assert.match(markup, /disabled="" title="This release has no reviewed Mac runtime\."/);
  assert.doesNotMatch(markup, /General setup help\./);
});

test('included resources needing a private execution copy stay ready without an installer, while managed copies stay installed', () => {
  const shipped = { version: '1.2.3', included: true, bundledExecution: 'copy', ready: true, removable: false,
    installDir: '/application/resources/runtime' };
  const runtime = manager('copy-at-launch', {}, { versions: ['1.2.3'] }, [shipped]);
  const included = render([runtime]);
  assert.match(included, /v1.2.3 · Included/);
  assert.match(included, /runtimeInstalledHeader"><span>Included<\/span>/);
  assert.doesNotMatch(included, /class="btn primary"|aria-label="Uninstall"|\/application\/resources\/runtime/);
  const managed = render([{ ...runtime, installed: [{ version: '1.2.3', source: 'download', ready: true,
    installDir: '/managed/runtime' }] }]);
  assert.match(managed, /v1.2.3 · Installed/);
  assert.match(managed, /aria-label="Uninstall"/);
  assert.doesNotMatch(managed, /· Included/);
});

test('switching architecture never hides installation behind another architecture included status', () => {
  const runtime = { ...manager('architectures', {}, { versions: ['1.2.3'], installableVersions: ['1.2.3'],
    versionRequirements: { '1.2.3': { variants: {
      arm64: { included: true }, x64: { included: false, installLabel: 'Install', installable: false,
        installReason: 'This release has no Intel package.' }
    } } } }, [{ version: '1.2.3', variant: 'arm64', ready: true, bundledExecution: 'direct', removable: false }]),
    defaultVariant: 'arm64', variants: [{ id: 'arm64', label: 'Apple Silicon' }, { id: 'x64', label: 'Intel' }] };
  assert.doesNotMatch(render([runtime]), /class="btn primary"/);
  const markup = render([runtime], runtime.id, { runtimeUi: { architectures: { remoteOpen: {}, installVersion: {},
    installVariant: { default: 'x64' }, installedSort: {}, error: null } } });
  assert.match(markup, /<option value="x64" selected="">Intel<\/option>/);
  assert.match(markup, /class="btn primary" disabled="" title="This release has no Intel package\."/);
  assert.doesNotMatch(markup, /v1.2.3 · Included/);
});
test('the Build override defaults to the launcher CPU and lists only CPUs with their own builds', () => {
  const builds = (key, architecture) => ({ versions: ['1.0'], versionRequirements: { '1.0': { architecture } } });
  const section = architectureCatalogs => ({ ...manager('cpu', {}, { versions: ['1.0'], architecture: 'arm64', architectureCatalogs }),
    launcherArchitecture: 'arm64' });
  const both = render([section({ arm64: builds('arm64', 'arm64'), x64: builds('x64', 'x64') })], 'cpu');
  const select = /<select[^>]*aria-label="Build architecture"[^>]*>(.*?)<\/select>/.exec(both)?.[1] || '';
  assert.deepEqual([...select.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map(match => match[1]), ['Automatic (Apple Silicon)', 'Intel (Rosetta)']);
  assert.match(select, /<option value="" selected="">/);
  // Intel-only builds listed for Apple Silicon offer no Apple Silicon choice.
  const intelOnly = render([section({ arm64: builds('arm64', 'x64'), x64: builds('x64', 'x64') })], 'cpu');
  assert.doesNotMatch(intelOnly, /aria-label="Build architecture"/);
  // A download that names no CPU, such as one publisher DMG for every Mac, is in both lists and needs no choice.
  assert.doesNotMatch(render([section({ arm64: { versions: ['1.0'] }, x64: { versions: ['1.0'] } })], 'cpu'), /aria-label="Build architecture"/);
  // Universal builds appear in both lists and need no choice.
  assert.doesNotMatch(render([section({ arm64: builds('arm64', 'universal'), x64: builds('x64', 'universal') })], 'cpu'), /aria-label="Build architecture"/);
  // The Intel app on Apple Silicon offers an Apple-Silicon-only runtime's builds
  // even though its automatic Intel list is empty.
  const appleOnly = { ...manager('cpu', {}, { status: 'success', versions: [], architecture: 'x64',
    architectureCatalogs: { arm64: builds('arm64', 'arm64'), x64: { versions: [] } } }), launcherArchitecture: 'x64' };
  const intelApp = render([appleOnly], 'cpu');
  const options = /<select[^>]*aria-label="Build architecture"[^>]*>(.*?)<\/select>/.exec(intelApp)?.[1] || '';
  assert.deepEqual([...options.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map(match => match[1]), ['Automatic (Intel)', 'Apple Silicon']);
  const picked = render([appleOnly], 'cpu', { runtimeUi: { cpu: { remoteOpen: {}, installVersion: {}, installVariant: {},
    installArchitecture: { default: 'arm64' }, installedSort: {} } } });
  assert.match(picked, /<option value="arm64" selected="">Apple Silicon<\/option>/);
  assert.match(picked, /<option[^>]*value="1\.0"/);
  // A remembered choice that is no longer offered falls back to the automatic list.
  const older = { versions: ['1.0', '0.9'], versionRequirements: { '1.0': { architecture: 'x64' }, '0.9': { architecture: 'x64' } } };
  const stale = render([section({ arm64: builds('arm64', 'x64'), x64: older })], 'cpu', { runtimeUi: { cpu: { remoteOpen: {},
    installVersion: {}, installVariant: {}, installArchitecture: { default: 'x64' }, installedSort: {} } } });
  assert.doesNotMatch(stale, /aria-label="Build architecture"/);
  assert.doesNotMatch(stale, /<option[^>]*value="0\.9"/);
});
test('a refreshed catalog names each listed version in the Version menu beside a newer unpublished installation', () => {
  // A refreshed Builds catalog lists an older published version for both CPUs,
  // while a newer installed version that was never published stays a retained entry.
  const requirement = architecture => ({ architecture, hostArchitectures: [architecture], minimumMacOS: '26.0',
    requiresDownload: true, requiresBuild: false, available: false, installLabel: 'Install' });
  const catalog = architecture => {
    const listed = { status: 'success', versions: ['MCLv8'], installable: true, installableVersions: ['MCLv8'], versionLabels: { MCLv8: 'MCLv8' } };
    const versionRequirements = { MCLv9: { ...requirement('x64'), available: true }, MCLv8: requirement(architecture) };
    return { ...listed, architecture, versionRequirements, sources: [{ ...listed, id: 'builds', label: 'MacLauncher Builds',
      source: 'https://procrastinine.github.io/maclauncher-builds/#refreshed', versionRequirements: { MCLv8: versionRequirements.MCLv8 } }] };
  };
  const section = { id: 'default', label: 'Refreshed versions', defaultVersion: 'MCLv8', defaultSource: 'manager',
    launcherArchitecture: 'arm64', automaticArchitecture: 'arm64', defaultArchitecture: 'arm64',
    installed: [{ version: 'MCLv9', architecture: 'x64', variant: 'architecture:arm64', ready: true, status: 'ready' }],
    catalog: { ...catalog('arm64'), architectureCatalogs: { arm64: catalog('arm64'), x64: catalog('x64') } } };
  const runtime = { id: 'refreshed', label: 'Refreshed', ui: {}, ...section, sections: [section] };
  for (const build of ['', 'x64']) {
    const markup = render([runtime], runtime.id, { runtimeUi: { refreshed: { remoteOpen: {}, installVersion: {}, installVariant: {},
      installArchitecture: { default: build }, installedSort: {}, error: null } } });
    const menu = /<select[^>]*aria-label="MacLauncher Builds version"[^>]*>(.*?)<\/select>/.exec(markup)?.[1] || '';
    const options = [...menu.matchAll(/<option[^>]*value="([^"]+)"[^>]*>([^<]*)<\/option>/g)].map(match => match.slice(1));
    assert.deepEqual(options.map(([value]) => value), ['MCLv8'], build || 'automatic build');
    // The visible text names the version itself, not a generic or relative description.
    for (const [value, text] of options) assert.ok(text.includes(value), `${value} reads "${text}"`);
    assert.match(markup, /class="saveName">MCLv9</);
  }
});
test('an Intel-only build installed on Apple Silicon is installed and can be the default', () => {
  const runtime = { ...manager('intel-only', {}, { versions: ['1.0'], installableVersions: ['1.0'], architecture: 'arm64',
    versionRequirements: { '1.0': { architecture: 'x64', installLabel: 'Install' } } },
    [{ version: '1.0', architecture: 'x64', ready: true, removable: true }]), launcherArchitecture: 'arm64', defaultVersion: '1.0' };
  const markup = render([runtime], runtime.id);
  assert.match(markup, /<span class="badge badgeAccent"[^>]*>Default<\/span>/);
  assert.doesNotMatch(markup, /<button[^>]*class="btn primary"[^>]*>Install<\/button>/);
});
test('installed builds are tagged by the CPU they were published for, and a missing default is stated', () => {
  // Both build choices hold x86_64 Wine; only the other build choice is tagged, and the Apple Silicon build is the default.
  const slots = { ...manager('slots', {}, { versions: ['1.0'] }, [
    { version: '1.0', architecture: 'x64', variant: 'architecture:arm64', ready: true },
    { version: '1.0', architecture: 'x64', variant: 'architecture:x64', ready: true }]), launcherArchitecture: 'arm64', defaultVersion: '1.0' };
  const rows = render([slots], slots.id).split('class="saveRow"').slice(1);
  assert.equal(rows.length, 2);
  assert.ok(rows.some(row => /badgeAccent/.test(row) && !/class="badge">(?:Apple Silicon|Intel)/.test(row)));
  assert.ok(rows.some(row => !/badgeAccent/.test(row) && /class="badge">Intel<\/span>/.test(row)));
  assert.doesNotMatch(render([slots], slots.id), / build<\/span>/);
  // In the Intel app the same rows are tagged the other way round.
  const intelApp = render([{ ...slots, launcherArchitecture: 'x64' }], slots.id).split('class="saveRow"').slice(1);
  assert.ok(intelApp.some(row => /class="badge">Apple Silicon<\/span>/.test(row)) && intelApp.some(row => !/class="badge">(?:Apple Silicon|Intel)/.test(row)));
  // An Intel-only binary installed for the Apple Silicon build choice stays tagged Intel.
  const single = { ...manager('single', {}, { versions: ['1.0'] }, [{ version: '1.0', architecture: 'x64', variant: 'architecture:arm64', ready: true }]),
    launcherArchitecture: 'arm64', defaultVersion: '1.0' };
  assert.match(render([single], single.id), /class="badge">Intel<\/span>/);
  // A library loaded by x86_64 Wine whose package targets Apple Silicon is not tagged Intel.
  const library = { ...manager('library', {}, { versions: ['1.0'], versionRequirements: { '1.0': { architecture: 'arm64' } } },
    [{ version: '1.0', architecture: 'x64', ready: true }]), launcherArchitecture: 'arm64', defaultVersion: '1.0' };
  assert.doesNotMatch(render([library], library.id), /class="badge">Intel</);
  assert.doesNotMatch(render([library], library.id), /<button[^>]*class="btn primary"[^>]*>Install<\/button>/);
  // Declared host CPUs win over file inspection: Apple-Silicon-only packages and
  // packages for every Mac carry no tag; a declared Intel build keeps its tag.
  const tagged = (requirement, architecture = 'x64') => {
    const runtime = { ...manager('declared', {}, { versions: ['1.0'], versionRequirements: { '1.0': requirement } },
      [{ version: '1.0', architecture, ready: true }]), launcherArchitecture: 'arm64', defaultVersion: '1.0' };
    return /class="badge">Intel</.test(render([runtime], runtime.id));
  };
  assert.equal(tagged({ hostArchitectures: ['arm64'] }), false);
  assert.equal(tagged({ hostArchitectures: ['arm64', 'x64'] }), false);
  assert.equal(tagged({ architecture: 'x64', hostArchitectures: ['arm64', 'x64'] }), true);
  assert.equal(tagged({}), true);
  const missing = { ...manager('missing', {}, { versions: ['2.0', '1.0'] }, [{ version: '1.0', ready: true }]), defaultVersion: '2.0' };
  assert.match(render([missing], missing.id), /The default version, v2\.0, is not installed\. MacLauncher asks before downloading it when a game needs it\./);
  assert.doesNotMatch(render([library], library.id), /is not installed/);
  // A default shared by two sections and installed in the other one is installed.
  const line = (id, version, installed) => ({ id, label: id, defaultVersion: '1.12', catalog: { status: 'idle', versions: [version] }, installed });
  const lineState = newer => ({ id: 'lines', label: 'Backend lines', ui: {},
    sections: [line('old', '1.9', [{ version: '1.9', ready: true }]), line('new', '1.12', newer)] });
  assert.doesNotMatch(render([lineState([{ version: '1.12', ready: true }])], 'lines', { runtimeSectionId: 'old' }), /is not installed/);
  assert.match(render([lineState([])], 'lines', { runtimeSectionId: 'old' }), /The default version, v1\.12, is not installed/);
});
test('a runtime whose packages another runtime installs names that runtime instead of an empty download list', () => {
  const art = manager('art', {}, { status: 'success', versions: [], source: 'https://example.org/builds',
    packagesFrom: { managerId: 'android', label: 'MacLauncher Android' } }, [{ version: '0.1.0', ready: true }]);
  const android = manager('android', {}, { versions: ['0.2.0'] });
  const markup = render([art, android], 'art');
  assert.match(markup, /MacLauncher Android installs these versions/);
  assert.match(markup, />Open MacLauncher Android<\/button>/);
  assert.doesNotMatch(markup, /No downloadable versions|Load versions|runtimeSources/);
});
test('cached source build choices display compact source/help links and explicit installed states', () => {
  const runtime = manager('source', { tabLabel: 'Source runtime' }, { versions: ['1.2.3'],
    installable: true, installLabel: 'Build', source: 'https://github.com/example/runtime/tree/revision',
    installReason: 'Requires CMake and SDL2.', installHelpUrl: 'https://example.com/setup' });
  const markup = render([runtime]);
  assert.match(markup, /<option value="1.2.3" selected="">v1.2.3<\/option>/);
  assert.match(markup, /<button class="btn primary">Build<\/button>/);
  assert.match(markup, /href="https:\/\/github.com\/example\/runtime\/tree\/revision"[^>]*>github.com<\/a>/);
  assert.match(markup, /href="https:\/\/example.com\/setup"[^>]*>Setup instructions<\/a>/);
  assert.match(markup, /Requires CMake and SDL2\./);
  assert.doesNotMatch(markup, /Reviewed pinned catalog|docs\/NATIVE_TOOL_SETUP/);
  assert.match(render([runtime], runtime.id, { downloadTasks: [{ id: 'build', managerId: runtime.id,
    sectionId: 'default', version: '1.2.3', downloaded: 0, total: null }] }), /<button class="btn primary" disabled="">Installing…<\/button>/);
  assert.match(render([{ ...runtime, installed: [{ version: '1.2.3' }] }]), /<button class="btn primary" disabled="" title="This version is installed\.">Installed<\/button>/);
});
test('direct grouped backend selection renders the correct tab and its version without sibling leakage', () => {
  const older = manager('opaque-a', { groupId: 'alice', tabLabel: 'AliceSoft', order: 110,
    sectionLabel: 'System 1–3', memberOrder: 0 }, { versions: ['old-v1'] });
  const newer = manager('opaque-b', { groupId: 'alice', tabLabel: 'AliceSoft', order: 110,
    sectionLabel: 'System 3.5–3.9', memberOrder: 1 }, { versions: ['new-v2'] });
  const markup = render([older, newer, manager('common', { tabLabel: 'NW.js', order: 10 })], newer.id);
  assert.match(markup, /class="launcherSidebarItem active" aria-current="page"[^>]*>AliceSoft<\/button>/);
  assert.match(markup, /role="tab" aria-selected="true"[^>]*>System 3.5–3.9<\/button>/);
  assert.match(markup, /<option value="new-v2" selected="">/);
  assert.doesNotMatch(markup, /<option value="old-v1"/);
  // Game engines are listed alphabetically.
  assert.ok(markup.indexOf('>AliceSoft</button>') < markup.indexOf('>NW.js</button>'));
});
test('the discovered ILSpy tool exposes versions and defaults through the shared UI', t => {
  const fs = require('node:fs'), os = require('node:os');
  const registry = require('../src/modules/registry');
  const tool = require('../src/modules/shared/runtime/managed-decompiler');
  const catalog = require('../src/modules/shared/runtime/ilspy-catalog');
  const manager = registry.listSharedRuntimeManagers().find(item => item.id === 'ilspy');
  assert.ok(manager);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maclauncher-tool-controls-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  // A previously retrieved release remains selectable without a render-time fetch.
  const { entries: fixtures } = require('./helpers/ilspy-catalog-fixture.cjs');
  catalog.saveCatalog(userDataDir, [fixtures['9.1.0.7988']]);
  const pin = fixtures['11.1.0.9782'], root = tool.installRoot(userDataDir, pin.version), files = path.join(root, 'files');
  fs.mkdirSync(files, { recursive: true });
  for (const name of ['ilspycmd.dll', 'ilspycmd.deps.json', 'ilspycmd.runtimeconfig.json', 'ICSharpCode.Decompiler.dll'])
    fs.writeFileSync(path.join(files, name), 'tool fixture');
  fs.writeFileSync(path.join(root, 'tool.json'), JSON.stringify({ version: pin.version, archiveSha256: pin.sha256,
    archiveSha512: pin.sha512, sourceRevision: pin.sourceRevision, framework: pin.framework, catalogEntry: pin, files: tool.__test.inventory(files) }));
  const state = manager.getState({ userDataDir });
  const model = { id: manager.id, label: manager.label, ui: registry.getRuntimeManagerUi(manager.id), ...state };
  const fixed = { id: 'fna', label: 'FNA', ui: registry.getRuntimeManagerUi('fna'), catalog: { versions: ['fixed-fna'] } };
  const markup = render([fixed, model], manager.id, { runtimeSectionId: 'decompiler',
    runtimeUi: { ilspy: { remoteOpen: { decompiler: true }, installVersion: {}, installVariant: {}, installedSort: {}, error: null } } });
  assert.match(markup, /runtime-panel-ilspy-decompiler/);
  assert.match(markup, /<option value="11\.1\.0\.9782"/); assert.match(markup, /<option value="9\.1\.0\.7988"/);
  assert.match(markup, /\.NET 10\.0/); assert.match(markup, /badge badgeAccent[^>]*>Default<\/span>/);
  assert.equal(state.sections.find(section=>section.id==='decompiler').defaultVersion,pin.version,'usable installed tool is the automatic default');
  assert.doesNotMatch(markup,/Set default<\/button>/,'the automatic installed default has no redundant default action');
  assert.match(markup, /aria-label="Reload versions"/);
  assert.doesNotMatch(markup, /runtime-panel-fna|fixed-fna|All versions<\/button>|Load versions/);
});
test('the discovered FVP module exposes its runtime, settings, tools and local icon without renderer setup', t => {
  const fs = require('node:fs'), os = require('node:os');
  const registry = require('../src/modules/registry');
  const moduleInfo = registry.getModuleInfo('fvp');
  const backend = registry.getModule('fvp').runtimeManagers.find(item => item.id === 'rfvp');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maclauncher-fvp-controls-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const runtime = { id: backend.id, label: backend.label, ui: registry.getRuntimeManagerUi(backend.id),
    ...backend.getState({ userDataDir }) };
  const markup = render([manager('other', { tabLabel: 'Other' }), runtime], backend.id);
  assert.match(markup, /class="launcherSidebarItem active"[^>]*>RFVP<\/button>/);
  assert.match(markup, /runtime-panel-rfvp-default/);
  assert.match(markup, /aria-label="Load versions"/);
  assert.doesNotMatch(markup, /No versions loaded/);
  const state = require('./library-layout-fixture').createLibraryFixture();
  state.modules = [moduleInfo];
  state.moduleSettings = { fvp: { defaultRuntime: 'rfvp' } };
  state.runtimeManagers = { rfvp: runtime };
  const offline = () => assert.fail('Rendering discovered module controls must not call the backend');
  const settings = renderToStaticMarkup(React.createElement(SettingsView, { state, showIcons: true,
    showNonDefaultTags: true, onSetLauncherSettings: offline, onSetModuleSettings: offline }));
  assert.match(settings, /class="launcherSidebarItem"[^>]*>FVP<\/button>/);
  assert.doesNotMatch(settings, /launcherSidebarSection|launcherSidebarHeading/, 'Settings keeps one plain section list');
  // main.js gives a game without artwork of its own the discovered module's icon file.
  const icon = fs.readFileSync(path.join(registry.getModuleDir('fvp'), moduleInfo.icon.path));
  const game = { ...state.recents[0], moduleId: 'fvp', runtimeId: 'rfvp', nativeAppPath: null,
    iconUrl: 'data:image/png;base64,' + icon.toString('base64'), iconSource: 'module-default',
    moduleRuntimeSupport: ['rfvp'], moduleSupports: moduleInfo.supports,
    gamePath: '/Games/Title/Title.hcb', moduleData: { scriptName: 'Title.hcb', archiveCount: 2 } };
  const inspector = renderToStaticMarkup(React.createElement(GameDetails, { g: game, state, moduleInfo,
    actions: {}, cheatsStatus: null, libsStatus: null, runtimeStatusEntry: null,
    cheatsPatchBusy: false, libsPatchBusy: false, moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null }));
  assert.match(inspector, /<option value="rfvp" selected="">RFVP<\/option>/);
  assert.match(inspector, /data-icon-source="module-default"/);
  assert.match(inspector, /aria-label="Runtime settings"/);
  assert.match(inspector, /aria-label="List assets"/);
  assert.match(inspector, /aria-label="Extract assets"/);
  assert.doesNotMatch(inspector, /<option value="crossover"/);
});

test('native local imports require a visible matching version while application imports detect their own version', () => {
  const runtime = manager('local-native', { management: 'managed' }, { versions: ['1.2', '1.1'],
    recommendedVersion: '1.2', importable: true, importVersionRequired: true, importLabel: 'Import local build…' });
  const markup = render([runtime], runtime.id, { onRuntimeImport() {}, runtimeUi: { 'local-native': {
    remoteOpen: {}, installVersion: { default: '1.1' }, installVariant: {}, installedSort: {} } } });
  assert.match(markup, /<option value="1.1" selected="">/);
  assert.match(markup, /<button class="btn">Import local build…<\/button>/);
  const unavailable = render([{ ...runtime, catalog: { ...runtime.catalog, versions: [] } }], runtime.id, { onRuntimeImport() {} });
  assert.match(unavailable, /<button class="btn" disabled="">Import local build…<\/button>/);
  const detected = render([manager('local-app', {}, { importable: true, managementKind: 'local-applications' })], 'local-app', { onRuntimeImport() {} });
  assert.match(detected, /<button class="btn">Import runtime…<\/button>/);
});

test('Sikarugir downloads and local CrossOver applications retain separate sidebar groups', () => {
  const metadata = require('../src/modules/crossover/manifest.json').runtime.managerUi;
  const wine = manager('sikarugir', metadata.sikarugir, { versions: ['11.0'] });
  const crossover = manager('crossover', metadata.crossover, { versions: [], importable: true,
    managementKind: 'local-applications', importLabel: 'Add application…' });
  const first = render([wine, crossover], 'sikarugir', { onRuntimeImport() {} });
  assert.match(first, /class="launcherSidebarItem[^>]*>Sikarugir<\/button>/);
  assert.match(first, /class="launcherSidebarItem[^>]*>CrossOver<\/button>/);
  assert.doesNotMatch(first, /aria-label="Wine sections"/);
  assert.match(first, /option value="11.0"/);
  assert.doesNotMatch(first, /Add application…/);
  const second = render([wine, crossover], 'crossover', { onRuntimeImport() {} });
  assert.match(second, /Add application…/);
  assert.doesNotMatch(second, /option value="11.0"/);
});

test('imported graphics model files expose import and removal without download or install controls', () => {
  const model = manager('graphics-models', { groupId: 'graphics', tabLabel: 'Graphics' }, {
    delivery: 'local-files', versions: ['model-1'], installable: false, importable: true,
    importLabel: 'Import model…', refreshLabel: 'Reload installed models'
  }, [{ version: 'model-1', imported: true, removalLabel: 'Remove' }]);
  const markup = render([model], model.id, { onRuntimeImport() {} });
  assert.match(markup, /Import model…/); assert.match(markup, /Imported files/);
  assert.match(markup, /aria-label="Reload installed models"/);
  assert.doesNotMatch(markup, /runtimeRemote|>Install<|No versions loaded|Registered applications/);
});

test('Graphics has its own sidebar section with component information and model actions without shader-pack management', t => {
  const models = require('../src/modules/shared/reshade/runtime/models-manager');
  t.mock.method(require('../src/modules/shared/reshade/models'), 'inspectionAvailable', () => true);
  const fs = require('node:fs');
  const userDataDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'graphics-runtime-view-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const state = models.getState({ userDataDir });
  const runtimes = [manager('engine', { tabLabel: 'Engine', order: 10 }),
    { ...state, id: models.id, label: models.label, ui: models.ui }];
  const markup = render(runtimes, models.id, { onRuntimeImport() {}, onRuntimeSetupAction() {} });
  // Graphics follows the game engines in its own section.
  assert.ok(markup.indexOf('>Engine</button>') < markup.indexOf('>Effects</button>'));
  assert.match(markup, /class="launcherSidebarHeading"[^>]*>Graphics<\/h2><ul class="launcherSidebarList"><li><button[^>]*>Effects<\/button>/);
  assert.doesNotMatch(markup, /ReShade ·|Shader packs|SweetFX|qUINT/);
  for (const label of ['Apple MetalFX', 'AMD FSR 1', 'AMD FSR 2.2', 'AMD FSR 3.1', 'AMD FSR 4.1', 'Lossless Scaling models']) assert.ok(markup.includes(label));
  assert.match(markup, /Download from Steam…/); assert.match(markup, /Find in Steam \/ CrossOver/);
  assert.match(markup, /Import Lossless Scaling DLL…/);
  assert.doesNotMatch(markup, />Install<\/button>/);
});

test('the included LuaSteam bridge stays available internally without a fake managed tab', t => {
  const love = require('../src/modules/love/runtime/love-runtime-manager');
  const metadata = require('../src/modules/love/manifest.json').runtime.managerUi.love;
  const fs = require('node:fs');
  const userDataDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'love-runtime-tabs-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const state = love.getState({ settings: {}, userDataDir });
  assert.ok(state.sections.some(section => section.id === 'luasteam'));
  const markup = render([{ id: love.id, label: love.label, ...state, ui: metadata }], love.id, { runtimeSectionId: 'luasteam' });
  assert.match(markup, />LÖVE 11<\/button>/);
  assert.match(markup, />LÖVE 12 nightly<\/button>/);
  assert.doesNotMatch(markup, /Steam bridge|LuaSteam|runtime-section-panel-love-luasteam/);
});

test('Settings section links select a module for both namespaced and direct identifiers', () => {
  const state = require('./library-layout-fixture').createLibraryFixture();
  state.modules = [{ id: 'android', label: 'Android', shortLabel: 'Android', runtime: { supported: [] } }];
  const offline = () => assert.fail('Opening a Settings section must not request a backend action');
  for (const sectionId of ['module:android', 'android']) {
    const markup = renderToStaticMarkup(React.createElement(SettingsView, { state, sectionId, navigationKey: 2,
      showIcons: true, showNonDefaultTags: true, onSetLauncherSettings: offline, onSetModuleSettings: offline }));
    assert.match(markup, /class="launcherSidebarItem active"[^>]*>Android<\/button>/);
    assert.match(markup, /id="settings-panel-android"/);
    assert.doesNotMatch(markup, /aria-label="Show game icons"/);
  }
});

test('translator source links use one caption with explicit project and Template provenance', () => {
  const create = require('../src/modules/shared/runtime/translator-managers').createManager;
  for (const engine of ['dxvk','dxmt','gstreamer']) {
    const owner=create(engine), state={...owner.getState({}),id:owner.id,label:owner.label,ui:owner.ui};
    const markup=render([state],owner.id);
    const links=[...markup.matchAll(/class="runtimeSourceLink"[^>]*>([^<]+)<\/a>/g)].map(match=>match[1]);
    assert.ok(links.length);if(engine!=='gstreamer')assert.ok(links.every(label=>label==='Source'));
    if(engine==='dxvk') { assert.match(markup,/DXVK-macOS/);assert.match(markup,/builtin-layout async packages/);assert.match(markup,/DXVK components from Sikarugir Templates/); }
    if(engine==='dxmt')assert.match(markup,/copies taken from a Sikarugir Template release/);
    if(engine==='gstreamer') { assert.match(markup,/GStreamer macOS runtime/);assert.match(markup,/Runtime framework packages published by GStreamer/);assert.match(markup,/runtimeSources/);assert.doesNotMatch(markup,/No downloadable versions/); }
  }
  for(const owner of require('../src/modules/shared/vulkan/libraries').managers) {
    const markup=render([{...owner.getState({}),id:owner.id,label:owner.label,ui:owner.ui}],owner.id);
    assert.match(markup,/class="runtimeSourceLink"[^>]*>Source<\/a>/);
    assert.match(markup, new RegExp('class="runtimeSourceName">'+(owner.backend==='moltenvk'?'MoltenVK':'LWJGL')+'<\\/span>'));
    assert.doesNotMatch(markup,/class="runtimeSourceName">Source<\/span>|Releases published by the runtime project/);
    if(owner.backend==='moltenvk')assert.match(markup,/MoltenVK releases published by KhronosGroup\/MoltenVK/);
    else assert.match(markup,/KosmicKrisp Vulkan drivers published by LWJGL/);
  }
});

test('included translator references use host records and shared release facts without managed installs or mutation controls', t => {
  const fs=require('node:fs'),os=require('node:os');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'translator-references-'));
  const previousHome=process.env.HOME;process.env.HOME=path.join(root,'home');fs.mkdirSync(process.env.HOME);
  t.after(()=>{process.env.HOME=previousHome;fs.rmSync(root,{recursive:true,force:true});});
  t.mock.method(globalThis,'fetch',()=>assert.fail('Reference status must stay offline'));
  const write=(file,bytes,mode=0o644)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{mode});return file;};
  const image=(type=6,cpu=0x1000007)=>{const bytes=Buffer.alloc(56);bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(cpu,4);bytes.writeUInt32LE(type,12);bytes.writeUInt32LE(1,16);bytes.writeUInt32LE(24,20);bytes.writeUInt32LE(0x32,32);bytes.writeUInt32LE(24,36);bytes.writeUInt32LE(1,40);bytes.writeUInt32LE(14<<16,44);return bytes;};
  const dll=()=>{const {bytes,peOffset}=require('./helpers/pe-fixture').peFixture({is64:true});bytes.writeUInt16LE(0x2002,peOffset+22);return bytes;};
  const owners=require('../src/modules/shared/runtime/translator-managers');
  const CrossOver=require('../src/modules/crossover/runtime/manager');
  const registeredCrossOver=CrossOver.core.listInstalled;
  t.mock.method(CrossOver.core,'listInstalled',directory=>registeredCrossOver(directory,{automaticPaths:[]}));
  const registry=require('../src/modules/registry'),sikarugir=registry.getModule('crossover').runtimeManagers.find(owner=>owner.id==='sikarugir');
  const originalCore=sikarugir.core;let templateHosts=[];
  // Only record enumeration is stubbed. The real reader inspects fixture hosts,
  // with no fabricated installation receipts, executable code or Wine process.
  sikarugir.core={...originalCore,listInstalled:()=>templateHosts};t.after(()=>{sikarugir.core=originalCore;});
  const userDataDir=path.join(root,'data'),warnings=[],options={userDataDir,logger:{warn:message=>warnings.push(message)}};
  t.mock.method(console,'warn',message=>warnings.push(message));
  const dxmt=owners.createManager('dxmt'),dxvk=owners.createManager('dxvk'),metal=owners.createManager('d3dmetal');
  const molten=require('../src/modules/shared/vulkan/libraries').createManager('moltenvk');
  const before=dxmt.getState(options);assert.equal(before.references,undefined);assert.deepEqual(before.installed,[]);
  const makeHost=(name,version)=>{
    const app=path.join(root,name+'.app'),wine=path.join(app,'Contents/SharedSupport/CrossOver');
    write(path.join(app,'Contents/Info.plist'),`<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
    for(const name of ['wine','cxbottle'])write(path.join(wine,'bin',name),'#!/usr/bin/perl\n',0o755);
    for(const name of ['wineloader','wineserver'])write(path.join(wine,'bin',name),image(2),0o755);
    write(path.join(wine,'lib/wine/x86_64-unix/wine'),image(2),0o755);
    const builtin=dll();builtin.write('Wine builtin DLL\0',64);
    write(path.join(wine,'lib/wine/x86_64-windows/d3d12.dll'),builtin);
    write(path.join(wine,'lib/dxmt/x86_64-windows/d3d11.dll'),dll());
    write(path.join(wine,'lib/dxvk/x86_64-windows/d3d11.dll'),dll());
    write(path.join(wine,'lib64/libMoltenVK.dylib'),image());
    write(path.join(wine,'lib64/gstreamer-1.0/libgstcoreelements.dylib'),image());
    write(path.join(wine,'changelog.html'),'Update to DXMT v0.80\nUpdate to DXVK v2.7\nUpdate to MoltenVK v1.2.10');
    const framework=path.join(wine,'lib64/apple_gptk/external/D3DMetal.framework/Versions/A');
    write(path.join(framework,'D3DMetal'),image());
    write(path.join(framework,'Resources/version.plist'),'<plist><dict><key>CFBundleShortVersionString</key><string>3.0</string></dict></plist>');
    CrossOver.importRuntime({userDataDir,runtimePath:app});return {app,wine};
  };
  const first=makeHost('Alpha','26.3'),second=makeHost('Beta','26.3');
  const registration=fs.readFileSync(CrossOver.__test.registryPath(userDataDir));
  const makeTemplate=(name,version)=>{
    const installDir=path.join(root,name),wine=path.join(installDir,'wine'),support=path.join(installDir,'support');
    write(path.join(wine,'lib/wine/x86_64-unix/wine'),image(2),0o755);
    const builtin=dll();builtin.write('Wine builtin DLL\0',64);
    write(path.join(wine,'lib/wine/x86_64-windows/d3d12.dll'),builtin);
    write(path.join(support,'SharedSupport/renderer/dxmt/d3d11.dll'),dll());
    write(path.join(support,'SharedSupport/renderer/dxmt/version'),'v0.81');
    write(path.join(support,'SharedSupport/renderer/dxvk3/d3d11.dll'),dll());
    write(path.join(support,'SharedSupport/renderer/dxvk3/version'),'3.1.1-gplasync');
    write(path.join(support,'Frameworks/GStreamer.framework/Versions/1.0/lib/gstreamer-1.0/libgstcoreelements.dylib'),image());
    return {version:name,versionLabel:name,installDir,engineRoot:wine,templateRoot:support,templateVersion:version,engineVersion:'10.0_8',ready:true};
  };
  templateHosts=[makeTemplate('Template-A','1.0.26'),makeTemplate('Template-B','1.0.27')];
  write(path.join(templateHosts[0].templateRoot,'Resources/vulkan/icd.d/optional.json'),'{');
  // Bad optional component metadata cannot hide another component or host.
  fs.symlinkSync(path.join(root,'outside'),path.join(first.wine,'lib/dxvk/escape'));fs.mkdirSync(path.join(root,'outside'));
  write(path.join(root,'outside/d3d11.dll'),dll());
  const Description=require('../src/modules/shared/runtime/translator-description'),described=[],inspected=[];
  const describe=Description.describeTranslator,inspect=Description.inspectFile;
  t.mock.method(Description,'describeTranslator',(root,options)=>{described.push(options.engine);return describe(root,options);});
  t.mock.method(Description,'inspectFile',file=>{inspected.push(file.path);return inspect(file);});
  warnings.length=0;
  const state=dxmt.getState(options),section=state.sections[0];
  assert.deepEqual(described,['dxmt','dxmt','dxmt','dxmt'],'per-manager references inspect only the requested engine');
  assert.deepEqual(inspected,[],'unrelated builtin Wine D3D12 binaries are not inspected');
  assert.deepEqual(warnings,[],'unrelated malformed optional components are not inspected');
  const Wine=require('../src/modules/shared/runtime/wine-translators');
  const unfiltered=Wine.includedTranslators(templateHosts[0],'sikarugir');
  assert.ok(unfiltered.included.some(row=>row.engine==='dxvk'));assert.ok(unfiltered.included.some(row=>row.engine==='wined3d'));
  assert.ok(unfiltered.warnings.length,'ordinary unfiltered inventory retains optional metadata warnings');
  assert.ok(Wine.includedTranslators(templateHosts[0],'sikarugir',{engine:'dxmt'}).included.every(row=>row.engine==='dxmt'));
  assert.equal(state.references.length,4);assert.deepEqual(state.installed,before.installed);assert.deepEqual(state.catalog,before.catalog);assert.equal(state.defaultVersion,before.defaultVersion);
  assert.equal(new Set(state.references.map(row=>row.version)).size,4);
  assert.ok(state.references.every(row=>row.included&&row.readOnly&&row.removable===false&&row.supportsDefault===false));
  assert.ok(state.references.every(row=>row.platformKey==='x86_64'&&row.architectures.includes('x86_64')));
  assert.ok(state.references.every(row=>row.apis.includes('Direct3D 11')));
  assert.ok(state.references.some(row=>row.versionLabel==='DXMT (CrossOver 26.3) · Alpha.app'&&row.detail==='Component 0.80'));
  assert.ok(state.references.some(row=>row.versionLabel==='DXMT (CrossOver 26.3) · Beta.app'&&row.detail==='Component 0.80'));
  assert.ok(state.references.some(row=>row.versionLabel==='DXMT · Template 1.0.26 (Wine 10.0_8)'&&row.detail==='Component v0.81'));
  assert.ok(state.references.some(row=>row.versionLabel==='DXMT · Template 1.0.27 (Wine 10.0_8)'));
  assert.deepEqual(state.references.filter(row=>row.source.runtime==='sikarugir').map(row=>row.versionLabel),['DXMT · Template 1.0.27 (Wine 10.0_8)','DXMT · Template 1.0.26 (Wine 10.0_8)']);
  assert.equal(metal.getState(options).references.length,2,'D3D12 aliases do not duplicate the same source component');
  assert.ok(metal.getState(options).references.every(row=>row.versionLabel.startsWith('D3DMetal (CrossOver 26.3)')&&row.detail==='Component 3.0'));
  assert.ok(molten.getState(options).references.every(row=>row.versionLabel.startsWith('MoltenVK (CrossOver 26.3)')&&row.detail==='Component 1.2.10'&&row.platformKey==='x86_64'));
  const dxvkState=dxvk.getState(options);
  assert.ok(dxvkState.references.some(row=>row.versionLabel==='DXVK3 · Template 1.0.27 (Wine 10.0_8)'&&row.detail==='Component 3.1.1-gplasync'));
  assert.ok(dxvkState.references.every(row=>!row.versionLabel.includes('DXVK DXVK')&&!row.versionLabel.includes('template-')));
  assert.equal(dxvkState.references.length,4,'usable siblings remain when an unsafe optional entry is skipped');assert.ok(warnings.some(row=>row.includes('dxvk')&&/outside.*root|escapes/.test(row)));
  const bounded=Wine.includedTranslators({crossoverRoot:first.wine},'crossover',{engine:'dxvk'}).included;
  assert.ok(bounded.some(row=>row.engine==='dxvk'));
  assert.ok(bounded.flatMap(row=>row.files).every(file=>!file.path.includes('escape')&&file.path.startsWith(path.join(first.wine,'lib/dxvk')+path.sep)),'unsafe entry never enters the retained description');
  const escaped=path.join(first.wine,'lib/dxvk/escaped.dll');fs.symlinkSync(path.join(root,'outside/d3d11.dll'),escaped);
  assert.equal(dxvk.getState(options).references.length,3,'a directly consumed escaping DLL excludes that component');
  assert.ok(warnings.some(row=>row.includes('dxvk')&&/outside.*root|escapes/.test(row)));
  fs.unlinkSync(escaped);
  assert.equal(owners.createManager('vkd3d-proton').getState(options).references,undefined,'builtin Wine choices are not mislabeled as vkd3d-proton');
  const wine=registry.listSharedRuntimeManagers().find(manager=>manager.id==='translator-vkd3d'),wineState=wine.getState(options);
  assert.equal(wine.customRuntime,false);assert.equal(wine.registerCustomRuntime,undefined);assert.equal(wineState.supportsDefault,false);
  assert.equal(wineState.references.length,4);assert.deepEqual(wineState.installed,[]);assert.deepEqual(wineState.catalog.versions,[]);
  assert.ok(wineState.references.every(row=>row.readOnly&&row.included&&row.reference.managerId!=='translator-vkd3d-proton'));
  assert.ok(wineState.references.some(row=>row.versionLabel.includes('Alpha.app')));assert.ok(wineState.references.some(row=>row.versionLabel.includes('Template 1.0.27')));
  const wineMarkup=render([{...wineState,id:wine.id,label:wine.label,ui:wine.ui}],wine.id,{onRuntimeRegister(){assert.fail('No standalone Wine registration');}});
  assert.match(wineMarkup,/Included copies/);assert.match(wineMarkup,/Refresh included copies/);assert.match(wineMarkup,/href="https:\/\/gitlab\.winehq\.org\/wine\/vkd3d"/);
  assert.doesNotMatch(wineMarkup,/Imported files|Register custom|Load versions|No downloadable|saveRowActions|Set default|>Install<|>Repair</);
  assert.equal(fs.existsSync(path.join(userDataDir,'runtimes',wine.id)),false,'Wine source-owned references create no receipt or payload');
  const codecs=owners.createManager('gstreamer'),codecState=codecs.getState(options);
  assert.equal(codecState.references.length,4);assert.deepEqual(codecState.installed,[]);
  assert.ok(codecState.references.every(row=>row.readOnly&&row.included&&row.versionLabel.includes('GStreamer')&&!/GStreamer (?:1\.0|26\.3)/.test(row.versionLabel)));
  const codecMarkup=render([{...codecState,id:codecs.id,label:codecs.label,ui:codecs.ui}],codecs.id,{onRuntimeRegister(){assert.fail('No registration during render');}});
  assert.match(codecMarkup,/GStreamer macOS runtime/);assert.match(codecMarkup,/GStreamer downloads/);assert.match(codecMarkup,/Register custom/);assert.match(codecMarkup,/Alpha\.app/);
  assert.doesNotMatch(codecMarkup,/No downloadable|saveRowActions/);
  assert.equal(dxmt.resolveSelection(null,null,userDataDir,{version:state.references[0].version}).install,null,'references are never managed choices');
  assert.deepEqual(require('../src/modules/shared/runtime/wine-translators').managedTranslators({userDataDir,settings:{}},'crossover',[dxmt,dxvk,metal,molten]),[],'per-game managed choices remain unchanged');
  const snapshot=structuredClone(state);
  const markup=render([{...state,id:dxmt.id,label:dxmt.label,ui:dxmt.ui}],dxmt.id);
  assert.match(markup,/>Included<\/span>/);assert.match(markup,/Alpha\.app/);assert.match(markup,/Template 1\.0\.27/);assert.match(markup,/x86_64/);
  assert.match(markup,/class="dim">Direct3D 11<\/div>/);
  assert.doesNotMatch(markup,/saveRowActions|Set default|aria-label="(?:Uninstall|Remove|Delete)|>Reinstall<|>Repair<|<option[^>]*value="reference:/);
  // Even an attached action/default marker cannot turn a reference into a control.
  const row=section.references[0];row.actions=[{id:'repair',label:'Repair reference'}];section.defaultVersion=row.version;
  const protectedMarkup=render([{...state,id:dxmt.id,label:dxmt.label,ui:dxmt.ui}],dxmt.id,{onRuntimeInstalledAction(){assert.fail('No reference action');}});
  assert.doesNotMatch(protectedMarkup,/Repair reference|saveRowActions|Set default/);
  assert.deepEqual(fs.readFileSync(CrossOver.__test.registryPath(userDataDir)),registration);
  assert.equal(fs.existsSync(path.join(userDataDir,'runtimes',dxmt.id)),false,'no managed receipt or payload created');
  assert.deepEqual(snapshot.installed,[]);assert.deepEqual(snapshot.catalog,before.catalog);
  templateHosts=[];
  CrossOver.__test.writeRegistry(userDataDir,{applications:[],ignoredPaths:[]});
  assert.equal(dxmt.getState(options).references,undefined);assert.match(render([{...dxmt.getState(options),id:dxmt.id,label:dxmt.label,ui:dxmt.ui}],dxmt.id),/No runtime versions installed yet/);
});

test('official codec catalog, local registration and Apple upstream links use ordinary runtime presentation', t => {
  const {createManager}=require('../src/modules/shared/runtime/translator-managers');
  const codecs=createManager('gstreamer'),local=codecs.getState({});
  const markup=render([{...local,id:codecs.id,label:codecs.label,ui:codecs.ui}],codecs.id,{onRuntimeRegister(){assert.fail('No registration during render');}});
  assert.equal(codecs.delivery.catalog,'remote');assert.ok(local.catalog.sources.some(source=>source.id==='upstream'));
  assert.match(markup,/Register custom/);assert.match(markup,/GStreamer macOS runtime/);assert.match(markup,/GStreamer downloads/);assert.match(markup,/Load versions/);
  assert.doesNotMatch(markup,/No downloadable versions|>Install</);
  const metal=createManager('d3dmetal'),state=metal.getState({});
  assert.equal(state.catalog.sources[0].delivery,'local-files');
  const apple=render([{...state,id:metal.id,label:metal.label,ui:metal.ui}],metal.id,{onRuntimeRegister(){assert.fail('No registration during render');}});
  assert.match(apple,/href="https:\/\/developer\.apple\.com\/games\/game-porting-toolkit\/"[^>]*>Source<\/a>/);
  assert.match(apple,/Register Game Porting Toolkit/);assert.match(apple,/Sikarugir Template/);
  assert.doesNotMatch(apple,/Register custom|Load Apple|No downloadable versions/);
  let registrations=0;
  const ui={installVersion:{},installVariant:{},installedSort:{},remoteOpen:{},pendingActions:{},messages:{},sourceErrors:{}};
  const control=componentHarness(RuntimeCatalogSources,{managerId:metal.id,section:{...state,id:'default'},ui,busy:false,variant:'',downloads:[],
    onSelect(){assert.fail('Registration must not alter a version choice');},onInstall(){assert.fail('Registration is not an Install');},onRefresh(){assert.fail('Registration must not refresh');},onRegister(){registrations++;}});
  const nodes=value=>value==null?[]:Array.isArray(value)?value.flatMap(nodes):typeof value==='object'?[value,...nodes(value.props?.children)]:[];
  nodes(control.render()).find(node=>node.type==='button'&&node.props.children==='Register Game Porting Toolkit…').props.onClick();assert.equal(registrations,1);control.close();
  const fs=require('node:fs'),os=require('node:os'),root=fs.mkdtempSync(path.join(os.tmpdir(),'apple-cached-template-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const CrossOver=require('../src/modules/crossover/runtime/manager'),Sika=require('../src/modules/crossover/sikarugir/runtime/manager');
  t.mock.method(CrossOver.core,'listInstalled',()=>[]);const originalSika=Sika.core;Sika.core={...originalSika,listInstalled:()=>[]};t.after(()=>{Sika.core=originalSika;});
  const Catalog=require('../src/modules/shared/runtime/runtime-catalog'),version='template-Template-1.0.27';
  Catalog.writeRuntimeCatalog({userDataDir:root,managerId:metal.id,source:'https://github.com/Sikarugir-App/Template/releases',entries:[{version,upstreamRevision:'published-template-release',catalogSourceId:'template',component:'d3dmetal',architecture:'universal',
    asset:{filename:'Template-1.0.27.tar.xz',url:'https://github.com/Sikarugir-App/Template/releases/download/v1.0/Template-1.0.27.tar.xz',integrity:'recorded-local'}}]});
  const before=fs.readFileSync(Catalog.catalogPath(root,metal.id)),cached=metal.getState({userDataDir:root});
  assert.deepEqual(cached.catalog.sources.find(source=>source.id==='template').versions,[version]);
  assert.equal(cached.catalog.sources[0].id,'apple');assert.deepEqual(fs.readFileSync(Catalog.catalogPath(root,metal.id)),before);
});

test('persisted generic-tag source labels render actual asset packages without Refresh or positional ties', t => {
  const fs=require('node:fs'),os=require('node:os'),root=fs.mkdtempSync(path.join(os.tmpdir(),'cached-template-presentation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const CrossOver=require('../src/modules/crossover/runtime/manager'),Sika=require('../src/modules/crossover/sikarugir/runtime/manager');
  t.mock.method(CrossOver.core,'listInstalled',()=>[]);const original=Sika.core;Sika.core={...original,listInstalled:()=>[]};t.after(()=>{Sika.core=original;});
  t.mock.method(globalThis,'fetch',()=>assert.fail('Cached presentation must stay offline'));
  const manager=require('../src/modules/shared/runtime/translator-managers').createManager('dxmt'),source=manager.getState({}).catalog.sourceUrl;
  const versions=['1.0.1','1.0.10','1.0.2','1.0.27'],entries=versions.map(version=>({version:'template-Template-'+version,upstreamRevision:'published-template-release',catalogSourceId:'template',component:'dxmt',architecture:'universal',
    versionLabel:'v1.0 (Sikarugir Template)',asset:{filename:`Template-${version}.tar.xz`,url:`https://github.com/Sikarugir-App/Template/releases/download/v1.0/Template-${version}.tar.xz`,integrity:'recorded-local'}}));
  const Catalog=require('../src/modules/shared/runtime/runtime-catalog');Catalog.writeRuntimeCatalog({userDataDir:root,managerId:manager.id,entries,source});
  const file=Catalog.catalogPath(root,manager.id),before=fs.readFileSync(file),state=manager.getState({userDataDir:root});
  assert.deepEqual(state.catalog.sources.find(row=>row.id==='template').versions,['template-Template-1.0.27','template-Template-1.0.10','template-Template-1.0.2','template-Template-1.0.1']);
  const markup=render([{...state,id:manager.id,label:manager.label,ui:manager.ui}],manager.id);
  for(const version of versions)assert.match(markup,new RegExp(`Template ${version.replaceAll('.','\\.')} · DXMT component`));
  for(const row of entries)assert.ok(markup.includes(`value="${row.version}"`));
  assert.doesNotMatch(markup,/\(2\)|earlier build|v1\.0 \(Sikarugir Template\)/);assert.deepEqual(fs.readFileSync(file),before);
});

test('grouped DXVK cards retain source identities and route variants, Install and Refresh through ordinary actions', t => {
  const fs=require('node:fs'),os=require('node:os'),root=fs.mkdtempSync(path.join(os.tmpdir(),'secondary-translator-sources-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const CrossOver=require('../src/modules/crossover/runtime/manager'),Sika=require('../src/modules/crossover/sikarugir/runtime/manager');
  t.mock.method(CrossOver.core,'listInstalled',()=>[]);const original=Sika.core;Sika.core={...original,listInstalled:()=>[]};t.after(()=>{Sika.core=original;});
  t.mock.method(globalThis,'fetch',()=>assert.fail('Disclosure must stay offline'));
  const owner=require('../src/modules/shared/runtime/translator-managers').createManager('dxvk'),initial=owner.getState({});
  const sourceIds=initial.catalog.sources.flatMap(row=>row.variants?.map(variant=>variant.id)||row.id),entries=sourceIds.map(id=>({version:id+'-fixture',upstreamRevision:'published-asset',catalogSourceId:id,architecture:'universal',
    asset:{filename:id.startsWith('template')?'Template-1.0.26.tar.xz':`dxvk-${id}-v2.7.tar.gz`,url:`https://github.com/example/runtime/releases/download/rolling/${id}.tar.gz`,integrity:'recorded-local'}}));
  require('../src/modules/shared/runtime/runtime-catalog').writeRuntimeCatalog({userDataDir:root,managerId:owner.id,entries,source:initial.catalog.sourceUrl});
  const state=owner.getState({userDataDir:root});assert.deepEqual(state.catalog.sources.map(row=>row.id),['upstream','macos','template']);
  const markup=render([{...state,id:owner.id,label:owner.label,ui:owner.ui}],owner.id);
  const offset=markup.indexOf('<details class="runtimeAdditionalSources">');assert.ok(offset>0);
  const primary=markup.slice(0,offset),additional=markup.slice(offset,markup.indexOf('</details>',offset));
  assert.match(primary,/data-runtime-source="upstream"/);assert.doesNotMatch(primary,/data-runtime-source="macos"/);
  assert.match(additional,/<summary>Additional sources<\/summary>/);assert.doesNotMatch(additional,/older Direct3D 8\/9 variant/);
  assert.equal((markup.match(/data-runtime-source=/g)||[]).length,3);
  assert.match(markup,/Historical D8VK/);assert.match(markup,/Historical D9VK/);assert.match(markup,/DXVK subset \(d9vk\)/);
  const ui={installVersion:{},installVariant:{},installedSort:{},remoteOpen:{},pendingActions:{},messages:{},sourceErrors:{}};
  const calls=[],props={managerId:owner.id,section:{...state,id:'default'},ui,busy:false,variant:'',downloads:[],
    onSelect(key,field,value){ui[field][key]=value;},onInstall(...args){calls.push(['install',...args]);},onRefresh(options){calls.push(['refresh',options]);}};
  const harness=componentHarness(RuntimeCatalogSources,props);
  const nodes=value=>value==null?[]:Array.isArray(value)?value.flatMap(nodes):typeof value==='object'?[value,...nodes(value.props?.children)]:[];
  for(const source of state.catalog.sources)for(const variant of source.variants){
    const key=JSON.stringify(['default',source.id]);ui.installVariant[key]=variant.id;
    const tree=nodes(harness.render()),card=tree.find(node=>node.props?.['data-runtime-source']===source.id),controls=nodes(card);
    const version=controls.find(node=>node.props?.['aria-label']===`${source.label} version`);
    assert.equal(version.props.value,variant.id+'-fixture');
    controls.find(node=>node.type==='button'&&node.props.children==='Install').props.onClick();
    assert.equal(calls.at(-1)[1],variant.id+'-fixture');assert.equal(calls.at(-1)[2],undefined,'source variant never becomes a runtime variant');
    controls.find(node=>node.props?.['aria-label']===`Reload ${source.label} versions`).props.onClick();
    assert.deepEqual(calls.at(-1),['refresh',{sourceId:source.id}]);
  }
  for(const entry of entries)assert.ok(state.catalog.versions.includes(entry.version));
  harness.close();
});

test('translator API coverage comes from actual installed libraries rather than manager hints', t => {
  const fs=require('node:fs'),os=require('node:os'),root=fs.mkdtempSync(path.join(os.tmpdir(),'translator-apis-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const {peFixture}=require('./helpers/pe-fixture'),{createManager}=require('../src/modules/shared/runtime/translator-managers');
  const owner=createManager('dxvk');
  const inspect=(name,libraries)=>{const dir=path.join(root,name);fs.mkdirSync(dir);for(const library of libraries){const {bytes,peOffset}=peFixture({is64:true});bytes.writeUInt16LE(0x2002,peOffset+22);fs.writeFileSync(path.join(dir,library),bytes);}return owner.customRuntime.inspect(dir);};
  const modern=inspect('modern',['d3d8.dll','d3d9.dll','d3d11.dll']),old=inspect('old',['d3d9.dll']),unknown=inspect('unknown',['publisher-future.dll']);
  assert.deepEqual(modern.translator.apis,['Direct3D 11','Direct3D 8','Direct3D 9']);assert.deepEqual(old.translator.apis,['Direct3D 9']);assert.deepEqual(unknown.translator.apis,[]);
  const state=owner.getState({}),rows=[modern,old,unknown].map((row,index)=>({...row,version:['modern','old','unknown'][index],ready:true}));
  state.installed=rows;state.sections=state.sections.map(section=>({...section,installed:rows}));
  const markup=render([{...state,id:owner.id,label:owner.label,ui:owner.ui}],owner.id);
  assert.match(markup,/class="dim">Direct3D 8, Direct3D 9, Direct3D 11<\/div>/);assert.match(markup,/class="dim">Direct3D 9<\/div>/);
  assert.doesNotMatch(markup,/Direct3D 10/);assert.match(markup,/unknown/,'unrecognized API metadata does not hide an installed library');
});

test('linked runtime choices persist one advertised patch and ordinary choices keep single-field behavior', async () => {
  function nodes(value){if(!value||typeof value!=='object')return [];if(Array.isArray(value))return value.flatMap(nodes);return [value,...nodes(value.props?.children),...nodes(value.props?.rows),...nodes(value.control)];}
  for(const scope of ['module','game']){
    const state=require('./library-layout-fixture').createLibraryFixture(),calls=[],context={scope,moduleId:'fixture',runtimeId:'managed',...(scope==='game'?{gamePath:state.recents[0].gamePath}:{})};
    const fields=[{key:'left',label:'First API',type:'select',default:'saved-unknown',optionsAction:'choices',optionsKey:'leftOptions'},{key:'right',label:'Second API',type:'select',default:'keep',optionsAction:'choices',optionsKey:'rightOptions'},{key:'other',label:'Unrelated',type:'string',default:'preserve'}];
    state.modules[0].runtime.entries.managed.settings={fields};
    const result={leftOptions:[{value:'linked',label:'Linked component',groupId:'future-pair',affectedRoles:['first','second'],reason:'Different shared binding',runtimeSettingsPatch:{left:'linked',right:'partner'}},{value:'ordinary',label:'Single component'}],rightOptions:[{value:'keep',label:'Current'},{value:'partner',label:'Partner'}],translatorRoles:[{id:'first',label:'First API',settingsKey:'left',optionsKey:'leftOptions',groupId:'pair'},{id:'second',label:'Second API',settingsKey:'right',optionsKey:'rightOptions',groupId:'pair'}],translatorGroups:[{id:'pair',label:'First and second APIs',reason:'Shared physical library'}],unknownMetadata:[{future:'kept'}]};
    const api={moduleAction:async()=>result,moduleSettingsAction:async()=>result,setModuleRuntimeSettings:async(...args)=>calls.push(['module',...args]),setGameRuntimeSettings:async(...args)=>calls.push(['game',...args])};
    const h=componentHarness(RuntimeSettingsWindow,{api,state,context,error:null});
    try{h.render();let tree=await h.settle(),markup=renderToStaticMarkup(tree);assert.match(markup,/Shared physical library/);assert.match(markup,/value="saved-unknown"/);
      const candidate=nodes(tree).find(node=>node.type==='option'&&node.props.value==='linked');assert.match(candidate.props.title,/First API \/ Second API/);assert.match(candidate.props.title,/Different shared binding/);
      let select=nodes(tree).find(node=>node.props?.['aria-label']==='First API');await select.props.onChange({target:{value:'linked'}});
      assert.equal(calls.length,1);assert.equal(calls[0][0],scope);assert.deepEqual(calls[0].at(-1),{left:'linked',right:'partner',other:'preserve'});
      tree=await h.settle();select=nodes(tree).find(node=>node.props?.['aria-label']==='First API');await select.props.onChange({target:{value:'ordinary'}});
      assert.equal(calls.length,2);assert.deepEqual(calls[1].at(-1),{left:'ordinary',right:'partner',other:'preserve'});
    }finally{h.close();}
  }
});

test('effective provider arrays expose all used settings without changing saved controls',async()=>{
 for(const label of ['first',['first','second']]){
  const state=require('./library-layout-fixture').createLibraryFixture(),writes=[];
  const fields=[{key:'backend',label:'Selected policy',type:'select',default:'automatic',optionsAction:'choices',optionsKey:'policies'},...['first','second','third'].map(provider=>({key:provider,label:provider+' provider settings',type:'string',default:provider+' saved',visibleWhen:[{key:'backend',equals:provider}]}))];
  state.modules[0].runtime.entries.managed.settings={fields,visibilityAction:'choices'};
  const api={moduleSettingsAction:async()=>({policies:[{value:'automatic',label:'Runtime automatic'}],effectiveSettings:[{value:'backend',label}]}),setModuleRuntimeSettings:async(...args)=>writes.push(args),setGameRuntimeSettings:async()=>assert.fail('No game write')};
  const h=componentHarness(RuntimeSettingsWindow,{api,state,context:{scope:'module',moduleId:'fixture',runtimeId:'managed'},error:null});
  try{h.render();const markup=renderToStaticMarkup(await h.settle());assert.match(markup,/first provider settings/);assert.equal(markup.includes('second provider settings'),Array.isArray(label));assert.doesNotMatch(markup,/third provider settings/);assert.match(markup,/value="automatic"/);assert.deepEqual(writes,[]);}finally{h.close();}
 }
});

test('translator defaults are absent for custom and Included rows while Vulkan defaults remain available', t => {
  const {createManager}=require('../src/modules/shared/runtime/translator-managers');
  const translator=createManager('dxvk'),state=translator.getState({});
  assert.equal(state.supportsDefault,false);
  const saved={defaultVersion:'kept-choice',unrelated:true};
  assert.deepEqual(translator.applySettingsUpdate('setDefault',{version:'other'},saved),saved);
  const rows=[{version:'registered',versionLabel:'Registered component',custom:true,ready:true},{version:'host',versionLabel:'Host component',reference:true,readOnly:true,removable:false,supportsDefault:false,ready:true}];
  const runtime={...state,id:translator.id,label:translator.label,ui:translator.ui,installed:rows,sections:undefined,defaultVersion:'not-installed'};
  const markup=render([runtime],translator.id);
  assert.doesNotMatch(markup,/Set default|Default first|data-runtime-default-missing|>Default<\/span>/);
  const driver=manager('vulkan-driver',{groupId:'vulkan-drivers'}, {versions:['1.4.2']},[{version:'1.4.1',ready:true}]);
  driver.supportsDefault=true;driver.defaultVersion='1.4.2';
  assert.match(render([driver]),/Set default/);
  for(const owner of require('../src/modules/shared/vulkan/libraries').managers)assert.equal(owner.getState({}).supportsDefault,true);
});

test('cached source release metadata sorts numerically without changing keys or build ties', t => {
  const fs=require('node:fs'),os=require('node:os'),root=fs.mkdtempSync(path.join(os.tmpdir(),'cached-release-order-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const {createPinnedNativeManager}=require('../src/modules/shared/runtime/pinned-native-manager'),Catalog=require('../src/modules/shared/runtime/runtime-catalog');
  const owner=createPinnedNativeManager({id:'release-order',label:'Release order',nativeLibrary:true,discoverCatalog:async()=>assert.fail('No discovery during status'),resolveExecutable:()=>null,dependencies:{systemVersionSync:()=> '26.0'}});
  const releases=['v1.4.1-rc1','v1.4.2-rc1','v1.4.1','v1.4.10','v1.4.2','v1.4.2'];
  const entries=releases.map((release,index)=>({version:'opaque-'+index,upstreamTag:'opaque-'+index,upstreamRevision:'published-'+index,sourceUrl:'https://github.com/KhronosGroup/MoltenVK/releases/tag/'+release,
    asset:{filename:'MoltenVK-macos.tar',url:'https://github.com/KhronosGroup/MoltenVK/releases/download/'+release+'/MoltenVK-macos.tar',integrity:'recorded-local'}}));
  Catalog.writeRuntimeCatalog({userDataDir:root,managerId:owner.id,entries});
  const file=Catalog.catalogPath(root,owner.id),before=fs.readFileSync(file),state=owner.getState({userDataDir:root});
  assert.deepEqual(state.catalog.versions,['opaque-3','opaque-4','opaque-5','opaque-1','opaque-2','opaque-0']);
  assert.deepEqual(fs.readFileSync(file),before);
  const runtime={...state,id:owner.id,label:owner.label,sections:undefined};
  const markup=render([runtime]);assert.match(markup,/<option[^>]*value="opaque-3" selected/);
  const minimum=manager('floor',{}, {versions:['low'],installableVersions:['low'],versionRequirements:{low:{minimumMacOS:'12.0'}}},[{version:'low',ready:true,minimumMacOS:'12.0'}]);
  assert.doesNotMatch(render([minimum]),/Requires macOS 12\.0/);
  minimum.catalog.versionRequirements.low.minimumMacOS='27.0';minimum.installed=[];assert.match(render([minimum]),/Requires macOS 27\.0 or later/);
});

test('source-group Refresh fetches each existing variant once and local registration uses no discovery', async t => {
  const fs=require('node:fs'),os=require('node:os'),root=fs.mkdtempSync(path.join(os.tmpdir(),'group-refresh-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=[],group={id:'upstream',label:'Publisher'},source=id=>({id,label:id,url:'https://example.invalid/'+id,group,discover:async()=>{calls.push(id);return[{version:id+'-1.0',upstreamRevision:'published',asset:{filename:id+'.tar.gz',url:'https://example.invalid/'+id+'.tar.gz',integrity:'recorded-local'}}];}});
  const owner=require('../src/modules/shared/runtime/pinned-native-manager').createPinnedNativeManager({id:'group-refresh',label:'Grouped publisher',nativeLibrary:true,resolveExecutable:()=>null,discoverCatalog:()=>[],catalogSources:[source('upstream'),source('historical'),{id:'local',label:'Local',delivery:'local-files',discover:async()=>assert.fail('Local registration must not discover')}]});
  const state=await owner.refreshCatalog({userDataDir:root,sourceId:'upstream',force:true});
  assert.deepEqual(calls.sort(),['historical','upstream']);assert.equal(state.sources[0].variants.length,2);
  await owner.refreshCatalog({userDataDir:root,sourceId:'local',force:true});assert.equal(calls.length,2);
});

test('Gcenx inspected source metadata declares offered PE forms without changing actual binary facts', t => {
  const fs=require('node:fs'),os=require('node:os'),root=fs.mkdtempSync(path.join(os.tmpdir(),'source-forms-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const Pinned=require('../src/modules/shared/runtime/pinned-native-manager'),original=Pinned.createPinnedNativeManager;let config;
  t.mock.method(Pinned,'createPinnedNativeManager',options=>{config=options;return original(options);});
  const file=require.resolve('../src/modules/shared/runtime/translator-managers');delete require.cache[file];
  const {createManager}=require(file);createManager('dxvk');t.after(()=>delete require.cache[file]);
  const {peFixture}=require('./helpers/pe-fixture');
  for(const builtin of [true,false]){
    const unpacked=path.join(root,builtin?'builtin':'native'),folder=path.join(unpacked,'dxvk',builtin?'x86_64-windows':'x64');fs.mkdirSync(folder,{recursive:true});
    const fixture=peFixture({is64:true});fixture.bytes.writeUInt16LE(0x2002,fixture.peOffset+22);if(builtin)fixture.bytes.write('Wine builtin DLL\0',64);fs.writeFileSync(path.join(folder,'d3d11.dll'),fixture.bytes);
    const pin={version:'unchanged-'+builtin,catalogSourceId:builtin?'async':'macos'},prepared=config.prepareInstall({unpacked,pin});
    assert.deepEqual(prepared.translator.source.optionsRuntimeForms,{crossover:'builtin'});
    assert.equal(prepared.translator.files.find(file=>file.format==='pe').form,builtin?'builtin':'native');
    assert.equal(pin.version,'unchanged-'+builtin);
  }
});

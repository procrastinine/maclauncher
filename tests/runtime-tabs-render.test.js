const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { build } = require('vite');
let RuntimesView, SettingsView, CreditsView, GameDetails, ReShadeFilterLibrary;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, 'runtime-tabs-components.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'runtime-components.cjs'), module);
  compiled.paths = module.paths;
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  ({ RuntimesView, SettingsView, CreditsView, GameDetails, ReShadeFilterLibrary } = compiled.exports);
});
const manager = (id, ui, catalog = {}, installed = []) => ({ id, label: `Backend ${id}`, ui,
  catalog: { status: 'idle', versions: [], ...catalog }, installed });
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
test('shader library has only three format families and keeps independent collection versions below imported filters', () => {
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
    assert.equal((markup.match(/role="tab" /g) || []).length, 3);
    for (const label of ['ReShade', 'libretro', 'MPV']) assert.match(markup, new RegExp(`>${label}<\\/button>`));
    assert.doesNotMatch(markup, /runtime-section-tab-/);
    assert.match(markup, /class="btn primary"[^>]*>Import filter…<\/button>/);
    assert.match(markup, /Own MPV/);assert.doesNotMatch(markup, /Own ReShade|Own libretro/);
    assert.match(markup, /<details class="runtimeSectionCard shaderCollections" open=""><summary>Collections<\/summary>/);
    assert.ok(markup.indexOf('Import filter…') < markup.indexOf('<summary>Collections'));
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
    for (const label of ['Upscaling', 'Shaders', 'Vulkan']) assert.match(topTabs, new RegExp(`>${label}<\\/button>`));
    assert.equal((topTabs.match(/role="tab"/g) || []).length, 3);
    assert.match(topTabs, /aria-selected="true"[\s\S]*?>Shaders<\/button>/);
    assert.match(markup, new RegExp(`id="shader-family-tab-${family}"[^>]*aria-selected="true"`));
    assert.match(markup, new RegExp(`id="runtime-panel-${source.id}-${collection.id}"`));
    for (const section of shaders.sections) assert.ok(!topTabs.includes(`>${section.label}</button>`));
  }
});
test('current module presentations repair cached Android and shader metadata without changing action identities', () => {
  const source = require('../src/modules/shared/reshade/runtime/shader-library-manager');
  const shaders = { ...source.getState(), ui: { groupId: 'graphics', tabLabel: 'Shader library', sectionLabel: 'Shader packs', order: 10, management: 'managed' } };
  shaders.sections = shaders.sections.map(({ shaderFamily, ...section }) => section);
  const cached = ['android', 'macapk', 'android-aim', 'android-art'].map((id, index) => manager(id,
    id === 'android-art' ? undefined : { tabLabel: 'Android', order: 123 + index, management: 'managed' },
    { versions: [id + '-version'] }, [{ version: id + '-version', ready: true }]));
  cached.push(manager('last-tool', { groupId: 'tools', tabLabel: 'Tools', order: -100, management: 'managed' }));
  cached.push(manager('future', undefined));cached.push(shaders);
  const before = structuredClone(cached);
  for (const id of ['android', 'android-art']) {
    const markup = render(cached, id);
    const names = [...markup.matchAll(/class="launcherSidebarItem[^>]*>([^<]*)<\/button>/g)].map(match => match[1]);
    for (const label of ['MacLauncher Android', 'Mac.apk', 'AIM']) assert.equal(names.filter(name => name === label).length, 1);
    assert.equal(names.includes('Android'), false);assert.equal(names.includes('Android ART'), false);assert.equal(names.at(-1), 'Tools');
    assert.match(markup, /role="tab"[^>]*>JVM<\/button>/);assert.match(markup, /role="tab"[^>]*>ART<\/button>/);
    assert.match(markup, new RegExp(`id="runtime-panel-${id}-default"`));
    assert.match(markup, new RegExp(`value="${id}-version"`));
  }
  const markup = render(cached, source.id, { runtimeSectionId: shaders.sections[0].id });
  assert.equal((markup.match(/role="tab" /g) || []).length, 3);
  for (const label of ['ReShade', 'libretro', 'MPV']) assert.match(markup, new RegExp(`>${label}<\\/button>`));
  assert.match(markup, /<summary>Collections<\/summary>/);assert.match(markup, /shader-collection/);
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
test('each Wine engine manages graphics bridge downloads and defaults inside its own runtime tab', () => {
  const registry = require('../src/modules/registry');
  const sources = require('../src/modules/crossover/temporal/support-manager').managers;
  const engineSources = [require('../src/modules/crossover/runtime/manager'),
    require('../src/modules/crossover/sikarugir/runtime/manager')];
  const engines = engineSources.map(source => ({ ...manager(source.id, registry.getRuntimeManagerUi(source.id) || source.ui), label: source.label }));
  const bridges = Object.values(sources).map(source => {
    const state = source.getState();
    const install = { version: state.catalog.versions[0], ready: true };
    return { ...state, id: source.id, label: source.label, ui: registry.getRuntimeManagerUi(source.id) || source.ui,
      sections: state.sections.map(section => ({ ...section, installed: [install], defaultVersion: null })) };
  });
  for (const bridge of bridges) {
    const markup = render([...engines, ...bridges], bridge.id);
    assert.match(markup, /class="launcherSidebarItem[^>]*>CrossOver<\/button>/);
    assert.match(markup, /class="launcherSidebarItem[^>]*>Sikarugir<\/button>/);
    assert.match(markup, /role="tab"[^>]*aria-selected="true"[^>]*>Graphics bridge<\/button>/);
    assert.match(markup, new RegExp(`id="runtime-group-panel-${bridge.ui.groupId}"`));
    assert.match(markup, />Install<\/button>|>Download<\/button>/);
    assert.match(markup, /Set default/);
    assert.doesNotMatch(markup, />Windows graphics<\/button>|>Graphics<\/button>/);
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
test('shared filter table exposes editable full names and paths without loading files or requiring a native runtime', () => {
  const offline = () => assert.fail('Rendering the filter library must not call the bridge');
  const filters = [{ id: 'one', name: 'Colour tuning.fx', path: '/Effects/' + 'long-folder/'.repeat(20) + 'Colour.fx', available: true },
    { id: 'two', name: 'Missing.fx', path: '/Effects/Missing.fx', available: false, reason: 'The filter file is unavailable.' },
    { id: 'three', name: 'CRT preset', path: '/Shaders/CRT.slangp', format: 'slangp', available: true },
    { id: 'four', name: 'Single pass', path: '/Shaders/Single.slang', format: 'slang', available: true }];
  const markup = renderToStaticMarkup(React.createElement(ReShadeFilterLibrary, { filters, api: {
    importReShadeFilters: offline, updateReShadeFilter: offline, removeReShadeFilter: offline, pickReShadeFilterPath: offline } }));
  assert.match(markup, /<table class="filterLibraryTable">/);
  for (const label of ['Name', 'Path', 'Actions']) assert.match(markup, new RegExp(`<th scope="col">${label}<`));
  assert.match(markup, /Import filter…/);
  assert.match(markup, /Shaders and filters/);
  for (const label of ['ReShade · .fx', 'RetroArch preset · .slangp', 'RetroArch shader · .slang']) assert.ok(markup.includes(label));
  assert.match(markup, /aria-label="Filter name: Colour tuning\.fx"/);
  assert.ok(markup.includes(filters[0].path));
  assert.match(markup, /aria-label="Replace file for Colour tuning\.fx"/);
  assert.match(markup, /aria-label="Remove filter Missing\.fx"/);
  assert.match(markup, /The filter file is unavailable\./);
  assert.match(markup, /<button type="button" class="btn" disabled="">Download shaders…<\/button>/);
  assert.doesNotMatch(markup, />Install<|native runtime unavailable/i);
  const unavailable = renderToStaticMarkup(React.createElement(ReShadeFilterLibrary, { filters: [], filtersError: 'The filter library could not be read.' }));
  assert.match(unavailable, /role="alert">The filter library could not be read\./);
  assert.match(unavailable, /No imported filters\./);
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
test('empty catalogs expose the same icon Reload button without a render-time request', () => {
  const markup = render([manager('common', { tabLabel: 'Common runtime' })]);
  assert.match(markup, /<button class="btn iconOnly runtimeRefresh"[^>]*aria-label="Reload versions"/);
  assert.doesNotMatch(markup, /Load versions/);
  assert.match(markup, /No versions loaded/);
  assert.doesNotMatch(markup, /<button[^>]*class="btn primary"/);
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
  assert.match(markup, /26.0 · Player\.app/);
  assert.match(markup, /26.0 · Player Beta\.app<span class="badge badgeAccent">Default/);
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
  assert.match(eligible, /<option value="copy-a">v26.0 · Player\.app<\/option>/);
  assert.match(eligible, /<option value="copy-b" selected="">v26.0 · Player Beta\.app<\/option>/);
  assert.match(eligible, /aria-label="Runtime settings"/);
  const ineligible = renderGame({ ...game, runtimeId: 'managed', moduleRuntimeSupport: [] });
  const emptyChoices = ineligible.match(/<select aria-label="Runtime"[^>]*>(.*?)<\/select>/)[1];
  assert.match(emptyChoices, /<option value="managed" disabled="" selected="">Managed runtime \(Unavailable\)<\/option>/);
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
  assert.match(markup, /v1.2.3 \[Included\]/);
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
  assert.match(included, /v1.2.3 \[Included\]/);
  assert.match(included, /runtimeInstalledHeader"><span>Included<\/span>/);
  assert.doesNotMatch(included, /class="btn primary"|aria-label="Uninstall"|\/application\/resources\/runtime/);
  const managed = render([{ ...runtime, installed: [{ version: '1.2.3', source: 'download', ready: true,
    installDir: '/managed/runtime' }] }]);
  assert.match(managed, /v1.2.3 \[Installed\]/);
  assert.match(managed, /aria-label="Uninstall"/);
  assert.doesNotMatch(managed, /\[Included\]/);
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
  assert.doesNotMatch(markup, /v1.2.3 \[Included\]/);
});
test('prelisted source builds are usable immediately and display compact source/help links', () => {
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
    sectionId: 'default', version: '1.2.3', downloaded: 0, total: null }] }), /<button class="btn primary" disabled="">Build<\/button>/);
  assert.match(render([{ ...runtime, installed: [{ version: '1.2.3' }] }]), /<button class="btn primary" disabled="">Build<\/button>/);
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
  assert.ok(markup.indexOf('>NW.js</button>') < markup.indexOf('>AliceSoft</button>'));
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
  catalog.saveCatalog(userDataDir, [catalog.PINS['9.1.0.7988']]);
  const pin = tool.TOOLS['11.1.0.9782'], root = tool.installRoot(userDataDir, pin.version), files = path.join(root, 'files');
  fs.mkdirSync(files, { recursive: true });
  for (const name of ['ilspycmd.dll', 'ilspycmd.deps.json', 'ilspycmd.runtimeconfig.json', 'ICSharpCode.Decompiler.dll'])
    fs.writeFileSync(path.join(files, name), 'tool fixture');
  fs.writeFileSync(path.join(root, 'tool.json'), JSON.stringify({ version: pin.version, archiveSha256: pin.sha256,
    archiveSha512: pin.sha512, sourceRevision: pin.sourceRevision, framework: pin.framework, files: tool.__test.inventory(files) }));
  const state = manager.getState({ userDataDir });
  const model = { id: manager.id, label: manager.label, ui: registry.getRuntimeManagerUi(manager.id), ...state };
  const fixed = { id: 'fna', label: 'FNA', ui: registry.getRuntimeManagerUi('fna'), catalog: { versions: ['fixed-fna'] } };
  const markup = render([fixed, model], manager.id, { runtimeSectionId: 'decompiler',
    runtimeUi: { ilspy: { remoteOpen: { decompiler: true }, installVersion: {}, installVariant: {}, installedSort: {}, error: null } } });
  assert.match(markup, /runtime-panel-ilspy-decompiler/);
  assert.match(markup, /<option value="11\.1\.0\.9782"/); assert.match(markup, /<option value="9\.1\.0\.7988"/);
  assert.match(markup, /\.NET 10\.0/); assert.match(markup, /Set default<\/button>/);
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
  assert.match(markup, /aria-label="Reload versions"/);
  assert.match(markup, /No versions loaded/);
  const state = require('./library-layout-fixture').createLibraryFixture();
  state.modules = [moduleInfo];
  state.moduleSettings = { fvp: { defaultRuntime: 'rfvp' } };
  state.runtimeManagers = { rfvp: runtime };
  const offline = () => assert.fail('Rendering discovered module controls must not call the backend');
  const settings = renderToStaticMarkup(React.createElement(SettingsView, { state, showIcons: true,
    showNonDefaultTags: true, onSetLauncherSettings: offline, onSetModuleSettings: offline }));
  assert.match(settings, /class="launcherSidebarItem"[^>]*>FVP<\/button>/);
  const game = { ...state.recents[0], moduleId: 'fvp', runtimeId: 'rfvp', nativeAppPath: null,
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

test('Graphics stays first with component information and model actions without shader-pack management', t => {
  const models = require('../src/modules/shared/reshade/runtime/models-manager');
  const fs = require('node:fs');
  const userDataDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'graphics-runtime-view-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const state = models.getState({ userDataDir });
  const runtimes = [manager('engine', { tabLabel: 'Engine', order: 10 }),
    { ...state, id: models.id, label: models.label, ui: models.ui }];
  const markup = render(runtimes, models.id, { onRuntimeImport() {}, onRuntimeSetupAction() {} });
  assert.ok(markup.indexOf('>Graphics</button>') < markup.indexOf('>Engine</button>'));
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
  assert.match(markup, />Releases<\/button>/);
  assert.match(markup, />Nightlies<\/button>/);
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

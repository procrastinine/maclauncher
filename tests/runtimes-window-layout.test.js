// The Runtimes window after the 11-17 UI review: one Wine entry per CPU with a
// tab per source, one Default menu per Installed list, compact source rows
// without repeated names, filler or duplicate links, and one help button per panel.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const { renderToStaticMarkup } = require('react-dom/server');
const { react } = require('./helpers/renderer-component');

let ui;
test.before(async () => {
  const { build } = require('vite');
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, 'runtimes-window-components.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'runtimes-window-components.cjs'), module);
  compiled.paths = module.paths;
  compiled.require = id => id === 'react' ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  ui = compiled.exports;
});

const sections = manager => manager.sections || [{ ...manager, id: 'default' }];
const wine = (id, label, order, installed, catalog = {}) => ({ id, label, ui: { groupId: id, tabLabel: label, sectionLabel: label,
  category: 'compatibility', hostGroup: 'Wine', order, management: 'managed' },
  sections: [{ id: 'default', label: 'Versions', launcherArchitecture: 'arm64', installed,
    catalog: { status: 'success', versions: installed.map(row => row.version), ...catalog } }] });
const wines = () => [
  wine('crossover', 'CrossOver', 200, [{ version: '26.1', ready: true, architectures: ['x86_64'] }]),
  wine('sikarugir', 'Sikarugir', 201, [], { status: 'idle', versions: [] }),
  wine('winecx', 'WineCX', 202, [{ version: '4.8.1', ready: true, architectures: ['x86_64'] }]),
  wine('highball-wine', 'Highball Wine', 203, [{ version: 'h1', ready: true, architectures: ['arm64'] }, { version: 'h0', ready: true, architectures: ['x86_64'] }]),
  wine('metalsharp-wine', 'MetalSharp Wine', 203, [{ version: '7.0', ready: true, architectures: ['arm64'] }])
];
const others = () => [
  { id: 'bridge', label: 'Steam client bridge', ui: { tabLabel: 'Steam client bridge', category: 'compatibility', order: 204, management: 'managed' },
    sections: [{ id: 'default', label: 'Versions', installed: [], catalog: { versions: [] } }] },
  { id: 'dosbox', label: 'DOSBox', ui: { tabLabel: 'DOSBox', category: 'compatibility', order: 205, management: 'managed' },
    sections: [{ id: 'default', label: 'Versions', installed: [], catalog: { versions: [] } }] }
];
const categories = [{ id: 'engines', label: 'Game engines', sort: 'label', default: true }, { id: 'compatibility', label: 'Compatibility' }];

test('Wine sources form one entry per CPU, each with one tab per source, where the first Wine source sorts', () => {
  const { groupRuntimeManagers, splitRuntimeGroupsByHost, runtimeGroupSections, runtimeSectionTabs, resolveRuntimeTabSelection } = ui;
  const groups = splitRuntimeGroupsByHost(groupRuntimeManagers([...others(), ...wines()], categories), sections);
  assert.deepEqual(groups.map(group => [group.heading, group.label]), [
    ['Compatibility', 'Wine · Apple Silicon'], ['Compatibility', 'Wine · Intel'],
    ['Compatibility', 'Steam client bridge'], ['Compatibility', 'DOSBox']]);
  const tabs = group => runtimeSectionTabs(runtimeGroupSections(group, sections)).map(tab => tab.label);
  // A source without CPU facts (Sikarugir before its list loads) is a tab of both entries.
  assert.deepEqual(tabs(groups[0]), ['Sikarugir', 'Highball Wine', 'MetalSharp Wine']);
  assert.deepEqual(tabs(groups[1]), ['CrossOver', 'Sikarugir', 'WineCX', 'Highball Wine']);
  const highball = entry => runtimeGroupSections(entry, sections).find(choice => choice.managerId === 'highball-wine');
  assert.deepEqual(highball(groups[0]).section.installed.map(row => row.version), ['h1']);
  assert.deepEqual(highball(groups[1]).section.installed.map(row => row.version), ['h0']);
  // A deep link lands on the automatic CPU's entry, or the only entry holding the source; a chosen entry is kept.
  assert.equal(resolveRuntimeTabSelection(groups, 'highball-wine', 'default', sections).group.label, 'Wine · Apple Silicon');
  assert.equal(resolveRuntimeTabSelection(groups, 'crossover', 'default', sections).group.label, 'Wine · Intel');
  assert.equal(resolveRuntimeTabSelection(groups, 'highball-wine', 'default', sections, groups[1].id).group.label, 'Wine · Intel');
  // Without any CPU facts the sources share one entry named Wine.
  const unknown = splitRuntimeGroupsByHost(groupRuntimeManagers([wine('a', 'A', 1, [], { versions: [] }), wine('b', 'B', 2, [], { versions: [] })], categories), sections);
  assert.deepEqual(unknown.map(group => group.label), ['Wine']);
});

test('a sidebar search for a source opens its entry at that tab; a search for the entry keeps the remembered tab', () => {
  const { groupRuntimeManagers, splitRuntimeGroupsByHost, runtimeGroupSections, runtimeChoiceForQuery } = ui;
  const intel = splitRuntimeGroupsByHost(groupRuntimeManagers(wines(), categories), sections)[1];
  const choices = runtimeGroupSections(intel, sections);
  assert.equal(runtimeChoiceForQuery(choices, 'winecx', intel.label).managerId, 'winecx');
  assert.equal(runtimeChoiceForQuery(choices, 'intel crossover', intel.label).managerId, 'crossover');
  assert.equal(runtimeChoiceForQuery(choices, 'wine', intel.label), null);
  assert.equal(runtimeChoiceForQuery(choices, '', intel.label), null);
});

const props = (managers, selected, overrides = {}) => ({ runtimeManagers: managers, runtimeUi: {}, runtimeManagerId: selected,
  runtimeSectionId: 'default', downloadTasks: [], setRuntimeManagerId() {}, setRuntimeSectionId() {}, updateRuntimeUiSection() {},
  onRuntimeRefresh() {}, onRuntimeInstall() {}, onRuntimeSetDefault() {}, onRuntimeUninstall() {}, onCancelDownload() {}, ...overrides });
const render = (managers, selected, overrides) => renderToStaticMarkup(react.createElement(ui.RuntimesView, props(managers, selected, overrides)));
const sidebarOrder = markup => [...markup.match(/<nav class="launcherSidebarChoices"[^>]*>([\s\S]*?)<\/nav>/)[1]
  .matchAll(/<h2 class="launcherSidebarHeading"[^>]*>([^<]+)<\/h2>|class="launcherSidebarItem[^>]*>([^<]+)<\/button>/g)]
  .map(match => match[1] ? `# ${match[1]}` : match[2]);

test('the sidebar lists Wine · Apple Silicon and Wine · Intel under Compatibility, and the entry shows a tab per source', () => {
  const markup = render([...wines(), ...others()], 'winecx');
  const order = sidebarOrder(markup);
  assert.deepEqual(order.slice(order.indexOf('# Compatibility')), ['# Compatibility', 'Wine · Apple Silicon', 'Wine · Intel', 'Steam client bridge', 'DOSBox']);
  assert.doesNotMatch(markup, /Wine · Intel \(Rosetta\)|<h2 class="launcherSidebarHeading"[^>]*>Wine/);
  assert.match(markup, /class="launcherSidebarItem active"[^>]*>Wine · Intel<\/button>/);
  const tabs = [...markup.matchAll(/role="tab" aria-selected="(true|false)"[^>]*>([^<]+)<\/button>/g)].map(match => [match[2], match[1]]);
  assert.deepEqual(tabs, [['CrossOver', 'false'], ['Sikarugir', 'false'], ['WineCX', 'true'], ['Highball Wine', 'false']]);
  assert.doesNotMatch(markup, /class="runtimePanelTitle"/, 'the selected tab names the panel');
});

const runtime = (installed, extra = {}) => ({ id: 'fixture', label: 'Fixture', ui: { tabLabel: 'Fixture', management: 'managed' },
  sections: [{ id: 'default', label: 'Versions', supportsDefault: true, installed,
    catalog: { status: 'success', versions: installed.filter(row => !row.custom).map(row => row.version) }, ...extra }] });

test('one Default menu in the Installed header replaces Set default and Use automatic default', () => {
  const rows = [{ version: '1.0', ready: true }, { version: '2.0', ready: true }, { version: '/Apps/Fixture 2', custom: true, ready: true, installDir: '/Apps/Fixture 2' }];
  const automatic = render([runtime(rows, { defaultVersion: '1.0', defaultSource: 'manager', customRuntime: true, versionLabels: { '/Apps/Fixture 2': 'v2.0' } })], 'fixture',
    { onRuntimeRegister() {} });
  assert.doesNotMatch(automatic, /Set default|Use automatic default/);
  // [value, label, selected, disabled] of each Default menu entry.
  const menu = markup => {
    const select = markup.match(/<select id="runtime-default-fixture-default" class="input inputSmall runtimeDefaultSelect"[^>]*>([\s\S]*?)<\/select>/);
    assert.ok(select, 'the Installed header holds the Default menu');
    return [...select[1].matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)].map(([, value, attributes, label]) =>
      [value.replace(/&quot;/g, '"'), label, /selected=""/.test(attributes), /disabled=""/.test(attributes)]);
  };
  assert.match(automatic, /<div class="saveSectionTitle runtimeInstalledHeader"><span>Installed<\/span><span class="runtimeInstalledHeaderRight"><span class="runtimeDefaultControl"><label for="runtime-default-fixture-default">Default<\/label>/);
  // Newest first; a registration's folder has no release to compare and follows.
  assert.deepEqual(menu(automatic), [['', 'Automatic (v1.0)', true, false], ['["2.0","",""]', 'v2.0', false, false],
    ['["1.0","",""]', 'v1.0', false, false], ['["/Apps/Fixture 2","",""]', 'v2.0 · Custom', false, false]]);
  assert.match(automatic, /<span>v1\.0<\/span><span class="badge badgeAccent">Default<\/span>/, 'rows keep the Default badge');
  const saved = render([runtime(rows.slice(0, 2), { defaultVersion: '2.0', defaultSource: 'saved' })], 'fixture');
  assert.deepEqual(menu(saved), [['', 'Automatic', false, false], ['["2.0","",""]', 'v2.0', true, false], ['["1.0","",""]', 'v1.0', false, false]]);
  const missing = render([runtime(rows.slice(0, 1), { defaultVersion: '3.0', defaultSource: 'saved' })], 'fixture');
  assert.deepEqual(menu(missing).at(-1), ['saved', 'v3.0 (not installed)', true, true]);
  assert.match(missing, /data-runtime-default-missing="true">The default version, v3\.0, is not installed\./);
  assert.doesNotMatch(render([runtime(rows.slice(0, 2), { supportsDefault: false })], 'fixture'), /runtimeDefaultSelect/);
});

test('choosing in the Default menu passes the version, variant and CPU; Automatic clears the saved default', () => {
  const rows = [{ install: { version: '1.0', variant: 'mono', architecture: 'x64', ready: true }, label: 'v1.0 · Intel · Mono', isDefault: true },
    { install: { version: '1.0', variant: 'mono', architecture: 'arm64', ready: true }, label: 'v1.0 · Mono', isDefault: false },
    { install: { version: '0.9', ready: false }, label: 'v0.9', isDefault: false }];
  const menu = ui.runtimeDefaultMenu({ defaultVersion: '1.0', defaultSource: 'saved' }, rows, version => `v${version}`);
  assert.deepEqual(menu.choices.map(choice => choice.label), ['Automatic', 'v1.0 · Intel · Mono', 'v1.0 · Mono']);
  assert.equal(menu.selected, JSON.stringify(['1.0', 'mono', 'x64']));
  const chosen = [];
  const tree = ui.RuntimeDefaultMenu({ id: 'menu', menu, onChoose: choice => chosen.push(choice) });
  const select = tree.props.children[1];
  select.props.onChange({ target: { value: JSON.stringify(['1.0', 'mono', 'arm64']) } });
  select.props.onChange({ target: { value: '' } });
  assert.deepEqual(chosen.map(({ version, variant, architecture }) => [version, variant, architecture]),
    [['1.0', 'mono', 'arm64'], [null, undefined, undefined]]);
});

test('one source is a compact row without its repeated name, URL filler or a second link into its repository', () => {
  const section = { id: 'default', label: 'Versions', installed: [{ version: '1.0', ready: true }],
    sourceLinks: [{ label: 'Project releases', url: 'https://github.com/example/runtime/releases' }],
    catalog: { status: 'success', versions: ['2.0', '1.0'], label: 'Fixture', explicit: true, source: 'https://github.com/example/runtime/releases',
      sourceLinks: [{ label: 'upstream code', url: 'https://github.com/example/runtime' }, { label: 'Library', url: 'https://github.com/other/library' }] } };
  const markup = renderToStaticMarkup(react.createElement(ui.RuntimeCatalogSources, { managerId: 'fixture', section, identity: 'Fixture',
    links: section.sourceLinks, ui: { installVersion: {}, installVariant: {}, pendingActions: {} }, busy: false, variant: '', downloads: [],
    onSelect() {}, onInstall() {}, onRefresh() {} }));
  assert.doesNotMatch(markup, /Releases published|Runtime packages published|Development builds from|Runtime downloads from|Available downloads from/);
  assert.doesNotMatch(markup, />Fixture</, 'the panel already names the source');
  assert.deepEqual([...markup.matchAll(/<a class="runtimeSourceLink" href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(match => [match[1], match[2]]),
    [['https://github.com/example/runtime/releases', 'github.com'], ['https://github.com/other/library', 'Library']]);
  assert.match(markup, /<div class="runtimeSourceRow"><label class="runtimeSourceName" for="[^"]+">Version<\/label><select[^>]*class="input inputSmall runtimeVersionSelect"/);
  assert.doesNotMatch(markup, /\(<a|runtimeUpstreamCode|runtimeRemoteField/);
});

test('one help button per panel; row details and the Register custom explanation are tooltips', () => {
  const markup = render([runtime([{ version: '1.0', ready: true, platformKey: 'mac-arm64', installDir: '/Runtimes/1.0', minimumMacOS: '14.0' }],
    { defaultVersion: '1.0', customRuntime: true, description: 'About the runtime.' })], 'fixture', { onRuntimeRegister() {} });
  assert.equal((markup.match(/class="helpTipButton"/g) || []).length, 1);
  assert.match(markup, /<span title="mac-arm64\n\/Runtimes\/1\.0">v1\.0<\/span>/);
  assert.match(markup, /<div class="dim">Requires macOS 14\.0 or later<\/div>/, 'a platform requirement stays visible, as a detail without a period');
  assert.match(markup, /<div class="runtimeInstalledFooter"><button class="btn small" title="Register a compatible executable[^"]*">Register custom…<\/button><\/div>/);
});

test('Steamworks4j joins Compatibility, sidebar rows are compact and an empty model list draws nothing', () => {
  assert.equal(require('../src/modules/java/runtime/steamworks/manager.js').ui.category, 'compatibility');
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/src/ui/styles.css'), 'utf8');
  assert.match(css, /\.launcherSidebarItem \{\s*display: block; width: 100%; margin: 1px 0; padding: 5px 10px;/);
  const providers = { id: 'providers', label: 'Providers', ui: { tabLabel: 'Effects', management: 'managed' },
    sections: [{ id: 'default', label: 'Providers', installed: [], catalog: { versions: [] },
      components: [{ id: 'anr', label: 'Apex Neural Rendering', available: false, status: 'Models required', capabilities: [] }] }] };
  assert.doesNotMatch(render([providers], 'providers'), /runtimeComponentCapabilities/);
});

test('the Windows Steam client files section is titled like every other version list', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/modules/crossover/runtime/steam-client-files.js'), 'utf8');
  assert.doesNotMatch(source, /managementTitle/);
});

// GUI 0877 review (11-17): entry-keeping tabs, group members' CPUs, the reveal,
// the empty list, row detail punctuation, tab strip edges and source rows.
const { componentHarness } = require('./helpers/renderer-component');
const treeElements = node => react.isValidElement(node) ? [node, ...react.Children.toArray(node.props.children).flatMap(treeElements)] : [];

test('a tab chosen inside Wine · Intel keeps Wine · Intel, even for a source whose automatic CPU is Apple Silicon', () => {
  const props = { runtimeManagers: wines(), runtimeUi: {}, runtimeManagerId: 'winecx', runtimeSectionId: 'default', downloadTasks: [],
    updateRuntimeUiSection() {}, onRuntimeRefresh() {}, onRuntimeInstall() {}, onRuntimeSetDefault() {}, onRuntimeUninstall() {}, onCancelDownload() {} };
  props.setRuntimeManagerId = id => { props.runtimeManagerId = id; };
  props.setRuntimeSectionId = id => { props.runtimeSectionId = id; };
  const harness = componentHarness(ui.RuntimesView, props);
  try {
    const entry = tree => treeElements(tree).find(node => node.props?.items && 'selectedId' in node.props).props;
    let tree = harness.render();
    const intel = entry(tree).items.find(item => item.label === 'Wine · Intel').id;
    assert.equal(entry(tree).selectedId, intel, 'the WineCX deep link opens Wine · Intel');
    const tab = treeElements(tree).find(node => node.props?.role === 'tab' && treeElements(node).some(child => child.props?.children === 'Highball Wine')
      || node.props?.role === 'tab' && node.props.children === 'Highball Wine');
    tab.props.onClick();
    tree = harness.render(); tree = harness.render();
    assert.equal(props.runtimeManagerId, 'highball-wine');
    assert.equal(entry(tree).selectedId, intel, 'the entry stays Wine · Intel');
    const selectedTabs = treeElements(tree).filter(node => node.props?.role === 'tab' && node.props['aria-selected']);
    assert.equal(selectedTabs.length, 1);
    assert.match(renderToStaticMarkup(selectedTabs[0]), />Highball Wine</);
  } finally { harness.close(); }
  assert.deepEqual(ui.runtimeTabChoice({ id: 'host:wine:x64' }, { managerId: 'highball-wine', sectionId: 'default' }),
    { groupId: 'host:wine:x64', managerId: 'highball-wine', sectionId: 'default' });
});

test('a member of a source group without CPU facts follows its source, so CrossOver graphics integration is only in Wine · Intel', () => {
  const { groupRuntimeManagers, splitRuntimeGroupsByHost, runtimeGroupSections, runtimeSectionTabs } = ui;
  const integration = { id: 'crossover-winemac', label: 'CrossOver graphics integration',
    ui: { groupId: 'crossover', sectionLabel: 'CrossOver graphics integration', memberOrder: 1, management: 'managed' },
    sections: [{ id: 'default', label: 'Versions', installed: [], catalog: { status: 'idle', versions: [] } }] };
  const groups = splitRuntimeGroupsByHost(groupRuntimeManagers([...wines(), integration], categories), sections);
  const tabs = group => runtimeSectionTabs(runtimeGroupSections(group, sections)).map(tab => tab.label);
  assert.deepEqual(groups.map(group => group.label), ['Wine · Apple Silicon', 'Wine · Intel']);
  assert.deepEqual(tabs(groups[0]), ['Sikarugir', 'Highball Wine', 'MetalSharp Wine']);
  assert.deepEqual(tabs(groups[1]), ['CrossOver', 'CrossOver graphics integration', 'Sikarugir', 'WineCX', 'Highball Wine']);
});

test('an entry revealed from outside the sidebar list is centred; one already in view stays put', async () => {
  const { pathToFileURL } = require('node:url');
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/src/ui/components/sidebar-navigation-model.ts')).href).catch(() => null);
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/src/ui/components/sidebar-navigation-model.ts'), 'utf8');
  assert.match(source, /export function sidebarRevealBlock/);
  const reveal = model?.sidebarRevealBlock || ui.sidebarRevealBlock;
  assert.equal(reveal({ top: 100, bottom: 126 }, { top: 60, bottom: 700 }), null);
  assert.equal(reveal({ top: 690, bottom: 716 }, { top: 60, bottom: 700 }), 'center', 'flush against the bottom edge is not left there');
  assert.equal(reveal({ top: 20, bottom: 46 }, { top: 60, bottom: 700 }), 'center');
  const sidebar = fs.readFileSync(path.join(__dirname, '../src/renderer/src/ui/components/SearchableSidebar.tsx'), 'utf8');
  assert.doesNotMatch(sidebar, /block: "nearest"/);
});

test('an empty list whose default is not installed says so once, and row details carry no sentence period', () => {
  const empty = render([runtime([], { defaultVersion: '3.0', defaultSource: 'manager' })], 'fixture');
  assert.equal((empty.match(/data-runtime-default-missing="true"/g) || []).length, 1);
  assert.match(empty, /<div class="empty runtimeDefaultMissing" data-runtime-default-missing="true">The default version, v3\.0, is not installed\./);
  assert.doesNotMatch(empty, /No runtime versions installed yet/);
  const row = render([runtime([{ version: '1.0', ready: true, minimumMacOS: '30.0' }], { defaultVersion: '1.0' })], 'fixture');
  assert.match(row, /<div class="dim">Requires macOS 30\.0 or later<\/div>/);
});

test('overflowing tab strips fade before their arrows, and named sources line up with plain Load versions buttons', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/src/ui/styles.css'), 'utf8');
  assert.match(css, /\.scrollableTabStrip\.moreRight \.scrollableTabStripViewport \{ -webkit-mask-image:/);
  assert.match(css, /\.scrollableTabStrip\.moreLeft \.scrollableTabStripViewport \{ -webkit-mask-image:/);
  const strip = fs.readFileSync(path.join(__dirname, '../src/renderer/src/ui/components/ScrollableTabStrip.tsx'), 'utf8');
  assert.match(strip, /scroll\.canScrollRight \? "moreRight"/);
  assert.match(css, /\.runtimeSourceRow\.named > \.runtimeSourceName \{ min-width: 9rem; \}/);
  assert.match(css, /\.runtimeDefaultSelect \{ width: auto; max-width: min\(36rem, 55vw\);/, 'the Default menu fits "Automatic (Apex Neural Rendering FG-V.B15)"');
  const section = { id: 'default', label: 'Versions', installed: [], catalog: { status: 'idle', versions: [] },
    catalogs: [{ id: 'builds', label: 'MacLauncher Builds', explicit: true, status: 'idle', versions: [] },
      { id: 'upstream', label: 'Upstream', explicit: true, status: 'idle', versions: [] }] };
  const markup = renderToStaticMarkup(react.createElement(ui.RuntimeCatalogSources, { managerId: 'fixture', section, identity: 'Fixture',
    links: [], ui: { installVersion: {}, installVariant: {}, pendingActions: {} }, busy: false, variant: '', downloads: [],
    onSelect() {}, onInstall() {}, onRefresh() {} }));
  const loads = [...markup.matchAll(/<button type="button" class="([^"]+)"[^>]*>Load versions<\/button>/g)].map(match => match[1]);
  assert.ok(loads.length >= 1, markup);
  assert.ok(loads.every(cls => cls === 'btn small'), 'Load versions is an ordinary button');
});

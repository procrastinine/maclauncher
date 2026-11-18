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

test('every usable installed row that is not the default has a Make default button passing its version, variant and CPU', () => {
  // Owner, 11-17 5:05 PM: "We should have make default buttons". The Default menu stays in the header.
  const rows = [{ version: '2.0', ready: true }, { version: '1.0', variant: 'mono', architecture: 'x64', ready: true },
    { version: '0.9', ready: false }, { version: '0.8', ready: true, supportsDefault: false }, { version: '0.7', ready: true, reference: true }];
  const calls = [], overrides = { onRuntimeSetDefault: (...args) => calls.push(args) };
  const harness = componentHarness(ui.RuntimesView, props([runtime(rows, { defaultVersion: '2.0', defaultSource: 'saved' })], 'fixture', overrides));
  try {
    const tree = harness.render(), markup = renderToStaticMarkup(tree);
    const buttons = treeElements(tree).filter(node => node.type === 'button' && node.props.children === 'Make default');
    assert.equal(buttons.length, 1, 'only v1.0: v2.0 is the default, v0.9 is not ready, v0.8 has no default and v0.7 is a reference');
    assert.match(markup, /<button type="button" class="btn small" title="Make v1\.0[^"]* the default">Make default<\/button>/);
    assert.match(markup, /runtimeDefaultSelect/, 'the Default menu stays in the Installed header');
    buttons[0].props.onClick();
    assert.deepEqual(calls, [['fixture', 'default', '1.0', 'mono', undefined, 'x64']]);
  } finally { harness.close(); }
  assert.doesNotMatch(render([runtime(rows.slice(0, 2), { supportsDefault: false })], 'fixture'), />Make default</);
  assert.equal(ui.runtimeMakeDefaultChoice({ install: { version: '1.0', ready: true }, label: 'v1.0', isDefault: true }), null);
  assert.deepEqual(ui.runtimeMakeDefaultChoice({ install: { version: '1.0', variant: 'mono', architecture: 'arm64' }, label: 'v1.0', isDefault: false }),
    { value: JSON.stringify(['1.0', 'mono', 'arm64']), version: '1.0', label: 'v1.0', variant: 'mono', architecture: 'arm64' });
});

// Owner, 11-17 7:24 PM: "There should be make default on every row in compatibility/graphics, not just select from
// dropdown." A runtime with a default per operation offers Make default for each operation a usable row serves.
test('rows of a runtime with a default per operation offer Make default for each operation they serve', () => {
  const rows = [{ version: '2.0', ready: true }, { version: '1.0', variant: 'mono', architecture: 'x64', ready: true }, { version: '0.9', ready: false }];
  const selections = [{ id: 'op', label: 'Operation', version: '2.0', compatibleVersions: ['2.0', '1.0', '0.9'] },
    { id: 'other', label: 'Other', version: '1.0', compatibleVersions: ['2.0', '1.0'] }];
  const calls = [], overrides = { onRuntimeSetDefault: (...args) => calls.push(args) };
  const harness = componentHarness(ui.RuntimesView, props([runtime(rows, { defaultVersion: '2.0', defaultSelections: selections })], 'fixture', overrides));
  try {
    const tree = harness.render(), markup = renderToStaticMarkup(tree);
    const buttons = treeElements(tree).filter(node => node.type === 'button' && /^Make default/.test([].concat(node.props.children).join('')));
    assert.deepEqual(buttons.map(node => [].concat(node.props.children).join('')), ['Make default for Other', 'Make default for Operation'],
      'v2.0 serves Other, v1.0 serves Operation; the row that is not ready offers none');
    assert.match(markup, /title="Make v2\.0 the default for Other">Make default for Other<\/button>/);
    buttons[1].props.onClick();
    assert.deepEqual(calls, [['fixture', 'default', '1.0', 'mono', 'op']]);
  } finally { harness.close(); }
  assert.deepEqual(ui.runtimeOperationDefaults({ version: '1.0', ready: true }, selections),
    [{ id: 'op', label: 'Operation', isDefault: false, makeDefault: true }, { id: 'other', label: 'Other', isDefault: true, makeDefault: false }]);
  assert.deepEqual(ui.runtimeOperationDefaults({ version: '0.9', ready: false }, selections), [{ id: 'op', label: 'Operation', isDefault: false, makeDefault: false }]);
  assert.deepEqual(ui.runtimeOperationDefaults({ version: '1.0', reference: true }, selections).map(row => row.makeDefault), [false, false]);
});

// Lead, 11-17 7:4x PM, after the owner still saw rows without Make default: a copy another Wine includes is a default
// wherever Play chooses among its source's copies. Its manager marks it supportsDefault: true; copies the runtime keeps to
// itself (CrossOver) and copies of no declared source stay without one.
test('an included copy its manager marks selectable offers Make default and can be the default', () => {
  const installed = [{ version: '2.0', ready: true }];
  const selectable = { version: 'reference:["sikarugir","/W","dxvk","/W/dxvk"]', versionLabel: 'DXVK 2.3 · Sikarugir', ready: true, included: true,
    readOnly: true, removable: false, supportsDefault: true, reference: { managerId: 'sikarugir', version: '10.0', path: '/W' } };
  const own = { ...selectable, version: 'reference:["crossover","/C","dxvk","/C/dxvk"]', versionLabel: 'DXVK 2.5 · CrossOver', supportsDefault: false,
    reference: { managerId: 'crossover', version: '26', path: '/C' } };
  const unmarked = { ...selectable, version: 'reference:["winecx","/X","dxvk","/X/dxvk"]', versionLabel: 'DXVK 2.4 · WineCX' };
  delete unmarked.supportsDefault;
  const calls = [], overrides = { onRuntimeSetDefault: (...args) => calls.push(args) };
  const harness = componentHarness(ui.RuntimesView, props([runtime(installed, { defaultVersion: '2.0', defaultSource: 'manager',
    references: [selectable, own, unmarked] })], 'fixture', overrides));
  try {
    const tree = harness.render();
    const buttons = treeElements(tree).filter(node => node.type === 'button' && node.props.children === 'Make default');
    assert.equal(buttons.length, 1, 'only the selectable Sikarugir copy: v2.0 is the default, CrossOver keeps its copy, the WineCX copy is unmarked');
    buttons[0].props.onClick();
    assert.deepEqual(calls, [['fixture', 'default', selectable.version, undefined, undefined, undefined]]);
  } finally { harness.close(); }
  const saved = render([runtime(installed, { defaultVersion: selectable.version, defaultSource: 'saved', references: [selectable, own] })], 'fixture');
  assert.doesNotMatch(saved, /runtimeDefaultMissing/, 'an included copy that is the default is present');
  assert.equal((saved.match(/>Default<\/span>/g) || []).length, 1, 'the copy carries the Default badge');
  assert.equal((saved.match(/>Make default<\/button>/g) || []).length, 1, 'v2.0 now offers Make default');
  assert.equal(ui.runtimeRowDefaultable(selectable), true);
  assert.equal(ui.runtimeRowDefaultable(own), false);
  assert.equal(ui.runtimeRowDefaultable(unmarked), false);
  const menu = ui.runtimeDefaultMenu({ defaultVersion: selectable.version, defaultSource: 'saved' },
    [{ install: installed[0], label: 'v2.0', isDefault: false }, { install: selectable, label: 'DXVK 2.3 · Sikarugir', isDefault: true },
      { install: own, label: 'DXVK 2.5 · CrossOver', isDefault: false }]);
  assert.deepEqual(menu.choices.map(choice => choice.label), ['Automatic', 'v2.0', 'DXVK 2.3 · Sikarugir']);
  assert.equal(menu.selected, JSON.stringify([selectable.version, '', '']));
});

// Lead, 11-17 8:03 PM: every module list uses the Settings sidebar's order, by the label shown, ignoring case, with
// numbers in numeric order.
test('the Game engines list sorts by the label shown, ignoring case, with numbers in numeric order', () => {
  const engine = (id, label) => ({ id, label, ui: { tabLabel: label, category: 'engines', management: 'managed' }, sections: [{ id: 'default', installed: [] }] });
  const groups = ui.groupRuntimeManagers([engine('b', 'Engine 10'), engine('a', 'engine 9'), engine('c', 'Alpha'), engine('d', 'beta')],
    [{ id: 'engines', label: 'Game engines', sort: 'label', default: true }]);
  assert.deepEqual(groups.map(group => group.label), ['Alpha', 'beta', 'engine 9', 'Engine 10']);
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

test('each source menu offers its own versions, never another source\'s installed build or a registered folder (GUI 0913 M1)', () => {
  const installed = [{ version: '0.41.0-MCLv8', ready: true }, { version: '0.41.0-macos-14-arm64', ready: true }, { version: '0.41.0-MCLv6', ready: true },
    { version: '/tmp/registered/mpv-0.41.0', custom: true, ready: false }];
  const render = catalog => renderToStaticMarkup(react.createElement(ui.RuntimeCatalogSources, { managerId: 'fixture',
    section: { id: 'default', label: 'Versions', installed, catalog }, identity: 'Fixture', links: [],
    ui: { installVersion: {}, installVariant: {}, pendingActions: {} }, busy: false, variant: '', downloads: [], onSelect() {}, onInstall() {}, onRefresh() {} }));
  const menus = markup => [...markup.matchAll(/<select[^>]*>([\s\S]*?)<\/select>/g)].map(match =>
    [...match[1].matchAll(/<option value="([^"]*)"([^>]*)>/g)].map(option => option[1] + (/selected=""/.test(option[2]) ? ' *' : '')));
  const split = render({ status: 'success', sources: [{ id: 'builds', label: 'MacLauncher Builds', status: 'success', versions: ['0.41.0-MCLv8'] },
    { id: 'upstream', label: 'Upstream', status: 'success', versions: ['0.41.0-macos-14-arm64'] }] });
  assert.deepEqual(menus(split), [['', '0.41.0-MCLv8 *'], ['', '0.41.0-macos-14-arm64 *']]);
  // One source still lists every installed download, but never a registered folder's path.
  const single = render({ status: 'success', versions: ['0.41.0-MCLv8'] });
  assert.deepEqual(menus(single), [['', '0.41.0-MCLv8 *', '0.41.0-macos-14-arm64', '0.41.0-MCLv6']]);
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

test('a deep link to a runtime whose sections arrive late keeps that runtime instead of the entry\'s first tab (GUI 0904)', () => {
  const sec = () => [{ id: 'default', label: 'Versions', installed: [], catalog: { versions: [] } }];
  const tool = (id, label, memberOrder) => ({ id, label, ui: { groupId: 'tools', tabLabel: 'Tools', sectionLabel: label, order: 200, memberOrder, management: 'managed' }, sections: sec() });
  const managers = [tool('innoextract', 'Installer reader', 100), tool('ilspy', 'ILSpy', 200),
    { id: 'java-steamworks', label: 'Steamworks4j', ui: { category: 'compatibility', tabLabel: 'Steamworks4j', order: 204, management: 'managed' }, sections: sec() }];
  const ilspy = managers[1], loaded = ilspy.sections; ilspy.sections = [];
  const props = { runtimeManagers: managers, runtimeUi: {}, runtimeManagerId: 'java-steamworks', runtimeSectionId: null, downloadTasks: [], navigationKey: 1,
    updateRuntimeUiSection() {}, onRuntimeRefresh() {}, onRuntimeInstall() {}, onRuntimeSetDefault() {}, onRuntimeUninstall() {}, onCancelDownload() {} };
  props.setRuntimeManagerId = id => { props.runtimeManagerId = id; };
  props.setRuntimeSectionId = id => { props.runtimeSectionId = id; };
  const harness = componentHarness(ui.RuntimesView, props);
  try {
    harness.render(); harness.render();
    props.runtimeManagerId = 'ilspy'; props.runtimeSectionId = null; props.navigationKey = 2;
    harness.render(); harness.render();
    assert.equal(props.runtimeManagerId, 'ilspy', 'the request stays while its sections load');
    ilspy.sections = loaded; props.runtimeManagers = [...managers];
    harness.render(); const tree = harness.render();
    const selected = treeElements(tree).filter(node => node.props?.role === 'tab' && node.props['aria-selected']);
    assert.equal(selected.length, 1);
    assert.match(renderToStaticMarkup(selected[0]), />ILSpy</);
  } finally { harness.close(); }
  assert.equal(ui.runtimeRequestPending({ managers: [{ id: 'ilspy' }] }, [], 'ilspy'), true);
  assert.equal(ui.runtimeRequestPending({ managers: [{ id: 'ilspy' }] }, [{ managerId: 'ilspy' }], 'ilspy'), false);
  assert.equal(ui.runtimeRequestPending({ managers: [{ id: 'other' }] }, [], 'ilspy'), false);
});

test('installed rows read macOS releases as macOS names them and keep each included component on one line (GUI 0904)', () => {
  const row = render([runtime([{ version: '1.0', ready: true, minimumMacOS: '26.0.0', componentSummary: 'DXMT 0.80 · MoltenVK 1.4.1 · GStreamer 1.26.3' },
    { version: '0.9', ready: true, minimumMacOS: '26.1.2' }])], 'fixture');
  assert.match(row, /<div class="dim">Requires macOS 26\.0 or later<\/div>/);
  assert.match(row, /<div class="dim">Requires macOS 26\.1\.2 or later<\/div>/);
  assert.match(row, /Includes <span class="runtimeIncludedPart">DXMT 0\.80<\/span> · <span class="runtimeIncludedPart">MoltenVK 1\.4\.1<\/span> · <span class="runtimeIncludedPart">GStreamer 1\.26\.3<\/span>/);
  assert.deepEqual(ui.runtimeIncludedParts('A 1 · B 2'), ['A 1', 'B 2']);
  assert.deepEqual(ui.runtimeIncludedParts(null), []);
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/src/ui/styles.css'), 'utf8');
  assert.match(css, /\.runtimeIncludedPart \{ white-space: nowrap; \}/);
});

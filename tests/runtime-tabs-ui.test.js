const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

test('shared settings and runtimes keep static detail in help while preserving controls and actionable errors', async () => {
  const { build } = require('vite'), Module = require('node:module'), React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const components = await Promise.all(['RuntimeSettingsWindow', 'SettingsView', 'RuntimesView'].map(async name => {
    const bundle = await build({ configFile: false, logLevel: 'silent', build: {
      ssr: path.resolve(__dirname, `../src/renderer/src/ui/components/${name}.tsx`), write: false,
      rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
    } });
    const compiled = new Module(path.join(__dirname, `${name}-render.cjs`), module);compiled.paths = module.paths;
    compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);return compiled.exports[name];
  }));
  const [RuntimeSettingsWindow, SettingsView, RuntimesView] = components;
  const state = require('./library-layout-fixture').createLibraryFixture(), mod = state.modules[0];
  Object.assign(mod.runtime.entries.managed, { description: 'Runtime description.', requirements: 'Runtime requirement.',
    settings: { fields: [{ key: 'audio', label: 'Audio', type: 'boolean', default: true, description: 'Audio explanation.' }] } });
  const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
  const settings = render(RuntimeSettingsWindow, { state, api: { setModuleRuntimeSettings() {}, setGameRuntimeSettings() {} },
    context: { scope: 'module', moduleId: mod.id, runtimeId: 'managed' }, error: 'Settings could not be read.' });
  assert.match(settings, /<input type="checkbox" aria-label="Audio" checked=""/);
  assert.doesNotMatch(settings, /<span>On<\/span>|<span>Off<\/span>|game type defaults/);
  assert.match(settings, /aria-label="Reset to global defaults">Reset<\/button>/);
  assert.match(settings, /popover="auto" class="helpPopover"><p>Runtime description\.<\/p><p>Runtime requirement\.<\/p>/);
  assert.match(settings, /class="error">Error: Settings could not be read\./);
  mod.settingsDefaults = {};
  const general = render(SettingsView, { state, sectionId: `module:${mod.id}`, showIcons: true, showNonDefaultTags: true,
    onSetLauncherSettings() {}, onSetModuleSettings() {} });
  assert.doesNotMatch(general, /No settings available|No configurable runtime settings|class="settingsLabel">Runtime settings/);
  assert.match(general, /role="tab"[^>]*[\s\S]*Managed runtime/);
  const section = { ...state.runtimeManagers['fixture-manager'].sections[0], description: 'Catalog explanation.',
    componentsTitle: 'Components', componentsDescription: 'Component explanation.',
    components: [{ id: 'part', label: 'Runtime part', available: false, status: 'Not installed', description: 'Part explanation.' }],
    installed: [{ version: '2.0', platformKey: 'mac-arm64', installDir: '/Runtimes/2.0', minimumMacOS: '13.0',
      detail: 'Installation detail.', ready: false, error: 'Reinstall this version.', libraries: { graphics: { ready: true, label: 'Graphics library', version: '1.0' } } }],
    catalog: { versions: ['3.0', '2.0'], installable: false, installReason: 'Requires an additional tool.' } };
  const runtimes = render(RuntimesView, { runtimeManagers: [{ id: 'fixture-manager', label: 'Fixture runtimes', sections: [section] }],
    runtimeManagerId: 'fixture-manager', runtimeSectionId: section.id, runtimeUi: {}, downloadTasks: [], downloadsOpen: false,
    setDownloadsOpen() {}, setRuntimeManagerId() {}, setRuntimeSectionId() {}, updateRuntimeUiSection() {},
    onRuntimeRefresh() {}, onRuntimeInstall() {}, onRuntimeSetDefault() {}, onRuntimeUninstall() {}, onCancelDownload() {} });
  assert.match(runtimes, /popover="auto" class="helpPopover">Component explanation\./);
  assert.match(runtimes, /class="runtimeCatalogDetails"><p>Catalog explanation\.<\/p>/);
  assert.match(runtimes, /popover="auto" class="helpPopover"><p>mac-arm64<\/p><p>Requires macOS 13\.0 or later\.<\/p>/);
  assert.doesNotMatch(runtimes, /class="runtimePanelSubtitle"|class="dim mono ellipsis runtimePath"|<div class="dim">Installation detail\./);
  assert.doesNotMatch(runtimes, /class="runtimeSectionHint"/);
  assert.match(runtimes, /<div>Requires an additional tool\.<\/div>/);
  assert.match(runtimes, /class="dim">Reinstall this version\./);
});

function modelTest(body) {
  const model = pathToFileURL(path.resolve(__dirname, '../src/renderer/src/ui/components/runtime-tabs-model.ts')).href;
  const script = `import assert from 'node:assert/strict';
    const { groupRuntimeManagers, runtimeGroupSections, runtimeSectionTabs, resolveRuntimeTabSelection, runtimeTabMovement, runtimeCatalogPresentation, runtimeSummaryPresentation, runtimeManagementPresentation, runtimeRemovalPresentation, isRuntimeManageable, managedRuntimeSections } = await import(${JSON.stringify(model)});
    const manager = (id, label, ui, names = ['Versions']) => ({ id, label, ui,
      sections: names.map((label, index) => ({ id: index === 0 ? 'default' : 'secondary', label, installed: [{ version: id + '-v1' }], catalog: { versions: [id + '-v1'] } })) });
    const sections = manager => manager.sections;
    ${body}`;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('shader collections retain exact action targets beneath one stable Graphics tab', () => modelTest(`
  const models = manager('models', 'Models', { groupId: 'graphics', tabLabel: 'Graphics', memberOrder: 0 });
  const shaders = manager('shader-library', 'Shader library', { groupId: 'graphics', library: 'shaders', sectionLabel: 'Shaders', memberOrder: 10 }, ['First collection', 'Second collection']);
  const group = groupRuntimeManagers([shaders, models])[0];
  const choices = runtimeGroupSections(group, sections);
  const tabs = runtimeSectionTabs(choices);
  assert.deepEqual(tabs.map(tab => tab.label), ['Models', 'Shaders']);
  assert.equal(tabs[1].choices.length, 2);
  const selected = resolveRuntimeTabSelection([group], shaders.id, 'secondary', sections);
  assert.equal(selected.section.sectionId, 'secondary');
  assert.equal(tabs[1].choices[1].id, selected.section.id);
  const reversed = runtimeSectionTabs(runtimeGroupSections({ ...group, managers: [models, { ...shaders, sections: [...shaders.sections].reverse() }] }, sections));
  assert.equal(reversed[1].id, tabs[1].id, 'Catalog ordering cannot replace the selected Shaders tab');
`));

test('version summaries omit values already selected without hiding a different available release', () => modelTest(`
  const section = { catalog: { versions: ['2', '1'], latestAvailableVersion: '2', latestInstalledVersion: '2' } };
  assert.equal(runtimeSummaryPresentation(section, '2').latestAvailableVersion, '');
  assert.equal(runtimeSummaryPresentation(section, '2').latestInstalledVersion, '');
  assert.equal(runtimeSummaryPresentation(section, '1').latestAvailableVersion, '2');
  assert.equal(runtimeSummaryPresentation(section, '1').latestInstalledVersion, '');
  section.catalog.latestInstalledVersion = '1';
  assert.equal(runtimeSummaryPresentation(section, '1').latestAvailableVersion, '2');
  assert.equal(runtimeSummaryPresentation(section, '1').latestInstalledVersion, '');
  assert.equal(runtimeSummaryPresentation(section, '2').latestAvailableVersion, '');
  assert.equal(runtimeSummaryPresentation(section, '2').latestInstalledVersion, '1');
`));

test('local runtime summaries distinguish included versions and retain defaults missing a matching usable variant', () => modelTest(`
  const included = { version: '1', variant: 'arm64', bundledExecution: 'direct', ready: true };
  const section = { installed: [included], defaultVersion: '1', defaultVariant: 'arm64',
    catalog: { versions: ['1'], fetchedAt: 1700000000000 } };
  const summary = runtimeSummaryPresentation(section, '1');
  assert.equal(summary.installedTitle, 'Included');
  assert.equal(summary.includedCount, 1); assert.equal(summary.installedCount, 0);
  assert.equal(summary.showDefaultVersion, false); assert.equal(summary.checkedAt, 1700000000000);
  assert.equal(runtimeSummaryPresentation({ ...section, defaultVariant: 'x64' }).showDefaultVersion, true);
  assert.equal(runtimeSummaryPresentation({ ...section, defaultVariant: 'x64', supportsDefault: false }).showDefaultVersion, false);
  assert.equal(runtimeSummaryPresentation({ ...section, installed: [{ ...included, ready: false }] }).showDefaultVersion, true);
  assert.equal(runtimeSummaryPresentation({ ...section, installed: [included, { version: '2', source: 'local' }] }).installedTitle, 'Included & installed');
  assert.equal(runtimeSummaryPresentation({ installed: [{ version: '2', source: 'local' }] }).installedTitle, 'Installed');
  assert.equal(runtimeSummaryPresentation({ catalog: { fetchedAt: Infinity } }).checkedAt, null);
`));

test('local application management preserves independent identities and unregisters applications without uninstall wording', () => modelTest(`
  const first = { version: 'local-main', label: '26.0 · Player.app', external: true };
  const second = { version: 'local-beta', label: '26.0 · Player Beta.app', external: true };
  const section = { catalog: { delivery: 'local', versions: [first.version, second.version],
    latestAvailableVersion: first.version, refreshLabel: 'Find installed applications' },
    defaultVersion: second.version, installed: [first, second] };
  const summary = runtimeSummaryPresentation(section);
  assert.equal(summary.installedTitle, 'Registered applications');
  assert.equal(summary.versionCount, 2);
  assert.equal(summary.latestAvailableVersion, '');
  assert.equal(summary.latestInstalledVersion, '');
  assert.equal(summary.showDefaultVersion, false);
  assert.equal(runtimeManagementPresentation(section).title, 'Applications');
  assert.equal(runtimeManagementPresentation(section).refreshLabel, 'Find installed applications');
  assert.deepEqual(runtimeRemovalPresentation(second, section), { label: 'Remove',
    confirm: 'Remove 26.0 · Player Beta.app from Runtimes? The application will remain installed.' });
  assert.deepEqual(runtimeRemovalPresentation({ version: '1.2.3' }), { label: 'Uninstall', confirm: 'Uninstall v1.2.3?' });
  assert.deepEqual(runtimeRemovalPresentation({ ...first, removalLabel: 'Forget', removalConfirm: 'Forget this entry?' }, section),
    { label: 'Forget', confirm: 'Forget this entry?' });
`));

test('selected runtime versions expose their actual install method and macOS requirement', () => modelTest(`
  const catalog = { installLabel: 'Install', source: 'https://example.org/runtime', versionRequirements: {
    shipped: { installLabel: 'Install', minimumMacOS: '27.0' }, source: { installLabel: 'Build' }
  } };
  const shipped = runtimeCatalogPresentation(catalog, 'shipped');
  assert.equal(shipped.installLabel, 'Install');
  assert.match(shipped.installReason, /Requires macOS 27.0/);
  const source = runtimeCatalogPresentation(catalog, 'source');
  assert.equal(source.installLabel, 'Build');
  assert.equal(source.installReason.includes('27.0'), false);
`));

test('selected version unavailability takes precedence over general installation help', () => modelTest(`
  const catalog = { installReason: 'General setup help.', versionRequirements: {
    historical: { installReason: 'This release has no reviewed Mac runtime.', minimumMacOS: '27.0' },
    inherited: { installReason: '  ' }
  } };
  assert.equal(runtimeCatalogPresentation(catalog, 'historical').installReason,
    'This release has no reviewed Mac runtime. Requires macOS 27.0 or later.');
  assert.equal(runtimeCatalogPresentation(catalog, 'inherited').installReason, 'General setup help.');
  assert.equal(runtimeCatalogPresentation(catalog, 'unknown').installReason, 'General setup help.');
`));

test('included and unavailable architectures retain independent installation state for one version', () => modelTest(`
  const catalog = { versionRequirements: { '1.2.3': { variants: {
    arm64: { included: true, installLabel: 'Included', installReason: '' },
    x64: { included: false, installLabel: 'Install', installReason: 'This release has no Intel package.' }
  } } } };
  assert.equal(runtimeCatalogPresentation(catalog, '1.2.3', 'arm64').included, true);
  const intel = runtimeCatalogPresentation(catalog, '1.2.3', 'x64');
  assert.equal(intel.included, false); assert.equal(intel.installLabel, 'Install');
  assert.equal(intel.installReason, 'This release has no Intel package.');
`));

test('runtime groups sort common runtimes by metadata and retain unknown managers without engine branches', () => modelTest(`
  const labels = ['NW.js', 'MKXP-Z', "Ren’Py", 'Godot', 'Java', 'LÖVE', 'Ruffle', 'Onsyuri', 'GameMaker', 'Butterscotch', 'KiriKiri', 'AliceSoft', 'Ikemen', 'GemRB', 'HashLink'];
  const managers = labels.map((label, index) => manager('opaque-' + index, 'Backend ' + index,
    { groupId: 'group-' + index, tabLabel: label, order: index === 9 ? 91 : index < 9 ? (index + 1) * 10 : index * 10 }));
  const ordered = managers.map((item, index) => ({ ...item, ui: { ...item.ui, order: index < 9 ? (index + 1) * 10 : index === 9 ? 91 : index * 10 } }));
  const unknown = manager('future', 'Future runtime', undefined);
  const groups = groupRuntimeManagers(Object.freeze([unknown, ...ordered].reverse()));
  assert.deepEqual(groups.map(group => group.label), [...labels, 'Future runtime']);
  assert.equal(groups.at(-1).order, 1000);
  assert.equal(groups[0].managers[0], ordered[0]);
`));
test('a declarative final-position group follows unclassified runtimes regardless of numeric order or label', () => modelTest(`
  const last = manager('last', 'Opaque group', { groupId: 'opaque', tabLabel: 'Utilities', position: 'last', order: -999 });
  const ordinary = manager('ordinary', 'Runtime', { order: 50 });
  const unknown = manager('unknown', 'Future runtime');
  assert.deepEqual(groupRuntimeManagers([last, unknown, ordinary]).map(group => group.id), ['ordinary', 'unknown', 'opaque']);
  assert.deepEqual(runtimeGroupSections(groupRuntimeManagers([last])[0], sections).map(choice => choice.managerId), ['last']);
`));

test('registry metadata exposes manageable production groups while exposing managed engine and tool routes', () => {
  const registry = require('../src/modules/registry');
  const all = [...registry.listSharedRuntimeManagers(), ...registry.listModules().flatMap(mod => registry.getModule(mod.id)?.runtimeManagers || [])];
  const unique = [...new Map(all.map(manager => [manager.id, manager])).values()];
  const states = unique.map(manager => ({ id: manager.id, label: manager.label,
    ui: registry.getRuntimeManagerUi(manager.id) || manager.ui,
    sections: manager.id === 'onsyuri' ? [
      { id: 'mac', label: 'Native' }, { id: 'web', label: 'Web' }
    ] : manager.id === 'ilspy' ? [{ id: 'decompiler', label: 'ILSpy' }] : [{ id: 'default', label: 'Versions' }] }));
  modelTest(`
    const states = ${JSON.stringify(states)};
    const groups = groupRuntimeManagers(states);
    const common = ['NW.js', 'MKXP-Z', "Ren'Py", 'Godot', 'Temurin', 'LÖVE', 'Flash', 'NScripter'];
    assert.deepEqual(groups.filter(group => common.includes(group.label)).map(group => group.label), common);
    assert.equal(groups.filter(group => group.label === 'GameMaker').length, 1);
    assert.equal(groups.some(group => group.label === 'Butterscotch'), false);
    assert.deepEqual(runtimeGroupSections(groups.find(group => group.id === 'sikarugir'), sections).map(choice => [choice.label, choice.managerId]),
      [['Sikarugir', 'sikarugir'], ['Graphics bridge', 'sikarugir-graphics-bridge']]);
    assert.deepEqual(runtimeGroupSections(groups.find(group => group.id === 'crossover'), sections).map(choice => [choice.label, choice.managerId]),
      [['CrossOver', 'crossover'], ['Graphics bridge', 'crossover-graphics-bridge']]);
    assert.deepEqual(runtimeGroupSections(groups.find(group => group.label === 'Flash'), sections).map(choice => [choice.label, choice.managerId]),
      [['Flash Player', 'flash-projector'], ['Ruffle', 'ruffle']]);
    assert.deepEqual(runtimeGroupSections(groups.find(group => group.label === 'GameMaker'), sections).map(choice => [choice.label, choice.managerId]),
      [['Official', 'gamemaker-official'], ['Butterscotch', 'butterscotch'], ['Classic (OpenGMK)', 'opengmk'], ['GM8Decompiler', 'gm8-decompiler'], ['UMT', 'undertale-mod-cli']]);
    assert.equal(groups.some(group => group.label === 'AliceSoft'), true);
    const nscripter = groups.find(group => group.label === 'NScripter');
    assert.equal(nscripter.id, 'nscripter');
    assert.deepEqual(runtimeGroupSections(nscripter, sections).map(choice => [choice.label, choice.managerId]),
      [['ONScripter-Yuri · Native', 'onsyuri'], ['ONScripter-Yuri · Web', 'onsyuri'], ['ONScripter-EN', 'onscripter-en']]);
    const ilspy = groups.find(group => group.label === 'Tools');
    assert.equal(ilspy.id, 'tools');
    assert.deepEqual(runtimeGroupSections(ilspy, sections).filter(choice => choice.managerId === 'ilspy').map(choice => [choice.label, choice.managerId, choice.sectionId]),
      [['ILSpy', 'ilspy', 'decompiler']]);
    assert.equal(groups.some(group => group.label === 'ILSpy' || group.label === 'ONScripter-Yuri Web'), false);
    assert.equal(resolveRuntimeTabSelection(groups, 'onsyuri', 'mac', sections).section.sectionId, 'mac');
    assert.ok(states.every(manager => ['managed', 'built-in'].includes(manager.ui.management)));
    assert.equal(groups.flatMap(group => group.managers).length, states.filter(manager => manager.ui.management === 'managed').length);
    for (const id of ['mkxpz', 'butterscotch', 'hashlink']) assert.ok(groups.some(group => group.managers.some(manager => manager.id === id)));
    for (const id of ['system3', 'xsystem35', 'xsystem4', 'fna', 'krkrsdl2', 'gemrb', 'innoextract']) {
      assert.ok(states.some(manager => manager.id === id));
      assert.equal(groups.some(group => group.managers.some(manager => manager.id === id)), true);
    }
  `);
  assert.equal(registry.getModule('alicesoft').runtimeManagers.length, 5);
  assert.ok(registry.getModule('alicesoft').manifest.runtime.entries.xsystem4.settings.fields.length);
});

test('management metadata alone controls navigation regardless of inclusion, installation or source build state', () => modelTest(`
  const fixed = manager('fixed', 'Built-in', { management: 'built-in' });
  const download = manager('download', 'Download', { management: 'managed' });
  const source = manager('source', 'Source build', { management: 'managed' });
  fixed.catalog = { get versions() { throw Error('Navigation must not inspect a catalog'); } };
  download.installed = [{ version: 'included', included: true }];
  source.catalog = { installLabel: 'Build' };
  const states = Object.freeze([fixed, download, source]);
  assert.deepEqual(groupRuntimeManagers(states).map(group => group.id), ['download', 'source']);
  assert.equal(states.length, 3);
  assert.equal(isRuntimeManageable(fixed), false);
  assert.equal(isRuntimeManageable(download), true);
  assert.equal(isRuntimeManageable(source), true);
  const mixed = manager('mixed', 'Mixed', { management: 'managed', sectionManagement: { default: 'built-in', secondary: 'managed' } }, ['Native', 'Web']);
  assert.deepEqual(managedRuntimeSections(mixed, sections).map(section => section.id), ['secondary']);
  assert.equal(isRuntimeManageable(mixed, 'default'), false);
  assert.equal(isRuntimeManageable(mixed, 'secondary'), true);
  const selected = resolveRuntimeTabSelection(groupRuntimeManagers([fixed, mixed]), fixed.id, 'default', sections);
  assert.equal(selected.section.managerId, mixed.id); assert.equal(selected.section.sectionId, 'secondary');
`));

test('direct AliceSoft opening selects the requested backend and independent settings/version data', () => modelTest(`
  const first = manager('opaque-old', 'Older systems', { groupId: 'alice', tabLabel: 'AliceSoft', order: 110, sectionLabel: 'System 1–3', memberOrder: 0 });
  const second = manager('opaque-new', 'Newer systems', { groupId: 'alice', tabLabel: 'AliceSoft', order: 110, sectionLabel: 'System 3.5–3.9', memberOrder: 1 });
  const groups = groupRuntimeManagers([second, first]);
  assert.equal(groups.length, 1);
  assert.deepEqual(runtimeGroupSections(groups[0], sections).map(choice => choice.label), ['System 1–3', 'System 3.5–3.9']);
  const selected = resolveRuntimeTabSelection(groups, second.id, null, sections);
  assert.equal(selected.group.label, 'AliceSoft');
  assert.equal(selected.section.managerId, second.id);
  assert.equal(selected.section.sectionId, 'default');
  assert.equal(selected.section.manager, second);
  assert.equal(selected.section.section, second.sections[0]);
  assert.deepEqual(selected.section.section.catalog.versions, ['opaque-new-v1']);
  const action = { managerId: selected.section.managerId, sectionId: selected.section.sectionId, version: selected.section.section.catalog.versions[0] };
  assert.deepEqual(action, { managerId: 'opaque-new', sectionId: 'default', version: 'opaque-new-v1' });
`));

test('GameMaker tools use distinct backend routes even when each section is named default', () => modelTest(`
  const members = [
    manager('tool-cli', 'Long tool name', { groupId: 'gm', tabLabel: 'GameMaker', order: 90, sectionLabel: 'UMT', memberOrder: 1 }),
    manager('classic-cli', 'Classic tool', { groupId: 'gm', tabLabel: 'GameMaker', order: 90, sectionLabel: 'GM8Decompiler', memberOrder: 2 }),
    manager('official-builds', 'Vendor inventory', { groupId: 'gm', tabLabel: 'GameMaker', order: 90, sectionLabel: 'Runtime', memberOrder: 0 })
  ];
  const groups = groupRuntimeManagers([...members, manager('experimental', 'Verbose name', { groupId: 'gm', tabLabel: 'GameMaker', sectionLabel: 'Butterscotch', memberOrder: 3, order: 90 })]);
  assert.deepEqual(groups.map(group => group.label), ['GameMaker']);
  const choices = runtimeGroupSections(groups[0], sections);
  assert.deepEqual(choices.map(choice => choice.label), ['Runtime', 'UMT', 'GM8Decompiler', 'Butterscotch']);
  assert.equal(new Set(choices.map(choice => choice.id)).size, 4);
  assert.equal(resolveRuntimeTabSelection(groups, 'classic-cli', 'default', sections).section.managerId, 'classic-cli');
  assert.equal(resolveRuntimeTabSelection(groups, 'tool-cli', 'missing', sections).section.managerId, 'tool-cli');
`));

test('existing channel sections, explicit selections and empty-manager fallback remain deterministic', () => modelTest(`
  const love = manager('channels', 'LÖVE', { order: 60 }, ['Releases', 'Nightlies']);
  const nw = manager('browser-runtime', 'NW.js', { order: 10 });
  const groups = groupRuntimeManagers([love, nw]);
  const selection = resolveRuntimeTabSelection(groups, love.id, 'secondary', sections);
  assert.equal(selection.section.label, 'Nightlies');
  assert.equal(selection.section.sectionId, 'secondary');
  assert.equal(resolveRuntimeTabSelection(groups, null, null, sections).section.managerId, nw.id);
  assert.equal(resolveRuntimeTabSelection(groupRuntimeManagers([nw, love].reverse()), love.id, 'secondary', sections).section.sectionId, 'secondary');
  assert.deepEqual(resolveRuntimeTabSelection([], null, null, sections), { group: null, section: null, sections: [] });
`));

test('runtime tab keys wrap correctly and catalog actions expose build labels and bounded source captions', () => modelTest(`
  assert.equal(runtimeTabMovement('ArrowRight', 2, 3), 0);
  assert.equal(runtimeTabMovement('ArrowLeft', 0, 3), 2);
  assert.equal(runtimeTabMovement('Home', 2, 3), 0);
  assert.equal(runtimeTabMovement('End', 0, 3), 2);
  assert.equal(runtimeTabMovement('Enter', 1, 3), null);
  assert.equal(runtimeTabMovement('ArrowRight', 0, 0), null);
  const build = runtimeCatalogPresentation({ installLabel: 'Build', source: 'https://github.com/example/runtime/tree/pinned', installReason: 'Requires CMake and SDL2.' });
  assert.deepEqual(build, { installLabel: 'Build', included: false, sourceUrl: 'https://github.com/example/runtime/tree/pinned', sourceLabel: 'github.com', installHelpUrl: null, installReason: 'Requires CMake and SDL2.' });
  assert.equal(runtimeCatalogPresentation({ installHelpUrl: 'https://example.com/setup' }).installHelpUrl, 'https://example.com/setup');
  assert.equal(runtimeCatalogPresentation({ installHelpUrl: 'file:///docs/runtimes/NATIVE_TOOL_SETUP.md' }).installHelpUrl, null);
  assert.equal(runtimeCatalogPresentation({}).installLabel, 'Install');
  assert.equal(runtimeCatalogPresentation({ source: 'javascript:alert(1)' }).sourceUrl, null);
  assert.equal(runtimeCatalogPresentation({ source: 'Reviewed pinned catalog (offline)' }).sourceLabel, '');
`));

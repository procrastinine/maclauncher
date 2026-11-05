const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Labels = require('../src/modules/shared/runtime/translator-label');
const Wine = require('../src/modules/shared/runtime/wine-translators');
const Pinned = require('../src/modules/shared/runtime/pinned-native-manager');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-template-components-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  };
  return { root, put };
}
function builtin() {
  const fixture = peFixture({ is64: true }); fixture.bytes.writeUInt16LE(0x2002, fixture.peOffset + 22);
  fixture.bytes.write('Wine builtin DLL\0', 64); return fixture.bytes;
}
// The renderer folders of an actual Template release: dxvk holds DXVK 1.10.3
// async, while d9vk and dxvk3 both hold DXVK 3.1.1 async.
function template(put, prefix) {
  for (const [folder, version] of [['dxvk', 'DXVK-Sikarugir-async-v1.10.3\nD9VK-Sikarugir-v2.3\n'],
    ['d9vk', 'DXVK-Sikarugir-v3.1.1-async\n'], ['dxvk3', 'DXVK-Sikarugir-v3.1.1-async\n'], ['dxmt', 'v0.80-244-g7c8dee1\n']]) {
    put(`${prefix}/renderer/${folder}/wine/x86_64-windows/d3d11.dll`, builtin());
    put(`${prefix}/renderer/${folder}/version`, version);
    put(`${prefix}/renderer/${folder}/LICENSE`, `${folder} licence`);
  }
}
// The translator managers' configurations, read without a network catalog.
function configurations(t) {
  const result = new Map(), create = Pinned.createPinnedNativeManager;
  t.mock.method(Pinned, 'createPinnedNativeManager', options => { result.set(options.id, options); return create(options); });
  const file = require.resolve('../src/modules/shared/runtime/translator-managers'), previous = require.cache[file];
  delete require.cache[file];
  t.after(() => { if (previous) require.cache[file] = previous; else delete require.cache[file]; });
  const Managers = require(file);
  for (const engine of ['dxvk', 'd3dmetal', 'dxmt']) Managers.createManager(engine);
  return { Managers, result };
}

test('a copy downloaded from a Template release is labelled managed, and the copies in an installed Template are labelled included', () => {
  const component = { engine: 'dxmt', component: 'd3d-renderer', version: 'v0.80-244-g7c8dee1' };
  assert.equal(Labels.label({ ...component, source: { kind: 'template', id: 'template', label: 'Sikarugir Template 1.0.21' } }),
    'DXMT 0.80-244-g7c8dee1 · Managed copy from Sikarugir Template 1.0.21');
  assert.equal(Labels.label({ ...component, included: true, source: { kind: 'sikarugir', runtime: 'sikarugir', label: 'Sikarugir Template 1.0.24' } }),
    'DXMT 0.80-244-g7c8dee1 · Sikarugir Template 1.0.24');
  assert.equal(Labels.label({ ...component, source: { kind: 'sikarugir', runtime: 'sikarugir', label: 'Sikarugir Template' } }, { templateRoot: '/fixture', catalogEntry: { template: { version: '1.0.24' } } }),
    'DXMT 0.80-244-g7c8dee1 · Sikarugir Template 1.0.24', 'a reference to an installed Template names its host');
  assert.equal(Labels.label({ ...component, source: { kind: 'upstream', label: 'dxmt' } }), 'DXMT 0.80-244-g7c8dee1 · dxmt');
});

test('an installed Wine runtime summarizes its translator versions after local preparation, naming Template folders that differ', async t => {
  const { root, put } = scratch(t), userDataDir = path.join(root, 'profile');
  const wine = path.join(root, 'engine/wine'), support = path.join(root, 'engine/support');
  const executablePath = put('engine/wine/bin/wine', image({ cpu: X64, fileType: 2 }));
  put('engine/wine/lib/wine/x86_64-unix/ntdll.so', image({ cpu: X64, symbols: ['wine_unix_call'] }));
  template(put, 'engine/support/Frameworks');
  const install = { ready: true, engineRoot: wine, installDir: wine, executablePath, architecture: 'x64', templateRoot: support,
    engineVersion: '10.0_8', version: '10.0_8-template-1.0.24', catalogEntry: { template: { version: '1.0.24' } } };
  assert.equal(Wine.includedSummary(install, 'sikarugir', { userDataDir }), '', 'a state reads retained descriptions only');
  await Wine.describedIncluded(install, 'sikarugir', { userDataDir, logger: { warn() {} } });
  const summary = Wine.includedSummary(install, 'sikarugir', { userDataDir });
  assert.deepEqual(summary.split(' · ').sort(), ['DXMT 0.80-244-g7c8dee1', 'DXVK 1.10.3 async (dxvk)', 'DXVK 3.1.1 async (d9vk, dxvk3)']);
  assert.equal(Wine.includedSummary(install, 'sikarugir', {}), '', 'without a profile nothing is read');
});

test('Template catalog versions name a known component version or say it is known after download', t => {
  const { Managers, result } = configurations(t);
  const references = [{ templateVersion: '1.0.24', templateComponent: 'dxvk3', versionLabel: 'DXVK 3.1.1 async · Sikarugir Template 1.0.24 · dxvk3' }];
  const pin = release => ({ version: `template-dxvk3-Template-${release}`, catalogSourceId: 'template-dxvk3', component: 'dxvk3',
    asset: { filename: `Template-${release}.tar.xz` }, versionLabel: `Template-${release}` });
  const dxvk = result.get('translator-dxvk');
  assert.equal(dxvk.formatVersionLabel(pin('1.0.24'), undefined, { includedReferences: references }), 'Template 1.0.24 · dxvk3 · DXVK 3.1.1 async');
  assert.equal(dxvk.versionContents(pin('1.0.24'), { includedReferences: references }), null);
  assert.equal(dxvk.formatVersionLabel(pin('1.0.27'), undefined, { includedReferences: references }), 'Template 1.0.27 · dxvk3');
  assert.equal(dxvk.versionContents(pin('1.0.27'), { includedReferences: references }), 'The DXVK version in this Template release is known after download.');
  assert.equal(dxvk.versionContents({ version: 'upstream-dxvk-2.7', catalogSourceId: 'upstream', asset: { filename: 'dxvk-2.7.tar.gz' } }, {}), null);
  const metal = { version: 'template-Template-1.0.27', catalogSourceId: 'template', component: 'd3dmetal', asset: { filename: 'Template-1.0.27.tar.xz' } };
  assert.equal(result.get('translator-d3dmetal').versionContents(metal, {}), 'The D3DMetal version in this Template release is known after download.');
  assert.equal(Managers.versionLabel(metal, { translator: { engine: 'd3dmetal', version: '4.0b3' } }, 'D3DMetal'), 'D3DMetal 4.0b3 · Managed copy from Sikarugir Template 1.0.27');
});

test('the Template source is primary where it is the only download source and installs one folder with its notices', async t => {
  const { result } = configurations(t);
  for (const [id, secondary] of [['translator-dxvk', true], ['translator-d3dmetal', false], ['sikarugir-graphics-bridge', false]]) {
    const sources = result.get(id).catalogSources.filter(source => source.id.startsWith('template'));
    assert.ok(sources.length, id);
    for (const source of sources) {
      assert.equal(Boolean(source.secondary || source.group?.secondary), secondary, `${id} ${source.id}`);
      assert.match(source.description, /^Managed .*copies taken from .*Sikarugir Template release.*, with the folder's licence and no Wine engine\./);
    }
  }
  const { root, put } = scratch(t);
  const release = name => {
    template(put, `${name}/Template-1.0.24.app/Contents/Frameworks`);
    put(`${name}/Template-1.0.24.app/Contents/Frameworks/renderer/d3dmetal/wine/x86_64-windows/d3d12.dll`, builtin());
    put(`${name}/Template-1.0.24.app/Contents/Frameworks/renderer/d3dmetal/License.rtf`, 'Apple licence');
    put(`${name}/Template-1.0.24.app/Contents/Frameworks/renderer/d3dmetal/Read Me.rtf`, 'Apple read me');
    return path.join(root, name);
  };
  const unpacked = release('dxvk-archive');
  const metadata = await result.get('translator-dxvk').prepareInstall({ unpacked,
    pin: { version: 'template-dxvk3-Template-1.0.24', catalogSourceId: 'template-dxvk3', component: 'dxvk3', asset: { filename: 'Template-1.0.24.tar.xz' } } });
  assert.deepEqual(fs.readdirSync(unpacked), ['dxvk'], 'only the selected folder remains, without the Wine engine or other folders');
  assert.deepEqual(fs.readdirSync(path.join(unpacked, 'dxvk')).sort(), ['LICENSE', 'version', 'wine']);
  assert.equal(fs.readFileSync(path.join(unpacked, 'dxvk/LICENSE'), 'utf8'), 'dxvk3 licence', 'the selected folder keeps its own licence');
  assert.equal(metadata.translatorRelative, 'dxvk');
  const metal = release('metal-archive');
  await result.get('translator-d3dmetal').prepareInstall({ unpacked: metal,
    pin: { version: 'template-Template-1.0.24', catalogSourceId: 'template', component: 'd3dmetal', asset: { filename: 'Template-1.0.24.tar.xz' } } });
  assert.deepEqual(fs.readdirSync(path.join(metal, 'd3dmetal')).sort(), ['License.rtf', 'Read Me.rtf', 'wine'], "Apple's licence and read me stay with D3DMetal");
});

// Apple's D3DMetal layout in recent Templates: a framework with its release in
// Info.plist, a bridge library, Wine modules and notices, and an apple_gptk link.
function appleD3DMetal(put, renderer, release) {
  const framework = `${renderer}/d3dmetal/external/D3DMetal.framework`;
  put(`${framework}/Versions/A/D3DMetal`, image({ cpu: X64, installName: '@rpath/D3DMetal.framework/Versions/A/D3DMetal' }));
  put(`${framework}/Versions/A/Resources/Info.plist`, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
    `<key>CFBundleIdentifier</key><string>com.apple.D3DMetal</string><key>CFBundleShortVersionString</key><string>${release}</string></dict></plist>`);
  put(`${renderer}/d3dmetal/external/libd3dshared.dylib`, image({ cpu: X64, installName: '@rpath/libd3dshared.dylib' }));
  put(`${renderer}/d3dmetal/wine/x86_64-windows/d3d12.dll`, builtin());
  for (const name of ['License.rtf', 'Read Me.rtf']) put(`${renderer}/d3dmetal/${name}`, name);
  return framework;
}

test('a D3DMetal Template install keeps the whole d3dmetal folder through the apple_gptk link and takes its release from the framework', async t => {
  const { root, put } = scratch(t), { result } = configurations(t);
  const renderer = 'metal/Template-1.0.27.app/Contents/SharedSupport/renderer', framework = path.join(root, appleD3DMetal(put, renderer, '9.1b2'));
  for (const link of [['A', 'Versions/Current'], ['Versions/Current/D3DMetal', 'D3DMetal'], ['Versions/Current/Resources', 'Resources']])
    fs.symlinkSync(link[0], path.join(framework, link[1]));
  fs.symlinkSync('d3dmetal', path.join(root, renderer, 'apple_gptk'));
  const unpacked = path.join(root, 'metal'), folder = path.join(root, renderer, 'd3dmetal');
  assert.equal(require('../src/modules/shared/runtime/component-runtime').componentRoot(unpacked, { names: ['d3dmetal', 'apple_gptk', 'redist'] }), folder,
    'the outermost component folder wins over a framework reached through the link');
  const metadata = await result.get('translator-d3dmetal').prepareInstall({ unpacked,
    pin: { version: 'template-Template-1.0.27', catalogSourceId: 'template', component: 'd3dmetal', asset: { filename: 'Template-1.0.27.tar.xz' } } });
  assert.deepEqual(fs.readdirSync(path.join(unpacked, 'd3dmetal')).sort(), ['License.rtf', 'Read Me.rtf', 'external', 'wine']);
  assert.equal(metadata.translator.version, '9.1b2', 'a folder with one framework bundle takes that bundle\'s release');
});

test('Runtimes names the translator versions of an installed Wine runtime and what a listed Template version holds', async () => {
  const { build } = require('vite'), Module = require('node:module'), React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.resolve(__dirname, '../src/renderer/src/ui/components/RuntimesView.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'translator-template-components-render.cjs'), module); compiled.paths = module.paths;
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  const render = (id, section) => renderToStaticMarkup(React.createElement(compiled.exports.RuntimesView, {
    runtimeManagers: [{ id, label: id, sections: [section] }], runtimeManagerId: id, runtimeSectionId: section.id, runtimeUi: {}, downloadTasks: [],
    downloadsOpen: false, setDownloadsOpen() {}, setRuntimeManagerId() {}, setRuntimeSectionId() {}, updateRuntimeUiSection() {},
    onRuntimeRefresh() {}, onRuntimeInstall() {}, onRuntimeSetDefault() {}, onRuntimeUninstall() {}, onCancelDownload() {} }));
  const wine = render('sikarugir', { id: 'default', label: 'Sikarugir', versionLabels: { engine: 'Wine 10.0_8 · Template 1.0.24' },
    installed: [{ version: 'engine', ready: true, componentSummary: 'D3DMetal 4.0b3 · DXVK 1.10.3 async (dxvk)' }], catalog: { versions: [] } });
  assert.match(wine, /data-runtime-components="true">Includes D3DMetal 4\.0b3 · DXVK 1\.10\.3 async \(dxvk\)</);
  const listed = 'template-Template-1.0.27', contents = 'The D3DMetal version in this Template release is known after download.';
  const metal = render('translator-d3dmetal', { id: 'default', label: 'D3DMetal', installed: [], versionLabels: { [listed]: 'Template 1.0.27 · d3dmetal' },
    catalog: { status: 'success', versions: [listed], installableVersions: [listed], installable: true, versionLabels: { [listed]: 'Template 1.0.27 · d3dmetal' },
      versionRequirements: { [listed]: { contents } } } });
  assert.match(metal, new RegExp(`data-runtime-contents="true">${contents.replace(/\./g, '\\.')}<`));
  const installedMetal = render('translator-d3dmetal', { id: 'default', label: 'D3DMetal', installed: [{ version: listed, ready: true }],
    catalog: { status: 'success', versions: [listed], installableVersions: [listed], installable: true, versionRequirements: { [listed]: { contents } } } });
  assert.doesNotMatch(installedMetal, /data-runtime-contents/, 'an installed version shows its own component version instead');
});

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const D = require('../src/modules/shared/runtime/translator-description');
const Labels = require('../src/modules/shared/runtime/translator-label');
const Wine = require('../src/modules/shared/runtime/wine-translators');
const Component = require('../src/modules/shared/runtime/component-runtime');
const Main = require('../src/modules/crossover/main');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');

test('included reader, runtime references and per-game choices share component versions and one actual host phrase', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-label-connection-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  };
  const builtin = () => {
    const fixture = peFixture({ is64: true }); fixture.bytes.writeUInt16LE(0x2002, fixture.peOffset + 22);
    fixture.bytes.write('Wine builtin DLL\0', 64); return fixture.bytes;
  };
  const hosts = new Map();
  for (const runtime of ['crossover', 'sikarugir']) {
    const wine = path.join(root, runtime, 'wine'), support = path.join(root, runtime, 'support');
    const executablePath = put(`${runtime}/wine/bin/wine`, image({ cpu: X64, fileType: 2 }));
    put(`${runtime}/wine/lib/wine/x86_64-unix/ntdll.so`, image({ cpu: X64, symbols: ['wine_unix_call'] }));
    const install = { ready: true, engineRoot: wine, installDir: wine, executablePath, architecture: 'x64',
      ...(runtime === 'crossover' ? { crossoverRoot: wine, upstreamVersion: '26.3', version: '26.3-installed' } :
        { templateRoot: support, engineVersion: '10.0_8', version: '10.0_8-template-1.0.24', catalogEntry: { template: { version: '1.0.24' } } }) };
    const renderer = runtime === 'crossover' ? `${runtime}/wine/lib/dxvk` : `${runtime}/support/Frameworks/renderer/dxvk`;
    put(renderer + '/x86_64-windows/d3d11.dll', builtin());
    const video = runtime === 'crossover' ? `${runtime}/wine/lib64/gstreamer-1.0` : `${runtime}/support/Frameworks/GStreamer.framework/Versions/1.0/lib/gstreamer-1.0`;
    put(video + '/libgstfixture.dylib', image({ cpu: X64, symbols: ['gst_plugin_fixture_get_desc'] }));
    if (runtime === 'crossover') {
      put(`${runtime}/wine/changelog.html`, '<p>Update to DXVK 1.10.3.</p>'); put(video + '/version', '1.26.10');
    } else {
      put(renderer + '/version', 'DXVK-Sikarugir-async-v1.10.3\nD9VK-Sikarugir-v2.3\n');
      put(`${runtime}/support/Frameworks/GStreamer.framework/Versions/1.0/Resources/Info.plist`,
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundlePackageType</key><string>FMWK</string><key>CFBundleShortVersionString</key><string>1.26.11</string></dict></plist>');
      assert.equal(install.templateVersion, undefined, 'the actual catalog Template fact supplies the host version');
    }
    hosts.set(runtime, install);
  }
  // References list the hosts in each runtime's Runtimes state.
  const registry = require('../src/modules/registry'), managers = [...hosts].map(([runtime, install]) => ({
    id: `label-${runtime}`, getState: () => ({ installed: [install] })
  }));
  t.mock.method(registry, 'getModule', id => id === 'crossover' ? { manifest: { runtime: { manager: {
    crossover: 'label-crossover', sikarugir: 'label-sikarugir' } } }, runtimeManagers: managers } : null);
  const referenceOptions = { userDataDir: path.join(root, 'profile'), logger: { warn() {} } };
  // Local state preparation inspects the included copies that status then reads.
  for (const engine of ['dxvk', 'gstreamer']) await Component.withIncludedReferences({ translatorEngine: engine }).prepareLocalState(referenceOptions);
  const references = new Map(['dxvk', 'gstreamer'].map(engine => [engine, Component.includedReferences(engine, referenceOptions)]));
  for (const [runtime, install] of hosts) {
    const included = Wine.includedTranslators(install, runtime), dxvk = included.included.find(item => item.engine === 'dxvk'), video = included.included.find(item => item.engine === 'gstreamer');
    const hostPhrase = runtime === 'crossover' ? 'CrossOver 26.3' : 'Sikarugir Template 1.0.24';
    const expectedDxvk = `${runtime === 'crossover' ? 'DXVK 1.10.3' : 'DXVK 1.10.3 async'} · ${hostPhrase}`;
    const expectedVideo = `GStreamer ${runtime === 'crossover' ? '1.26.10' : '1.26.11'} · ${hostPhrase}`;
    assert.equal(D.label(dxvk), expectedDxvk); assert.equal(D.label(video), expectedVideo);
    assert.equal(D.label(dxvk), Labels.label(dxvk, install)); assert.equal(D.label(video), Labels.label(video, install));
    const context = { runtimeId: runtime, runtimeSettings: { translatorRenderer: dxvk.id }, settings: {}, userDataDir: path.join(root, 'profile'), logger: { warn() {} } };
    const options = await Main.__test.translatorOptions({ runtimeId: runtime }, {}, context,
      { runtimeManager: { resolveSelection: () => ({ ready: true, install }) }, managers: [], host: { macOSVersion: '26.0', physicalAppleGPU: false } });
    assert.equal(options.translatorRendererOptions.find(option => option.value === dxvk.id).label, expectedDxvk);
    assert.equal(options.translatorD3D11Options.find(option => option.value === dxvk.id).label, expectedDxvk);
    assert.equal(options.translatorVideoOptions.find(option => option.value === video.id).label, expectedVideo);
    for (const description of [dxvk, video]) {
      const reference = references.get(description.engine).find(row => row.installDir === description.root);
      assert.ok(reference); assert.equal(reference.versionLabel, D.label(description));
      assert.equal(reference.versionLabel.split(hostPhrase).length - 1, 1);
      assert.doesNotMatch(reference.versionLabel, /[\r\n]|DXVK DXVK|10\.0_8|26\.3.*26\.3/);
    }
  }
});

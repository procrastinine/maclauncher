// Required first: it replaces the network functions before modules load.
const Harness = require('./helpers/future-upstream.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { react } = require('./helpers/renderer-component');

let RuntimesView, runtimeSharedInstallReason;
test.before(async () => {
  const { build } = require('vite');
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, 'runtime-tabs-components.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'runtime-shared-install-reason-components.cjs'), module);
  compiled.paths = module.paths;
  compiled.require = id => id === 'react' ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  ({ RuntimesView, runtimeSharedInstallReason } = compiled.exports);
});

const REPOSITORY = 'gauthierpiarrette/highball-engine';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function release(tag) {
  const name = `${tag}.tar.gz`, archive = Buffer.from(`archive ${tag}`), sum = Buffer.from(`${sha(archive)}  ${name}\n`);
  const asset = (file, bytes) => ({ name: file, size: bytes.length, id: file.length, digest: `sha256:${sha(bytes)}`,
    browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${file}` });
  return { tag_name: tag, prerelease: false, published_at: '2026-11-12T00:00:00Z', assets: [asset(name, archive), asset(`${name}.sha256`, sum)] };
}
function routes(releases) {
  const result = { [`https://api.github.com/repos/${REPOSITORY}/releases`]: releases,
    [`https://api.github.com/repos/${REPOSITORY}/tags`]: releases.map(row => ({ name: row.tag_name, commit: { sha: 'a'.repeat(40) } })) };
  for (const row of releases) result[`https://api.github.com/repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(row.tag_name)}`] = { object: { type: 'commit', sha: 'a'.repeat(40) } };
  return result;
}
// The Windows module's own presentation of the source: a tab of the Wine entry of each CPU.
const managerUi = () => require('../src/modules/crossover/sources/settings').withSources(require('../src/modules/crossover/manifest.json')).runtime.managerUi['highball-wine'];
function render(state) {
  const noNetwork = () => { throw new Error('Rendering must not request a runtime or source URL'); };
  return renderToStaticMarkup(React.createElement(RuntimesView, {
    runtimeManagers: [{ id: 'highball-wine', label: 'Highball Wine', ui: managerUi(), ...state }], runtimeUi: {}, runtimeManagerId: 'highball-wine',
    runtimeSectionId: 'default', downloadTasks: [], downloadsOpen: false, setDownloadsOpen() {}, setRuntimeManagerId() {},
    setRuntimeSectionId() {}, updateRuntimeUiSection() {}, onRuntimeRefresh: noNetwork, onRuntimeInstall: noNetwork,
    onRuntimeSetDefault() {}, onRuntimeUninstall() {}, onCancelDownload() {}, onOpenSource: noNetwork }));
}

// GUI 0877 R28: Highball Wine on Apple Silicon listed every version as "· Unavailable" beside a disabled Install,
// each for the same reason, the Highball application its builds run through not being installed.
test('a source whose every version shares one reason states it once, without unavailable versions or a disabled Install (GUI 0877 R28)', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-shared-reason-')));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); Harness.network.routes = null; });
  const applications = path.join(root, 'Applications'), userDataDir = path.join(root, 'profile');
  const manager = require('../src/runtime-adapters/wine-release').createManager('highball-wine', { dependencies: { applicationDirectories: [applications] } });
  const tags = ['engine-arm64-wine-11.18-20261108T132317Z-spatial-0056-0057', 'engine-arm64-wine-11.18-20261104T130327Z-arm64-games-0053-0054',
    'engine-arm64-wine-11.18-20261015T181931Z-arm64-r1', 'engine-wine-11.0-20261112T101620Z-gst-rpath-0030'];
  Harness.network.routes = routes(tags.map(release));
  await manager.refreshCatalog({ userDataDir, force: true });
  const state = manager.getState({ userDataDir, componentSummaries: false });
  // The snapshot's shape: every build listed, none installable; the arm64 builds share the loader reason and the
  // Intel build has its own.
  const arm = state.catalog.versions.filter(version => state.catalog.versionRequirements[version].architecture === 'arm64');
  const intel = state.catalog.versions.filter(version => state.catalog.versionRequirements[version].architecture === 'x64');
  assert.equal(arm.length, 3); assert.equal(intel.length, 1);
  assert.deepEqual(state.catalog.installableVersions, []);
  for (const version of arm)
    assert.equal(state.catalog.versionRequirements[version].installReason, `Highball Wine ${version} runs through Highball, which is not installed.`);
  assert.equal(runtimeSharedInstallReason(state.catalog, state.catalog.versions), null, 'the two CPUs\' reasons differ');
  assert.equal(runtimeSharedInstallReason(state.catalog, intel),
    'Highball Wine needs the GStreamer and FFmpeg libraries Highball installs beside it, which its download does not include.');
  // Wine · Apple Silicon, the entry the source opens in on this Mac, lists the arm64 builds.
  const markup = render(state);
  assert.match(markup, /Wine · Apple Silicon/);
  assert.equal((markup.match(/Highball Wine runs through Highball, which is not installed\./g) || []).length, 1, 'the reason reads once');
  assert.match(markup, /<span class="dim runtimeAvailability" data-runtime-shared-reason="true">Highball Wine runs through Highball, which is not installed\.<\/span>/);
  assert.doesNotMatch(markup, /Unavailable/, 'no version reads as unavailable');
  assert.doesNotMatch(markup, /<select[^>]*aria-label="Version"/, 'no menu of versions that cannot install');
  assert.doesNotMatch(markup, /class="btn small primary"[^>]*>Install|disabled=""[^>]*>Install</, 'no disabled Install');
  assert.match(markup, /class="btn small iconOnly runtimeRefresh"/, 'the source keeps its reload control');
  // Once the application is installed the builds install, and the menu returns.
  fs.mkdirSync(path.join(applications, 'Highball.app/Contents/Helpers/WineLoader.app/Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(applications, 'Highball.app/Contents/Helpers/WineLoader.app/Contents/MacOS/wine'), '#!/bin/sh\n', { mode: 0o755 });
  const ready = manager.getState({ userDataDir, componentSummaries: false });
  assert.deepEqual([...ready.catalog.installableVersions].sort(), [...arm].sort());
  const readyMarkup = render(ready);
  assert.match(readyMarkup, /<select[^>]*aria-label="Version"/);
  assert.doesNotMatch(readyMarkup, /data-runtime-shared-reason/);
});

test('reasons that differ, or an installed or installable version, keep the per-version menu', () => {
  const catalog = { installableVersions: [], versionRequirements: { a: { installReason: 'Engine a needs macOS 27.' }, b: { installReason: 'Engine b runs through Loader, which is not installed.' } } };
  assert.equal(runtimeSharedInstallReason(catalog, ['a', 'b']), null);
  const same = { installableVersions: [], versionRequirements: { a: { installReason: 'Engine a runs through Loader, which is not installed.' }, b: { installReason: 'Engine b runs through Loader, which is not installed.' } } };
  assert.equal(runtimeSharedInstallReason(same, ['a', 'b']), 'Engine runs through Loader, which is not installed.');
  assert.equal(runtimeSharedInstallReason(same, ['a', 'b'], ['b']), null);
  assert.equal(runtimeSharedInstallReason({ ...same, installableVersions: ['a'] }, ['a', 'b']), null);
});

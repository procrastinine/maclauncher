const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { build } = require('vite');
let GameDetails, PlayButton, GameActions;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: true, write: false,
    rollupOptions: { input: path.resolve('src/renderer/src/ui/components/GameDetails.tsx'),
      external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs' } }
  } });
  const compiled = new Module(path.join(__dirname, 'inspection-components.cjs'), module);
  compiled.paths = module.paths;
  compiled._compile(bundle.output.find(c => c.type === 'chunk').code, compiled.id);
  GameDetails = compiled.exports.GameDetails;
  const actionsBundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: true, write: false, rollupOptions: { input: path.resolve('src/renderer/src/ui/components/GameActions.tsx'),
      external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs' } }
  } });
  compiled._compile(actionsBundle.output.find(c => c.type === 'chunk').code, compiled.id);
  PlayButton = compiled.exports.PlayButton;
  GameActions = compiled.exports.GameActions;
});
function inspector(launch, data = {}) {
  const state = require('./library-layout-fixture').createLibraryFixture();
  const g = { ...state.recents[0], moduleData: data, moduleSupports: { ...state.recents[0].moduleSupports, launch } };
  return renderToStaticMarkup(React.createElement(GameDetails, {
    g, state, moduleInfo: state.modules[0], actions: {}, moduleActionResults: {}, moduleActionBusy: {}
  }));
}
test('inspection retains tools, runtime choice and notes while omitting launch, saves and graphics', () => {
  const markup = inspector(false, { inspectionReason: 'Encrypted package: import a decrypted game folder to play.' });
  assert.match(markup, /Encrypted package: import a decrypted game folder to play/);
  assert.match(markup, /aria-label="Runtime"/);
  assert.match(markup, /Extract/);
  assert.match(markup, /Notes/);
  assert.doesNotMatch(markup, />Launch<|Launch arguments|Network access|>Saves<|Save tools|Edit saves|Create shortcut…|title="Save a \.command|>Graphics<|Frame generation|aria-label="Play /);
});
test('launchable inputs retain launch, save and graphics controls even without an installed runtime', () => {
  const markup = inspector(true);
  assert.match(markup, /aria-label="Play Alpha"/);
  assert.match(markup, /Launch arguments/);
  assert.match(markup, /Network access/);
  assert.match(markup, />Saves</);
  assert.match(markup, /title="Save a \.command file[^>]*>Create shortcut…<\/button>/);
  assert.match(markup, /Graphics/);
});
test('inspection reason uses existing format metadata, with a useful fallback for unknown formats', () => {
  assert.match(inspector(false, { compatibility: 'A macOS export is needed.' }), /A macOS export is needed/);
  assert.match(inspector(false), /Select a compatible runtime or import a supported game export to play/);
  const row = renderToStaticMarkup(React.createElement(PlayButton, {
    g: { name: 'Input', gamePath: '/input', moduleSupports: { launch: false }, moduleData: { compatibility: 'A macOS export is needed.' } }
  }));
  assert.match(row, /class="detailMeta gameInspectionNotice"/);
  assert.match(row, /title="Game input: A macOS export is needed\."/);
});
test('a running or preparing game retains Stop or Cancel after capability changes', () => {
  const g = { name: 'Input', gamePath: '/input', moduleSupports: { launch: false } };
  const render = props => renderToStaticMarkup(React.createElement(PlayButton, { g, ...props }));
  assert.match(render({ isRunning: true }), /aria-label="Stop Input"/);
  assert.match(render({ preparation: { phase: 'prepare' } }), /aria-label="Cancel Input"/);
});
test('a session entry lists what it applies to, and the last remove button says it ends the session', () => {
  const state = require('./library-layout-fixture').createLibraryFixture();
  const render = sessionTargets => renderToStaticMarkup(React.createElement(GameDetails, {
    g: { ...state.recents[0], ephemeral: true, sessionTargets }, state, moduleInfo: state.modules[0], actions: {}, moduleActionResults: {}, moduleActionBusy: {}
  }));
  const several = render([{ id: 'w3', label: 'Document', detail: 'TextEdit' }, { id: 'd1', label: 'Studio Display', detail: 'Display' }]);
  assert.match(several, />Applied to</);
  assert.match(several, /aria-label="Remove Document \(TextEdit\)"/);
  assert.match(several, /aria-label="Remove Studio Display \(Display\)"/);
  assert.match(render([{ id: 'w3', label: 'Document' }]), /aria-label="Remove Document and end the session"/);
});
test('a Play notice stays as its own line under the changing preparation status', () => {
  const g = { name: 'Input', gamePath: '/input', moduleSupports: { launch: true } };
  const notice = 'No KosmicKrisp (Intel) version is available to download. Using MoltenVK.';
  const render = preparation => renderToStaticMarkup(React.createElement(GameActions, { g, isRunning: false, actions: {}, inspector: true, preparation }));
  const installing = render({ phase: 'install', label: 'Installing MoltenVK…', percent: 40, notice });
  assert.match(installing, /class="gameLaunchStatus" role="status"[^>]*>Installing MoltenVK… · 40%</);
  assert.match(installing, /<span class="gameLaunchFallback" role="status">No KosmicKrisp \(Intel\) version is available to download\. Using MoltenVK\.<\/span>/);
  assert.doesNotMatch(render({ phase: 'install', label: 'Installing MoltenVK…', percent: 40 }), /gameLaunchFallback/);
});
test('Play preparation shows converted modules of the total and the installation step after a download', () => {
  const g = { name: 'Input', gamePath: '/input', moduleSupports: { launch: true } };
  const render = preparation => renderToStaticMarkup(React.createElement(GameActions, { g, isRunning: false, actions: {}, inspector: true, preparation }));
  const converting = render({ phase: 'prepare', label: 'Converting PS5 program…', completed: 3, total: 10, unit: 'modules', step: 'Instruction scan · PS5Util.prx' });
  assert.match(converting, /role="status" title="Instruction scan · PS5Util\.prx">Converting PS5 program… 3 \/ 10 modules</);
  assert.match(converting, /<progress aria-label="Converting PS5 program…" max="10" value="3"/);
  const extracting = render({ phase: 'install', label: 'Installing AnyPS5…', step: 'Extracting files…' });
  assert.match(extracting, />Installing AnyPS5… · Extracting files…</);
  assert.doesNotMatch(extracting, /100%/);
});

function inspect(moduleId, game = {}) {
  const state = require('./library-layout-fixture').createLibraryFixture();
  const moduleInfo = require('../src/modules/registry').getModuleInfo(moduleId);
  const g = { ...state.recents[0], moduleId, moduleData: {}, runtimeData: {}, moduleRuntimeSupport: moduleInfo.runtime.supported,
    moduleSupports: { ...state.recents[0].moduleSupports, launch: true }, ...game };
  return renderToStaticMarkup(React.createElement(GameDetails, {
    g, state: { ...state, modules: [moduleInfo] }, moduleInfo, actions: {}, moduleActionResults: {}, moduleActionBusy: {}
  }));
}
const menu = (markup, label) => {
  const select = new RegExp(`<select[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)</select>`).exec(markup);
  return select && [...select[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)</g)].map(match => [match[1], match[2]]);
};
test('the Wine sources share one Wine runtime entry, and a Wine row picks the source', () => {
  const markup = inspect('unity', { runtimeId: 'sikarugir', nativeAppPath: null });
  assert.deepEqual(menu(markup, 'Runtime').map(([, label]) => label), ['Unity Mono player', 'Wine'], 'Game\'s macOS app needs an app bundle');
  assert.match(markup, /<option value="group:Wine" selected="">Wine<\/option>/);
  assert.deepEqual(menu(markup, 'Wine'), [['crossover', 'CrossOver'], ['sikarugir', 'Sikarugir'], ['winecx', 'WineCX'],
    ['highball-wine', 'Highball Wine'], ['metalsharp-wine', 'MetalSharp Wine']]);
  assert.match(markup, /<option value="sikarugir" selected="">Sikarugir<\/option>/);
  const own = inspect('unity', { runtimeId: 'unity' });
  assert.equal(menu(own, 'Wine'), null, 'a runtime outside the group has no Wine row');
  assert.match(own, /<option value="unity" selected="">Unity Mono player<\/option>/);
  const saved = inspect('unity', { runtimeId: 'crossover', moduleRuntimeSupport: ['unity', 'sikarugir'] });
  assert.deepEqual(menu(saved, 'Wine'), [['crossover', 'CrossOver (saved; incompatible input)'], ['sikarugir', 'Sikarugir']]);
});
test('Ren\'Py offers game Live2D tools with Ren\'Py Patch and shows the SDK version\'s Live2D with the SDK', () => {
  const live2d = { ready: true, owned: true, version: '5-r.5', label: 'Live2D', summary: 'Cubism 5-r.5', note: 'Managed in Runtimes.' };
  const runtimeManagers = { sdk: { id: 'sdk', label: "Ren'Py", sections: [{ id: 'v8', label: "Ren'Py 8", defaultVersion: '8.5.3',
    installed: [{ version: '8.5.3', ready: true, libraries: { live2d } }, { version: '8.5.2', ready: true, libraries: { live2d: { ready: false, label: 'Live2D' } } }],
    catalog: { versions: ['8.5.3', '8.5.2'] } }] } };
  const state = require('./library-layout-fixture').createLibraryFixture();
  const moduleInfo = require('../src/modules/registry').getModuleInfo('renpy');
  const render = (runtimeId, extra = {}) => renderToStaticMarkup(React.createElement(GameDetails, {
    g: { ...state.recents[0], moduleId: 'renpy', runtimeId, moduleRuntimeSupport: moduleInfo.runtime.supported,
      moduleData: { major: 8 }, runtimeData: {}, moduleSupports: { ...state.recents[0].moduleSupports, launch: true }, ...extra },
    state: { ...state, runtimeManagers }, moduleInfo, actions: {}, moduleActionResults: {}, moduleActionBusy: {},
    runtimeAutomaticEntry: { runtimeId, value: { managerId: 'sdk', version: '8.5.3' } } }));
  const patched = render('patched');
  assert.match(patched, /<span>Live2D<\/span>/);
  assert.match(patched, /aria-label="Install Live2D library"/);
  assert.doesNotMatch(patched, /aria-label="Remove Live2D library"/);
  const installed = render('patched', { moduleData: { major: 8, live2dInstalled: true } });
  assert.match(installed, /aria-label="Remove Live2D library"/);
  assert.doesNotMatch(installed, /aria-label="Install Live2D library"/);
  const sdk = render('sdk', { runtimeData: { sdk: { version: '8.5.3' } } });
  assert.doesNotMatch(sdk, /Install Live2D library|Remove Live2D library|Live2D status/);
  assert.match(sdk, /<div class="detailValue">Cubism 5-r\.5<\/div>/);
  assert.match(sdk, /About Live2D/);
  assert.match(render('sdk', { runtimeData: { sdk: { version: '8.5.2' } } }), /<div class="detailValue">Not installed<\/div>/);
  assert.match(render('sdk', { runtimeData: { sdk: { version: '8.5.3' } }, moduleData: { major: 8, live2dInstalled: true } }),
    /aria-label="Remove Live2D library"/, 'a game library stays removable with the SDK');
});

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { build } = require('vite');
let GameDetails, PlayButton;
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
  assert.doesNotMatch(markup, />Launch<|Launch arguments|Network access|>Saves<|Save tools|Edit saves|Save \.command|>Graphics<|Frame generation|aria-label="Play /);
});
test('launchable inputs retain launch, save and graphics controls even without an installed runtime', () => {
  const markup = inspector(true);
  assert.match(markup, /aria-label="Play Alpha"/);
  assert.match(markup, /Launch arguments/);
  assert.match(markup, /Network access/);
  assert.match(markup, />Saves</);
  assert.match(markup, /Save \.command/);
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

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { build } = require('vite');
const { react, componentHarness } = require('./helpers/renderer-component');
let ReShadeControls;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, '../src/renderer/src/ui/components/ReShadeControls.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'reshade-controls.cjs'), module);
  compiled.paths = module.paths;
  compiled.require = id => id === 'react' ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  ({ ReShadeControls } = compiled.exports);
});
const presets = [{ id: 'crt', label: 'CRT' }, { id: 'vibrance', label: 'Colour' }, { id: 'sharpen', label: 'Sharpen' }, { id: 'custom', label: 'Custom effect' }];
function props(overrides = {}) {
  return { game: { gamePath: '/Games/Example.app' }, status: { available: true, presets }, running: false,
    onChange: () => assert.fail('Rendering must not save options'), onChooseEffect: () => assert.fail('Rendering must not open a picker'), ...overrides };
}
function render(overrides) { return renderToStaticMarkup(React.createElement(ReShadeControls, props(overrides))); }
function component(options) { return componentHarness(ReShadeControls, options).render(); }
function elements(element) {
  return React.isValidElement(element) ? [element, ...React.Children.toArray(element.props.children).flatMap(elements)] : [];
}
test('parameter writes bind the original saved shader identity independently of displayed managed aliases', async () => {
  const writes = [], original = {enabled: true, preset: 'pack:sweetfx:old:tonemap', effectPath: null, effects: null},
    game = {gamePath: '/Game', reshade: original}, options = props({game, status: {available: true, shaderParameters: true,
      presets: [{id: 'shader:sweetfx:tonemap', label: 'Tone map', available: true}]}, onChange: async (...args) => writes.push(args)});
  const harness = componentHarness(ReShadeControls, options);
  try {
    const tree = harness.render(), parameters = elements(tree).find(node => node.props.settings === original && typeof node.props.onChange === 'function');
    assert.ok(parameters);assert.equal(elements(tree).find(node => node.props.id === 'game-reshade-preset').props.value, 'shader:sweetfx:tonemap');
    await parameters.props.onChange('/Game', {parameters: {Strength: [.2]}});
    assert.deepEqual(writes[0], ['/Game', {parameters: {Strength: [.2]}}, {preset: 'pack:sweetfx:old:tonemap', effectPath: null, effects: null}]);
    await elements(tree).find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({target: {checked: false}});
    assert.deepEqual(writes[1], ['/Game', {enabled: false}], 'ordinary toggles keep their existing optional-free contract');
  } finally {harness.close();}
});
test('existing shader selections and custom effects remain available without a shader-management route', () => {
  const status = { available: true, presets: [...presets,
    { id: 'pack:sweetfx:123:tonemap', label: 'SweetFX · Tonemap', installed: true, available: true },
    { id: 'pack:quint:123:mxao', label: 'qUINT · MXAO', installed: true, available: false, reason: 'Requires game depth.' }] };
  const game = { gamePath: '/Games/Example.app', reshade: { enabled: true, preset: 'pack:sweetfx:123:tonemap' } };
  const markup = render({ status, game });
  assert.match(markup, /<section class="graphicsGroup" aria-label="Shaders and filters"><div class="graphicsGroupHeader"><div class="graphicsGroupTitle"><h4 class="detailSectionHeading">Shaders and filters/);
  assert.match(markup, /<div class="graphicsGroupActions"><label class="inlineCheck">.*Enable<\/label><button class="btn small">Manage effects…<\/button><\/div><\/div>/);
  assert.doesNotMatch(markup, /<div class="detailLabel">Effects<\/div>/);
  assert.match(markup, /value="pack:sweetfx:123:tonemap" selected=""/);
  assert.match(markup, /value="pack:quint:123:mxao" disabled="" title="Requires game depth\."/);
  assert.match(markup, /value="custom"/);
  assert.match(markup, /Included effects are available offline/);
  assert.match(markup, /Custom shader accepts ReShade \.fx, RetroArch \.slangp or \.slang, and MPV\/libplacebo \.glsl or \.hook files/);
  assert.doesNotMatch(markup, /Shader packs|Download|Runtimes/);
  const nodes = elements(component(props({ status, game: { ...game, reshade: { enabled: true, preset: 'chain', effects: ['crt', 'sharpen'] } } })));
  const chain = nodes.find(node => node.props['aria-label'] === 'ReShade effect 1');
  assert.ok(chain); assert.equal(elements(chain).some(node => String(node.props.value).startsWith('pack:')), false);
});
test('included shader resources stay selectable offline and preserve per-game effect updates', async () => {
  const saved = [];
  const options = props({ game: { gamePath: '/Games/Offline effects', reshade: { enabled: true, preset: 'shader:sweetfx:tonemap' } },
    status: { available: true, presets: [...presets, { id: 'shader:sweetfx:tonemap', label: 'SweetFX · Tonemap', installed: true, bundled: true, available: true }] },
    onChange: async (...args) => saved.push(args) });
  const markup = render(options);
  assert.match(markup, /value="shader:sweetfx:tonemap" selected=""/);
  assert.doesNotMatch(markup, /Shader packs|Download|Install|Runtimes/);
  const select = elements(component(options)).find(node => node.props['aria-label'] === 'Shader or filter preset');
  await select.props.onChange({ target: { value: 'sharpen' } });
  assert.deepEqual(saved, [['/Games/Offline effects', { preset: 'sharpen' }]]);
});
test('selecting Custom shader picks before saving, cancels without changes and reports picker failures', async () => {
  const saved = [], picked = [];
  const game = { gamePath: '/Games/Imported shader', reshade: { enabled: true, preset: 'filter:existing', effectPath: '/Effects/Old.fx', parameters: { Strength: [0.3] } } };
  const before = structuredClone(game), options = props({ game, onChange: async (...args) => saved.push(args) });
  const previousWindow = global.window;
  let complete;
  global.window = { MacLauncher: { launcher: {
    pickGameEffectFile: path => { picked.push(path);return new Promise(resolve => { complete = resolve; }); },
    pickGameReShadeEffect: () => assert.fail('Use the read-only picker, not the mutating legacy picker')
  } } };
  const harness = componentHarness(ReShadeControls, options);
  const selector = () => elements(harness.render()).find(node => node.props.id === 'game-reshade-preset');
  try {
    const pending = selector().props.onChange({ target: { value: 'custom' } });
    assert.equal(selector().props.disabled, true);assert.equal(selector().props.value, 'filter:existing');
    assert.deepEqual(saved, []);complete(null);await pending;
    assert.equal(selector().props.disabled, false);assert.deepEqual(saved, []);
    const chosen = selector().props.onChange({ target: { value: 'custom' } });
    complete('/Shaders/CRT Royale.slangp');await chosen;
    assert.deepEqual(saved, [[game.gamePath, { preset: 'custom', effectPath: '/Shaders/CRT Royale.slangp', parameters: null }]]);
    assert.deepEqual(picked, [game.gamePath, game.gamePath]);assert.deepEqual(game, before);
    global.window.MacLauncher.launcher.pickGameEffectFile = async () => { throw new Error('The shader file cannot be read.'); };
    await selector().props.onChange({ target: { value: 'custom' } });
    assert.match(renderToStaticMarkup(harness.render()), /role="alert">The shader file cannot be read\./);
    assert.equal(saved.length, 1);assert.equal(selector().props.value, 'filter:existing');
    global.window.MacLauncher.launcher = {};
    await selector().props.onChange({ target: { value: 'custom' } });
    assert.match(renderToStaticMarkup(harness.render()), /Shader selection is unavailable\./);assert.equal(saved.length, 1);
  } finally { harness.close();global.window = previousWindow; }
});
test('saved pack aliases display the matching included shader without changing settings or hiding unavailable effects', () => {
  const game = { gamePath: '/Games/Existing effects', reshade: { enabled: true, preset: 'pack:sweetfx:123:tonemap' } };
  const status = { available: true, presets: [...presets, { id: 'shader:sweetfx:tonemap', label: 'SweetFX · Tonemap', installed: true, available: true }] };
  const markup = render({ game, status });
  assert.match(markup, /value="shader:sweetfx:tonemap" selected=""/);
  assert.doesNotMatch(markup, /Unavailable preset/);
  assert.equal(game.reshade.preset, 'pack:sweetfx:123:tonemap');
  const unsupported = render({ game, status: { ...status, presets: [...presets, { ...status.presets.at(-1), available: false, reason: 'Requires a supported shader compiler.' }] } });
  assert.match(unsupported, /value="shader:sweetfx:tonemap" disabled=""[^>]*selected=""/);
  assert.match(unsupported, /Requires a supported shader compiler/);
  const missing = render({ game, status: { available: true, presets } });
  assert.match(missing, /value="pack:sweetfx:123:tonemap" disabled=""[^>]*selected="">Unavailable preset/);
});
test('imported filters retain preset selection and refresh parameter controls only when their file changes', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const status = { available: true, shaderParameters: true, presets: [...presets,
    { id: 'filter:' + id, label: 'Colour tuning.fx', installed: true, available: true }],
    filters: [{ id, name: 'Colour tuning.fx', path: '/Effects/Original.fx', available: true }] };
  const options = props({ status, graphicsHost: 'window', game: { gamePath: '/Games/Shared filter', reshade: { enabled: true, preset: 'filter:' + id } } });
  assert.match(render(options), new RegExp(`value="filter:${id}" selected=""`));
  const parameterKey = values => elements(component(values)).find(node => node.type.name === 'ShaderParameters').key;
  const originalKey = parameterKey(options);
  const renamed = { ...options, status: { ...status, filters: [{ ...status.filters[0], name: 'Renamed filter' }] } };
  assert.equal(parameterKey(renamed), originalKey);
  const replaced = { ...options, status: { ...status, filters: [{ ...status.filters[0], path: '/Effects/Replacement.fx' }] } };
  assert.notEqual(parameterKey(replaced), originalKey);
  const chain = elements(component({ ...options, game: { ...options.game, reshade: { enabled: true, preset: 'chain', effects: ['crt', 'sharpen'] } } }))
    .find(node => node.props['aria-label'] === 'ReShade effect 1');
  assert.equal(elements(chain).some(node => String(node.props.value).startsWith('filter:')), false);
});
test('RetroArch selections show their format and retain the ordinary shader controls', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const status = { available: true, shaderParameters: true, presets: [...presets,
    { id: 'filter:' + id, label: 'CRT Royale', available: true, installed: true }],
    filters: [{ id, name: 'CRT Royale', path: '/Shaders/Alias.fx', format: 'slangp', available: true }] };
  const markup = render({ status, game: { gamePath: '/Games/Example.app', reshade: { enabled: true, preset: 'filter:' + id } } });
  assert.match(markup, /Shaders and filters/);assert.match(markup, /RetroArch preset · \.slangp/);
  assert.match(markup, /Shader parameters…/);assert.match(markup, new RegExp(`value="filter:${id}" selected=""`));
  const custom = render({ game: { gamePath: '/Games/Example.app', reshade: { enabled: true, preset: 'custom', effectPath: '/Shaders/Pass.slang' } } });
  assert.match(custom, /RetroArch shader · \.slang/);assert.match(custom, /Choose shader…/);
  assert.doesNotMatch(custom, /\.glslp|\.cgp/);
  const mpv = render({ game: { gamePath: '/Games/Example.app', reshade: { enabled: true, preset: 'custom', effectPath: '/Shaders/Resize.hook' } } });
  assert.match(mpv, /MPV\/libplacebo · \.glsl \/ \.hook/);
});
test('ReShade is opt-in and rendering never starts installation or effects', () => {
  const markup = render();
  assert.match(markup, /aria-label="Enable shaders and filters"/);
  assert.doesNotMatch(markup, /checked=""|Shader or filter preset|Download|Install|Runtimes/);
});
test('Manage effects opens Graphics settings without changing the selected game or starting a download', async () => {
  const previousWindow = global.window, opened = [];
  global.window = { MacLauncher: { launcher: { openUtilityWindow: async request => opened.push(request) } } };
  try {
    const button = elements(component(props())).find(node => node.type === 'button' && node.props.children === 'Manage effects…');
    await button.props.onClick();assert.deepEqual(opened, [{ view: 'settings', sectionId: 'graphics:filters' }]);
  } finally { global.window = previousWindow; }
});
test('explicit Android presentation exposes the same shader parameter controls', () => {
  const markup = render({ graphicsHost: 'explicit', status: { available: true, shaderParameters: true, presets },
    game: { gamePath: '/Games/Pixel game.apk', reshade: { enabled: true, preset: 'crt' } } });
  assert.match(markup, /Shader parameters…/);
});
test('effects placement reorders spatial processing independently of the shader chain', async () => {
  const saved = [];
  const game = { gamePath: '/Games/Effects', reshade: { enabled: true, preset: 'chain', effects: ['crt', 'sharpen'] }, graphics: { effectPlacement: 'after' } };
  const status = { ...props().status, graphics: { hosts: { window: { effectPlacement: true, liveSwitching: true }, remote: {} } } };
  const options = props({ game, status, graphicsHost: 'window', running: true, live: true, onGraphicsChange: async (...args) => saved.push(args) });
  const markup = render(options);
  assert.match(markup, /value="after" selected="">After spatial scaling/);
  assert.match(markup, /Spatial upscaling → Effects → Frame generation/);
  assert.match(markup, /Depth effects require Before spatial scaling/);
  assert.match(markup, /Effects placement updates during play/);
  const select = elements(component(options)).find(node => node.props.id === 'game-effect-placement');
  await select.props.onChange({ target: { value: 'before' } });
  assert.deepEqual(saved, [['/Games/Effects', { effectPlacement: 'before' }]]);
  assert.deepEqual(game.reshade.effects, ['crt', 'sharpen']);
  assert.match(render({ ...options, graphicsHost: 'remote' }), /value="after" disabled="" selected="">After spatial scaling · Unavailable/);
  assert.doesNotMatch(render({ ...options, graphicsHost: 'remote', game: { ...game, graphics: {} } }), /game-effect-placement/);
});
test('depth effects stay selectable for native windows and explain color-only hosts', () => {
  const status = { available: true, presets: [...presets, { id: 'pack:quint:123:ssr', label: 'qUINT · SSR', available: true, installed: true, depthHosts: ['window'] }] };
  const game = { gamePath: '/Games/Example.app', reshade: { enabled: true, preset: 'pack:quint:123:ssr' } };
  assert.match(render({ status, game, graphicsHost: 'window' }), /value="pack:quint:123:ssr" selected=""/);
  for (const graphicsHost of ['explicit', 'remote', undefined]) {
    const markup = render({ status, game, graphicsHost });
    assert.match(markup, /value="pack:quint:123:ssr" disabled=""/);
    assert.match(markup, /Requires game depth, which this presentation path does not provide\./);
  }
});
test('native video shaders use renderer availability while unavailable files and game choices stay restricted', () => {
  const native = { id: 'shader:video:chroma', label: 'Chroma interpolation', installed: true, nativeVideo: true,
    nativeVideoAvailable: true, available: false, reason: 'Requires native video luma or chroma inputs.' };
  const imported = { id: 'filter:planes', label: 'Local chroma', installed: true, traits: { requiresVideoPlanes: true },
    nativeVideoAvailable: true, available: false, reason: 'Requires native video luma or chroma inputs.' };
  const missing = { ...native, id: 'shader:video:missing', label: 'Missing source', nativeVideoAvailable: false, reason: 'The installed shader file is missing.' };
  const status = { available: true, shaderLiveSwitching: true, shaderParameters: true, presets: [...presets, native, imported, missing] };
  const game = { gamePath: '/Video/clip.mp4', reshade: { enabled: true, preset: native.id } };
  const graphicsInputs = { source: 'native-video', nativeVideo: true, shaderBindingsNextLaunch: true, cameraProjection: false, methods: [] };
  const markup = render({ game, status, graphicsHost: 'window', graphicsInputs, running: true });
  assert.match(markup, /value="shader:video:chroma" selected="">Chroma interpolation/);
  assert.match(markup, /value="filter:planes">Local chroma/);
  assert.match(markup, /value="shader:video:missing" disabled="" title="The installed shader file is missing\."/);
  assert.match(markup, /Video shader selections and parameters apply on the next launch\./);assert.doesNotMatch(markup, /Updates during play\./);
  const controls = elements(component(props({ game, status, graphicsInputs })));
  assert.equal(controls.find(node => node.type.name === 'ShaderParameters').props.live, false);
  const ordinary = render({ game: { ...game, reshade: { enabled: true, preset: 'crt' } }, status, graphicsHost: 'window' });
  assert.doesNotMatch(ordinary, /Chroma interpolation|Local chroma|Missing source/);
});
test('missing runtime explains availability but an enabled setting can still be turned off', () => {
  const status = { available: false, reason: 'ReShade is unavailable on this Mac.', presets };
  assert.match(render({ status }), /aria-label="Enable shaders and filters" disabled=""/);
  const enabled = render({ status, game: { gamePath: '/Games/Example.app', reshade: { enabled: true, preset: 'crt' } } });
  assert.match(enabled, /ReShade is unavailable on this Mac\./);
  assert.match(enabled, /aria-label="Enable shaders and filters" checked=""/);
  assert.match(enabled, /aria-label="Shader or filter preset" disabled=""/);
});
test('shader and placement controls catch propagated save failures locally', async () => {
  const harness = componentHarness(ReShadeControls, props({game: {gamePath: '/Game', reshade: {enabled: true, preset: 'crt'}},
    status: {...props().status, graphics: {effectPlacement: true}}, onChange: async () => {throw new Error('Shader save rejected.');},
    onGraphicsChange: async () => {throw new Error('Placement save rejected.');}}));
  try {
    elements(harness.render()).find(node => node.props['aria-label'] === 'Enable shaders and filters').props.onChange({target: {checked: false}});
    await harness.settle();assert.match(renderToStaticMarkup(harness.render()), /role="alert">Shader save rejected\./);
    elements(harness.render()).find(node => node.props.id === 'game-effect-placement').props.onChange({target: {value: 'after'}});
    await harness.settle();assert.match(renderToStaticMarkup(harness.render()), /role="alert">Placement save rejected\./);
  } finally {harness.close();}
});
test('Simple combinations keep shaders accessible and hide manual placement while ordinary shader flow stays unchanged', () => {
  const onGraphicsChange = () => assert.fail('Rendering must not change graphics');
  const status = {...props().status, graphics: {effectPlacement: true}};
  const game = {gamePath: '/Game', reshade: {enabled: true, preset: 'crt'}};
  const ordinary = render({status, game, onGraphicsChange});
  assert.match(ordinary, /id="game-effect-placement"/);assert.doesNotMatch(ordinary, /Effects use automatic order/);
  for (const graphics of [{neuralMethod: 'mlx-dlss'}, {frameGeneration: 'lsfg', frameMultiplier: 4}, {spatialMethod: 'fsr1'}, {temporalMethod: 'metalfx'}]) {
    const markup = render({status, game: {...game, graphics}, onGraphicsChange});
    assert.doesNotMatch(markup, /id="game-effect-placement"/);assert.match(markup, /Effects use automatic order/);
    assert.match(markup, /aria-label="Shader or filter preset"/);assert.match(markup, /value="crt" selected=""/);
  }
});
test('custom effects retain their filename and report the active host live behavior inside existing help', () => {
  const markup = render({ running: true, game: { gamePath: '/Games/Example.app', reshade: { enabled: true, preset: 'custom', effectPath: '/Effects/Colour tuning.fx' } } });
  assert.match(markup, />Colour tuning\.fx<\/div>/);
  assert.match(markup, /Choose shader…/);
  assert.match(markup, /Effect selection and order apply on the next launch\./);
  for (const graphicsHost of ['window', 'explicit']) {
    const live = render({ running:true, live:true, graphicsHost, status:{ ...props().status, shaderLiveSwitching:true },
      game:{ gamePath:'/Games/Example.app', reshade:{ enabled:true, preset:'crt' } } });
    assert.match(live, /Updates during play\./);
    assert.match(live, /aria-label="About shaders and filters"/);
    assert.match(live, /Updates during play\. Loading a different effect can briefly pause rendering/);
    assert.doesNotMatch(live, /Effect selection and order apply on the next launch/);
  }
});
test('an unbound current game keeps Simple parameter edits and status on the next launch', () => {
  const options = props({running: true, live: false, graphicsHost: 'window', status: {...props().status, shaderParameters: true, shaderLiveSwitching: true},
    game: {gamePath: '/Games/Unfiltered', reshade: {enabled: true, preset: 'crt'}}});
  assert.doesNotMatch(render(options), /Updates during play\./);
  assert.equal(elements(component(options)).find(node => node.type.name === 'ShaderParameters').props.live, false);
});
test('controls persist patches and choose files for the exact selected game without changing other options', async () => {
  const saved = [], picked = [];
  const options = props({ game: { gamePath: '/Games/Selected game', reshade: { enabled: true, preset: 'custom', effectPath: '/Effects/Original.fx' } },
    onChange: async (...args) => saved.push(args) });
  const previousWindow = global.window;
  global.window = { MacLauncher: { launcher: { pickGameEffectFile: async gamePath => { picked.push(gamePath);return '/Effects/Replacement.slangp'; } } } };
  try {
  const nodes = elements(component(options));
  await nodes.find(node => node.type === 'input').props.onChange({ target: { checked: false } });
  await nodes.find(node => node.type === 'select').props.onChange({ target: { value: 'sharpen' } });
  await nodes.find(node => node.type === 'button' && node.props.children === 'Choose shader…').props.onClick();
  assert.deepEqual(saved, [['/Games/Selected game', { enabled: false }], ['/Games/Selected game', { preset: 'sharpen' }],
    ['/Games/Selected game', { preset: 'custom', effectPath: '/Effects/Replacement.slangp', parameters: null }]]);
  assert.deepEqual(picked, ['/Games/Selected game']);
  } finally { global.window = previousWindow; }
});
test('combined effects keep visible order, bounded additions and independent game settings', async () => {
  const saved = [];
  const options = props({ game: { gamePath: '/Games/Combined', reshade: { enabled: true, preset: 'chain', effects: ['cas', 'crt', 'grayscale'] } },
    status: { available: true, presets: require('../src/modules/shared/reshade').PRESETS },
    onChange: async (...args) => saved.push(args) });
  const nodes = elements(component(options));
  const find = label => nodes.find(node => node.props['aria-label'] === label);
  assert.equal(find('Move effect 1 up').props.disabled, true);
  assert.equal(find('Move effect 3 down').props.disabled, true);
  assert.deepEqual(nodes.filter(node => node.type === 'select').map(node => node.props.value), ['chain', 'cas', 'crt', 'grayscale']);
  await find('Move effect 2 up').props.onClick();
  await find('Remove effect 2').props.onClick();
  await find('ReShade effect 1').props.onChange({ target: { value: 'vibrance' } });
  await nodes.find(node => node.type === 'button' && node.props.children === 'Add effect').props.onClick();
  assert.deepEqual(saved, [
    ['/Games/Combined', { effects: ['crt', 'cas', 'grayscale'] }],
    ['/Games/Combined', { effects: ['cas', 'grayscale'] }],
    ['/Games/Combined', { effects: ['vibrance', 'crt', 'grayscale'] }],
    ['/Games/Combined', { effects: ['cas', 'crt', 'grayscale', 'sharpen'] }]
  ]);
  for (const count of [2, 4]) {
    const bounded = elements(component({ ...options, game: { ...options.game, reshade: { enabled: true, preset: 'chain', effects: Array(count).fill('crt') } } }));
    if (count === 2) assert.ok(bounded.filter(node => String(node.props['aria-label']).startsWith('Remove effect')).every(node => node.props.disabled));
    else assert.ok(bounded.find(node => node.type === 'button' && node.props.children === 'Add effect').props.disabled);
  }
});

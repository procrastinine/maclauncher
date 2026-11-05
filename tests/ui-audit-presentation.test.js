const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { build } = require('vite');
let components;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, 'ui-audit-components.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'ui-audit-components.cjs'), module);
  compiled.paths = module.paths;
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  components = compiled.exports;
});
test('runtime choice requests use the correct global or per-game provider', async () => {
  const calls = [];
  const api = {
    moduleAction: async (...args) => calls.push(['game', ...args]),
    moduleSettingsAction: async (...args) => calls.push(['module', ...args])
  };
  const context = {moduleId: 'fixture', runtimeId: 'managed', scope: 'module'};
  await components.settingChoiceRequest(api, context)('listDevices');
  await components.settingChoiceRequest(api, {...context, scope: 'game', gamePath: '/game.apk'})('listDevices');
  const payload = { cursor: 'current-choice' };
  await components.settingChoiceRequest(api, {...context, runtimeId: 'viewed-provider', scope: 'game', gamePath: '/game.apk'})('listDevices', payload);
  assert.deepEqual(calls, [
    ['module', 'fixture', 'listDevices', {runtimeId: 'managed'}],
    ['game', '/game.apk', 'listDevices', undefined, {runtimeId: 'managed'}],
    ['game', '/game.apk', 'listDevices', payload, {runtimeId: 'viewed-provider'}]
  ]);
  assert.equal(calls[2][3], payload, 'The existing action payload is forwarded unchanged');
  assert.equal(components.settingChoiceRequest({}, context), null);
  assert.equal(components.settingChoiceRequest(api, {...context, scope:'game'}), null);
});
test('saved setting choices arrive independently of slow or failed providers and ignore closed windows', async () => {
  const pending = new Map(), received = [], failed = [], settled = [];
  const stop = components.loadSettingChoices(['accounts', 'devices', 'runtimes'],
    action => new Promise((resolve, reject) => pending.set(action, { resolve, reject })),
    (action, value) => received.push([action, value]),
    (action, error) => failed.push([action, error.message]),
    action => settled.push(action));
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick();
  const accounts = { accounts: [{ value: 'saved', label: 'Saved account' }] };
  pending.get('accounts').resolve(accounts);
  await tick();
  assert.deepEqual(received, [['accounts', accounts]]);
  assert.deepEqual(settled, ['accounts']);
  pending.get('runtimes').reject(new Error('Local runtime scan failed'));
  await tick();
  assert.deepEqual(failed, [['runtimes', 'Local runtime scan failed']]);
  assert.equal(received.length, 1);
  stop();
  pending.get('devices').resolve({ devices: [{ value: 'camera', label: 'Camera' }] });
  await tick();
  assert.equal(received.length, 1);
  assert.deepEqual(settled, ['accounts', 'runtimes']);
});
test('a stalled live-variable status read stays single until it settles and can recover after failure', async () => {
  let calls = 0, resolve, reject;
  const read = components.createStatusReader(() => {
    calls++;
    return new Promise((yes, no) => { resolve = yes; reject = no; });
  });
  const first = read();
  for (let i = 0; i < 1000; i++) assert.equal(read(), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve({ phase: 'paused' });
  assert.deepEqual(await first, { phase: 'paused' });
  const second = read();
  assert.notEqual(second, first);
  await Promise.resolve();
  reject(new Error('Game disconnected'));
  await assert.rejects(second, /Game disconnected/);
  const third = read();
  await Promise.resolve();
  assert.equal(calls, 3);
  resolve({ phase: 'closed' });
  assert.deepEqual(await third, { phase: 'closed' });
});
test('live-variable polling has no queued timer while blocked and releases timers and late replies on close', async () => {
  const timers = new Map(), values = [], errors = [];
  let timerId = 0, calls = 0, resolve, reject;
  const options = {
    read: () => { calls++; return new Promise((yes, no) => { resolve = yes; reject = no; }); },
    onValue: value => values.push(value), onError: error => errors.push(error.message),
    schedule: callback => { timers.set(++timerId, callback); return timerId; }, cancel: id => timers.delete(id)
  };
  const tick = () => { const [id, callback] = timers.entries().next().value; timers.delete(id); callback(); };
  const settle = () => new Promise(yes => setImmediate(yes));
  const stop = components.startStatusPolling(options);
  assert.equal(timers.size, 1);
  tick(); assert.equal(calls, 1); assert.equal(timers.size, 0);
  reject(new Error('Slow connection'));
  await settle(); assert.deepEqual(errors, ['Slow connection']); assert.equal(timers.size, 1);
  tick(); resolve({ phase: 'running' });
  await settle(); assert.deepEqual(values, [{ phase: 'running' }]); assert.equal(timers.size, 1);
  tick(); stop(); resolve({ phase: 'paused' });
  await settle(); assert.equal(values.length, 1); assert.equal(timers.size, 0);
  const stopBeforeRead = components.startStatusPolling(options);
  assert.equal(timers.size, 1); stopBeforeRead(); assert.equal(timers.size, 0);
  assert.equal(calls, 3);
});
test('game icons show the artwork main resolves, marking declared module icons, with a local generic fallback', () => {
  const registry = require('../src/modules/registry'), fs = require('node:fs');
  assert.deepEqual(components.gameIconCandidates({ iconUrl: 'data:image/png;base64,game', iconSource: 'game-extracted' }),
    [{ url: 'data:image/png;base64,game', source: 'game-extracted' }]);
  const generic = renderToStaticMarkup(React.createElement(components.GameIcon, { game: { iconUrl: null, iconSource: null } }));
  assert.match(generic, /data-icon-source="generic"/);
  assert.match(generic, /<svg[^>]*viewBox="0 0 24 24"/);
  assert.doesNotMatch(generic, /<img|https?:\/\/|gameIconText/);
  for (const manifest of registry.listModules()) {
    // A game without usable artwork of its own receives its module's declared icon file from main.js.
    assert.ok(manifest.icon?.path, `${manifest.id}: declared module icon`);
    const icon = fs.readFileSync(path.join(registry.getModuleDir(manifest.id), manifest.icon.path));
    const markup = renderToStaticMarkup(React.createElement(components.GameIcon, {
      game: { iconUrl: 'data:image/png;base64,' + icon.toString('base64'), iconSource: 'module-default' } }));
    assert.match(markup, /class="gameIcon gameIconEngine"/, manifest.id);
    assert.match(markup, /data-icon-source="module-default"/, manifest.id);
    assert.match(markup, /<img[^>]+src="data:image\/png;base64,[^"]+"[^>]+alt=""/, manifest.id);
  }
});
test('Settings uses native-window content with searchable module navigation and a labelled settings region', () => {
  const { createLibraryFixture } = require('./library-layout-fixture');
  const markup = renderToStaticMarkup(React.createElement(components.SettingsView, {
    state: createLibraryFixture(), showIcons: true, showNonDefaultTags: false,
    onSetLauncherSettings() { throw Error('Rendering must not change settings'); },
    onSetModuleSettings() { throw Error('Rendering must not change settings'); }
  }));
  assert.match(markup, /<main class="launcherView settingsView" aria-labelledby="settings-title">/);
  assert.match(markup, /<aside[^>]*aria-label="Settings sections"/);
  assert.match(markup, /<nav[^>]*aria-label="Settings sections"/);
  assert.match(markup, /<input[^>]*type="search"[^>]*aria-label="Search settings"/);
  assert.match(markup, /<button[^>]*aria-current="page"[^>]*aria-controls="settings-panel-launcher"[^>]*>Launcher<\/button>/);
  assert.match(markup, /<div\b(?=[^>]*role="region")(?=[^>]*id="settings-panel-launcher")(?=[^>]*aria-label="Launcher")[^>]*>/);
  assert.match(markup, /aria-label="Show game icons" checked=""/);
  assert.match(markup, /<button[^>]*title="Fixture engine"[^>]*>FX<\/button>/);
  assert.doesNotMatch(markup, /modalBackdrop|aria-modal|role="dialog"|aria-label="Close"|Back to Library/);
});
test('fixed runtime management metadata preserves the engine in searchable Settings navigation', () => {
  const { createLibraryFixture } = require('./library-layout-fixture');
  const state = createLibraryFixture();
  state.modules[0].runtime.managerUi = { 'fixture-manager': { management: 'built-in' } };
  state.runtimeManagers['fixture-manager'].ui = { management: 'built-in' };
  const markup = renderToStaticMarkup(React.createElement(components.SettingsView, {
    state, showIcons: true, showNonDefaultTags: false,
    onSetLauncherSettings() {}, onSetModuleSettings() {}
  }));
  assert.match(markup, /<nav[^>]*aria-label="Settings sections"/);
  assert.match(markup, /aria-label="Search settings"/);
  assert.match(markup, /<button[^>]*title="Fixture engine"[^>]*>FX<\/button>/);
  assert.match(markup, /role="region" id="settings-panel-launcher" aria-label="Launcher"/);
  assert.doesNotMatch(markup, /modalBackdrop|aria-modal|role="dialog"|aria-label="Close"|Back to Library/);
});
test('native-window headers show the view title without an HTML close or return control', () => {
  const markup = renderToStaticMarkup(React.createElement(components.LauncherViewHeader, {
    title: 'Settings', titleId: 'settings-title'
  }));
  assert.match(markup, /<h1[^>]+id="settings-title">Settings<\/h1>/);
  assert.doesNotMatch(markup, /<button|Back to Library|Close/);
});
test('Credits merges shared and module metadata without mutating sources or duplicating links', () => {
  const shared = Object.freeze([
    Object.freeze({ label: '', url: ' https://example.com/runtime/ ' }),
    Object.freeze({ label: 'Tool 10', url: 'https://example.com/tool-10' })
  ]);
  const modules = Object.freeze([
    Object.freeze({ acknowledgments: Object.freeze([
      Object.freeze({ label: 'Runtime', url: 'https://EXAMPLE.com/runtime' }),
      Object.freeze({ label: 'Tool 2', url: 'https://example.com/tool-2' }),
      Object.freeze({ label: 'Repeated tool', url: 'https://example.com/tool-2/' }),
      Object.freeze({ label: 'Missing URL', url: ' ' })
    ]) }),
    Object.freeze({})
  ]);
  const before = JSON.stringify([shared, modules]);
  assert.deepEqual(components.collectAcknowledgments(modules, shared), [
    { label: 'Runtime', url: 'https://example.com/runtime/' },
    { label: 'Tool 2', url: 'https://example.com/tool-2' },
    { label: 'Tool 10', url: 'https://example.com/tool-10' }
  ]);
  assert.equal(JSON.stringify([shared, modules]), before);
  assert.deepEqual(components.collectAcknowledgments([], shared).map(item => item.label), ['https://example.com/runtime/', 'Tool 10']);
});
test('Credits opens projects and game port resources only through their explicit Open controls', () => {
  const opened = [];
  const acknowledgments = [{ label: 'Runtime', url: 'https://example.com/runtime' }];
  const element = components.CreditsView({ acknowledgments, canOpenExternal: true, onOpenLink: url => opened.push(url) });
  assert.deepEqual(opened, []);
  const body = element.props.children.find(child => child.props.className === 'launcherViewBody');
  const credits = body.props.children.find(child => child.props.className === 'ackTable');
  const row = credits.props.children[1][0];
  const control = row.props.children[2].props.children;
  assert.equal(control.props.disabled, false);
  assert.equal(control.props.children, 'Open');
  control.props.onClick();
  assert.deepEqual(opened, ['https://example.com/runtime']);
  const resources = body.props.children.find(child => child.props['aria-labelledby'] === 'credits-resources-title');
  const resourceControl = resources.props.children[1].props.children.props.children[2].props.children;
  assert.equal(resourceControl.props.disabled, false);
  assert.equal(resourceControl.props['aria-label'], 'Open Awesome Decomp Games');
  resourceControl.props.onClick();
  assert.deepEqual(opened, ['https://example.com/runtime', 'https://github.com/SubmitGame/awesome-decomp-games']);
  const markup = renderToStaticMarkup(React.createElement(components.CreditsView, { acknowledgments, canOpenExternal: false, onOpenLink() {} }));
  assert.match(markup, /Runtime/);
  assert.match(markup, /https:\/\/example\.com\/runtime/);
  assert.match(markup, /<button[^>]+disabled=""[^>]*>Open<\/button>/);
  assert.match(markup, /<button[^>]+disabled=""[^>]+aria-label="Open Awesome Decomp Games"[^>]*>Open<\/button>/);
  assert.match(markup, /Platforms and game data requirements vary by project/);
});
test('row and inspector icons share artwork without initial-letter boxes', () => {
  const registry = require('../src/modules/registry'), fs = require('node:fs');
  const manifest = registry.getModuleInfo('godot');
  const icon = fs.readFileSync(path.join(registry.getModuleDir(manifest.id), manifest.icon.path));
  const game = { iconUrl: 'data:image/png;base64,' + icon.toString('base64'), iconSource: 'module-default' };
  const row = renderToStaticMarkup(React.createElement(components.GameIcon, { game }));
  const markup = renderToStaticMarkup(React.createElement(components.GameIcon, { game, inspector: true }));
  assert.match(markup, /gameIconInspector gameIconEngine/);
  assert.match(markup, /data-icon-source="module-default"/);
  assert.match(markup, /<img[^>]+alt=""[^>]+loading="eager"/);
  assert.equal(/src="([^"]+)"/.exec(row)[1], /src="([^"]+)"/.exec(markup)[1], 'The row and the inspector show the same artwork');
  const unknown = renderToStaticMarkup(React.createElement(components.GameIcon, { game: { iconUrl: null, iconSource: null } }));
  assert.match(unknown, /data-icon-source="generic"/);
  assert.match(unknown, /<svg/);
  assert.doesNotMatch(row + markup + unknown, /gameIconText|>Godot<|>Unknown</);
});
test('tool fields omit missing/sentinel/invalid values and duplicates while retaining false and zero', () => {
  const data = { missing: null, sentinel: '—', count: 0, active: false, hash: 'abc', duplicate: 'abc', bad: Infinity, opaque: { path: 'x' } };
  const fields = components.presentModuleFields(data, Object.keys(data).map(key => ({ key,
    label: key === 'duplicate' ? 'hash' : key, format: key === 'active' ? 'boolean' : undefined })));
  assert.deepEqual(fields.map(field => [field.label, field.value]), [['count', '0'], ['active', 'No'], ['hash', 'abc']]);
});
test('advanced groups stay collapsed initially but completed tool results need no extra disclosure', () => {
  const markup = renderToStaticMarkup(React.createElement(components.ModuleTools, {
    game: { gamePath: '/game', moduleData: { blocked: true } }, groups: [
      { id: 'tools', label: 'Tools', actions: ['extract'] },
      { id: 'advanced', label: 'Advanced', collapsed: true, actions: ['inspect', 'hidden'] }
    ], actions: [
      { id: 'extract', label: 'Decompile', resultFields: [{ key: 'hash', label: 'Hash' }, { key: 'empty', label: 'Empty' }] },
      { id: 'inspect', label: 'Inspect', disabledWhen: [{ key: 'moduleData.blocked', truthy: true }] },
      { id: 'hidden', label: 'Hidden', hiddenWhen: [{ key: 'moduleData.blocked', truthy: true }] }
    ], results: { extract: { hash: 'abc123', empty: null } }, busy: {},
    onAction() { throw Error('Rendering must never execute a backend action'); }
  }));
  assert.match(markup, /<details class="moduleToolGroup"><summary>Advanced<\/summary>/);
  assert.doesNotMatch(markup, /<details class="moduleToolResults"/);
  assert.match(markup, /<div class="moduleResultGroup" role="status">/);
  assert.match(markup, /<dt>Hash<\/dt><dd><span>abc123<\/span><\/dd>/);
  assert.match(markup, /disabled="" title="Inspect"/);
  assert.doesNotMatch(markup, /<details[^>]* open|Empty|Hidden|—/);
});
test('results from an action still running stay hidden until completion', () => {
  const markup = renderToStaticMarkup(React.createElement(components.ModuleTools, {
    game: { gamePath: '/game' }, groups: [{ id: 'tools', label: 'Tools', actions: ['status'] }],
    actions: [{ id: 'status', label: 'Reload', resultFields: [{ key: 'status', label: 'Status' }] }],
    results: { status: { status: 'stale status' } }, busy: { status: true }, onAction() {}
  }));
  assert.doesNotMatch(markup, /stale status|moduleToolResults/);
  assert.match(markup, /disabled=""/);
  assert.match(markup, /aria-busy="true"/);
  assert.match(markup, /class="moduleToolActivity" role="status">[\s\S]*>Reload…<\/span>/);
});
test('help placement stays next to its anchor and inside each viewport edge', () => {
  const place = components.positionHelpTip;
  assert.deepEqual(place({ left: 100, right: 116, top: 80, bottom: 96 }, 200, 70, 800, 600), { left: 124, top: 76 });
  const right = place({ left: 750, right: 766, top: 570, bottom: 586 }, 200, 70, 800, 600);
  assert.equal(right.left, 542);
  assert.equal(right.top, 522);
  const cramped = place({ left: 20, right: 36, top: 20, bottom: 36 }, 240, 160, 280, 200);
  assert.ok(cramped.left >= 8 && cramped.top >= 8 && cramped.left + 240 <= 272 && cramped.top + 160 <= 192);
});
test('runtime install offers Cancel, preserves Stop, and avoids backend details in the label', () => {
  const props = { g: { name: 'Game', gamePath: '/game' }, isRunning: false, showLabel: true,
    preparation: { phase: 'install', label: 'Installing opaque backend 999', managerId: 'opaque', version: '999' },
    onPlay() {}, onStop() {} };
  const markup = renderToStaticMarkup(React.createElement(components.PlayButton, props));
  assert.match(markup, /title="Cancel" aria-label="Cancel Game" aria-busy="true"/);
  assert.match(markup, /gameLaunchSpinner/);
  assert.doesNotMatch(markup, /disabled=/);
  assert.doesNotMatch(markup, /opaque|999|Preparing/);
  const stop = renderToStaticMarkup(React.createElement(components.PlayButton, { ...props, isRunning: true }));
  assert.match(stop, /title="Stop"/);
  assert.doesNotMatch(stop, /disabled=|gameLaunchSpinner|Installing/);
});
test('missing game files disable Shortcut and Cheats with the stated reason while Play rechecks and saves stay usable', () => {
  const reason = "Files unavailable. The game&#x27;s files were not found at their saved location.";
  const g = { name: 'Game', gamePath: '/game', moduleSupports: { launch: true, saveEditing: true, saveLocation: true, cheats: true },
    availability: { available: false, reason: 'missing', message: "The game's files were not found at their saved location." } };
  const markup = renderToStaticMarkup(React.createElement(components.GameActions, { g, isRunning: false, inspector: true, actions: {} }));
  const button = text => [...markup.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].find(match => match[2].includes(text))?.[1] || '';
  for (const label of ['Create shortcut', 'Cheats']) {
    assert.match(button(label), /disabled=""/, label);
    assert.ok(button(label).includes(`title="${reason}"`), label);
  }
  assert.ok(button('Play').includes(`title="${reason}"`));
  assert.doesNotMatch(button('Play'), /disabled=""/, 'Play checks again and reports the reason');
  assert.doesNotMatch(button('Edit saves'), /disabled=""/, 'saves outside the game folder stay usable');
});
test('removal shows a compact busy state and prevents game actions while preserving Stop for running games', () => {
  const g = { name: 'Game', gamePath: '/game', moduleSupports: { launch: true, saveEditing: true, saveLocation: true, cheats: true } };
  const pending = renderToStaticMarkup(React.createElement(components.GameActions, {
    g, isRunning: false, inspector: true, actions: {}, preparation: { phase: 'remove', label: 'Removing' }
  }));
  assert.match(pending, /title="Removing" aria-label="Removing Game" aria-busy="true"/);
  assert.match(pending, /gameLaunchSpinner/);
  const controls = [...pending.matchAll(/<button([^>]*)>/g)].map(match => match[1]);
  assert.equal(controls.length, 5);
  assert.ok(controls.every(attributes => attributes.includes('disabled=""')));
  const running = renderToStaticMarkup(React.createElement(components.GameActions, { g, isRunning: true, actions: {} }));
  const stop = [...running.matchAll(/<button([^>]*)>/g)].find(match => match[1].includes('aria-label="Stop Game"'));
  const forget = [...running.matchAll(/<button([^>]*)>/g)].find(match => match[1].includes('aria-label="Forget Game"'));
  assert.ok(stop && !stop[1].includes('disabled=""'));
  assert.ok(forget?.[1].includes('disabled=""'));
});
test('Play shows the component and bounded install progress in the row and inspector without exposing backend metadata', () => {
  const g = { name: 'Game', gamePath: '/game', moduleSupports: { launch: true, saveEditing: false, saveLocation: false, cheats: false } };
  for (const [progress, expected] of [
    [{ percent: 0 }, 0], [{ percent: 42.9 }, 42],
    [{ percent: -8 }, 0], [{ percent: 125 }, 100],
    [{ downloaded: 25, total: 100 }, 25], [{ downloaded: 200, total: 100 }, 100]
  ]) {
    const preparation = { phase: 'install', label: 'Installing runtime', step: 'Downloading runtime…', managerId: 'opaque', version: '999', ...progress };
    for (const inspector of [false, true]) {
      const markup = renderToStaticMarkup(React.createElement(components.GameActions, { g, isRunning: false, actions: {}, inspector, preparation }));
      assert.ok(markup.includes('title="Cancel" aria-label="Cancel Game" aria-busy="true"'));
      assert.match(markup, new RegExp(`class="gameLaunchStatus"[^>]*>Installing runtime · ${expected}%`));
      assert.match(markup, /Downloading runtime…<\/span>/);
      assert.match(markup, /<progress aria-label="Installing runtime · \d+%"/);
      if (progress.downloaded !== undefined) assert.ok(markup.includes(`${progress.downloaded} B / ${progress.total} B`));
      assert.doesNotMatch(markup, /opaque|999/);
    }
  }
});
test('unknown install progress remains indeterminate and prepare/launch never show an installation percentage', () => {
  const props = { g: { name: 'Game', gamePath: '/game' }, isRunning: false, showLabel: true, onPlay() {}, onStop() {} };
  for (const progress of [{}, { percent: NaN }, { percent: Infinity }, { downloaded: 1, total: 0 },
    { downloaded: 1, total: null }, { downloaded: 1, total: Infinity }, { downloaded: Infinity, total: 10 }]) {
    const markup = renderToStaticMarkup(React.createElement(components.PlayButton, { ...props, preparation: { phase: 'install', label: 'Backend detail', ...progress } }));
    assert.match(markup, /title="Cancel" aria-label="Cancel Game" aria-busy="true"/);
    assert.doesNotMatch(markup, /%|NaN|Infinity|Backend detail/);
  }
  for (const phase of ['check', 'prepare', 'launch']) {
    const preparation = { phase, label: 'Backend detail', percent: 90 };
    const starting = renderToStaticMarkup(React.createElement(components.PlayButton, { ...props, preparation }));
    assert.match(starting, /title="Cancel" aria-label="Cancel Game" aria-busy="true"/);
    assert.doesNotMatch(starting, /%|Backend detail/);
    const stop = renderToStaticMarkup(React.createElement(components.PlayButton, { ...props, isRunning: true, preparation }));
    assert.match(stop, /title="Stop" aria-label="Stop Game"/);
    assert.doesNotMatch(stop, /disabled=|aria-busy=|gameLaunchSpinner|Starting|%/);
  }
});
test('resolved launch capability shows an idle inspection notice while preserving Stop, Cancel and launchable command export', () => {
  const g = { name: 'Tools game', gamePath: '/tools', moduleSupports: { launch: false, saveEditing: false, saveLocation: false, cheats: false } };
  const play = components.PlayButton.type({ g, isRunning: false, onPlay() {}, onStop() {} });
  assert.equal(play.type, 'span');
  assert.equal(play.props.role, 'status');
  assert.match(play.props.title, /Inspection only\. Select a compatible runtime or import a supported game export to play/);
  for (const launch of [true, undefined]) {
    const playable = components.PlayButton.type({ g: { ...g, moduleSupports: { launch } }, isRunning: false, onPlay() {}, onStop() {} });
    assert.equal(playable.type, 'button');
    assert.equal(playable.props.disabled, false, 'existing modules remain launchable unless they explicitly opt out');
    assert.equal(playable.props['aria-label'], 'Play Tools game');
  }
  const stopped = [];
  const stop = components.PlayButton.type({ g, isRunning: true, onPlay() { throw Error('Stop must not launch'); }, onStop: gamePath => stopped.push(gamePath) });
  assert.equal(stop.props.disabled, false);
  assert.equal(stop.props.title, 'Stop');
  stop.props.onClick();
  assert.deepEqual(stopped, ['/tools']);
  const cancel = components.PlayButton.type({ g, isRunning: false, preparation: { phase: 'install', label: 'Installing runtime', percent: 25 },
    onPlay() { throw Error('Cancel must not launch'); }, onStop: gamePath => stopped.push(gamePath) });
  assert.equal(cancel.props.disabled, false);
  assert.equal(cancel.props['aria-label'], 'Cancel Tools game');
  cancel.props.onClick();
  assert.deepEqual(stopped, ['/tools', '/tools']);
  const preparing = renderToStaticMarkup(React.createElement(components.GameActions, { g, isRunning: false, actions: {},
    preparation: { phase: 'install', label: 'Installing runtime', percent: 25 } }));
  assert.match(preparing, /gameLaunchStatus[^>]*>Installing runtime · 25%/);
  assert.doesNotMatch(preparing, /gameInspectionNotice/);
  const commands = [];
  for (const inspector of [false, true]) {
    const shortcutLabel = inspector ? 'Create shortcut…' : 'Shortcut';
    const inspection = components.GameActions.type({ g, isRunning: false, actions: {}, inspector });
    assert.equal(inspection.props.children.find(child => child?.props?.children === shortcutLabel), undefined);
    // The resolved capability can change when a compatible provider is selected.
    for (const launch of [true, undefined]) {
      const playable = { ...g, moduleSupports: { ...g.moduleSupports, launch } };
      const actions = components.GameActions.type({ g: playable, isRunning: false,
        actions: { onCreateCommand: gamePath => commands.push(gamePath) }, inspector });
      const shortcut = actions.props.children.find(child => child?.props?.children === shortcutLabel);
      assert.equal(shortcut.props.disabled, false);
      shortcut.props.onClick();
      const removing = components.GameActions.type({ g: playable, isRunning: false, actions: {}, inspector, preparation: { phase: 'remove' } });
      assert.equal(removing.props.children.find(child => child?.props?.children === shortcutLabel).props.disabled, true);
    }
  }
  assert.deepEqual(commands, ['/tools', '/tools', '/tools', '/tools']);
});
test('busy save views retain a focusable selected tab while announcing their unavailable state', () => {
  const markup = renderToStaticMarkup(React.createElement(components.SaveToolsModal, {
    windowMode: true, saveGame: { name: 'Game', gamePath: '/game' }, saveInfo: null,
    saveFiles: [], saveBusy: true, saveError: null, editingFile: null, editingJson: '', saveRevision: 0
  }));
  const tabs = markup.match(/<button[^>]*role="tab"[^>]*>/g);
  assert.equal(tabs.length, 2);
  for (const tab of tabs) {
    assert.match(tab, /aria-disabled="true"/);
    assert.doesNotMatch(tab, /(?:^|\s)disabled=/, 'native disabling would discard keyboard focus during loading');
  }
  assert.match(tabs[0], /aria-selected="true" tab[Ii]ndex="0"/);
});
test('live-variable scope tabs identify their panel and preserve focus during edits', () => {
  const props = { scopes: [{ id: 'globals', label: 'Globals', count: 4 },
    { id: 'instance/1', label: 'Player instance', count: 2 }], scope: 'instance/1', busy: true, onSelect() {} };
  const busy = renderToStaticMarkup(React.createElement(components.LiveVariableScopeTabs, props));
  const tabs = busy.match(/<button[^>]*role="tab"[^>]*>/g);
  assert.equal(tabs.length, 2);
  for (const tab of tabs) {
    assert.match(tab, /id="live-variables-tab-[^"]+" aria-controls="live-variables-panel"/);
    assert.match(tab, /aria-disabled="true"/);
    assert.doesNotMatch(tab, /(?:^|\s)disabled=/, 'an edit must retain keyboard focus on the selected scope');
  }
  assert.match(tabs[1], /id="live-variables-tab-instance%2F1"/);
  assert.match(tabs[1], /aria-selected="true" tab[Ii]ndex="0"/);
  assert.match(tabs[0], /aria-selected="false" tab[Ii]ndex="-1"/);
  const idle = renderToStaticMarkup(React.createElement(components.LiveVariableScopeTabs, { ...props, busy: false }));
  assert.doesNotMatch(idle, /aria-disabled=|(?:^|\s)disabled=/);
});
test('save views rely on their tab name and keep snapshot instructions under anchored help', () => {
  const files = renderToStaticMarkup(React.createElement(components.SaveToolsModal, {
    windowMode: true, saveGame: { name: 'Game', gamePath: '/game' }, saveInfo: null,
    saveFiles: [], saveBusy: false, saveError: null, editingFile: null, editingJson: '', saveRevision: 0
  }));
  assert.equal((files.match(/>Save files</g) || []).length, 1, 'the selected tab already identifies the save file list');
  const snapshots = renderToStaticMarkup(React.createElement(components.SaveSnapshotPanel, {
    runAction() { throw Error('Rendering must not change or read real saves'); }, busy: false, revision: 0, onRestored() {}
  }));
  assert.match(snapshots, /class="helpTipButton"[^>]*aria-label="About save snapshots"/);
  assert.match(snapshots, /popover="auto" class="helpPopover">Snapshots keep copies/);
  assert.doesNotMatch(snapshots, /<p[^>]*>Snapshots keep copies/);
});
test('native live-variable view presents a scrollable panel without a nested dialog or close button', () => {
  const previousWindow = global.window;
  global.window = {};
  try {
    const markup = renderToStaticMarkup(React.createElement(components.LiveVariablesWindow, {
      context: { gamePath: '/game', sessionId: 'session', actions: {} }
    }));
    assert.match(markup, /class="liveVariablesBody" role="tabpanel" id="live-variables-panel" tab[Ii]ndex="0" aria-label="Variables"/);
    assert.doesNotMatch(markup, /modalBackdrop|role="dialog"|aria-label="Close"/);
  } finally { global.window = previousWindow; }
});
test('runtime headers omit repeated tab names and empty defaults while retaining real version state', () => {
  const manager = { id: 'opaque', label: 'Runtime backend', ui: { groupId: 'group', tabLabel: 'Engine group', sectionLabel: 'Runtime line' },
    sections: [{ id: 'default', label: 'Versions', installed: [], catalog: { versions: ['1.2.3'], recommendedVersion: '1.2.3' } }] };
  const secondManager = { ...manager, id: 'other', ui: { ...manager.ui, sectionLabel: 'Another line' } };
  const otherGroup = { ...manager, id: 'other-group', ui: { groupId: 'another-group', tabLabel: 'Another engine' } };
  const props = { runtimeManagers: [manager, secondManager, otherGroup], runtimeUi: {}, runtimeManagerId: 'opaque', runtimeSectionId: 'default',
    downloadTasks: [], downloadsOpen: false, setDownloadsOpen() {}, setRuntimeManagerId() {}, setRuntimeSectionId() {},
    updateRuntimeUiSection() {}, onRuntimeRefresh() {}, onRuntimeInstall() {}, onRuntimeSetDefault() {}, onRuntimeUninstall() {}, onCancelDownload() {} };
  const empty = renderToStaticMarkup(React.createElement(components.RuntimesView, props));
  // The selected tab names its panel; the backend's own name is the tab's tooltip, not a differing panel title.
  assert.match(empty, /role="tab" aria-selected="true"[^>]*title="Runtime backend"[^>]*>Runtime line<\/button>/, 'compact tabs retain the actual backend name');
  assert.doesNotMatch(empty, /class="runtimePanelTitle"|Default version not set|0 installed/);
  assert.equal((empty.match(/>Runtime line</g) || []).length, 1, 'the selected subtab already identifies its line');
  const installed = { ...manager, sections: [{ ...manager.sections[0], defaultVersion: '1.2.3',
    installed: [{ version: '1.2.3', platformKey: 'darwin-arm64', installDir: '/runtime' }] }] };
  const populated = renderToStaticMarkup(React.createElement(components.RuntimesView, { ...props, runtimeManagers: [installed, secondManager, otherGroup] }));
  assert.match(populated, /class="badge badgeAccent">Default<\/span>/);
  assert.match(populated, /title="Runtime backend"[^>]*>Runtime line<\/button>/);
  assert.doesNotMatch(populated, /runtimePanelSubtitle|class="runtimePanelTitle"|Default version not set|0 installed/);
  const single = renderToStaticMarkup(React.createElement(components.RuntimesView, { ...props, runtimeManagers: [manager] }));
  assert.match(single, /class="runtimePanelTitle">Runtime backend</, 'a single group retains the actual runtime name when there is no group tab');
  assert.doesNotMatch(single, /Default version not set|0 installed/);
});
test('save and runtime-settings error banners render the useful message without IPC wrappers', () => {
  const error = "Error invoking remote method 'launcher:moduleAction': Error: Save configuration could not be read.";
  const save = renderToStaticMarkup(React.createElement(components.SaveToolsModal, {
    windowMode: true, saveGame: { name: 'Game', gamePath: '/game' }, saveInfo: null,
    saveFiles: [], saveBusy: false, saveError: error, editingFile: null, editingJson: '', saveRevision: 0
  }));
  const { createLibraryFixture } = require('./library-layout-fixture');
  const settings = renderToStaticMarkup(React.createElement(components.RuntimeSettingsWindow, {
    api: {}, state: createLibraryFixture(), error,
    context: { scope: 'module', moduleId: 'fixture', runtimeId: 'managed' }
  }));
  for (const markup of [save, settings]) {
    assert.match(markup, /<div class="error" role="alert"><span class="errorMessage">Save configuration could not be read\.<\/span><\/div>/);
    assert.doesNotMatch(markup, /Error: Save configuration/);
    assert.doesNotMatch(markup, /Error invoking remote method|launcher:moduleAction/);
  }
});
test('user-visible errors unwrap repeated Error and Electron IPC prefixes while retaining the launch reason', () => {
  const { formatUserError } = components;
  const reason = 'This export needs the Mac Steamworks library and Steam client. Choose a compatible runtime to run its VM data.';
  for (const wrapped of [
    `Error: ${reason}`,
    `Error invoking remote method 'launcher:launchGame': Error: ${reason}`,
    `Error: Error invoking remote method 'launcher:launchGame': Error: Error: ${reason}`,
    `Error invoking remote method "launcher:moduleAction": Error: ${reason}`
  ]) assert.equal(formatUserError(wrapped), reason);
});
test('error formatting leaves useful classes, paths, quoted text and multiline details intact', () => {
  const { formatUserError } = components;
  const messages = [
    'TypeError: Cannot read the runtime configuration.',
    'SyntaxError: Invalid save data at line 3.',
    "ENOENT: no such file or directory, open '/path/to/game/Error: script'",
    "Runtime failed: Error: missing file. Error invoking remote method 'quoted': is part of this detail.",
    'Error budget exhausted.',
    'Error invoking remote method without a quoted channel: missing handler.',
    "Error invoking remote method 'launcher:launchGame':",
    'Error:', 'Error: ', ''
  ];
  for (const message of messages) assert.equal(formatUserError(message), message);
  assert.equal(formatUserError(new TypeError('Invalid runtime configuration.')), 'TypeError: Invalid runtime configuration.');
  const detail = 'TypeError: Invalid save.\n  File: /path/to/save.json\nError: another diagnostic line\n';
  assert.equal(formatUserError(`Error invoking remote method 'launcher:moduleAction': Error: ${detail}`), detail);
});
test('Settings lists every game type once and no runtime provider beside the game types it serves', () => {
  const { settingsSectionModules } = components;
  const modules = require('../src/modules/registry').listModules();
  const sections = settingsSectionModules(modules), ids = new Set(sections.map(mod => mod.id));
  for (const mod of modules.filter(mod => mod.detection)) assert.ok(ids.has(mod.id), `${mod.id} has a Settings section`);
  const served = new Set(modules.filter(mod => mod.detection).flatMap(mod => mod.runtime?.supported || []));
  for (const mod of sections.filter(mod => !mod.detection))
    assert.ok(!(mod.runtime?.supported || []).length || (mod.runtime.supported).some(id => !served.has(id)), `${mod.id} repeats runtime tabs of other sections`);
  assert.equal(ids.size, sections.length);
});
test('every game type offers its playable runtimes as the default and gives each offered runtime a settings tab', () => {
  const { SettingsView, defaultRuntimeChoices } = components;
  const modules = require('../src/modules/registry').listModules();
  for (const mod of modules.filter(mod => mod.detection && (mod.runtime?.supported || []).length)) {
    const choices = defaultRuntimeChoices(mod);
    for (const id of choices) assert.ok(mod.runtime.entries?.[id]?.launch !== false || id === mod.runtime.default,
      `${mod.id} offers ${id}, which cannot play, as its default`);
    const markup = renderToStaticMarkup(React.createElement(SettingsView, {
      state: { modules, moduleSettings: {}, runtimeDefaults: {}, recents: [] }, sectionId: `module:${mod.id}`,
      showIcons: true, showNonDefaultTags: false, onSetLauncherSettings() {}, onSetModuleSettings() {} }));
    const select = /<select[^>]*aria-label="Default runtime"[^>]*>([\s\S]*?)<\/select>/.exec(markup);
    assert.equal(Boolean(select), choices.length > 1, `${mod.id} shows a Default runtime choice exactly when it has more than one`);
    if (choices.length < 2) continue;
    const offered = [...select[1].matchAll(/<option[^>]*value="([^"]*)"/g)].map(match => match[1]);
    assert.deepEqual(offered, choices, `${mod.id} Default runtime options`);
    for (const id of choices) assert.match(markup, new RegExp(`id="settings-runtime-(?:tab|heading)-${mod.id}-${id}"`),
      `${mod.id} offers ${id} as the default without a settings tab`);
  }
});
test('a version chosen from the combined inspector list names the section that lists it', () => {
  const { resolveRuntimeSectionId } = components;
  const moduleInfo = { runtime: { inspectorSections: { love: 'all' }, managerSectionBy: { love: 'resolvedSection' },
    managerSectionOverrideKey: { love: 'channel' }, managerSectionMap: { love: { stable: 'stable', nightly: 'nightly' } } } };
  const managerState = { sections: [{ id: 'stable', installed: [{ version: '11.5' }], catalog: { versions: ['11.5'] } },
    { id: 'stable-0-10', installed: [], catalog: { versions: ['0.10.2'] } }] };
  const game = { moduleData: { resolvedSection: 'stable' }, runtimeData: { love: { version: '0.10.2' } } };
  assert.equal(resolveRuntimeSectionId(moduleInfo, 'love', game, { ignoreOverride: true, managerState }), 'stable-0-10');
  assert.equal(resolveRuntimeSectionId(moduleInfo, 'love', { ...game, runtimeData: {} }, { ignoreOverride: true, managerState }), 'stable');
  const chosen = { ...game, runtimeData: { love: { version: '0.10.2', channel: 'nightly' } } };
  assert.equal(resolveRuntimeSectionId(moduleInfo, 'love', chosen, { managerState }), 'nightly', 'an explicit channel still wins');
});
test('runtime version labels stay distinct when builds share an upstream version', () => {
  const { runtimeVersionTagger, runtimeVersionOptions, resolveRuntimeVersionLabel } = components;
  const tag = runtimeVersionTagger({ installed: [{ version: '0.41.0-MCLv6' }, { version: '0.41.0-MCLv7' }], catalog: { versions: ['0.42.0-MCLv1', '0.42.0'] } });
  assert.equal(tag('0.42.0'), 'v0.42.0');
  assert.equal(tag('0.42.0-MCLv1'), 'v0.42.0 · MCLv1 · MacLauncher Builds');
  assert.equal(tag('0.41.0-MCLv7'), 'v0.41.0 · MCLv7');
  assert.equal(tag('0.41.0-MCLv6'), 'v0.41.0 · MCLv6');
  // Package revisions of one upstream version, and packages named only by their revision, read as their revisions.
  const mkxpz = runtimeVersionTagger({ installed: [{ version: '2.4.2-MCLv8' }], catalog: { versions: ['2.4.2-MCLv7'] } });
  assert.deepEqual(['2.4.2-MCLv8', '2.4.2-MCLv7'].map(mkxpz), ['v2.4.2 · MCLv8', 'v2.4.2 · MCLv7']);
  const anyps5 = runtimeVersionTagger({ installed: [{ version: 'MCLv9' }], catalog: { versions: ['MCLv8'] } });
  assert.deepEqual(['MCLv9', 'MCLv8'].map(anyps5), ['MCLv9', 'MCLv8']);
  const many = runtimeVersionTagger({ catalog: { versions: ['2.4.2-MCLv8', '2.4.2-MCLv7', '2.4.2-MCLv6', '2.4.2'] } });
  assert.deepEqual(['2.4.2-MCLv8', '2.4.2-MCLv7', '2.4.2-MCLv6', '2.4.2'].map(many),
    ['v2.4.2 · MCLv8 · MacLauncher Builds', 'v2.4.2 · MCLv7 · MacLauncher Builds', 'v2.4.2 · MCLv6 · MacLauncher Builds', 'v2.4.2']);
  // Two packages with one revision and date name their exact versions.
  const profiles = runtimeVersionTagger({ catalog: { versions: ['MCLv1-1028-kag3-1', 'MCLv1-1028-1'] } });
  assert.deepEqual(['MCLv1-1028-kag3-1', 'MCLv1-1028-1'].map(profiles),
    ['Development build (Oct 28) · MCLv1-1028-kag3-1', 'Development build (Oct 28) · MCLv1-1028-1']);
  const dated = runtimeVersionTagger({ catalog: { versions: ['MCLv3-1007', 'MCLv2-1007', 'MCLv1-0921'] } });
  assert.deepEqual(['MCLv3-1007', 'MCLv2-1007', 'MCLv1-0921'].map(dated),
    ['Development build (Oct 7) · MCLv3', 'Development build (Oct 7) · MCLv2', 'Development build (Sep 21)']);
  const hashed = runtimeVersionTagger({ catalog: { versions: ['0.1.0-afa08284-7f7f8af9', '0.1.0-8da3e063-ba5d556d', '0.1.0'] } });
  assert.deepEqual(['0.1.0-afa08284-7f7f8af9', '0.1.0-8da3e063-ba5d556d', '0.1.0'].map(hashed), ['v0.1.0-afa08284-7f7f8af9', 'v0.1.0-8da3e063-ba5d556d', 'v0.1.0']);
  assert.equal(resolveRuntimeVersionLabel('2026-01-12T18-22-32Z_794d1897abe529a23f3f2f9c4f72d711a3b18391', null), '2026-01-12');
  const options = runtimeVersionOptions([{ value: '', label: 'Default' }, { value: '1.0-MCLv1', label: '1.0-MCLv1' }, { value: '1.0-MCLv2', label: '1.0-MCLv2' }]);
  assert.equal(options[0].label, 'Default');
  assert.deepEqual(options.map(option => option.label), ['Default', 'v1.0 · MCLv1', 'v1.0 · MCLv2']);
});
test('error formatting never shows a user name or password from a proxy or download URL', () => {
  const { formatUserError } = components;
  assert.equal(formatUserError('Proxy rejected http://user:secret@127.0.0.1:8080 with HTTP/1.1 403'), 'Proxy rejected http://127.0.0.1:8080 with HTTP/1.1 403');
  assert.equal(formatUserError('Download failed: https://token@example.org/file.zip'), 'Download failed: https://example.org/file.zip');
  assert.equal(formatUserError('Contact user@example.org at https://example.org/a@b'), 'Contact user@example.org at https://example.org/a@b');
});
test('connection failures name the unreachable service instead of the transport detail', () => {
  const { formatUserError } = components;
  const github = 'Could not connect to GitHub. Check the internet connection and try again.';
  assert.equal(formatUserError('Failed to establish tunnel to raw.githubusercontent.com:443 via http://user:secret@127.0.0.1:58350: HTTP/1.1 403'), github);
  assert.equal(formatUserError('Error: getaddrinfo ENOTFOUND api.github.com'), github);
  assert.equal(formatUserError("request to https://downloads.example.org/a.zip failed, reason: connect ETIMEDOUT 203.0.113.4:443"),
    'Could not connect to downloads.example.org. Check the internet connection and try again.');
  assert.equal(formatUserError('TypeError: fetch failed'), 'Could not connect to the server. Check the internet connection and try again.');
  assert.equal(formatUserError('connect ECONNREFUSED 127.0.0.1:9222'), 'connect ECONNREFUSED 127.0.0.1:9222');
  assert.equal(formatUserError('GitHub releases fetch failed (403)'), 'GitHub releases fetch failed (403)');
});
test('formatting a backend error record or Error instance never changes its stored message or diagnostics', () => {
  const { formatUserError } = components;
  const message = "Error invoking remote method 'launcher:launchGame': Error: The runtime is unavailable.";
  const record = Object.freeze({ message, code: 'RUNTIME_UNAVAILABLE', stack: 'Original stack', cause: 'Original cause' });
  const original = JSON.stringify(record);
  assert.equal(formatUserError(record), 'The runtime is unavailable.');
  assert.equal(JSON.stringify(record), original);
  const error = new Error(message);
  const stack = error.stack;
  assert.equal(formatUserError(error), 'The runtime is unavailable.');
  assert.equal(error.message, message);
  assert.equal(error.stack, stack);
});
test('inline runtime settings rely on their tab label while standalone windows retain their identity', () => {
  const { createLibraryFixture } = require('./library-layout-fixture');
  const props = { api: {}, state: createLibraryFixture(), error: null,
    context: { scope: 'module', moduleId: 'fixture', runtimeId: 'managed' } };
  const inline = renderToStaticMarkup(React.createElement(components.RuntimeSettingsWindow, { ...props, inline: true }));
  assert.match(inline, /class="runtimeSettingsInline" aria-label="Managed runtime settings"/);
  assert.doesNotMatch(inline, /runtimeSettingsHeader|modalSubtitle|game type defaults/);
  const window = renderToStaticMarkup(React.createElement(components.RuntimeSettingsWindow, props));
  assert.match(window, /class="runtimeSettingsHeader"/);
  assert.match(window, /Managed runtime settings/);
  // The standalone subtitle names the game type whose defaults it edits.
  assert.match(window, /<div class="modalSubtitle">Fixture engine<\/div>/);
});
// Network access is one checkbox per game in the inspector, with its initial
// value in Settings ▸ Launcher; runtime settings never repeat it.
test('network access stays out of game and runtime-default settings even when a runtime declares it', () => {
  const { createLibraryFixture } = require('./library-layout-fixture');
  const { withNetworkSettings } = require('../src/modules/shared/runtime/network-isolation');
  for (const scope of ['module', 'game']) for (const isolated of [false, true]) {
    const state=createLibraryFixture();state.modules[0]=withNetworkSettings(state.modules[0]);
    const settings=state.modules[0].runtime.entries.managed.settings;
    assert.ok(!settings.fields.some(field => field.key === 'networkIsolation'), 'Runtime metadata carries no network field');
    // An older schema that still declares the field is not shown either.
    settings.fields=[...settings.fields,{key:'networkIsolation',label:'Network access',type:'boolean',default:true,checkedValue:false}];
    state.runtimeDefaults.managed={networkIsolation:isolated};
    const context={scope,moduleId:'fixture',runtimeId:'managed',...(scope==='game'?{gamePath:state.recents[0].gamePath}:{})};
    const markup=renderToStaticMarkup(React.createElement(components.RuntimeSettingsWindow,{api:{},state,context,error:null}));
    assert.match(markup,/class="settingsStack"/,scope);
    assert.doesNotMatch(markup,/aria-label="Network access"|<span>(?:Enabled|Disabled|On|Off)<\/span>/,scope);
  }
});

test('dependent runtime fields follow metadata in both scopes and retain hidden values', () => {
  const { createLibraryFixture } = require('./library-layout-fixture');
  const { listModules } = require('../src/modules/registry');
  const { normalizeRuntimeSettings } = require('../src/core/runtime-settings');
  const cases = [
    ['android', 'klepton', 'Vulkan implementation', { angleBackend: 'metal', vulkanRuntime: 'saved-driver' }, { angleBackend: 'vulkan' }],
    ['android', 'klepton', 'Joystick center X (%)', { touchJoystick: 'off', touchJoystickX: 32 }, { touchJoystick: 'wasd' }],
    ['android', 'klepton', 'microG account', { googleIntegration: false, googleAccount: 'saved-account' }, { googleIntegration: true }],
    ['android', 'macapk', 'Google account', { googleIntegration: false, googleAccount: 'saved-account' }, { googleIntegration: true }],
    ['ios', 'playcover', 'Window width', { windowMode: 'native', windowWidth: 1600 }, { windowMode: 'fixed' }],
    ['ios', 'playcover', 'Mouse sensitivity', { keymapping: false, mouseSensitivity: 75 }, { keymapping: true }],
    ['rgss', 'mkxpz', 'RTP path', { rtpMode: 'auto', rtpPath: '/RTP' }, { rtpMode: 'manual' }],
    ['rgss', 'mkxpz', 'MJIT max cache', { JITEnable: false, JITMaxCache: 200 }, { JITEnable: true }],
    ['rgss', 'mkxpz', 'Bicubic sharpness', { smoothScaling: '0', smoothScalingDown: '0', bitmapSmoothScaling: '0', bitmapSmoothScalingDown: '0', bicubicSharpness: 75 }, { bitmapSmoothScalingDown: '2' }],
    ['easyrpg', 'easyrpg', 'MIDI soundfont', { noAudio: true, soundfont: '/MIDI.sf2' }, { noAudio: false }],
    ['crossover', 'sikarugir', 'Game temporal integration', { graphicsBackend: 'dxvk', dlss: true }, { graphicsBackend: 'dxmt' }],
    ['gamemaker', 'official-studio', 'Graphics helper', { softwareOpenGLFallback: 'disabled', graphicsHelperVersion: 'software-gl-v5-universal' }, { softwareOpenGLFallback: 'auto' }]
  ];
  for (const [moduleId, runtimeId, label, hidden, enabled] of cases) for (const scope of ['module', 'game']) {
    const moduleInfo = listModules().find(module => module.id === moduleId);
    const schema = moduleInfo.runtime.entries[runtimeId].settings;
    const original = normalizeRuntimeSettings(schema, hidden), restored = normalizeRuntimeSettings(schema, { ...original, ...enabled });
    const field = schema.fields.find(field => field.label === label);
    assert.equal(restored[field.key], original[field.key], `${moduleId}/${label}: value preserved`);
    function render(values) {
      const state = createLibraryFixture();state.modules = [moduleInfo];
      state.moduleSettings = { [moduleId]: { runtimeSettings: { [runtimeId]: values } } };
      state.recents[0] = { ...state.recents[0], moduleId, runtimeId, runtimeSettings: { [runtimeId]: values } };
      return renderToStaticMarkup(React.createElement(components.RuntimeSettingsWindow, {
        api: {}, state, context: { scope, moduleId, runtimeId, gamePath: state.recents[0].gamePath }, error: null
      }));
    }
    if (scope === 'module' && field.gameOnly) continue;
    assert.ok(!render(original).includes(`aria-label="${label}"`), `${moduleId}/${scope}/${label}: hidden`);
    assert.ok(render(restored).includes(`aria-label="${label}"`), `${moduleId}/${scope}/${label}: restored`);
  }
});

// The runtime summary is one help button beside the window title, as beside
// the inspector's Runtime label: description, requirements, setup, data.
test('runtime summaries keep description, requirements, setup and data details together in one help', () => {
  const { createLibraryFixture } = require('./library-layout-fixture');
  const state = createLibraryFixture();
  Object.assign(state.modules[0].runtime.entries.managed, {
    description: 'Compatible application runtime', requirements: 'macOS 15 or later',
    preparation: 'Automatic setup details.', dataNotice: 'Separate application data.'
  });
  const markup = renderToStaticMarkup(React.createElement(components.RuntimeSettingsWindow, {
    api: {}, state, context: { scope: 'module', moduleId: 'fixture', runtimeId: 'managed' }, error: null
  }));
  assert.equal((markup.match(/aria-label="About this runtime"/g) || []).length, 1);
  assert.match(markup, /class="helpPopover"><p>Compatible application runtime<\/p><p>macOS 15 or later<\/p><p>Automatic setup details\.<\/p><p>Separate application data\.<\/p><\/div>/);
  assert.doesNotMatch(markup, /<p class="dim">(?:Compatible application|macOS 15|Automatic setup|Separate application)/);
});


test('schema-declared setting options retain linked patches and unrelated action metadata', async () => {
  const option={value:'opaque:publisher-choice',label:'Prepared component',runtimeSettingsPatch:{left:'opaque:publisher-choice',right:'opaque:related-choice'}};
  const result={leftOptions:[option],translatorRoles:[{id:'api-role',label:'API scope',settingsKey:'left',optionsKey:'leftOptions',groupId:'shared'}],translatorGroups:[{id:'shared',label:'Linked APIs',reason:'Shared physical binding'}],futureMetadata:{publisher:'unchanged'},unrelated:[{notAnOption:true}]};
  const received=[],failures=[],settled=[];
  components.loadSettingChoices(['choices'],async()=>result,(_action,value)=>received.push(value),(_action,error)=>failures.push(error),action=>settled.push(action),[{key:'left',type:'select',label:'Left',optionsAction:'choices',optionsKey:'leftOptions'}]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(failures,[]);assert.deepEqual(settled,['choices']);assert.deepEqual(received,[result]);assert.equal(received[0].leftOptions[0],option);assert.equal(received[0].futureMetadata,result.futureMetadata);
  components.loadSettingChoices(['choices'],async()=>({...result,leftOptions:[{value:'invalid',label:123}]}),(_action,value)=>received.push(value),(_action,error)=>failures.push(error),()=>{},[{key:'left',type:'select',label:'Left',optionsAction:'choices',optionsKey:'leftOptions'}]);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(failures.length,0);assert.deepEqual(received[1].leftOptions,[]);assert.equal(received[1].futureMetadata,result.futureMetadata);
});

test('publisher revision labels distinguish real nightly and source choices without positional suffixes', () => {
  const {runtimeVersionTagger,resolveRuntimeVersionLabel}=components;
  const versions=['2026-10-30-a90c4c9a9190-appkit-arm64-13013297777','2026-10-30-405ae65a66fa-appkit-arm64-13012825371'];
  const labels=Object.fromEntries(versions.map((version,index)=>[version,`2026-10-30 · ${index?'405ae65a66fa':'a90c4c9a9190'} (AppKit nightly, ARM)`]));
  const tag=runtimeVersionTagger({versionLabels:labels,catalog:{versions}});
  assert.deepEqual(versions.map(tag),Object.values(labels));assert.ok(versions.map(tag).every(label=>!/[()]\d+[()]/.test(label)));
  const sha='0837e5326e710f49e2ab0a8d995da0708047442e';assert.equal(resolveRuntimeVersionLabel('git-'+sha,null),'Source revision '+sha);
  const molten=runtimeVersionTagger({catalog:{versions:['1.4.2','1.4.2-rc1','1.0.37-Metal-3.0','1.0.37']}});
  assert.deepEqual(['1.4.2','1.4.2-rc1','1.0.37-Metal-3.0','1.0.37'].map(molten),['v1.4.2','v1.4.2-rc1','v1.0.37-Metal-3.0','v1.0.37']);
});

test('generic visibility matches any projected provider while scalar and exclusion behavior stay intact',()=>{
 const show=provider=>({key:'setting',label:'Provider setting',type:'string',visibleWhen:[{key:'backend',equals:provider}]}),hide={key:'hidden',label:'Excluded provider',type:'string',hiddenWhen:[{key:'backend',equals:'first'}]};
 for(const value of ['first',['first','second']]){assert.equal(components.isRuntimeSettingVisible(show('first'),{backend:value}),true);assert.equal(components.isRuntimeSettingVisible(show('third'),{backend:value}),false);assert.equal(components.isRuntimeSettingVisible(hide,{backend:value}),false);}
 assert.equal(components.isRuntimeSettingVisible(show('second'),{backend:['first','second']}),true);
 assert.equal(components.isRuntimeSettingVisible({...show('third'),visibleWhen:[{key:'backend',notEquals:'first'}]},{backend:['first','second']}),false);
 assert.equal(components.isRuntimeSettingVisible(show('first'),{backend:[]}),false);
});

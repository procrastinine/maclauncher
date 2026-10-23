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
  assert.deepEqual(calls, [
    ['module', 'fixture', 'listDevices', {runtimeId: 'managed'}],
    ['game', '/game.apk', 'listDevices']
  ]);
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
test('game icons prioritize extracted artwork and provide declared module or generic local fallbacks', () => {
  const registry = require('../src/modules/registry');
  for (const manifest of registry.listModules()) {
    const candidates = components.gameIconCandidates({ moduleId: manifest.id, iconUrl: 'data:image/png;base64,game', iconSource: 'game-extracted' }, manifest);
    assert.equal(candidates[0].url, 'data:image/png;base64,game');
    assert.equal(candidates[0].source, 'game-extracted');
    const fallback = renderToStaticMarkup(React.createElement(components.GameIcon, {
      game: { moduleId: manifest.id, iconUrl: null, iconSource: null }, moduleInfo: manifest
    }));
    if (manifest.icon?.path) {
      assert.equal(candidates[1]?.source, 'module-default', `${manifest.id}: declared bundled fallback`);
      assert.doesNotMatch(candidates[1].url, /^https?:/);
      assert.match(fallback, /data-icon-source="module-default"/);
      assert.match(fallback, /<img[^>]+alt=""/);
    } else {
      assert.equal(candidates.length, 1, `${manifest.id}: extracted artwork remains first without a declared module icon`);
      assert.match(fallback, /data-icon-source="generic"/);
      assert.match(fallback, /<svg[^>]*viewBox="0 0 24 24"/);
      assert.doesNotMatch(fallback, /<img|https?:\/\/|gameIconText/);
    }
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
  const manifest = require('../src/modules/godot/manifest.json');
  const game = { moduleId: manifest.id, iconUrl: null, iconSource: null };
  const markup = renderToStaticMarkup(React.createElement(components.GameIcon, { game, moduleInfo: manifest, inspector: true }));
  assert.match(markup, /gameIconInspector gameIconEngine/);
  assert.match(markup, /data-icon-source="module-default"/);
  assert.match(markup, /<img[^>]+alt=""[^>]+loading="eager"/);
  const unknown = renderToStaticMarkup(React.createElement(components.GameIcon, { game: { ...game, moduleId: 'unknown' }, moduleInfo: null }));
  assert.match(unknown, /data-icon-source="generic"/);
  assert.match(unknown, /<svg/);
  assert.doesNotMatch(markup + unknown, /gameIconText|>Godot<|>Unknown</);
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
test('Play shows bounded reported install progress in the row and inspector without exposing backend details', () => {
  const g = { name: 'Game', gamePath: '/game', moduleSupports: { launch: true, saveEditing: false, saveLocation: false, cheats: false } };
  for (const [progress, expected] of [
    [{ percent: 0 }, 'Installing 0%'], [{ percent: 42.9 }, 'Installing 42%'],
    [{ percent: -8 }, 'Installing 0%'], [{ percent: 125 }, 'Installing 100%'],
    [{ downloaded: 25, total: 100 }, 'Installing 25%'], [{ downloaded: 200, total: 100 }, 'Installing 100%']
  ]) {
    const preparation = { phase: 'install', label: 'Installing opaque backend 999', managerId: 'opaque', version: '999', ...progress };
    for (const inspector of [false, true]) {
      const markup = renderToStaticMarkup(React.createElement(components.GameActions, { g, isRunning: false, actions: {}, inspector, preparation }));
      assert.ok(markup.includes('title="Cancel" aria-label="Cancel Game" aria-busy="true"'));
      assert.ok(markup.includes(`class="gameLaunchStatus" role="status">${expected}</span>`));
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
test('module launch capability disables Play while preserving Stop and command export for every game', () => {
  const g = { name: 'Tools game', gamePath: '/tools', moduleSupports: { launch: false, saveEditing: false, saveLocation: false, cheats: false } };
  const play = components.PlayButton.type({ g, isRunning: false, onPlay() {}, onStop() {} });
  assert.equal(play.props.disabled, true);
  assert.equal(play.props.title, 'Launch unavailable for this game');
  for (const launch of [true, undefined]) {
    const playable = components.PlayButton.type({ g: { ...g, moduleSupports: { launch } }, isRunning: false, onPlay() {}, onStop() {} });
    assert.equal(playable.props.disabled, false, 'existing modules remain launchable unless they explicitly opt out');
  }
  const stopped = [];
  const stop = components.PlayButton.type({ g, isRunning: true, onPlay() { throw Error('Stop must not launch'); }, onStop: gamePath => stopped.push(gamePath) });
  assert.equal(stop.props.disabled, false);
  assert.equal(stop.props.title, 'Stop');
  stop.props.onClick();
  assert.deepEqual(stopped, ['/tools']);
  const commands = [];
  for (const inspector of [false, true]) {
    const actions = components.GameActions.type({ g, isRunning: false,
      actions: { onCreateCommand: gamePath => commands.push(gamePath) }, inspector });
    const shortcut = actions.props.children.find(child => child?.props?.children === (inspector ? 'Save .command…' : 'Shortcut'));
    assert.equal(shortcut.props.disabled, false);
    shortcut.props.onClick();
    const removing = components.GameActions.type({ g, isRunning: false, actions: {}, inspector, preparation: { phase: 'remove' } });
    assert.equal(removing.props.children.find(child => child?.props?.children === (inspector ? 'Save .command…' : 'Shortcut')).props.disabled, true);
  }
  assert.deepEqual(commands, ['/tools', '/tools']);
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
  assert.match(empty, /class="runtimePanelTitle">Runtime backend<\/div>/, 'compact tabs retain the actual backend name');
  assert.doesNotMatch(empty, /class="runtimePanelTitle">(?:Engine group|Runtime line|Versions)<|Default version not set|0 installed/);
  assert.equal((empty.match(/>Runtime line</g) || []).length, 1, 'the selected subtab already identifies its line');
  const installed = { ...manager, sections: [{ ...manager.sections[0], defaultVersion: '1.2.3',
    installed: [{ version: '1.2.3', platformKey: 'darwin-arm64', installDir: '/runtime' }] }] };
  const populated = renderToStaticMarkup(React.createElement(components.RuntimesView, { ...props, runtimeManagers: [installed, secondManager, otherGroup] }));
  assert.match(populated, /class="badge badgeAccent">Default<\/span>/);
  assert.match(populated, /class="runtimePanelTitle">Runtime backend<\/div>/);
  assert.doesNotMatch(populated, /runtimePanelSubtitle|class="runtimePanelTitle">(?:Engine group|Runtime line|Versions)<|Default version not set|0 installed/);
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
    assert.match(markup, /<div class="error">Error: Save configuration could not be read\.<\/div>/);
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
  assert.match(window, /Fixture engine · game type defaults/);
});
test('network access uses enabled checkboxes in both game and runtime settings', () => {
  const { createLibraryFixture } = require('./library-layout-fixture');
  const { withNetworkSettings } = require('../src/modules/shared/runtime/network-isolation');
  for (const scope of ['module', 'game']) for (const isolated of [false, true]) {
    const state=createLibraryFixture();state.modules[0]=withNetworkSettings(state.modules[0]);
    state.runtimeDefaults.managed={networkIsolation:isolated};
    const context={scope,moduleId:'fixture',runtimeId:'managed',...(scope==='game'?{gamePath:state.recents[0].gamePath}:{})};
    const markup=renderToStaticMarkup(React.createElement(components.RuntimeSettingsWindow,{api:{},state,context,error:null}));
    const checkbox=markup.match(/<input type="checkbox" aria-label="Network access"[^>]*>/)?.[0];
    assert.ok(checkbox,scope);assert.equal(checkbox.includes('checked=""'),!isolated,scope);
    assert.match(markup,new RegExp(`<span>${isolated?'Disabled':'Enabled'}</span>`));
    assert.doesNotMatch(markup,/<select[^>]*aria-label="Network access"/);
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

test('runtime summaries keep requirements visible and place setup and data details in help', () => {
  const { createLibraryFixture } = require('./library-layout-fixture');
  const state = createLibraryFixture();
  Object.assign(state.modules[0].runtime.entries.managed, {
    description: 'Compatible application runtime', requirements: 'macOS 15 or later',
    preparation: 'Automatic setup details.', dataNotice: 'Separate application data.'
  });
  const markup = renderToStaticMarkup(React.createElement(components.RuntimeSettingsWindow, {
    api: {}, state, context: { scope: 'module', moduleId: 'fixture', runtimeId: 'managed' }, error: null
  }));
  assert.match(markup, /Compatible application runtime/);
  assert.match(markup, /<p class="dim">macOS 15 or later<\/p>/);
  assert.match(markup, /aria-label="About this runtime"/);
  assert.match(markup, /class="helpPopover"><p>Automatic setup details\.<\/p><p>Separate application data\.<\/p>/);
  assert.doesNotMatch(markup, /<p class="dim">(?:Automatic setup|Separate application)/);
});


const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Filters = require("../src/modules/shared/reshade/filter-library");
const StoredPlan = require("../src/modules/shared/effects/stored-plan");

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "reshade-filter-ipc-"));
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  const root = fs.realpathSync(temporary), profile = path.join(root, "profile");
  fs.mkdirSync(profile);
  const first = path.join(root, "Tone.fx"), second = path.join(root, "Colour.fx");
  fs.writeFileSync(first, "// Local filter one\n");
  fs.writeFileSync(second, "// Local filter two\n");
  const handlers = new Map(), dialogs = [], broadcasts = [], replies = [], games = [], saved = [];
  const owner = { name: "Runtimes" }, fallbackOwner = {name:"Hidden Library"}, sender = {};
  const context = {
    // Plans built inside the context are copied into this realm before validation.
    ReShadeFilters: Filters, GraphicsImports: require("../src/modules/shared/reshade/imports"), StoredPlan: {accept: plan => StoredPlan.accept(structuredClone(plan))},
    storedGraphicsPlan: entry => StoredPlan.read(entry, {userDataDir: profile}), fs, path, userDataDir: profile, cachedState: null,
    refreshShaderSelections: () => {},
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    BrowserWindow: {fromWebContents: webContents => {assert.equal(webContents,sender);return owner;}},
    getLauncherDialogOwner: () => fallbackOwner,
    dialog: { showOpenDialog: async (...args) => {
      dialogs.push(args);
      return replies.shift() || { canceled: true, filePaths: [] };
    } },
    loadSettings: () => ({}), loadGamesHydrated: () => games,
    findGameByPath: (records, gamePath) => records.find(row => row.gamePath === gamePath),
    saveGameRecord: entry => saved.push(structuredClone(entry)),
    buildState: () => ({ games }),
    broadcastState: () => {},
    // Open graphics views receive the catalog with the library's filters.
    graphicsCatalog: {changed: () => broadcasts.push({ reshade: { filters: Filters.list(profile) } })}
  };
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const start = source.indexOf("function publishReShadeFilters()"), end = source.indexOf('ipcMain.handle("launcher:setLibrarySort"', start);
  assert.ok(start !== -1 && end > start);
  vm.runInNewContext(source.slice(start, end), context);
  const invoke = (channel, ...args) => handlers.get(`launcher:${channel}`)({sender}, ...args);
  return { root, profile, first, second, dialogs, broadcasts, replies, owner, invoke, games, saved };
}

test("filter import uses an explicit native multi-file picker and publishes shared state", async t => {
  const f = fixture(t);
  assert.deepEqual(f.dialogs, []);
  assert.deepEqual(Filters.list(f.profile), []);
  f.replies.push({ canceled: false, filePaths: [f.first, f.second] });
  const imported = await f.invoke("importReShadeFilters");
  assert.equal(imported.length, 2);
  assert.deepEqual(new Set(imported.map(row => row.name)), new Set(["Tone.fx", "Colour.fx"]));
  assert.equal(f.dialogs[0][0], f.owner);
  assert.deepEqual(Array.from(f.dialogs[0][1].properties), ["openFile", "multiSelections"]);
  assert.deepEqual(Array.from(f.dialogs[0][1].filters[0].extensions), [...Filters.SUPPORTED_EXTENSIONS]);
  assert.deepEqual(f.broadcasts[0].reshade.filters, imported);
  f.replies.push({ canceled: false, filePaths: [f.first] });
  const repeated = await f.invoke("importReShadeFilters");
  assert.equal(repeated.length, 1);
  assert.equal(repeated.find(row => row.path === f.first).id, imported.find(row => row.path === f.first).id);
  assert.equal(f.broadcasts.at(-1).reshade.filters.length, 2);
});

test("family import narrows the existing picker and rejects mismatched canonical sources before registration", async t => {
  const f = fixture(t), slang = path.join(f.root, 'Own.slangp'), hook = path.join(f.root, 'Own.hook');
  fs.writeFileSync(slang, 'shaders = 0\n');fs.writeFileSync(hook, '//!HOOK MAIN\n');
  for (const [family, extensions, file] of [['reshade', ['fx'], f.first], ['libretro', ['slangp', 'slang'], slang], ['mpv', ['glsl', 'hook', 'cube', 'plfilter'], hook]]) {
    f.replies.push({ canceled: false, filePaths: [file] });await f.invoke('importReShadeFilters', family);
    assert.deepEqual(Array.from(f.dialogs.at(-1)[1].filters[0].extensions), extensions);
  }
  const original = Filters.list(f.profile), count = f.broadcasts.length;
  const alias = path.join(f.root, 'Wrong.fx');fs.symlinkSync(slang, alias);
  for (const [family, file] of [['mpv', f.first], ['reshade', alias]]) {
    f.replies.push({ canceled: false, filePaths: [file] });
    await assert.rejects(f.invoke('importReShadeFilters', family), /selected family/);
    assert.deepEqual(Filters.list(f.profile), original);assert.equal(f.broadcasts.length, count);
  }
  const dialogs = f.dialogs.length;
  await assert.rejects(f.invoke('importReShadeFilters', 'unknown'), /supported shader family/);
  assert.equal(f.dialogs.length, dialogs);
});

test("canceled import and path selection leave registrations and shared state unchanged", async t => {
  const f = fixture(t);
  assert.equal(await f.invoke("importReShadeFilters"), null);
  assert.equal(f.broadcasts.length, 0);
  const [filter] = Filters.importFiles(f.profile, [f.first]);
  f.replies.push({ canceled: false, filePaths: [f.second] });
  assert.equal(await f.invoke("pickReShadeFilterPath", filter.id), f.second);
  assert.equal(Filters.list(f.profile)[0].path, f.first);
  assert.equal(f.dialogs.at(-1)[1].defaultPath, f.first);
  assert.equal(await f.invoke("pickReShadeFilterPath", filter.id), null);
  assert.equal(Filters.list(f.profile)[0].path, f.first);
  assert.equal(f.broadcasts.length, 0);
});
test("RetroArch preset imports and replacements retain their format through the same native picker flow", async t => {
  const f = fixture(t), preset = path.join(f.root, "CRT.slangp"), shader = path.join(f.root, "Single.slang");
  fs.writeFileSync(preset, 'shaders = 1\nshader0 = "Single.slang"\n');fs.writeFileSync(shader, "#version 450\n");
  f.replies.push({ canceled: false, filePaths: [preset] });
  const [filter] = await f.invoke("importReShadeFilters");assert.equal(filter.format, "slangp");
  f.replies.push({ canceled: false, filePaths: [shader] });
  assert.equal(await f.invoke("pickReShadeFilterPath", filter.id), shader);
  assert.deepEqual(Array.from(f.dialogs.at(-1)[1].filters[0].extensions), ["fx", "slangp", "slang", "glsl", "hook", "cube", "plfilter", "fs", "isf", "hlsl", "mclfilter"]);
  await f.invoke("updateReShadeFilter", filter.id, { path: shader });
  assert.equal(f.broadcasts.at(-1).reshade.filters[0].format, "slang");
  assert.equal(f.broadcasts.at(-1).reshade.filters[0].id, filter.id);
});
test("name/path edits publish once, invalid edits publish nothing and removal preserves source files", async t => {
  const f = fixture(t);
  const [filter, other] = Filters.importFiles(f.profile, [f.first, f.second]);
  assert.equal(await f.invoke("updateReShadeFilter", filter.id, { name: "Warm tone" }), true);
  assert.equal(f.broadcasts.length, 1);
  assert.equal(f.broadcasts[0].reshade.filters.find(row => row.id === filter.id).name, "Warm tone");
  await assert.rejects(f.invoke("updateReShadeFilter", filter.id, { name: other.name }));
  await assert.rejects(f.invoke("updateReShadeFilter", filter.id, { path: path.join(f.root, "missing.fx") }));
  assert.equal(f.broadcasts.length, 1);
  assert.equal(await f.invoke("removeReShadeFilter", other.id), true);
  assert.equal(await f.invoke("updateReShadeFilter", filter.id, { path: f.second }), true);
  assert.equal(f.broadcasts.at(-1).reshade.filters[0].path, f.second);
  assert.equal(await f.invoke("removeReShadeFilter", filter.id), true);
  assert.deepEqual(f.broadcasts.at(-1).reshade.filters, []);
  assert.equal(fs.readFileSync(f.first, "utf8"), "// Local filter one\n");
  assert.equal(fs.readFileSync(f.second, "utf8"), "// Local filter two\n");
  const calls = f.dialogs.length;
  await assert.rejects(f.invoke("pickReShadeFilterPath", filter.id), /not found/);
  assert.equal(f.dialogs.length, calls);
});

const shaderPlan = (preset, parameters) => ({ schema: 2, mode: "advanced", enabled: true,
  video: [{ id: "shader", kind: "shader", enabled: true, shader: { enabled: true, preset, parameters } }] });
test("replacing a registered file resets only parameters on games selecting that filter", async t => {
  const f = fixture(t), [filter] = Filters.importFiles(f.profile, [f.first]);
  f.games.push({ gamePath: "/Games/Selected", effects: shaderPlan(`filter:${filter.id}`, { Exposure: [2] }) },
    { gamePath: "/Games/Other", effects: shaderPlan("crt", { Curve: [1] }) });
  await f.invoke("updateReShadeFilter", filter.id, { name: "Warm tone" });
  assert.equal(f.saved.length, 0);
  assert.deepEqual(f.games[0].effects.video[0].shader.parameters, { Exposure: [2] });
  await f.invoke("updateReShadeFilter", filter.id, { path: f.second });
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].effects.video[0].shader.preset, `filter:${filter.id}`);
  assert.equal(f.saved[0].effects.video[0].shader.parameters, undefined);
  assert.deepEqual(f.games[1].effects.video[0].shader.parameters, { Curve: [1] });
});

test("replacing a filter clears only its saved advanced-row parameters", async t => {
  const f = fixture(t), [filter] = Filters.importFiles(f.profile, [f.first]);
  f.games.push({ gamePath: "/Games/Advanced", effects: { schema: 2, mode: "advanced", enabled: true, video: [
    { id: "imported", kind: "shader", enabled: false, shader: { enabled: true, preset: `filter:${filter.id}`, parameters: { Tone: [2] } } },
    { id: "other", kind: "shader", enabled: true, shader: { enabled: true, preset: "cas", parameters: { Sharpness: [.4] } } }
  ] } });
  await f.invoke("updateReShadeFilter", filter.id, { name: "Tone" });assert.equal(f.saved.length, 0);
  await f.invoke("updateReShadeFilter", filter.id, { path: f.second });
  assert.equal(f.saved.length, 1);assert.equal(f.games[0].effects.video[0].shader.parameters, undefined);
  assert.deepEqual(f.games[0].effects.video[1].shader.parameters, { Sharpness: [.4] });
  assert.equal(f.games[0].effects.video[0].enabled, false);
});

test("replacing an upgraded spatial shader source clears its old uniforms while retaining appearance and resolution choices", async t => {
  const f = fixture(t), [filter] = Filters.importFiles(f.profile, [f.first]);
  f.games.push(StoredPlan.upgradeLegacy({gamePath: "/Games/Spatial", reshade: {enabled: true, preset: "crt", parameters: {Curve: [1]}},
    graphics: {spatialMethod: "off", spatialMultiplier: 2, frameGeneration: "lsfg",
      spatialShader: {enabled: true, preset: `filter:${filter.id}`, parameters: {Old: [3]}}}}, {userDataDir: f.profile}));
  const before = structuredClone(f.games[0].effects), row = id => f.games[0].effects.video.find(node => node.id === id);
  assert.deepEqual(row("legacy-spatial-shader").shader.parameters, {Old: [3]});
  await f.invoke("updateReShadeFilter", filter.id, {path: f.second});
  assert.equal(f.saved.length, 1);assert.equal(row("legacy-spatial-shader").shader.parameters, undefined);
  assert.equal(row("legacy-spatial-shader").shader.preset, `filter:${filter.id}`);
  assert.deepEqual(f.games[0].effects.renderResolution, before.renderResolution);
  assert.deepEqual(row("legacy-frame-generation"), before.video.find(node => node.id === "legacy-frame-generation"));
  assert.deepEqual(row("legacy-shader").shader.parameters, {Curve: [1]});
});

test("preload exposes filter actions without invoking dialogs or writes during initialization", async () => {
  const calls = []; let api;
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/shared/web/preload/launcher.js"), "utf8");
  vm.runInNewContext(source, {
    require: id => {
      assert.equal(id, "electron");
      return { contextBridge: { exposeInMainWorld: (_name, value) => { api = value.launcher; } },
        ipcRenderer: { invoke: async (...args) => { calls.push(args); return true; } }, webUtils: {} };
    }
  });
  assert.deepEqual(calls, []);
  await api.importReShadeFilters();
  await api.updateReShadeFilter("entry", { name: "Warm tone" });
  await api.pickReShadeFilterPath("entry");
  await api.removeReShadeFilter("entry");
  assert.deepEqual(calls, [
    ["launcher:importReShadeFilters"],
    ["launcher:updateReShadeFilter", "entry", { name: "Warm tone" }],
    ["launcher:pickReShadeFilterPath", "entry"],
    ["launcher:removeReShadeFilter", "entry"]
  ]);
});

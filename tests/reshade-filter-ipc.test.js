const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Filters = require("../src/modules/shared/reshade/filter-library");
const ReShade = require("../src/modules/shared/reshade");

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "reshade-filter-ipc-"));
  const root = fs.realpathSync(temporary), profile = path.join(root, "profile");
  fs.mkdirSync(profile);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, "Tone.fx"), second = path.join(root, "Colour.fx");
  fs.writeFileSync(first, "// Local filter one\n");
  fs.writeFileSync(second, "// Local filter two\n");
  const handlers = new Map(), dialogs = [], broadcasts = [], replies = [], games = [], saved = [];
  const owner = { name: "Settings" };
  const context = {
    ReShadeFilters: Filters, GraphicsImports: require("../src/modules/shared/reshade/imports"), ReShade, EffectsPlan: require("../src/modules/shared/effects/plan"),
    GraphicsSettings: require("../src/modules/shared/reshade/graphics-settings"), fs, userDataDir: profile, cachedState: null,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getLauncherDialogOwner: () => owner,
    dialog: { showOpenDialog: async (...args) => {
      dialogs.push(args);
      return replies.shift() || { canceled: true, filePaths: [] };
    } },
    loadSettings: () => ({}), loadGamesHydrated: () => games,
    findGameByPath: (records, gamePath) => records.find(row => row.gamePath === gamePath),
    editGraphics: async (_gamePath, edit) => edit(),
    saveGameRecord: entry => saved.push(structuredClone(entry)),
    saveGameReShade: async (gamePath, patch) => {
      const game = games.find(row => row.gamePath === gamePath);
      game.reshade = { ...game.reshade, ...patch };saved.push(structuredClone(game));return true;
    },
    buildState: () => ({ reshade: { filters: Filters.list(profile) } }),
    broadcastState: () => broadcasts.push(structuredClone(context.cachedState))
  };
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const start = source.indexOf("function publishReShadeFilters()"), end = source.indexOf('ipcMain.handle("launcher:setLibrarySort"', start);
  assert.ok(start !== -1 && end > start);
  vm.runInNewContext(source.slice(start, end), context);
  const invoke = (channel, ...args) => handlers.get(`launcher:${channel}`)(null, ...args);
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
  assert.deepEqual(Array.from(f.dialogs[0][1].filters[0].extensions), ["fx", "slangp", "slang", "glsl", "hook"]);
  assert.deepEqual(f.broadcasts[0].reshade.filters, imported);
  f.replies.push({ canceled: false, filePaths: [f.first] });
  const repeated = await f.invoke("importReShadeFilters");
  assert.equal(repeated.length, 2);
  assert.equal(repeated.find(row => row.path === f.first).id, imported.find(row => row.path === f.first).id);
});

test("family import narrows the existing picker and rejects mismatched canonical sources before registration", async t => {
  const f = fixture(t), slang = path.join(f.root, 'Own.slangp'), hook = path.join(f.root, 'Own.hook');
  fs.writeFileSync(slang, 'shaders = 0\n');fs.writeFileSync(hook, '//!HOOK MAIN\n');
  for (const [family, extensions, file] of [['reshade', ['fx'], f.first], ['libretro', ['slangp', 'slang'], slang], ['mpv', ['glsl', 'hook'], hook]]) {
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
  await assert.rejects(f.invoke('importReShadeFilters', 'unknown'), /ReShade, libretro or MPV/);
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
  assert.deepEqual(Array.from(f.dialogs.at(-1)[1].filters[0].extensions), ["fx", "slangp", "slang", "glsl", "hook"]);
  await f.invoke("updateReShadeFilter", filter.id, { path: shader });
  assert.equal(f.broadcasts.at(-1).reshade.filters[0].format, "slang");
  assert.equal(f.broadcasts.at(-1).reshade.filters[0].id, filter.id);
});
test("the per-game custom picker accepts Slang and saves the canonical file without changing other games", async t => {
  const f = fixture(t), file = path.join(f.root, "CRT.slangp"), alias = path.join(f.root, "Alias.fx");
  fs.writeFileSync(file, 'shaders = 0\n');fs.symlinkSync(file, alias);
  f.games.push({ gamePath: "/Games/Selected", reshade: { enabled: true, preset: "crt" } }, { gamePath: "/Games/Other", reshade: { enabled: false, preset: "crt" } });
  f.replies.push({ canceled: false, filePaths: [alias] });
  assert.equal(await f.invoke("pickGameReShadeEffect", "/Games/Selected"), file);
  assert.deepEqual(f.games[0].reshade, { enabled: true, preset: "custom", effectPath: file });
  assert.deepEqual(f.games[1].reshade, { enabled: false, preset: "crt" });
  assert.deepEqual(Array.from(f.dialogs[0][1].filters[0].extensions), ["fx", "slangp", "slang", "glsl", "hook"]);
  assert.equal(await f.invoke("pickGameReShadeEffect", "/Games/Selected"), null);
  const unsupported = path.join(f.root, "Old.glslp");fs.writeFileSync(unsupported, "shaders=0\n");
  f.replies.push({ canceled: false, filePaths: [unsupported] });
  await assert.rejects(f.invoke("pickGameReShadeEffect", "/Games/Selected"), /\.fx.*\.slangp.*\.slang/);
  assert.equal(f.saved.length, 1);
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

test("replacing a registered file resets only parameters on games selecting that filter", async t => {
  const f = fixture(t), [filter] = Filters.importFiles(f.profile, [f.first]);
  f.games.push({ gamePath: "/Games/Selected", reshade: { enabled: true, preset: `filter:${filter.id}`, parameters: { Exposure: [2] } } },
    { gamePath: "/Games/Other", reshade: { enabled: true, preset: "crt", parameters: { Curve: [1] } } });
  await f.invoke("updateReShadeFilter", filter.id, { name: "Warm tone" });
  assert.equal(f.saved.length, 0);
  assert.deepEqual(f.games[0].reshade.parameters, { Exposure: [2] });
  await f.invoke("updateReShadeFilter", filter.id, { path: f.second });
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].reshade.preset, `filter:${filter.id}`);
  assert.equal(f.saved[0].reshade.parameters, undefined);
  assert.deepEqual(f.games[1].reshade.parameters, { Curve: [1] });
});

test("replacing a filter clears only its saved advanced-row parameters", async t => {
  const f = fixture(t), [filter] = Filters.importFiles(f.profile, [f.first]);
  f.games.push({ gamePath: "/Games/Advanced", reshade: { enabled: false, preset: "crt" }, effects: { schema: 1, mode: "advanced", video: [
    { id: "imported", kind: "shader", enabled: false, shader: { preset: `filter:${filter.id}`, parameters: { Tone: [2] } } },
    { id: "other", kind: "shader", enabled: true, shader: { preset: "cas", parameters: { Sharpness: [.4] } } }
  ] } });
  await f.invoke("updateReShadeFilter", filter.id, { name: "Tone" });assert.equal(f.saved.length, 0);
  await f.invoke("updateReShadeFilter", filter.id, { path: f.second });
  assert.equal(f.saved.length, 1);assert.equal(f.games[0].effects.video[0].shader.parameters, undefined);
  assert.deepEqual(f.games[0].effects.video[1].shader.parameters, { Sharpness: [.4] });
  assert.equal(f.games[0].effects.video[0].enabled, false);assert.equal(f.games[0].reshade.preset, "crt");
});

test("replacing a spatial shader source clears its old uniforms while retaining appearance and resolution choices", async t => {
  const f = fixture(t), [filter] = Filters.importFiles(f.profile, [f.first]);
  f.games.push({gamePath: "/Games/Spatial", reshade: {enabled: true, preset: "crt", parameters: {Curve: [1]}},
    graphics: {spatialMethod: "off", spatialMultiplier: 2, frameGeneration: "lsfg",
      spatialShader: {enabled: true, preset: `filter:${filter.id}`, parameters: {Old: [3]}}}});
  await f.invoke("updateReShadeFilter", filter.id, {path: f.second});
  assert.equal(f.saved.length, 1);assert.equal(f.games[0].graphics.spatialShader.parameters, undefined);
  assert.equal(f.games[0].graphics.spatialShader.preset, `filter:${filter.id}`);
  assert.equal(f.games[0].graphics.spatialMultiplier, 2);assert.equal(f.games[0].graphics.frameGeneration, "lsfg");
  assert.deepEqual(f.games[0].reshade, {enabled: true, preset: "crt", parameters: {Curve: [1]}});
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

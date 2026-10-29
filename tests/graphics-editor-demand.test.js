const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {createGraphicsCatalog} = require("../src/main/graphics-catalog");
const ReShade = require("../src/modules/shared/reshade");
const Filters = require("../src/modules/shared/reshade/filter-library");
const temporary = (t, prefix) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));return root;
};
const sender = id => {
  const sent = [], listeners = [];
  return {id, sent, isDestroyed: () => false, send: (channel, value) => sent.push([channel, value]), once: (name, listener) => listeners.push([name, listener]),
    destroy: () => {for (const [name, listener] of listeners) if (name === "destroyed") listener();}};
};
const hook = description => `//!HOOK MAIN\n//!BIND HOOKED\n//!DESC ${description}\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }\n`;

test("the graphics catalog is built only while a view asks for it and reused until its inventory changes", () => {
  let builds = 0, value = "a", inputs = "one";
  const catalog = createGraphicsCatalog({build: () => {builds++;return {value};}, inputs: () => inputs});
  for (let index = 0; index < 5; index++) catalog.refresh();
  catalog.changed();inputs = "two";catalog.refresh();
  assert.equal(builds, 0, "no view, no build");
  const first = sender(1), second = sender(2);
  const opened = catalog.request(first, {open: true, revision: null});
  assert.deepEqual(opened, {revision: 1, reshade: {value: "a"}});assert.equal(builds, 1);
  assert.deepEqual(catalog.request(first, {open: true, revision: 1}), {revision: 1}, "a second view in one window shares the request");
  catalog.refresh();catalog.refresh();
  assert.equal(builds, 1, "unchanged inputs reuse the catalog");
  assert.deepEqual(catalog.request(second, {open: true, revision: null}), {revision: 1, reshade: {value: "a"}});
  assert.equal(builds, 2, "a newly opened window reads the sources again");
  assert.equal(first.sent.length, 0, "the same catalog is not sent again");
  const revision = catalog.revision();
  inputs = "three";catalog.refresh();
  assert.equal(builds, 3);assert.notEqual(catalog.revision(), revision);
  assert.equal(first.sent.length, 0, "equal content keeps the published revision");
  value = "b";catalog.changed();
  assert.equal(builds, 4);
  assert.deepEqual(first.sent.at(-1), ["launcher:graphicsCatalog", {revision: 2, reshade: {value: "b"}}]);
  assert.deepEqual(second.sent.at(-1), ["launcher:graphicsCatalog", {revision: 2, reshade: {value: "b"}}]);
  catalog.request(first, {open: false});catalog.request(first, {open: false});second.destroy();
  assert.equal(catalog.demanded, false);
  value = "c";catalog.changed();inputs = "four";catalog.refresh();
  assert.equal(builds, 4, "closed views stop all catalog work");
});

test("an opening view finds a shader edited in place and editor discovery is read again", t => {
  const userDataDir = temporary(t, "graphics-demand-"), file = path.join(userDataDir, "Edit.glsl");
  fs.writeFileSync(file, hook("First"));Filters.importFiles(userDataDir, [file]);
  const catalog = createGraphicsCatalog({build: () => ReShade.getState({app: {}, userDataDir, settings: {}}), inputs: () => "inventory"});
  const view = sender(1), description = reply => reply.reshade.filters.find(row => row.path === file).traits.description;
  const opened = catalog.request(view, {open: true, revision: null});
  assert.equal(description(opened), "First");
  catalog.request(view, {open: false});
  const revision = catalog.revision();
  fs.writeFileSync(file, hook("Second"));
  const reopened = catalog.request(view, {open: true, revision: opened.revision});
  assert.equal(reopened.revision, opened.revision + 1);assert.equal(description(reopened), "Second");
  assert.notEqual(catalog.revision(), revision, "reuse keys change with the edited source");
});

test("editor discovery and templates are reused for one inventory revision and read again for the next", t => {
  const userDataDir = temporary(t, "graphics-discovery-");
  const Effects = require("../src/modules/shared/effects/runtime"), Xess = require("../src/modules/shared/reshade/xess");
  let states = 0, xess = 0;
  const getState = ReShade.getState, state = Xess.state;
  t.mock.method(ReShade, "getState", (...args) => {states++;return getState(...args);});
  t.mock.method(Xess, "state", (...args) => {xess++;return state(...args);});
  const entry = {gameId: "g", gamePath: "/Games/g", effects: {schema: 2, mode: "advanced", enabled: true,
    video: [{id: "a", kind: "shader", enabled: true, shader: {enabled: true, preset: "grayscale"}}]}};
  const options = revision => ({userDataDir, app: {}, settings: {}, graphicsHost: "window", graphicsArchitecture: "arm64", graphicsInputs: {},
    ...(revision ? {inventoryRevision: revision} : {})});
  const first = Effects.info(entry, options("r1"));
  assert.equal(states, 1);assert.equal(xess, 2);assert.equal(first.templates, undefined, "templates are read when the menu asks");
  const again = Effects.info(entry, options("r1"));
  assert.equal(states, 1);assert.equal(xess, 2);assert.equal(again.catalog, first.catalog, "the catalog rows are reused");
  const templates = Effects.templates(entry, options("r1"));
  assert.equal(states, 1);assert.equal(Effects.templates(entry, options("r1")), templates);
  const edited = {...entry, effects: {...entry.effects, video: [...entry.effects.video, {id: "b", kind: "upscale", method: "bilinear", enabled: true, settings: {}}]}};
  assert.notEqual(Effects.templates(edited, options("r1")), templates, "templates follow the saved plan");
  Effects.info(entry, options("r2"));
  assert.equal(states, 2, "a new inventory revision reads discovery again");
  Effects.info(entry, options());Effects.info(entry, options());
  assert.equal(states, 4, "without a revision nothing is reused");
});

test("shader analyses persist per parser and file identity in the application's data", t => {
  const userDataDir = temporary(t, "graphics-traits-"), source = temporary(t, "graphics-traits-source-");
  const file = path.join(source, "Persisted.glsl");fs.writeFileSync(file, hook("Stored"));
  const modulePath = require.resolve("../src/modules/shared/reshade/shader-traits");
  const fresh = () => {
    for (const key of Object.keys(require.cache)) if (key.includes(`${path.sep}src${path.sep}modules${path.sep}shared${path.sep}`)) delete require.cache[key];
    const Traits = require(modulePath);Traits.configure({userDataDir});return Traits;
  };
  t.after(() => {for (const key of Object.keys(require.cache)) if (key.includes(`${path.sep}src${path.sep}modules${path.sep}shared${path.sep}`)) delete require.cache[key];});
  let Traits = fresh();
  assert.equal(Traits.analyzeFile(file, "libplacebo").traits.description, "Stored");
  Traits.flush();
  const store = path.join(userDataDir, "graphics", "shader-traits-cache.json");
  assert.ok(fs.statSync(store).isFile());assert.equal(fs.existsSync(path.join(source, "shader-traits-cache.json")), false);
  const reads = () => {let count = 0;const open = fs.openSync;t.mock.method(fs, "openSync", (target, ...rest) => {if (target === file) count++;return open(target, ...rest);});return () => count;};
  Traits = fresh();let count = reads();
  assert.equal(Traits.analyzeFile(file, "libplacebo").traits.description, "Stored");
  assert.equal(count(), 0, "a later process reuses the stored analysis");
  t.mock.restoreAll();
  const document = JSON.parse(fs.readFileSync(store, "utf8"));
  fs.writeFileSync(store, JSON.stringify({...document, parser: "0".repeat(64), entries: Object.fromEntries(Object.entries(document.entries)
    .map(([key, row]) => [key, {...row, analysis: {...row.analysis, parser: "0".repeat(64)}}]))}));
  Traits = fresh();count = reads();Traits.analyzeFile(file, "libplacebo");
  assert.equal(count(), 1, "another parser analyzes again");
  t.mock.restoreAll();Traits.flush();
  fs.writeFileSync(file, hook("Edited"));
  Traits = fresh();
  assert.equal(Traits.analyzeFile(file, "libplacebo").traits.description, "Edited", "a changed file identity analyzes again");
});

test("a rolled-back publication restores the XeSS request watcher of the plan it restores", t => {
  const Broker = require("../src/modules/shared/runtime/gpu-compute-broker"), Effects = require("../src/modules/shared/effects/runtime");
  const {createPublication} = require("../src/modules/shared/reshade/live-publication");
  const userDataDir = temporary(t, "gpu-broker-rollback-"), binding = {...Broker.reserve({userDataDir, launchId: "rollback"}), namespace: "org.maclauncher.xess.test."};
  t.after(() => Broker.release(binding));
  t.mock.timers.enable({apis: ["setInterval"]});
  const watchers = [];
  t.mock.method(fs, "watch", () => {
    const watcher = {closed: false, close() {this.closed = true;}, on() {return this;}, unref() {}};watchers.push(watcher);return watcher;
  });
  Broker.bind(binding, process.pid);
  Broker.register(binding, {executable: process.execPath, arguments: [], hostPath: "/trusted/helper.exe", originalLibrary: "/trusted/original.dll", environment: {}});
  const entry = {gameId: "xess-rollback", gamePath: "/Games/XeSS"}, launchBinding = {effectPlanLiveResources: {xess: binding}};
  const rejected = createPublication();
  Effects.publishSimple(entry, userDataDir, {publication: rejected, running: true, launchBinding});
  t.mock.timers.tick(1000);
  assert.equal(watchers[0].closed, true, "a plan without XeSS releases the idle watcher");
  rejected.rollback();
  assert.equal(watchers.length, 2);assert.equal(watchers[1].closed, false, "the restored XeSS plan watches again");
  const committed = createPublication();
  Effects.publishSimple(entry, userDataDir, {publication: committed, running: true, launchBinding});
  committed.commit();t.mock.timers.tick(1000);
  assert.equal(watchers[1].closed, true);assert.equal(watchers.length, 2, "a committed plan without XeSS keeps it released");
});

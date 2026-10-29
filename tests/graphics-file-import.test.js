const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { EventEmitter } = require("node:events"), { pathToFileURL } = require("node:url");
const Imports = require("../src/modules/shared/reshade/imports");
const Filters = require("../src/modules/shared/reshade/filter-library");
const { createGameImportQueue } = require("../src/core/game-import-queue");
const { startFileOpen, pathsFromArguments, configureLauncherData } = require("../src/main/file-open");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-file-import-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile"); fs.mkdirSync(userDataDir);
  return { root, userDataDir };
}
function appFor(root, lock = true) {
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: true, setName() {}, setPath() {}, getPath: () => root, getAppPath: () => path.join(root, "MacLauncher.app"),
    requestSingleInstanceLock: data => { app.lockData = data; return lock; }, quit: () => { app.quitCalled = true; } });
  return app;
}
const shader = "//!HOOK MAIN\n//!DESC CNN x2\n//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\nvec4 hook(){return vec4(0);}\n";

test("explicit launcher data directories isolate Chromium storage and logs while ordinary startup keeps its profile", t => {
  const f = fixture(t), selected = path.join(f.root, "separate profile"), paths = {}, logPaths = [];
  const app = { setName() {}, getPath: () => f.root, setPath: (key, value) => { paths[key] = value; },
    setAppLogsPath: value => logPaths.push(value) };
  configureLauncherData(app, ["/MacLauncher", `--user-data=${selected}`]);
  assert.equal(fs.statSync(selected).isDirectory(), true);
  assert.deepEqual(paths, { userData: selected, sessionData: selected });
  assert.deepEqual(logPaths, [path.join(selected, "logs")]);
  const ordinary = {}, ordinaryLogs = [];
  configureLauncherData({ ...app, setPath: (key, value) => { ordinary[key] = value; },
    setAppLogsPath: value => ordinaryLogs.push(value) }, ["/MacLauncher"]);
  assert.deepEqual(ordinary, { userData: path.join(f.root, "maclauncher") });
  assert.deepEqual(ordinaryLogs, []);
});

test("invalid or unavailable explicit data directories never silently select the ordinary profile", t => {
  const f = fixture(t), calls = [], app = { setName() {}, getPath: () => f.root,
    setPath: (...args) => calls.push(args), setAppLogsPath() {} };
  for (const value of ["", "relative/profile"]) assert.throws(() => configureLauncherData(app,
    ["/MacLauncher", `--user-data=${value}`]), /absolute directory/);
  const file = path.join(f.root, "a file"); fs.writeFileSync(file, "content");
  assert.throws(() => configureLauncherData(app, ["/MacLauncher", `--user-data=${file}`]));
  assert.deepEqual(calls, []);
  assert.throws(() => configureLauncherData({ ...app, setPath() { throw new Error("Path unavailable"); } },
    ["/MacLauncher", `--user-data=${f.userDataDir}`]), /Path unavailable/);
});

test("graphics dispatch registers every supported source format, deduplicates real paths and preserves referenced assets", async t => {
  const f = fixture(t), games = [], changes = [];
  const importer = Imports.createImporter({ ...f, importGame: file => games.push(file), importModel: async file => ({ modelPath: file }),
    onGraphicsImported: result => changes.push(result.kind) });
  const files = ["Tone.fx", "Scale.glsl", "Denoise.hook", "CRT.slang", "CRT.slangp"].map(name => path.join(f.root, name));
  files.forEach(file => fs.writeFileSync(file, shader));
  const include = path.join(f.root, "common.fxh"), texture = path.join(f.root, "lookup.png");
  fs.writeFileSync(include, "include content"); fs.writeFileSync(texture, "texture content");
  for (const file of files) assert.equal((await importer(file)).kind, "filter");
  const alias = path.join(f.root, "Alias.fx"); fs.symlinkSync(files[0], alias);
  await importer(alias);
  assert.equal(Filters.list(f.userDataDir).length, 5);
  assert.equal(Filters.list(f.userDataDir)[0].path, files[0]);
  assert.deepEqual(games, []); assert.equal(changes.length, 6);
  assert.equal(fs.readFileSync(include, "utf8"), "include content"); assert.equal(fs.readFileSync(texture, "utf8"), "texture content");
  for (const file of files) assert.equal(fs.readFileSync(file, "utf8"), shader);
  const archive = path.join(f.root, "Game.zip"), dll = path.join(f.root, "Game.dll");
  fs.writeFileSync(archive, "game archive"); fs.writeFileSync(dll, "game library");
  await importer(archive); await importer(dll);
  assert.deepEqual(games, [archive, dll], "generic archives and DLLs retain game detection");
  const directory = path.join(f.root, "Folder.fx"); fs.mkdirSync(directory);
  await assert.rejects(importer(directory), /instead of a folder/);
  assert.equal(games.length, 2);
});

test("cold Finder events, initial and second-instance arguments and drops share graphics-first import with games", async t => {
  const f = fixture(t), app = appFor(f.root), queue = createGameImportQueue(), games = [], errors = [];
  const first = path.join(f.root, "First.glsl"), second = path.join(f.root, "Second.fx"), game = path.join(f.root, "Game.exe");
  for (const file of [first, second, game]) fs.writeFileSync(file, shader);
  assert.equal(startFileOpen({ app, imports: queue, dialog: { showMessageBox: value => errors.push(value) }, argv: ["/MacLauncher", first] }), true);
  let prevented = false;
  app.emit("open-file", { preventDefault: () => { prevented = true; } }, second);
  app.emit("second-instance", {}, ["/MacLauncher", game], f.root, { inputPaths: [game] });
  assert.equal(prevented, true); assert.equal(Filters.list(f.userDataDir).length, 0);
  queue.setImporter(Imports.createImporter({ ...f, importGame: file => { games.push(file); return file; }, importModel: async () => {} }));
  // The same queue import is the launcher's drag/drop IPC entry point.
  await Promise.all([queue.import(first), queue.import(second), queue.import(game)]);
  assert.equal(Filters.list(f.userDataDir).length, 2); assert.deepEqual(games, [game]); assert.deepEqual(errors, []);
  assert.deepEqual(app.lockData.inputPaths, [first]);
});

test("argument forwarding ignores application and Chromium options, preserves file URLs and leaves dedicated game processes independent", t => {
  const f = fixture(t), file = path.join(f.root, "Scale with spaces.hook"); fs.writeFileSync(file, shader);
  assert.deepEqual(pathsFromArguments(["/Electron", "/project", "--user-data=/profile", "Scale with spaces.hook", pathToFileURL(file).href, "--original-process-start-time=42"],
    { packaged: false, cwd: f.root, appPath: "/project" }), [file]);
  const secondary = appFor(f.root, false), calls = [];
  assert.equal(startFileOpen({ app: secondary, imports: { import: async file => calls.push(file) }, dialog: {}, argv: ["/MacLauncher", file] }), false);
  assert.equal(secondary.quitCalled, true); assert.deepEqual(calls, []);
  const child = appFor(f.root);
  assert.equal(startFileOpen({ app: child, dialog: {}, argv: ["/MacLauncher", "--maclauncher-game-child", "--maclauncher-game=/Games/Example"] }), true);
  assert.equal(child.lockData, undefined); assert.equal(child.listenerCount("open-file"), 0);
});

test("renamed development Electron ignores its source entry point on initial and forwarded launches", async t => {
  const f = fixture(t), app = appFor(f.root), calls = [];
  const entry = path.join(f.root, "bootstrap.cjs"), first = path.join(f.root, "First.hook"), second = path.join(f.root, "Game.exe");
  for (const file of [entry, first, second]) fs.writeFileSync(file, shader);
  app.getAppPath = () => f.root;
  assert.equal(startFileOpen({ app, defaultApp: true, argv: ["/MacLauncher", entry, first],
    imports: { import: async file => calls.push(file) }, dialog: {} }), true);
  assert.deepEqual(app.lockData.inputPaths, [first]);
  app.emit("second-instance", {}, ["/MacLauncher", entry, second], f.root);
  assert.deepEqual(calls, [first, second]);
});

test("file import errors identify the selected file", async t => {
  const f = fixture(t), app = appFor(f.root), errors = [];
  const file = path.join(f.root, "Unrecognized.bin"); fs.writeFileSync(file, "content");
  startFileOpen({ app, argv: ["/MacLauncher", file], imports: { import: async () => { throw new Error("No game data found."); } },
    dialog: { showMessageBox: error => errors.push(error) } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1); assert.equal(errors[0].detail, `${file}\n\nNo game data found.`);
});

test("model documents use the existing local manager without opening another picker", async t => {
  const f = fixture(t), crypto = require("node:crypto"), runtimePath = path.join(f.root, "Small.dlssmodel"); fs.mkdirSync(runtimePath);
  const weights = Buffer.alloc(4096, 7);
  fs.writeFileSync(path.join(runtimePath, "weights.safetensors"), weights);
  fs.writeFileSync(path.join(runtimePath, "manifest.json"), JSON.stringify({ schemaVersion: 1, identifier: "org.example.document",
    architecture: "mlxdlss.neural-rendering-transformer.v1",
    inputs: [{ name: "color", dataType: "float32", layout: "nhwc", shape: [1, "height", "width", 16] }],
    outputs: [{ name: "color", dataType: "float32", layout: "nhwc", shape: [1, "height", "width", 4] }], state: { kind: "stateless" },
    weights: { file: "weights.safetensors", tensors: require("./helpers/neural-model-contract").nrTensors(),
      sha256: crypto.createHash("sha256").update(weights).digest("hex") } }));
  const source = fs.readFileSync(require.resolve("../src/main/main"), "utf8"), start = source.indexOf("async function importNeuralModelFile("),
    end = source.indexOf("async function openGamesFromMenu()", start), snapshots = [];
  let settings = {};
  const context = { fs, AbortController, graphicsImportsClosing: false, graphicsImportControllers: new Map(), importProgress: new Map(), userDataDir: f.userDataDir,
    getRuntimeManager: () => require("../src/modules/shared/reshade/runtime/neural-models-manager"),
    runRuntimeManagerAction: require("../src/core/runtime-manager-service").runRuntimeManagerAction,
    loadSettings: () => settings, settingsCoordinator: { applySettings: async (_previous, next) => { settings = next; } },
    broadcastActivity() {}, refreshRuntimeSnapshots: async ids => snapshots.push(ids) };
  vm.runInNewContext(source.slice(start, end), context);
  const importer = Imports.createImporter({ ...f, importGame: () => assert.fail("model package reached game detection"),
    importModel: context.importNeuralModelFile });
  const result = await importer(runtimePath);
  assert.equal(result.kind, "neural-model"); assert.notEqual(result.model.modelPath, runtimePath);
  assert.equal(settings.runtimes["graphics-neural-models"].defaultVersion, result.model.version);
  assert.equal(snapshots.length, 1); assert.equal(context.graphicsImportControllers.size, 0);
  assert.deepEqual(fs.readFileSync(path.join(runtimePath, "weights.safetensors")), weights);
  context.broadcastActivity = () => context.graphicsImportControllers.get(runtimePath)?.abort();
  await assert.rejects(importer(runtimePath), { name: "AbortError" });
  assert.equal(context.graphicsImportControllers.size, 0); assert.equal(context.importProgress.size, 0);
  assert.deepEqual(fs.readFileSync(path.join(runtimePath, "weights.safetensors")), weights);
});

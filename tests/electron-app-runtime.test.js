const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Registry = require("../src/modules/registry");
const Manager = require("../src/modules/shared/web/runtime/electron-manager");
const ElectronApp = require("../src/modules/shared/web/runtime/electron-app-provider");
const Loader = require("../src/runtime/electron-app");
const Transport = require("../src/modules/shared/runtime/upstream-transport");
const { peFixture, versionResource } = require("./helpers/pe-fixture");

const WEB_MODULES = ["web", "construct", "gamemaker-html5", "mv", "mz", "tyrano", "wolfrpg"];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "electron-app-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}
// An Electron app archive as Electron writes it: a size pickle, a header pickle
// holding the JSON file tree, then the file contents.
function writeAsar(file, files) {
  const header = { files: {} }, chunks = [];
  let offset = 0;
  for (const [relative, contents] of Object.entries(files)) {
    const data = Buffer.from(typeof contents === "string" ? contents : contents.data || ""), parts = relative.split("/");
    let node = header;
    for (const part of parts.slice(0, -1)) node = node.files[part] ||= { files: {} };
    if (contents.unpacked) node.files[parts.at(-1)] = { size: data.length, unpacked: true };
    else { node.files[parts.at(-1)] = { size: data.length, offset: String(offset) }; offset += data.length; chunks.push(data); }
  }
  const json = Buffer.from(JSON.stringify(header)), aligned = json.length + (4 - json.length % 4) % 4;
  const start = Buffer.alloc(16);
  start.writeUInt32LE(4, 0); start.writeUInt32LE(8 + aligned, 4); start.writeUInt32LE(4 + aligned, 8); start.writeUInt32LE(json.length, 12);
  const padded = Buffer.alloc(aligned);
  json.copy(padded);
  write(file, Buffer.concat([start, padded, ...chunks]));
}
const electronExecutable = () => peFixture({ version: versionResource({ strings: {
  OriginalFilename: "electron.exe", ProductName: "Electron", FileDescription: "Electron" } }) }).bytes;
// A Windows Electron release: the launcher, and its app with a main-process
// script, a preload script and the page.
function windowsRelease(root, { main = "main.js", packageJson } = {}) {
  write(path.join(root, "Game.exe"), electronExecutable());
  const app = path.join(root, "resources", "app");
  write(path.join(app, "package.json"), JSON.stringify(packageJson || { name: "authored-game", productName: "Authored Game", main }));
  write(path.join(app, "main.js"), "// main process");
  write(path.join(app, "preload.js"), "// preload");
  write(path.join(app, "index.html"), "<html><canvas></canvas></html>");
  return app;
}
const GameQuarantine = require("../src/modules/shared/runtime/game-quarantine");
function electronPath(t, value = "/Applications/MacLauncher.app/Contents/MacOS/MacLauncher") {
  const previous = process.env.MACLAUNCHER_ELECTRON_PATH;
  process.env.MACLAUNCHER_ELECTRON_PATH = value;
  t.after(() => { if (previous === undefined) delete process.env.MACLAUNCHER_ELECTRON_PATH; else process.env.MACLAUNCHER_ELECTRON_PATH = previous; });
  return value;
}

const HOSTED_MODULES = WEB_MODULES.filter(id => id !== "wolfrpg");
const electronLabels = info => info.runtime.supported.filter(id => /electron/i.test(info.runtime.labels?.[id] || id));

test("every web game type has one Electron runtime whose versions are MacLauncher's and separately installed ones", () => {
  // The hosted Electron stays the default runtime with its own settings; the
  // Electron manager lists its versions, and the game's-app runtime is not listed.
  for (const id of HOSTED_MODULES) {
    const info = Registry.getModuleInfo(id);
    assert.deepEqual(electronLabels(info), ["electron"], id);
    assert.equal(info.runtime.default, "electron", id);
    assert.equal(info.runtime.manager.electron, "electron", id);
    assert.equal(info.runtime.entries.electron.graphicsHost, "remote", id);
    assert.equal(info.runtime.labels["electron-app"], undefined, id);
  }
  // Wolf RPG has no hosted Electron, so its one Electron runtime runs the game's app.
  const wolf = Registry.getModuleInfo("wolfrpg");
  assert.equal(wolf.runtime.default, "browser-woditor");
  assert.deepEqual(electronLabels(wolf), ["electron-app"]);
  assert.equal(wolf.runtime.labels["electron-app"], "Electron");
  assert.equal(wolf.runtime.manager["electron-app"], "electron");
  assert.equal(wolf.runtime.entries["electron-app"].graphicsHost, undefined);
  assert.ok(Registry.getModule("web").runtimeManagers.some(manager => manager.id === "electron"));
  assert.ok(Registry.listSharedRuntimeManagers().some(manager => manager.id === "electron"));
});

test("detection records an Electron app folder or archive inside the game's release", async t => {
  const root = fixture(t), release = path.join(root, "Windows Game");
  windowsRelease(release);
  for (const input of [release, path.join(release, "Game.exe")]) {
    const detected = await Registry.detectGameAsync(input);
    assert.deepEqual(detected.runtimeData["electron-app"], { app: path.join("resources", "app") });
    assert.equal(ElectronApp.recorded(detected), path.join(release, "resources", "app"));
    for (const id of WEB_MODULES) {
      const supported = Registry.getModule(id).filterRuntimeSupport({ ...detected, moduleId: id }, [], {}, {});
      assert.equal(supported.includes("electron-app"), id === "wolfrpg", id);
    }
  }

  // TyranoScript's macOS export keeps its app in Contents/Resources/app.asar.
  const bundle = path.join(root, "Tyrano Game.app");
  write(path.join(bundle, "Contents", "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Tyrano Game</string></dict></plist>');
  write(path.join(bundle, "Contents", "MacOS", "Tyrano Game"), "#!/bin/sh\n");
  writeAsar(path.join(bundle, "Contents", "Resources", "app.asar"), { "package.json": JSON.stringify({ name: "tyrano-game", main: "main.js" }),
    "main.js": "// main process", "index.html": "<html></html>", "tyrano/plugins/kag/kag.js": "// kag" });
  const tyrano = await Registry.detectGameAsync(bundle);
  assert.equal(tyrano.engine, "tyrano");
  assert.deepEqual(tyrano.runtimeData["electron-app"], { app: path.join("Contents", "Resources", "app.asar") });
});

test("only a contained Electron main script makes an app", async t => {
  const outside = fixture(t);
  write(path.join(outside, "main.js"), "// elsewhere");
  const cases = {
    // NW.js names its page as main.
    "nw page": root => windowsRelease(root, { packageJson: { name: "nw", main: "index.html" } }),
    "missing main": root => { const app = windowsRelease(root, { main: "missing.js" }); fs.rmSync(path.join(app, "main.js")); },
    "escaping main": root => windowsRelease(root, { main: "../../outside.js" }),
    "linked main": root => {
      const app = windowsRelease(root, { main: "linked.js" });
      fs.symlinkSync(path.join(outside, "main.js"), path.join(app, "linked.js"));
    },
    "linked app": root => {
      write(path.join(root, "Game.exe"), electronExecutable());
      write(path.join(outside, "app", "package.json"), JSON.stringify({ main: "main.js" }));
      write(path.join(outside, "app", "main.js"), "//");
      write(path.join(outside, "app", "index.html"), "<html></html>");
      fs.mkdirSync(path.join(root, "resources"));
      fs.symlinkSync(path.join(outside, "app"), path.join(root, "resources", "app"));
    }
  };
  for (const [name, make] of Object.entries(cases)) {
    const root = path.join(fixture(t), "Game");
    make(root);
    assert.equal(ElectronApp.findApp({ gameType: "web", gamePath: root, contentRootDir: path.join(root, "resources", "app") }), null, name);
  }

  // Without main, Electron starts index.js; a main without its extension and
  // a main folder resolve as Node resolves them.
  for (const [main, file] of [[null, "index.js"], ["dist/main", "dist/main.js"], ["dist", "dist/index.js"]]) {
    const root = path.join(fixture(t), "Game"), app = path.join(root, "resources", "app");
    write(path.join(app, "package.json"), JSON.stringify(main ? { main } : { name: "game" }));
    write(path.join(app, file), "//");
    assert.deepEqual(ElectronApp.findApp({ gameType: "web", gamePath: root, contentRootDir: app }), { app: path.join("resources", "app") }, file);
  }

  // An archive's main may be unpacked beside it.
  const root = path.join(fixture(t), "Game"), archive = path.join(root, "resources", "app.asar");
  writeAsar(archive, { "package.json": JSON.stringify({ main: "main.js" }), "main.js": { data: "//", unpacked: true } });
  assert.equal(ElectronApp.findApp({ gameType: "web", gamePath: root }), null);
  write(path.join(`${archive}.unpacked`, "main.js"), "//");
  assert.deepEqual(ElectronApp.findApp({ gameType: "web", gamePath: root }), { app: path.join("resources", "app.asar") });
  // Another game type never records an app.
  assert.equal(ElectronApp.provider.decorateEntry({ gameType: "renpy", gamePath: root }).runtimeData, undefined);
  assert.equal(ElectronApp.recorded({ gameType: "web", gamePath: root, runtimeData: { "electron-app": { app: "../elsewhere" } } }), null);
});

test("the Electron list comes from Electron's release index with Apple Silicon builds from Electron 11", async () => {
  const releases = [
    { version: "45.5.0", date: "2026-11-24", chrome: "142.0.1", node: "22.20.0" },
    { version: "46.0.0-beta.3", date: "2026-11-20" },
    { version: "47.0.0-nightly.20261125", date: "2026-11-25" },
    { version: "11.0.0", date: "2020-11-16", chrome: "87.0.4280.60", node: "12.18.3" },
    { version: "10.4.7", date: "2021-06-15" }
  ];
  const original = Transport.fetchUrlBuffer;
  Transport.fetchUrlBuffer = async () => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(releases)) });
  try {
    const all = await Manager.source.discover({});
    assert.deepEqual(all.map(row => `${row.version}/${row.architecture}`), ["45.5.0/arm64", "45.5.0/x64", "11.0.0/arm64", "11.0.0/x64", "10.4.7/x64"]);
    const latest = all[0];
    assert.equal(latest.files[0].url, "https://github.com/electron/electron/releases/download/v45.5.0/electron-v45.5.0-darwin-arm64.zip");
    assert.equal(latest.details.chrome, "142.0.1");
    assert.deepEqual((await Manager.source.discover({ arch: "arm64" })).map(row => row.version), ["45.5.0", "11.0.0"]);
    assert.deepEqual((await Manager.source.discover({ arch: "x64" })).map(row => row.version), ["45.5.0", "11.0.0", "10.4.7"]);
  } finally { Transport.fetchUrlBuffer = original; }
});

test("a download installs only with the checksum Electron publishes for it", async () => {
  const pin = { version: "45.5.0", asset: { filename: "electron-v45.5.0-darwin-arm64.zip" } };
  const digest = "a".repeat(64), original = Transport.fetchUrlBuffer, requested = [];
  const answer = (status, text = "") => async url => { requested.push(url); return { status, headers: {}, body: Buffer.from(text) }; };
  try {
    Transport.fetchUrlBuffer = answer(200, `${"b".repeat(64)} *electron-v45.5.0-darwin-x64.zip\n${digest} *electron-v45.5.0-darwin-arm64.zip\n`);
    assert.deepEqual(await Manager.verifyArtifact({ archiveSha256: digest, pin }), { verified: true, identity: "Electron SHASUMS256.txt", archiveSha256: digest });
    assert.equal(requested[0], "https://github.com/electron/electron/releases/download/v45.5.0/SHASUMS256.txt");
    await assert.rejects(Manager.verifyArtifact({ archiveSha256: "c".repeat(64), pin }), /does not match Electron's published checksum/);
    Transport.fetchUrlBuffer = answer(200, `${digest} *electron-v45.5.0-darwin-x64.zip\n`);
    await assert.rejects(Manager.verifyArtifact({ archiveSha256: digest, pin }), /does not list/);
    Transport.fetchUrlBuffer = answer(404);
    assert.equal(await Manager.verifyArtifact({ archiveSha256: digest, pin }), null);
    Transport.fetchUrlBuffer = answer(503);
    await assert.rejects(Manager.verifyArtifact({ archiveSha256: digest, pin }), /checksum list for 45\.5\.0 is unavailable\. .*answered 503\./);
  } finally { Transport.fetchUrlBuffer = original; }
});

test("an installed Electron starts games through a link that makes the app packaged", t => {
  const unpacked = fixture(t), app = path.join(unpacked, "Electron.app");
  write(path.join(app, "Contents", "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Electron</string></dict></plist>');
  fs.mkdirSync(path.join(app, "Contents", "MacOS"));
  fs.copyFileSync("/usr/bin/true", path.join(app, "Contents", "MacOS", "Electron"));
  assert.equal(Manager.resolveExecutable(unpacked), path.join(app, "Contents", "MacOS", "Electron"));
  const evidence = Manager.prepareInstall({ unpacked });
  assert.ok(evidence.architectures.includes("arm64"));
  const link = path.join(app, "Contents", "MacOS", Manager.PACKAGED_EXECUTABLE);
  assert.equal(Manager.resolveExecutable(unpacked), link);
  assert.equal(fs.statSync(link).ino, fs.statSync(path.join(app, "Contents", "MacOS", "Electron")).ino);
  assert.notEqual(path.basename(link).toLowerCase(), "electron");
});

test("MacLauncher's Electron is an included version and the default until another is chosen", t => {
  const executable = electronPath(t), userDataDir = fixture(t);
  const state = Manager.getState({ userDataDir, settings: {} });
  const included = state.installed.find(row => row.version === "included");
  assert.deepEqual({ included: included.included, removable: included.removable, ready: included.ready }, { included: true, removable: false, ready: true });
  assert.equal(included.versionLabel, `${Manager.includedVersion()} · MacLauncher`);
  assert.equal(state.versionLabels.included, included.versionLabel);
  assert.equal(state.defaultVersion, "included");
  assert.equal(state.sections[0].defaultVersion, "included");
  assert.equal(Manager.getState({ userDataDir, settings: { defaultVersion: "45.5.0" } }).defaultVersion, "45.5.0");

  const app = { "electron-app": { app: path.join("resources", "app") } }, defaulted = { runtimes: { electron: { defaultVersion: "45.5.0" } } };
  const entry = { gameId: "game", gameType: "web", runtimeId: "electron", runtimeData: { ...app } };
  const automatic = Manager.resolveSelection(entry, {}, userDataDir);
  assert.equal(automatic.version, "included");
  assert.equal(automatic.ready, true);
  assert.equal(automatic.install.executablePath, executable);
  assert.equal(Manager.resolveSelection({ ...entry, runtimeData: { ...app, electron: { version: "included" } } }, defaulted, userDataDir).version, "included");
  // A game's own version and a saved default select downloaded versions.
  const chosen = Manager.resolveSelection({ ...entry, runtimeData: { ...app, electron: { version: "45.5.0" } } }, {}, userDataDir);
  assert.equal(chosen.version, "45.5.0");
  assert.equal(chosen.ready, false);
  assert.equal(Manager.resolveSelection(entry, defaulted, userDataDir).version, "45.5.0");
  // Wolf RPG keeps the choice under its own Electron runtime.
  assert.equal(Manager.resolveSelection({ ...entry, runtimeId: "electron-app", runtimeData: { "electron-app": { ...app["electron-app"], version: "45.5.0" } } },
    {}, userDataDir).version, "45.5.0");
  // A game without an Electron app of its own stays on MacLauncher's Electron
  // whatever the default, and a choice of another version explains itself.
  const hostedOnly = { ...entry, runtimeData: {} };
  assert.equal(Manager.resolveSelection(hostedOnly, defaulted, userDataDir).version, "included");
  const refused = Manager.resolveSelection({ ...hostedOnly, runtimeData: { electron: { version: "45.5.0" } } }, {}, userDataDir);
  assert.deepEqual({ version: refused.version, ready: refused.ready }, { version: null, ready: false });
  assert.match(refused.reason, /Electron 45\.5\.0 runs a game's own Electron app, and this game has none/);

  assert.equal(Manager.applySettingsUpdate("setDefault", { version: "included" }, { defaultVersion: "45.5.0" }, { userDataDir }).defaultVersion, null);
  assert.equal(Manager.applySettingsUpdate("setDefault", { version: "45.5.0" }, {}, { userDataDir }).defaultVersion, "45.5.0");
  assert.equal(Manager.updateSettingsAfterInstall({}, { version: "45.5.0" }), undefined);
  assert.deepEqual(Manager.updateSettingsAfterUninstall({ defaultVersion: "45.5.0" }, { version: "45.5.0" }), { defaultVersion: null });
  assert.equal(Manager.updateSettingsAfterUninstall({ defaultVersion: "45.5.0" }, { version: "44.0.0" }), undefined);
});

test("Play asks for a chosen Electron that is not installed and starts the game's app with its own data", async t => {
  const executable = electronPath(t), root = fixture(t), userDataDir = path.join(root, "data"), release = path.join(root, "Game");
  const app = windowsRelease(release);
  const entry = { gameId: "game-1", gameType: "web", gamePath: release, contentRootDir: app, runtimeId: "electron-app",
    runtimeData: { "electron-app": { app: path.join("resources", "app") } } };
  assert.equal(ElectronApp.provider.ensureRuntime(entry, { settings: {}, userDataDir }), null);
  assert.deepEqual(ElectronApp.provider.ensureRuntime({ ...entry, runtimeData: { "electron-app": { app: path.join("resources", "app"), version: "45.5.0" } } },
    // Without a version list yet, Play reads Electron's list before it offers the download.
    { settings: {}, userDataDir }), { managerId: "electron", version: "45.5.0", discoveryRequired: true, installOptions: {} });

  const environment = { ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect", ELECTRON_START_URL: "http://127.0.0.1:5174/", NODE_ENV: "development", KEEP: "value" };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const spawned = [];
  const context = { settings: {}, userDataDir, platform: "linux", gameArguments: ["--windowed", "save one"], logger: { info() {}, warn() {} },
    spawnDetachedChecked: async (command, args, options, needsRosetta) => { spawned.push({ command, args, options, needsRosetta }); return { pid: 1 }; } };
  await ElectronApp.provider.launchRuntime("electron-app", entry, context);
  const [launch] = spawned;
  assert.equal(launch.command, executable);
  assert.equal(launch.args[0], ElectronApp.loaderPath());
  assert.equal(launch.args[1], `--maclauncher-electron-app=${app}`);
  assert.ok(launch.args.includes("--use-mock-keychain"));
  assert.deepEqual(Loader.gameArguments(launch.args), ["--windowed", "save one"]);
  assert.equal(launch.options.cwd, release);
  // The game's app keeps the user's own home, so its saves land where the
  // game's own releases put them.
  assert.equal(launch.options.env.HOME, process.env.HOME);
  assert.equal(launch.options.env.CFFIXED_USER_HOME, undefined);
  assert.equal(launch.options.env.ELECTRON_FORCE_IS_PACKAGED, "true");
  assert.equal(launch.options.env.KEEP, "value");
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "ELECTRON_START_URL", "NODE_ENV"]) assert.equal(launch.options.env[key], undefined, key);
  assert.equal(launch.needsRosetta, false);

  // A downloaded Intel Electron runs through Rosetta.
  const resolve = Manager.resolveSelection;
  Manager.resolveSelection = () => ({ version: "10.4.7", ready: true, requiresRosetta: true,
    install: { executablePath: "/runtimes/electron/10.4.7/Electron.app/Contents/MacOS/Electron App" } });
  t.after(() => { Manager.resolveSelection = resolve; });
  await ElectronApp.provider.launchRuntime("electron-app", entry, context);
  assert.equal(spawned[1].command, "/runtimes/electron/10.4.7/Electron.app/Contents/MacOS/Electron App");
  assert.equal(spawned[1].needsRosetta, true);
  assert.equal(spawned[1].args[0], ElectronApp.loaderPath());
});

test("separately installed Electron versions run the game's app; MacLauncher's Electron keeps hosting the game", async t => {
  electronPath(t);
  const root = fixture(t), userDataDir = path.join(root, "data"), release = path.join(root, "Game"), app = windowsRelease(release);
  const settings = {}, recordedApp = { "electron-app": { app: path.join("resources", "app") } };
  for (const id of HOSTED_MODULES) {
    const mod = Registry.getModule(id), owner = (runtimeData, context = { settings, userDataDir }) =>
      mod.runtimeVersionOwner("electron", { gameType: "web", gamePath: release, contentRootDir: app, runtimeId: "electron", runtimeData }, context);
    assert.equal(owner(recordedApp), null, id);
    assert.equal(owner({ ...recordedApp, electron: { version: "included" } }), null, id);
    assert.equal(owner({ ...recordedApp, electron: { version: "45.5.0" } }), "electron-app", id);
    assert.equal(owner(recordedApp, { settings: { runtimes: { electron: { defaultVersion: "45.5.0" } } }, userDataDir }), "electron-app", id);
    // Without an app of its own the game stays hosted, and other runtimes are never taken over.
    assert.equal(owner({ electron: { version: "45.5.0" } }), null, id);
    assert.equal(mod.runtimeVersionOwner("nwjs", { gameType: "web", gamePath: release, runtimeData: { ...recordedApp, nwjs: { version: "45.5.0" } } },
      { settings, userDataDir }), null, id);
  }

  // The hosted runtime's version choice reaches the launch, and an app that
  // carries Steam's macOS library asks for the Steam client connection.
  write(path.join(app, "node_modules", "steamworks.js", "dist", "osx", "libsteam_api.dylib"), "");
  const steam = [], spawned = [], resolve = Manager.resolveSelection, requested = [];
  Manager.resolveSelection = (entry, ...rest) => {
    requested.push([entry.runtimeId, entry.runtimeData?.[entry.runtimeId]?.version]);
    return { version: "45.5.0", ready: true, install: { executablePath: "/runtimes/electron/arm64/45.5.0/Electron.app/Contents/MacOS/Electron App" } };
  };
  t.after(() => { Manager.resolveSelection = resolve; });
  await ElectronApp.provider.launchRuntime("electron-app", { gameId: "game-1", gameType: "web", gamePath: release, contentRootDir: app,
    runtimeId: "electron", runtimeData: { ...recordedApp, electron: { version: "45.5.0" } } },
  { settings, userDataDir, runtimeId: "electron", platform: "linux", logger: { info() {}, warn() {} },
    useSteamClient: async required => steam.push(required),
    spawnDetachedChecked: async command => { spawned.push(command); return { pid: 1 }; } });
  assert.deepEqual(requested, [["electron", "45.5.0"]]);
  assert.deepEqual(steam, [true]);
  assert.equal(spawned[0], "/runtimes/electron/arm64/45.5.0/Electron.app/Contents/MacOS/Electron App");
  assert.equal(ElectronApp.usesSteamApi(app), true);
  assert.equal(ElectronApp.usesSteamApi(windowsRelease(path.join(root, "Plain"))), false);
  const archive = path.join(root, "Packed", "resources", "app.asar");
  writeAsar(archive, { "package.json": "{}", "main.js": "//", "node_modules/greenworks/lib/libsteam_api.dylib": { data: "", unpacked: true } });
  assert.equal(ElectronApp.usesSteamApi(archive), true);
});

test("launch drops the download quarantine from the game's own app folders on macOS before the app starts", async t => {
  const root = fixture(t), release = path.join(root, "Game"), app = windowsRelease(release);
  const entry = { gameId: "game-1", gameType: "web", gamePath: release, contentRootDir: app, runtimeId: "electron-app",
    runtimeData: { "electron-app": { app: path.join("resources", "app") } } };
  const events = [];
  const context = { settings: {}, userDataDir: path.join(root, "data"), platform: "darwin", logger: { info() {}, warn: warning => events.push(["warn", warning]) },
    spawnDetachedChecked: async () => { events.push(["spawn"]); return { pid: 1 }; } };
  const remove = GameQuarantine.removeGameQuarantine;
  GameQuarantine.removeGameQuarantine = async (targets, dependencies) => {
    events.push(["quarantine", targets, dependencies.platform]);
    return [];
  };
  t.after(() => { GameQuarantine.removeGameQuarantine = remove; });
  await ElectronApp.provider.launchRuntime("electron-app", entry, context);
  assert.deepEqual(events, [["quarantine", { appRoot: app, gameRoot: release }, "darwin"], ["spawn"]]);

  // A failed clear warns but still starts the game, which its owner can approve by hand.
  GameQuarantine.removeGameQuarantine = async () => { throw new Error("Could not prepare the game's app: permission denied"); };
  events.length = 0;
  await ElectronApp.provider.launchRuntime("electron-app", entry, context);
  assert.deepEqual(events.map(([first]) => first), ["warn", "spawn"]);
});

test("the loader is unpacked beside app.asar so every Electron release can read it", () => {
  assert.ok(require("../package.json").build.asarUnpack.includes("src/runtime/electron-app.js"));
  assert.equal(ElectronApp.loaderPath("/Applications/MacLauncher.app/Contents/Resources/app.asar/src/runtime/electron-app.js"),
    "/Applications/MacLauncher.app/Contents/Resources/app.asar.unpacked/src/runtime/electron-app.js");
  assert.equal(ElectronApp.loaderPath(), path.resolve(__dirname, "../src/runtime/electron-app.js"));
});

function fakeElectron(calls, { ready = true } = {}) {
  return { app: {
    setVersion: value => calls.push(["version", value]), setName: value => calls.push(["name", value]),
    setPath: (name, value) => calls.push(["path", name, value]), getPath: name => `/home/Library/${name}`,
    setAppPath: value => calls.push(["appPath", value]), isReady: () => ready, once: (event, listener) => calls.push(["once", event, listener]),
    dock: { setIcon: value => calls.push(["icon", value]) }
  } };
}
function processState(t) {
  const argv = process.argv, resourcesPath = process.resourcesPath, defaultApp = Object.getOwnPropertyDescriptor(process, "defaultApp");
  t.after(() => {
    process.argv = argv;
    if (resourcesPath === undefined) delete process.resourcesPath; else process.resourcesPath = resourcesPath;
    if (defaultApp) Object.defineProperty(process, "defaultApp", defaultApp); else delete process.defaultApp;
  });
}

test("the loader sets up the app as Electron does for a packaged app, then runs its main script", t => {
  processState(t);
  const app = path.join(fixture(t), "Game", "resources", "app"), calls = [];
  write(path.join(app, "package.json"), JSON.stringify({ name: "authored-game", productName: "Authored Game", version: "1.2.3", main: "main.js" }));
  write(path.join(app, "main.js"), "global.__electronAppLoaded = { argv: process.argv.slice(), resourcesPath: process.resourcesPath };");
  t.after(() => { delete global.__electronAppLoaded; });
  const argv = ["/Electron", "/loader.js", `--maclauncher-electron-app=${app}`, "--use-mock-keychain", "--maclauncher-dock-icon=/icons/game.png",
    `--maclauncher-game-arguments=${Buffer.from(JSON.stringify(["--windowed"])).toString("base64")}`];
  Loader.start({ electron: fakeElectron(calls), argv });
  assert.deepEqual(calls, [["version", "1.2.3"], ["name", "Authored Game"], ["path", "userData", "/home/Library/appData/Authored Game"],
    ["appPath", app], ["icon", "/icons/game.png"]]);
  assert.deepEqual(global.__electronAppLoaded, { argv: [process.execPath, "--windowed"], resourcesPath: path.dirname(app) });

  // An Electron started as a default app keeps the app's path as its first argument.
  delete global.__electronAppLoaded;
  Object.defineProperty(process, "defaultApp", { configurable: true, value: true });
  const other = path.join(fixture(t), "resources", "app");
  write(path.join(other, "package.json"), JSON.stringify({ name: "second" }));
  write(path.join(other, "index.js"), "global.__electronAppLoaded = { argv: process.argv.slice() };");
  const later = [];
  Loader.start({ electron: fakeElectron(later, { ready: false }), argv: ["/Electron", `--maclauncher-electron-app=${other}`, "--maclauncher-dock-icon=/icons/b.png"] });
  assert.deepEqual(global.__electronAppLoaded.argv, [process.execPath, other]);
  const waiting = later.find(call => call[0] === "once");
  assert.equal(waiting[1], "ready");
  waiting[2]();
  assert.deepEqual(later.at(-1), ["icon", "/icons/b.png"]);

  assert.throws(() => Loader.start({ electron: fakeElectron([]), argv: ["/Electron", "--maclauncher-electron-app=relative/app"] }), /absolute Electron app path/);
  assert.throws(() => Loader.gameArguments([`--maclauncher-game-arguments=${Buffer.from("[1]").toString("base64")}`]), /Invalid game launch arguments/);
});

test("the loader imports an ES module app", async t => {
  processState(t);
  const app = path.join(fixture(t), "resources", "app");
  write(path.join(app, "package.json"), JSON.stringify({ name: "module-game", type: "module", main: "main.js" }));
  write(path.join(app, "main.js"), "globalThis.__electronModuleLoaded = import.meta.url;");
  t.after(() => { delete globalThis.__electronModuleLoaded; });
  await Loader.start({ electron: fakeElectron([]), argv: ["/Electron", `--maclauncher-electron-app=${app}`] });
  assert.ok(globalThis.__electronModuleLoaded.endsWith("/resources/app/main.js"));
});

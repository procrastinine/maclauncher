const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { createElectronGameHost } = require("../src/modules/shared/web/runtime/electron-host");
const { parseArguments, runElectronGame } = require("../src/runtime/electron-game");

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
const settle = () => new Promise(resolve => setImmediate(resolve));

function fakeElectron({ loadURL, constructError, response = 0 } = {}) {
  let nextId = 1;
  const windows = [];
  const sessions = new Map();
  const dialogs = [];
  const externalUrls = [];
  class BrowserWindow extends EventEmitter {
    constructor(config) {
      super();
      if (constructError) throw constructError;
      this.config = config;
      this.destroyed = false;
      this.calls = [];
      this.resizable = true;
      this.size = [config.width, config.height];
      const wc = new EventEmitter();
      Object.assign(wc, {
        id: nextId++, userAgent: "Electron Test", devtools: false,
        setWindowOpenHandler: handler => { wc.windowOpenHandler = handler; },
        getUserAgent: () => wc.userAgent,
        setUserAgent: value => { wc.userAgent = value; },
        isDestroyed: () => this.destroyed,
        isDevToolsOpened: () => wc.devtools,
        openDevTools: config => { wc.devtools = true; wc.devtoolsConfig = config; },
        focusDevTools: () => { wc.devtoolsFocused = true; },
        reloadIgnoringCache: () => this.calls.push(["reload"]),
        send: (...args) => this.calls.push(["send", ...args])
      });
      this.wc = wc;
      windows.push(this);
    }
    get webContents() {
      // Real Electron no longer exposes webContents once a window is destroyed.
      if (this.destroyed) throw new Error("Object has been destroyed");
      return this.wc;
    }
    async loadURL(url) {
      this.url = url;
      if (loadURL) await loadURL(this, url);
    }
    isDestroyed() { return this.destroyed; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
    }
    close() { this.calls.push(["close"]); this.destroy(); }
    show() { this.calls.push(["show"]); }
    hide() { this.calls.push(["hide"]); }
    focus() { this.calls.push(["focus"]); }
    maximize() { this.calls.push(["maximize"]); }
    minimize() { this.calls.push(["minimize"]); }
    restore() { this.calls.push(["restore"]); }
    isFullScreen() { return Boolean(this.fullScreen); }
    setFullScreen(value) { this.fullScreen = value; this.calls.push(["fullScreen", value]); }
    setPosition(...args) { this.calls.push(["position", ...args]); }
    setAlwaysOnTop(value) { this.calls.push(["alwaysOnTop", value]); }
    isResizable() { return this.resizable; }
    setResizable(value) { this.resizable = value; this.calls.push(["resizable", value]); }
    setSize(...args) { this.size = args; this.calls.push(["size", ...args]); }
    setContentSize(...args) { this.size = args; this.calls.push(["contentSize", ...args]); }
    getSize() { return this.size; }
    getContentSize() { return this.size; }
    static getFocusedWindow() { return BrowserWindow.focusedWindow; }
  }
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: true, whenReady: async () => {}, setName() {},
    getPath: () => os.tmpdir(), setPath() {}, quit() {},
    commandLine: { appendSwitch() {} }
  });
  let menu = { previous: true };
  const electron = {
    app, BrowserWindow, ipcMain: new EventEmitter(),
    dialog: { showMessageBox: async (...args) => { dialogs.push(args); return { response }; } },
    shell: { openExternal: async url => externalUrls.push(url) },
    Menu: {
      getApplicationMenu: () => menu,
      setApplicationMenu: next => { menu = next; },
      buildFromTemplate: template => ({ template })
    },
    session: {
      fromPartition: (partitionId, options) => {
        if (!sessions.has(partitionId)) {
          const current = { partitionId, options, listener: null, listenerChanges: [] };
          current.webRequest = { onBeforeRequest: listener => {
            current.listener = listener;
            current.listenerChanges.push(listener);
          } };
          sessions.set(partitionId, current);
        }
        return sessions.get(partitionId);
      }
    }
  };
  return { electron, windows, sessions, dialogs, externalUrls };
}

function fixture(t, { hosted, hooks, fakeOptions } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "electron-host-"));
  const root = path.join(temp, "game");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "index.html"), "<html>Game</html>");
  const entry = { moduleId: "sample", gameType: "web", gameId: "game-1", gamePath: root,
    indexHtml: path.join(root, "index.html"), name: "Sample Game" };
  const info = {
    id: "sample", label: "Sample", supports: { cheats: true },
    runtime: { default: "electron", supported: ["electron", "nwjs"],
      hosted: { id: "electron", fallback: "nwjs", ...hosted },
      entries: { electron: { label: "Electron" }, nwjs: { label: "NW.js" } } }
  };
  const launches = [];
  const mod = {
    cheats: { normalize: value => ({ enabled: value?.enabled === true }) },
    launchRuntime: async (...args) => { launches.push(args); return { pid: 123 }; }
  };
  const registry = { getModule: () => mod, getModuleInfo: () => info };
  const fake = fakeElectron(fakeOptions);
  const servers = [];
  const createStaticServer = async (rootDir, options) => {
    const server = { rootDir, options, port: 32000 + servers.length, closed: 0,
      close: async () => { server.closed++; } };
    servers.push(server);
    return server;
  };
  const userDataDir = path.join(temp, "user-data");
  const host = createElectronGameHost({ electron: fake.electron, userDataDir, logger: quietLogger,
    registry, createStaticServer, isSmoke: true, devtoolsEnabled: false, ...hooks });
  t.after(async () => { await host.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  return { ...fake, host, entry, root, temp, userDataDir, servers, info, mod, launches };
}

function preloadValue(win, key) {
  const prefix = `--maclauncher-${key}=`;
  const value = win.config.webPreferences.additionalArguments.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
  return value == null ? null : decodeURIComponent(value);
}

function requestPolicy(netSession, url) {
  let result;
  netSession.listener({ url }, value => { result = value; });
  return result;
}

test("host asset read roots come from the module and are passed only to its static server", async t => {
  const f = fixture(t), source = path.join(f.temp, "original-assets"); fs.mkdirSync(source);
  f.mod.getContentReadRoots = (entry, context) => {
    assert.equal(entry, f.entry); assert.equal(context.userDataDir, f.userDataDir); return [source];
  };
  const result = await f.host.createGameWindow(f.entry, { context: { settings: {}, userDataDir: f.userDataDir } });
  assert.deepEqual(f.servers[0].options.readRoots, [source]);
  assert.equal(preloadValue(result.win, "content-root"), f.root);
  assert.ok(!result.win.config.webPreferences.additionalArguments.some(value => value.includes(source)));
});

test("helper and bootstrap can be required without loading Electron or main", () => {
  const hostPath = require.resolve("../src/modules/shared/web/runtime/electron-host");
  const runtimePath = require.resolve("../src/runtime/electron-game");
  const result = spawnSync(process.execPath, ["-e", `
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function(id, ...args) {
      if (id === 'electron' || /main\\/main/.test(id)) throw new Error('Forbidden import: ' + id);
      return original.call(this, id, ...args);
    };
    require(${JSON.stringify(hostPath)});
    require(${JSON.stringify(runtimePath)});
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("core context preserves hosted configuration, metadata save override, cheats and UA", async t => {
  const { host, entry, root, userDataDir, servers } = fixture(t, {
    hosted: { saveDirectory: true, userAgent: { suffix: "NW.js/{nwjsVersion}", hint: "NW.js/" } }
  });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ window: { width: 960, height: 540, title: "Game title" } }));
  entry.saveDirOverride = path.join(root, "Custom Saves");
  entry.defaultSaveDir = path.join(root, "Default Saves");
  entry.cheats = { enabled: true };
  const cheatsFilePath = path.join(userDataDir, "cheats.json");
  const { win, saveDir, origin } = await host.createGameWindow(entry, { runtimeId: "electron", context: {
    settings: {}, moduleSettings: {}, runtimeSettings: { enableProtections: false },
    toolsButtonVisible: false, cheatsFilePath, nwjsVersion: "0.99.1"
  } });
  assert.equal(win.config.width, 960);
  assert.equal(preloadValue(win, "game-data-dir"), path.join(userDataDir, "games", entry.gameId));
  assert.equal(win.config.height, 540);
  assert.equal(win.config.title, "Game title");
  assert.equal(win.config.useContentSize, true);
  assert.equal(win.config.webPreferences.nodeIntegration, true);
  assert.equal(win.config.webPreferences.contextIsolation, false);
  assert.equal(win.config.webPreferences.sandbox, false);
  assert.equal(win.config.webPreferences.devTools, true);
  assert.equal(win.config.webPreferences.preload, path.resolve(__dirname, "../src/modules/shared/web/preload/game.js"));
  assert.equal(win.config.webPreferences.session.partitionId, "persist:maclauncher-game-unrestricted-game-1");
  assert.equal(win.config.webPreferences.session.listener, null);
  assert.equal(saveDir, entry.saveDirOverride);
  assert.equal(preloadValue(win, "save-dir"), entry.saveDirOverride);
  assert.equal(preloadValue(win, "content-root"), root);
  assert.equal(preloadValue(win, "cheats-file"), cheatsFilePath);
  assert.deepEqual(JSON.parse(preloadValue(win, "cheats")), { enabled: true });
  assert.equal(preloadValue(win, "tools-button"), "0");
  assert.equal(preloadValue(win, "unrestricted"), "1");
  assert.equal(preloadValue(win, "nwjs-version"), "0.99.1");
  assert.equal(win.webContents.userAgent, "Electron Test NW.js/0.99.1");
  assert.deepEqual(win.webContents.windowOpenHandler(), { action: "deny" });
  assert.deepEqual(host.policies.get(win.webContents.id), { enableProtections: false, allowExternal: true });
  assert.equal(win.url, `${origin}/index.html`);
  assert.equal(servers[0].rootDir, root);
  assert.equal(servers[0].options.logger, quietLogger);
  win.close();
  await settle();
  assert.equal(servers[0].closed, 1);
  assert.equal(host.policies.size, 0);
});

test("save injection follows metadata rather than module IDs and UA hints avoid duplicates", async t => {
  const { host, entry, info, windows } = fixture(t, { hosted: { userAgent: { suffix: "NW.js/1", hint: "Electron" } } });
  entry.moduleId = "mv";
  entry.saveDirOverride = "/save";
  const { win, saveDir } = await host.createGameWindow(entry);
  assert.equal(saveDir, null);
  assert.equal(preloadValue(win, "save-dir"), null);
  assert.equal(win.webContents.userAgent, "Electron Test");
  info.runtime.hosted.saveDirectory = true;
  entry.moduleId = "different-module";
  await host.createGameWindow(entry);
  assert.equal(preloadValue(windows[1], "save-dir"), "/save");
});

test("legacy hooks receive the original entry, settings and runtime", async t => {
  const settings = { modules: {} }, calls = [];
  const { host, entry } = fixture(t, { hooks: {
    loadSettings: () => settings,
    resolveModuleSettings: (value, id) => { calls.push(["module", value, id]); return {}; },
    resolveRuntimeSettingsForEntry: (value, cfg, info, id) => {
      calls.push(["runtime", value, cfg, info.id, id]); return { enableProtections: false };
    },
    resolveRuntimeSupportForEntry: () => ["electron"],
    normalizeCheatsForModule: (id, value) => { calls.push(["cheats", id, value]); return { enabled: true }; },
    writeCheatsFile: (id, moduleId, value) => { calls.push(["write", id, moduleId, value]); return "/cheats.json"; },
    resolveToolsButtonVisible: () => false,
    resolvePreferredNwjsVersion: () => "1.2.3",
    resolveUserAgentSuffix: (raw, context) => { calls.push(["ua", raw, context]); return "Custom UA"; },
    onWindowCreated: (win, value) => calls.push(["window", win, value]),
    applyDockIdentity: value => calls.push(["dock", value])
  } });
  const { win } = await host.createGameWindow(entry);
  assert.deepEqual(calls.find(call => call[0] === "runtime").slice(1), [entry, settings, "sample", "electron"]);
  assert.deepEqual(calls.find(call => call[0] === "write").slice(1), ["game-1", "sample", { enabled: true }]);
  assert.equal(calls.find(call => call[0] === "window")[2], entry);
  assert.equal(calls.find(call => call[0] === "dock")[1], entry);
  assert.equal(win.webContents.userAgent, "Electron Test Custom UA");
  assert.equal(preloadValue(win, "cheats-file"), "/cheats.json");
});

test("container and staged roots encode each index URL segment", async t => {
  const { host, entry, temp, root, servers } = fixture(t);
  const container = path.join(temp, "game.container");
  fs.writeFileSync(container, "container");
  const subdir = path.join(root, "a folder #?");
  fs.mkdirSync(subdir);
  const indexHtml = path.join(subdir, "index #?%.html");
  fs.writeFileSync(indexHtml, "index");
  entry.gamePath = container;
  entry.indexHtml = indexHtml;
  const staged = await host.createGameWindow(entry, { context: {}, runtimeSettings: {} });
  assert.equal(servers[0].rootDir, subdir);
  assert.equal(staged.win.url, `${staged.origin}/index%20%23%3F%25.html`);
  assert.equal(preloadValue(staged.win, "game-dir"), container);
  assert.equal(preloadValue(staged.win, "content-root"), subdir);
  entry.contentRootDir = root;
  const nested = await host.createGameWindow(entry);
  assert.equal(servers[1].rootDir, root);
  assert.equal(nested.win.url, `${nested.origin}/a%20folder%20%23%3F/index%20%23%3F%25.html`);
});

test("the core static server actually serves the encoded staged index and closes on disposal", async t => {
  const { createStaticServer } = require("../src/core/static-server");
  const { host, entry, root } = fixture(t, { hooks: { createStaticServer } });
  const indexHtml = path.join(root, "index #?%.html");
  fs.writeFileSync(indexHtml, "<html>Encoded game index</html>");
  entry.indexHtml = indexHtml;
  const { win, server } = await host.createGameWindow(entry);
  const response = await fetch(win.url, { headers: { Connection: "close" } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "<html>Encoded game index</html>");
  await host.dispose();
  assert.equal(server.server.listening, false);
});

test("escaping and symlinked indexes are rejected before creating a server or window", async t => {
  const { host, entry, temp, root, servers, windows } = fixture(t);
  const outside = path.join(temp, "outside.html");
  fs.writeFileSync(outside, "outside");
  entry.indexHtml = outside;
  await assert.rejects(host.createGameWindow(entry), /inside the content root/);
  const link = path.join(root, "linked.html");
  fs.symlinkSync(outside, link);
  entry.indexHtml = link;
  await assert.rejects(host.createGameWindow(entry), /inside the content root/);
  assert.equal(servers.length, 0);
  assert.equal(windows.length, 0);
});

test("offline restrictions permit local HTTP and WS only on registered ports", async t => {
  const { host, entry } = fixture(t);
  const { win, origin } = await host.createGameWindow(entry);
  const netSession = win.config.webPreferences.session;
  const port = new URL(origin).port;
  for (const url of [origin, `http://localhost:${port}/a`, `ws://127.0.0.1:${port}/socket`,
    `wss://localhost:${port}/socket`, `ws://[::1]:${port}/socket`, "data:text/plain,hello", "blob:null/id",
    "devtools://devtools/a", "chrome-devtools://a", "chrome://a", "chrome-extension://id/a"]) {
    assert.deepEqual(requestPolicy(netSession, url), {}, url);
  }
  for (const url of ["https://example.com/a", "ws://localhost:1234/socket", "wss://127.0.0.1:1234/a",
    "ws://localhost/a", `ws://remote.example:${port}/a`, "file:///tmp/game", "invalid"]) {
    assert.deepEqual(requestPolicy(netSession, url), { cancel: true }, url);
  }
  win.close();
  await settle();
  assert.equal(netSession.listener, null);
});

test("shared sessions retain active ports and detach restrictions after the last window", async t => {
  const { host, entry, servers } = fixture(t);
  const first = await host.createGameWindow(entry);
  const second = await host.createGameWindow(entry);
  const netSession = first.win.config.webPreferences.session;
  assert.equal(netSession, second.win.config.webPreferences.session);
  assert.equal(netSession.listenerChanges.length, 1);
  first.win.close();
  await settle();
  assert.deepEqual(requestPolicy(netSession, first.origin), { cancel: true });
  assert.deepEqual(requestPolicy(netSession, second.origin), {});
  await host.dispose();
  assert.equal(netSession.listener, null);
  assert.deepEqual(servers.map(server => server.closed), [1, 1]);
  await assert.rejects(host.createGameWindow(entry), /disposed/);
});

test("main can share its policy map and retain policies owned by other windows", async t => {
  const policies = new Map([[999, { allowExternal: false }]]);
  const { host, entry } = fixture(t, { hooks: { policies } });
  assert.equal(host.policies, policies);
  const { win } = await host.createGameWindow(entry);
  assert.deepEqual(policies.get(win.webContents.id), { allowExternal: false, enableProtections: true });
  await host.dispose();
  assert.deepEqual([...policies], [[999, { allowExternal: false }]]);
});

test("dispose waits for a server already closing and repeated calls share cleanup", async t => {
  let releaseClose;
  const closePromise = new Promise(resolve => { releaseClose = resolve; });
  const { host, entry } = fixture(t, { hooks: {
    createStaticServer: async () => ({ port: 32001, close: () => closePromise })
  } });
  const { win } = await host.createGameWindow(entry);
  win.close();
  let disposed = false;
  const first = host.dispose();
  const second = host.dispose();
  assert.equal(first, second);
  first.then(() => { disposed = true; });
  await settle();
  assert.equal(disposed, false);
  releaseClose();
  await second;
  assert.equal(disposed, true);
});

test("partition setup and BrowserWindow construction failures close allocated servers", async t => {
  const failedPartition = fixture(t);
  failedPartition.entry.gameId = null;
  await assert.rejects(failedPartition.host.createGameWindow(failedPartition.entry), /partition/);
  assert.equal(failedPartition.servers[0].closed, 1);
  assert.equal(failedPartition.windows.length, 0);
  const failedWindow = fixture(t, { fakeOptions: { constructError: new Error("Window failed") } });
  await assert.rejects(failedWindow.host.createGameWindow(failedWindow.entry), /Window failed/);
  assert.equal(failedWindow.servers[0].closed, 1);
  assert.equal([...failedWindow.sessions.values()][0].listener, null);
  assert.equal(failedWindow.host.policies.size, 0);
});

test("load rejection cleans the window, policy, restriction and server without a failure event", async t => {
  const { host, entry, windows, sessions, servers, dialogs } = fixture(t, {
    fakeOptions: { loadURL: async () => { throw new Error("Load rejected"); } }
  });
  await assert.rejects(host.createGameWindow(entry), /Load rejected/);
  assert.equal(windows[0].isDestroyed(), true);
  assert.equal(host.policies.size, 0);
  assert.equal([...sessions.values()][0].listener, null);
  assert.equal(servers[0].closed, 1);
  assert.equal(dialogs.length, 0);
});

test("failed main-frame loads offer fallback once with a context for that runtime", async t => {
  const processRuns = [], contexts = [];
  const { host, entry, dialogs, launches, servers } = fixture(t, {
    hooks: { isSmoke: false,
      buildModuleLaunchContext: (value, settings, options) => {
        const context = { settings, ...options, runtimeSettings: { enableProtections: false }, spawnDetachedChecked() {} };
        contexts.push([value, context]); return context;
      },
      onProcessRun: (...args) => processRuns.push(args)
    },
    fakeOptions: { response: 1, loadURL: async win => {
      win.webContents.emit("did-fail-load", {}, -7, "Load failed", "url", true);
      win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
      throw new Error("Load failed");
    } }
  });
  await assert.rejects(host.createGameWindow(entry), /Load failed/);
  assert.equal(dialogs.length, 1);
  assert.deepEqual(dialogs[0][1].buttons, ["Close", "Launch with NW.js"]);
  assert.equal(launches.length, 1);
  assert.equal(launches[0][0], "nwjs");
  assert.equal(launches[0][2], contexts[0][1]);
  assert.equal(launches[0][2].runtimeId, "nwjs");
  assert.deepEqual(processRuns[0], [entry, { pid: 123 }, "nwjs"]);
  assert.equal(host.policies.size, 0);
  assert.equal(servers[0].closed, 1);
});

test("subframe failures and clean exits keep the host running; crashes clean up", async t => {
  const { host, entry, dialogs, servers } = fixture(t, { hooks: { isSmoke: false } });
  const { win } = await host.createGameWindow(entry);
  win.webContents.emit("did-fail-load", {}, -7, "Subframe", "url", false);
  win.webContents.emit("render-process-gone", {}, { reason: "clean-exit" });
  await settle();
  assert.equal(dialogs.length, 0);
  assert.equal(servers[0].closed, 0);
  win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 9 });
  await settle();
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0][1].detail, /crashed.*exit 9/);
  assert.equal(win.isDestroyed(), true);
  assert.equal(servers[0].closed, 1);
});

test("IPC controls and external shell opening are scoped to the owned sender", async t => {
  const { host, entry, electron, externalUrls } = fixture(t);
  host.installIpc();
  host.installIpc();
  assert.equal(electron.ipcMain.listenerCount("maclauncher:window:show"), 1);
  const protectedGame = await host.createGameWindow(entry);
  const unrestrictedGame = await host.createGameWindow(entry, { runtimeSettings: { enableProtections: false } });
  const sender = { sender: unrestrictedGame.win.webContents };
  const unrelated = { sender: { id: sender.sender.id } };
  electron.ipcMain.emit("maclauncher:window:hide", unrelated);
  assert.equal(unrestrictedGame.win.calls.length, 0);
  electron.ipcMain.emit("maclauncher:window:hide", sender);
  electron.ipcMain.emit("maclauncher:game:reload", sender);
  electron.ipcMain.emit("maclauncher:window:moveTo", sender, 10.2, -20.8);
  electron.ipcMain.emit("maclauncher:window:moveTo", sender, "bad", 10);
  unrestrictedGame.win.resizable = false;
  electron.ipcMain.emit("maclauncher:window:resizeTo", sender, 100, 480.6, { mode: "outer" });
  electron.ipcMain.emit("maclauncher:window:resizeTo", sender, Infinity, 10);
  assert.deepEqual(unrestrictedGame.win.calls.slice(0, 3), [["hide"], ["reload"], ["position", 10, -21]]);
  assert.ok(unrestrictedGame.win.calls.some(call => JSON.stringify(call) === JSON.stringify(["size", 200, 481])));
  assert.equal(unrestrictedGame.win.resizable, false);
  electron.ipcMain.emit("maclauncher:shell:openExternal", { sender: protectedGame.win.webContents }, "https://example.com");
  electron.ipcMain.emit("maclauncher:shell:openExternal", unrelated, "https://unrelated.example");
  for (const url of ["invalid", "javascript:alert(1)", "custom:thing", "https://example.com", "mailto:test@example.com", "file:///tmp/a"]) {
    electron.ipcMain.emit("maclauncher:shell:openExternal", sender, url);
  }
  await settle();
  assert.deepEqual(externalUrls, ["https://example.com", "mailto:test@example.com", "file:///tmp/a"]);
  await host.dispose();
  assert.equal(electron.ipcMain.listenerCount("maclauncher:window:show"), 0);
});

test("legacy fullscreen IPC updates only its owned game window", async t => {
  const { host, entry, electron } = fixture(t);
  host.installIpc();
  const first = await host.createGameWindow(entry);
  const second = await host.createGameWindow(entry);
  const sender = { sender: first.win.webContents };
  electron.ipcMain.emit("maclauncher:window:setFullScreen", { sender: { id: sender.sender.id } }, true);
  assert.equal(first.win.isFullScreen(), false);
  electron.ipcMain.emit("maclauncher:window:setFullScreen", sender, true);
  assert.equal(first.win.isFullScreen(), true);
  assert.equal(second.win.isFullScreen(), false);
  electron.ipcMain.emit("maclauncher:window:toggleFullScreen", sender);
  assert.equal(first.win.isFullScreen(), false);
  electron.ipcMain.emit("maclauncher:window:setFullScreen", sender, true);
  electron.ipcMain.emit("maclauncher:window:setFullScreen", sender, false);
  assert.deepEqual(first.win.calls, [["fullScreen", true], ["fullScreen", false], ["fullScreen", true], ["fullScreen", false]]);
  await host.dispose();
  assert.equal(electron.ipcMain.listenerCount("maclauncher:window:setFullScreen"), 0);
});

test("Mac devtools shortcut and Tools menu target hosted windows", async t => {
  const { host, entry, electron } = fixture(t, { hooks: { platform: "darwin", devtoolsEnabled: true } });
  const { win } = await host.createGameWindow(entry);
  let prevented = 0;
  win.webContents.emit("before-input-event", { preventDefault: () => prevented++ }, { key: "i", type: "keyDown", meta: true, alt: true });
  assert.equal(prevented, 1);
  assert.deepEqual(win.webContents.devtoolsConfig, { mode: "detach" });
  const previous = electron.Menu.getApplicationMenu();
  host.installMenu();
  const menu = electron.Menu.getApplicationMenu();
  const tools = menu.template.find(item => item.label === "Tools").submenu;
  assert.equal(tools[0].accelerator, "CmdOrCtrl+Shift+T");
  electron.BrowserWindow.focusedWindow = win;
  tools[0].click();
  assert.deepEqual(win.calls.at(-1), ["send", "maclauncher:tools:toggle"]);
  electron.BrowserWindow.focusedWindow = { webContents: { id: -1 } };
  const count = win.calls.length;
  tools[1].click();
  assert.equal(win.calls.length, count);
  await host.dispose();
  assert.equal(electron.Menu.getApplicationMenu(), previous);
});

test("standalone bootstrap requires a game and launches through core without persisting the entry", async () => {
  assert.throws(() => parseArguments(["--runtime=electron"]), /game is required/);
  assert.deepEqual(parseArguments(["--game=/tmp/Game #?", "--runtime=electron", "--user-data=/tmp/data"]),
    { gamePath: "/tmp/Game #?", runtimeId: "electron", userDataDir: "/tmp/data" });
  const fake = fakeElectron();
  const entry = { gameId: "stored", gamePath: "/tmp/game" }, settings = { modules: {} };
  const calls = [];
  const launcher = {
    loadSettings: () => settings,
    resolveEntry: async (...args) => { calls.push(["resolve", ...args]); return entry; },
    getLaunchContext: () => ({ settings }),
    launchEntry: async (value, options) => {
      calls.push(["launch", value, options]);
      return launchHosted(value, options.runtimeId, { settings });
    }
  };
  let launchHosted;
  const host = {
    installIpc: () => calls.push(["ipc"]), installMenu: () => calls.push(["menu"]),
    dispose: async () => calls.push(["dispose"]),
    createGameWindow: async (...args) => { calls.push(["window", ...args]); return { win: {} }; }
  };
  const result = await runElectronGame({
    argv: ["--game=/tmp/game", "--runtime=electron", "--user-data=/tmp/user-data"],
    electron: fake.electron, logger: quietLogger,
    createLauncher: options => { launchHosted = options.launchHosted; assert.equal(options.userDataDir, "/tmp/user-data"); return launcher; },
    createElectronGameHost: options => { assert.equal(options.electron, fake.electron); return host; }
  });
  assert.equal(result.entry, entry);
  assert.deepEqual(calls.find(call => call[0] === "resolve"), ["resolve", "/tmp/game", { runtimeId: "electron", persist: false }]);
  assert.deepEqual(calls.find(call => call[0] === "launch"), ["launch", entry, { runtimeId: "electron", settings }]);
  assert.deepEqual(calls.find(call => call[0] === "window"), ["window", entry, { runtimeId: "electron", context: { settings } }]);
  fake.electron.app.emit("before-quit");
  assert.deepEqual(calls.at(-1), ["dispose"]);
});

test("standalone bootstrap disposes IPC and windows after core launch errors", async () => {
  const fake = fakeElectron();
  let disposed = 0;
  await assert.rejects(runElectronGame({
    argv: ["--game=/tmp/game"], electron: fake.electron,
    createLauncher: () => ({ loadSettings: () => ({}), resolveEntry: async () => { throw new Error("Detection failed"); } }),
    createElectronGameHost: () => ({ installIpc() {}, installMenu() {}, dispose: async () => { disposed++; } })
  }), /Detection failed/);
  assert.equal(disposed, 1);
  assert.equal(fake.electron.app.listenerCount("window-all-closed"), 0);
  assert.equal(fake.electron.app.listenerCount("before-quit"), 0);
});

test("the packaged bootstrap route starts the runtime module when it is required", () => {
  const bootstrapPath = require.resolve("../src/main/bootstrap");
  const result = spawnSync(process.execPath, ["-e", `
    const { EventEmitter } = require('node:events');
    const Module = require('node:module');
    const original = Module._load;
    const app = new EventEmitter();
    Object.assign(app, { setName() {}, setPath() {}, getPath: () => '/tmp',
      whenReady: async () => {}, quit() {}, exit: code => process.exit(code),
      commandLine: { appendSwitch() {} } });
    let launchHosted;
    Module._load = function(id, ...args) {
      if (id === 'electron') return { app };
      if (id === './main') throw new Error('Launcher UI must not initialize');
      if (id === '../core/launcher') return { createLauncher: options => {
        launchHosted = options.launchHosted;
        return { loadSettings: () => ({}), resolveEntry: async (_path, options) => {
          if (options.persist !== false) throw new Error('Runtime persisted entry');
          return { name: 'Game' };
        }, getLaunchContext: () => ({}), launchEntry: async entry => launchHosted(entry, 'electron', {}) };
      } };
      if (id === '../modules/shared/web/runtime/electron-host') return { createElectronGameHost: () => ({
        installIpc() {}, installMenu() {}, dispose: async () => {},
        createGameWindow: async () => { process.stdout.write('HOST_STARTED'); return { win: {} }; }
      }) };
      return original.call(this, id, ...args);
    };
    process.argv.push('--maclauncher-runtime-host', '--game=/tmp/game', '--runtime=electron');
    require(${JSON.stringify(bootstrapPath)});
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "HOST_STARTED");
});

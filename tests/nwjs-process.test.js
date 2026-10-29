const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { TOKEN_ENV, PROTOCOL_PREFIX } = require("../src/core/hosted-process");
const { STARTUP_FILE, installStartupReporter, launchNwjsProcess } = require("../src/modules/shared/web/runtime/nwjs-process");
const NwjsLauncher = require("../src/modules/shared/web/runtime/nwjs-launcher");
const NwjsPatchedLauncher = require("../src/modules/shared/web/runtime/nwjs-patched-launcher");

function wrapper(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-nw-ready-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "index.html"), "<title>Original</title>");
  fs.writeFileSync(path.join(directory, "existing.js"), "window.originalInjection = (window.originalInjection || 0) + 1;");
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ main: "index.html", inject_js_start: "existing.js" }));
  return directory;
}

test("NW reporter remains private and preserves earlier injections on repeat", t => {
  const directory = wrapper(t);
  const original = path.join(directory, "original-reporter.js");
  fs.writeFileSync(original, "original bytes");
  fs.mkdirSync(path.join(directory, "__maclauncher"));
  fs.symlinkSync(original, path.join(directory, "__maclauncher", "hosted-startup-reporter.js"));
  const url = installStartupReporter(directory);
  installStartupReporter(directory);
  assert.equal(fs.readFileSync(original, "utf8"), "original bytes");
  assert.equal(fs.lstatSync(path.join(directory, "__maclauncher", "hosted-startup-reporter.js")).isSymbolicLink(), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json")));
  assert.equal(manifest.inject_js_start, STARTUP_FILE);
  assert.deepEqual(manifest.maclauncher.startupInject, ["existing.js"]);
  assert.equal(url, pathToFileURL(path.join(directory, "index.html")).href);
});

test("NW injection waits for a loaded native window and retains game injection order", t => {
  const directory = wrapper(t);
  const url = installStartupReporter(directory);
  const events = {}, reports = [];
  const window = { location: { href: url }, addEventListener: (name, callback) => { events[name] = callback; } };
  window.top = window;
  const context = { window, document: { readyState: "loading" }, nw: {
    App: { startPath: directory }, Window: { get: () => ({ on: (name, callback) => { events[name] = callback; } }) }
  }, require: filename => {
    if (filename === path.join(directory, "__maclauncher", "hosted-startup-reporter.js")) {
      return { createHostedStartupReporter: () => ({ ready: report => reports.push(report), error: error => { throw error; } }) };
    }
    if (filename === "path") return path;
    if (filename === "fs") return fs;
    throw new Error(`Unexpected module require: ${filename}`);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(directory, STARTUP_FILE), "utf8"), context);
  assert.equal(window.originalInjection, 1);
  assert.equal(reports.length, 0);
  events.loaded();
  assert.equal(reports[0].host, "nwjs");
  assert.equal(reports[0].nativeWindowLoaded, true);
  assert.equal(reports[0].url, url);
});

test("NW browser-frame readiness waits for the exact inner document and forwards inner startup errors", t => {
  const directory = wrapper(t), readinessFrame = {id: "game-content", path: "content #é.html"}; fs.writeFileSync(path.join(directory, readinessFrame.path), "game");
  const url = installStartupReporter(directory, {readinessFrame}), contentUrl = pathToFileURL(path.join(directory, readinessFrame.path)).href;
  const events = {}, frameEvents = {}, childEvents = {}, reports = [], errors = [];
  const child = {location: {href: "about:blank"}, document: {readyState: "complete"}, addEventListener: (name, callback) => {childEvents[name] = callback;}};
  const frame = {id: readinessFrame.id, contentWindow: child, addEventListener: (name, callback) => {frameEvents[name] = callback;}};
  const window = {location: {href: url}, addEventListener() {}}; window.top = window;
  vm.runInNewContext(fs.readFileSync(path.join(directory, STARTUP_FILE), "utf8"), {window, URL,
    document: {readyState: "loading", getElementById: () => frame}, nw: {App: {startPath: directory}, Window: {get: () => ({on: (name, callback) => {events[name] = callback;}})}},
    require: filename => filename === path.join(directory, "__maclauncher/hosted-startup-reporter.js")
      ? {createHostedStartupReporter: () => ({ready: value => reports.push(value), error: error => errors.push(error.message)})} : require(filename)});
  events.loaded(); assert.equal(reports.length, 0, "empty outer shell or initial about:blank is not ready");
  child.location.href = contentUrl; child.document.readyState = "loading"; events["document-start"](frame);
  assert.equal(reports.length, 0); child.document.readyState = "complete"; frameEvents.load();
  assert.equal(reports[0].contentLoaded, true); assert.equal(reports[0].contentUrl, contentUrl);
  childEvents.error({message: "Original inner startup failure"}); assert.deepEqual(errors, ["Original inner startup failure"]);
});

test("NW parent requires authenticated inner document readiness instead of accepting a loaded container", async t => {
  const directory = wrapper(t), readinessFrame = {id: "game-content", path: "content.html"}; fs.writeFileSync(path.join(directory, readinessFrame.path), "game");
  for (const content of [{}, {contentLoaded: true, contentUrl: "about:blank"}, {contentLoaded: true, contentUrl: pathToFileURL(path.join(directory, readinessFrame.path)).href}]) {
    const child = fakeChild(), pending = launchNwjsProcess({executable: "/runtime/nwjs", args: [directory], wrapperDir: directory, readinessFrame, timeoutMs: 1000,
      spawn: async (_cmd, _args, options) => {setImmediate(() => child.stdout.write(`${PROTOCOL_PREFIX}${options.env[TOKEN_ENV]} ${JSON.stringify({protocol: 1, status: "ready", host: "nwjs", nativeWindowLoaded: true, url: pathToFileURL(path.join(directory, "index.html")).href, ...content})}\n`)); return child;}});
    if (content.contentUrl?.startsWith("file:")) assert.equal(await pending, child);
    else {await assert.rejects(pending, {code: "HOSTED_STARTUP_PROTOCOL"}); assert.equal(child.signalCode, "SIGKILL");}
  }
});

test("plain and patched NW wrappers inject into the game window and protect its browser requests", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-nw-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, "original"); fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, "index.html"), "<title>Original</title>");
  fs.writeFileSync(path.join(game, "author.js"), "window.authorInjection = true;");
  fs.writeFileSync(path.join(game, "package.json"), JSON.stringify({ main: "index.html", inject_js_start: "author.js" }));
  for (const [id, launcher] of [["plain", NwjsLauncher], ["patched", NwjsPatchedLauncher]]) {
    const directory = launcher.buildWrapper({ entry: { gameId: id, gamePath: game,
      contentRootDir: game, indexHtml: path.join(game, "index.html") }, moduleId: "web",
      userDataDir: path.join(root, "userData"), enableProtections: true, supportsCheats: false,
      patchConfig: { modules: [], scripts: [] } });
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    const requested = [], errors = [];
    const window = { location: { href: pathToFileURL(path.join(directory, "index.html")).href },
      fetch: url => { requested.push(url); return url; } };
    const context = { window, URL, navigator: {}, document: {}, process: { versions: { nw: "0.117.0" } },
      nw: { App: { startPath: directory, manifest } },
      require: name => {
        if (["fs", "path", "url"].includes(name)) return require(name);
        throw new Error(`Browser injections must not use CommonJS to load ${name}`);
      }, console: { error: (...args) => errors.push(args) } };
    vm.runInNewContext(fs.readFileSync(path.join(directory, "maclauncher-start.js"), "utf8"), context);
    assert.equal(window.authorInjection, true, id);
    assert.deepEqual(errors, [], id);
    assert.throws(() => window.fetch("https://example.test/telemetry"), /Outbound network disabled/, id);
    assert.deepEqual(requested, [], id);
    window.fetch("http://127.0.0.1/game");
    assert.deepEqual(requested, ["http://127.0.0.1/game"], id);
  }
});

test("NW network policy is independent of child guards in ordinary and patched wrappers", t => {
  const game = wrapper(t), entry = {gameId: "network", gameType: "web", gamePath: game, contentRootDir: game, indexHtml: path.join(game, "index.html")};
  for (const [name, launcher] of [["plain", NwjsLauncher], ["patched", NwjsPatchedLauncher]]) for (const networkIsolation of [false, true]) for (const enableProtections of [false, true]) {
    const directory = launcher.buildWrapper({entry: {...entry, gameId: name}, moduleId: "web", userDataDir: path.join(game, "data"), networkIsolation,
      enableProtections, runtimeSettings: {enableProtections}, patchConfig: {modules: [], scripts: []}});
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"))), guards = [];
    assert.equal(manifest.maclauncher.offlineEnabled, networkIsolation); assert.equal(manifest.maclauncher.childProcessProtection, enableProtections);
    assert.equal((manifest["chromium-args"] || "").includes("--proxy-server=127.0.0.1:9"), networkIsolation);
    if (manifest["bg-script"]) vm.runInNewContext(fs.readFileSync(path.join(directory, manifest["bg-script"]), "utf8"), {
      require: name => {guards.push(name); return {};}, nw: {App: {manifest}}, process: {env: {}}
    });
    assert.deepEqual(guards, [...(enableProtections ? ["./disable-child"] : []), ...(networkIsolation ? ["./disable-net"] : [])]);
  }
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  child.ref = child.unref = () => {};
  child.kill = signal => { child.signalCode = signal; setImmediate(() => child.emit("close", null, signal)); return true; };
  return child;
}

test("NW launch checks the requested document and forwards cwd, stdio and Rosetta", async t => {
  const directory = wrapper(t), child = fakeChild();
  const received = [];
  const result = await launchNwjsProcess({ executable: "/runtime/nwjs", args: [directory], wrapperDir: directory,
    needsRosetta: true, timeoutMs: 1000, spawn: async (...args) => {
      received.push(args);
      const report = { protocol: 1, status: "ready", host: "nwjs", nativeWindowLoaded: true,
        url: pathToFileURL(path.join(directory, "index.html")).href };
      setImmediate(() => child.stdout.write(`${PROTOCOL_PREFIX}${args[2].env[TOKEN_ENV]} ${JSON.stringify(report)}\n`));
      return child;
    } });
  assert.equal(result, child);
  assert.equal(received[0][2].cwd, directory);
  assert.deepEqual(received[0][2].stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(received[0][3], true);
});

test("plain and patched NW launches use the shared game context for effects and preserve Steam and startup state", async t => {
  const { createLauncher } = require("../src/core/launcher");
  const ReShade = require("../src/modules/shared/reshade");
  const Manager = require("../src/modules/shared/web/runtime/nwjs-manager");
  const Greenworks = require("../src/modules/shared/web/runtime/greenworks-preparation");
  const game = wrapper(t), userDataDir = path.join(game, "profile"), prepared = [], spawned = [];
  const steamEnvironment = { PATH: process.env.PATH, SteamAppId: "123", DYLD_INSERT_LIBRARIES: "/steam/overlay.dylib" };
  t.mock.method(Manager.core, "resolveBestInstalled", options => {
    assert.equal(options.version, "0.103.1", "The fixture explicitly selects the verified Greenworks-compatible host");
    return { version: "0.103.1", variant: "sdk", platformKey: "osx-arm64", executablePath: "/runtime/nwjs" };
  });
  t.mock.method(Greenworks, "resolveGreenworksRequirement", () => ({ needsGreenworks: true, greenworksVersion: "0.103.1", targets: [] }));
  t.mock.method(Greenworks, "ensureGreenworksInstalled", () => ({ installDir: "/runtime/greenworks" }));
  t.mock.method(Greenworks, "prepareLaunchEnvironment", async () => ({ environment: steamEnvironment }));
  t.mock.method(Greenworks, "overlayGreenworks", () => {});
  t.mock.method(ReShade, "prepare", async entry => {
    prepared.push(entry.gameId);
    return entry.effects ? { DYLD_INSERT_LIBRARIES: "/effects/reshade.dylib", RESHADE_EFFECT: "/effects/grayscale.fx" } : {};
  });
  const manifest = { id: "web", runtime: { default: "nwjs", supported: ["nwjs", "nwjs-patched"] } };
  const launcher = createLauncher({ userDataDir, registry: {
    getModule: () => ({ id: "web", manifest }), getModuleInfo: () => manifest, listModules: () => [manifest]
  }, rosetta: { requiresForExecutable: () => false }, spawn: (command, args, options) => {
    const child = fakeChild(); spawned.push({ command, args, options });
    process.nextTick(() => child.emit("spawn"));
    setImmediate(() => child.stdout.write(`${PROTOCOL_PREFIX}${options.env[TOKEN_ENV]} ${JSON.stringify({
      protocol: 1, status: "ready", host: "nwjs", nativeWindowLoaded: true,
      url: pathToFileURL(path.join(options.cwd, "index.html")).href
    })}\n`));
    return child;
  } });
  const grayscale = { schema: 2, mode: "advanced", enabled: true, video: [{ id: "shader", kind: "shader", enabled: true, shader: { enabled: true, preset: "grayscale" } }] };
  for (const [runtimeId, runtime] of [["nwjs", NwjsLauncher], ["nwjs-patched", NwjsPatchedLauncher]]) {
    for (const enabled of [false, true]) {
      const entry = { gameId: `${runtimeId}-${enabled}`, moduleId: "web", runtimeId, gameType: "web",
        gamePath: game, contentRootDir: game, indexHtml: path.join(game, "index.html"), effects: enabled ? grayscale : null, networkAccess: true };
      const settings = { runtimes: { nwjs: { defaultVersion: "0.103.1" } } };
      const gameArguments = ["--user-data-dir=/game argument", "A name", ""];
      const context = launcher.getLaunchContext(entry, settings, { runtimeId, gameEffects: true, gameArguments });
      await runtime.launchRuntime({ entry, moduleId: "web", userDataDir, settings, context, patchConfig: { modules: [], scripts: [] } });
      const call = spawned.at(-1);
      assert.equal(call.command, "/runtime/nwjs");
      assert.equal(call.options.env.SteamAppId, "123");
      assert.equal(call.options.env.DYLD_INSERT_LIBRARIES, enabled ? "/steam/overlay.dylib:/effects/reshade.dylib" : "/steam/overlay.dylib");
      assert.equal(call.options.env.RESHADE_EFFECT, enabled ? "/effects/grayscale.fx" : undefined);
      assert.ok(call.options.env[TOKEN_ENV]);
      assert.deepEqual(call.options.stdio, ["ignore", "pipe", "pipe"]);
      assert.deepEqual(call.args.slice(2), ["--", ...gameArguments], "application arguments follow the Chromium switch terminator");
      assert.ok(call.args[0].includes("0.103.1-osx-arm64-sdk"), "selected runtime/profile remain unchanged");
    }
  }
  assert.equal(prepared.length, 2, "both enabled NW modes reach the shared effect service; disabled launches skip preparation");
  assert.equal(steamEnvironment.DYLD_INSERT_LIBRARIES, "/steam/overlay.dylib");
  assert.equal(steamEnvironment.RESHADE_EFFECT, undefined);
});

test("effective core network policy overrides stale NW per-call runtime settings", async t => {
  const game = wrapper(t), Manager = require("../src/modules/shared/web/runtime/nwjs-manager");
  t.mock.method(Manager.core, "resolveBestInstalled", () => ({version: "0.115.0", variant: "sdk", platformKey: "osx-arm64", executablePath: "/runtime/nwjs"}));
  for (const [runtimeId, runtime] of [["nwjs", NwjsLauncher], ["nwjs-patched", NwjsPatchedLauncher]]) for (const networkAllowed of [false, true]) {
    let manifest, directory;
    const context = {networkAllowed, runtimeSettings: {networkIsolation: !networkAllowed, enableProtections: true},
      spawnDetachedChecked: async (_command, _args, options) => {
        directory = options.cwd; manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json")));
        const child = fakeChild(); setImmediate(() => child.stdout.write(`${PROTOCOL_PREFIX}${options.env[TOKEN_ENV]} ${JSON.stringify({protocol: 1, status: "ready", host: "nwjs", nativeWindowLoaded: true,
          url: pathToFileURL(path.resolve(directory, manifest.main)).href})}\n`)); return child;
      }};
    await runtime.launchRuntime({entry: {gameId: runtimeId, gamePath: game, contentRootDir: game, indexHtml: path.join(game, "index.html")}, moduleId: "web", userDataDir: path.join(game, "data"), settings: {},
      context, runtimeSettings: {networkIsolation: networkAllowed, enableProtections: false}, patchConfig: {modules: [], scripts: []}});
    assert.equal(manifest.maclauncher.offlineEnabled, !networkAllowed); assert.equal(manifest.maclauncher.childProcessProtection, true);
    assert.equal((manifest["chromium-args"] || "").includes("--proxy-server=127.0.0.1:9"), !networkAllowed);
    const bg = fs.readFileSync(path.join(directory, manifest["bg-script"]), "utf8"); assert.match(bg, /disable-child/);
    if (runtimeId === "nwjs") assert.equal(bg.includes("disable-net"), !networkAllowed);
  }
});

test("NW early exit returns its actual stderr instead of claiming a launched game", async t => {
  const directory = wrapper(t), child = fakeChild();
  await assert.rejects(launchNwjsProcess({ executable: "/runtime/nwjs", args: [directory], wrapperDir: directory,
    timeoutMs: 1000, spawn: async () => {
      setImmediate(() => { child.stderr.write("dyld: Library not loaded: missing.dylib\n"); child.exitCode = 1; child.emit("close", 1, null); });
      return child;
    } }), error => error.code === "HOSTED_STARTUP_EXIT" && error.stderr.includes("missing.dylib") && error.exitCode === 1);
});

test("NW refuses a loaded unrelated page and stops only its startup child", async t => {
  const directory = wrapper(t), child = fakeChild();
  await assert.rejects(launchNwjsProcess({ executable: "/runtime/nwjs", args: [directory], wrapperDir: directory,
    timeoutMs: 1000, spawn: async (_cmd, _args, options) => {
      setImmediate(() => child.stdout.write(`${PROTOCOL_PREFIX}${options.env[TOKEN_ENV]} ${JSON.stringify({
        protocol: 1, status: "ready", host: "nwjs", nativeWindowLoaded: true, url: "about:blank"
      })}\n`));
      return child;
    } }), { code: "HOSTED_STARTUP_PROTOCOL" });
  assert.equal(child.signalCode, "SIGKILL");
});

test("NW accepts its current app-origin document only with the requested root, app ID and index", async t => {
  const directory = wrapper(t), appId = "a".repeat(32);
  for (const extra of [{}, { appRoot: path.join(directory, "other") }, { appId: "b".repeat(32) },
    { url: `chrome-extension://${appId}/other.html` }]) {
    const child = fakeChild();
    const launch = launchNwjsProcess({ executable: "/runtime/nwjs", args: [directory], wrapperDir: directory,
      timeoutMs: 1000, spawn: async (_cmd, _args, options) => {
        const record = { protocol: 1, status: "ready", host: "nwjs", nativeWindowLoaded: true,
          appRoot: directory, appId, url: `chrome-extension://${appId}/index.html`, ...extra };
        setImmediate(() => child.stdout.write(`${PROTOCOL_PREFIX}${options.env[TOKEN_ENV]} ${JSON.stringify(record)}\n`));
        return child;
      } });
    if (Object.keys(extra).length) await assert.rejects(launch, { code: "HOSTED_STARTUP_PROTOCOL" });
    else assert.equal(await launch, child);
  }
});

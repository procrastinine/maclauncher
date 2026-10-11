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

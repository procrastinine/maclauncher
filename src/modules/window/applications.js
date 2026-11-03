const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn: spawnProcess } = require("node:child_process");
const readline = require("node:readline");
const Requirements = require("../shared/runtime/feature-requirements");

const HELPER = "maclauncher-graphics-window";

// Window graphics need the macOS release whose content picker reports the
// picked window, and a graphics package that reports the window source.
// Everything here is local: no network request and no capture.
function availability({ root, platform = process.platform, macOSVersion, readRecord, publication } = {}) {
  const support = Requirements.requirementSupport(Requirements.WINDOW_GRAPHICS, { platform,
    macOSVersion: macOSVersion || (platform === "darwin" ? require("../shared/runtime/bundled-native").systemVersionSync() : null) });
  if (support.supported === false) return { available: false, reason: support.reason };
  try {
    root ||= require("../shared/reshade").runtimeRoot();
    const record = (readRecord || require("../shared/reshade/runtime-record").read)(root);
    if (record?.features?.graphics?.windowSourceAPI !== 2)
      return { available: false, reason: "The installed graphics runtime does not include window graphics." };
    const row = (publication || require("../shared/reshade/publication")).forRoot(root)?.files?.find(file => file.path === HELPER);
    const executable = path.join(root, HELPER);
    if (!row || !fs.statSync(executable).isFile()) return { available: false, reason: "The window graphics helper is missing." };
    return { available: true, root, row, executable, library: path.join(root, "libreshade-macos.dylib") };
  } catch {
    return { available: false, reason: "The graphics runtime is unavailable." };
  }
}

function helperEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(DYLD_|RESHADE_)/.test(key)) delete env[key];
  return env;
}

function run(executable, args, { execute = execFile, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = helperEnvironment();
    execute(executable, args, { env, timeout, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(JSON.parse(String(stdout).trim().split("\n").pop())); } catch (cause) { reject(cause); }
    });
  });
}

const validName = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
const validPath = value => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
const validReason = value => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);

// Running regular apps, most recently active first, without the launcher.
async function listApplications({ executable, excludePid = process.pid, execute } = {}) {
  const result = await run(executable, ["--list-applications", "--exclude-pid", String(excludePid)], { execute });
  if (result?.schema !== 1 || !Array.isArray(result.applications)) return [];
  return result.applications.filter(app => Number.isSafeInteger(app?.pid) && app.pid > 0 && validName(app.name)).slice(0, 64).map(app => ({
    pid: app.pid, name: app.name,
    ...(validName(app.bundleIdentifier) ? { bundleIdentifier: app.bundleIdentifier } : {}),
    ...(validPath(app.path) ? { path: app.path } : {}),
    ...(validPath(app.executable) ? { executable: app.executable } : {})
  }));
}

// Which of these bundle identifiers still name an installed app.
async function installedApplications(identifiers, { executable, execute } = {}) {
  const ids = [...new Set(identifiers)].filter(validName).slice(0, 64);
  if (!ids.length) return {};
  const result = await run(executable, ["--installed", ...ids], { execute });
  return result?.schema === 1 && result.installed && typeof result.installed === "object" ? result.installed : {};
}

const count = value => Number.isFinite(value) && value > 0 && value <= 100000 ? value : 0;
const identifier = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const THUMBNAIL = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, ICON = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
// One catalog event, validated: displays and windows with the fields the
// Apply Graphics window shows, the windows left out of that list (`more`),
// which only its search finds, a thumbnail of one of them, an app's icon, a
// missing permission, or a list that could not be read.
function catalogEvent(event) {
  if (event?.event === "permission") return { event: "permission", screenRecording: event.screenRecording === true };
  if (event?.event === "failed") return { event: "failed", ...(validReason(event.reason) ? { reason: event.reason } : {}) };
  if (event?.event === "icon")
    return validPath(event.path) && typeof event.image === "string" && event.image.length <= 128 * 1024 && ICON.test(event.image)
      ? { event: "icon", path: event.path, image: event.image } : null;
  if (event?.event === "thumbnail")
    return /^(window|display):\d{1,10}$/.test(event.target) && typeof event.image === "string" && event.image.length <= 512 * 1024 && THUMBNAIL.test(event.image)
      ? { event: "thumbnail", target: event.target, image: event.image } : null;
  if (event?.event !== "catalog" || !Array.isArray(event.displays) || !Array.isArray(event.windows)) return null;
  const displays = event.displays.filter(display => identifier(display?.id)).slice(0, 16).map(display => ({
    id: display.id, name: validName(display.name) ? display.name : "Display", width: count(display.width), height: count(display.height),
    main: display.main === true, ...(validName(display.uuid) ? { uuid: display.uuid } : {}) }));
  const rows = (list, limit) => (Array.isArray(list) ? list : []).filter(window => identifier(window?.id) && Number.isSafeInteger(window.pid) && window.pid > 0).slice(0, limit).map(window => ({
    id: window.id, pid: window.pid, application: validName(window.application) ? window.application : "Application",
    ...(validName(window.title) ? { title: window.title } : {}),
    ...(validName(window.bundleIdentifier) ? { bundleIdentifier: window.bundleIdentifier } : {}),
    ...(validPath(window.path) ? { path: window.path } : {}), ...(validPath(window.executable) ? { executable: window.executable } : {}),
    width: count(window.width), height: count(window.height), onScreen: window.onScreen === true }));
  const windows = rows(event.windows, 128), more = rows(event.more, 2048);
  return { event: "catalog", displays, windows, ...(more.length ? { more } : {}) };
}

// Pickers share a catalog relay, which connects to the capture service.
let catalog = null, exiting = Promise.resolve();
function watchCatalog({ executable, excludePid = process.pid, spawn = spawnProcess, onEvent = () => {}, onExit = () => {}, logger = console } = {}) {
  if (catalog && (catalog.ended || catalog.executable !== executable || catalog.excludePid !== excludePid)) stopCatalog();
  if (!catalog) catalog = startCatalog({ executable, excludePid, spawn, logger });
  const current = catalog, watcher = { onEvent, onExit };
  current.watchers.add(watcher);
  return { stop() {
    if (!current.watchers.delete(watcher) || current.watchers.size) return Promise.resolve();
    if (catalog === current) stopCatalog();
    return exiting;
  } };
}
function startCatalog({ executable, excludePid, spawn, logger }) {
  const current = { child: null, executable, excludePid, watchers: new Set(), ended: false, exited: null };
  const end = error => {
    if (current.ended) return;
    current.ended = true;
    if (catalog === current) catalog = null;
    for (const watcher of [...current.watchers]) watcher.onExit(error);
    current.watchers.clear();
  };
  const receive = raw => {
    if (current.ended) return;
    const event = catalogEvent(raw);
    if (event) for (const watcher of [...current.watchers]) watcher.onEvent(event);
  };
  const attach = child => {
    current.child = child;
    current.lines = readline.createInterface({ input: child.stdout });
    current.lines.on("line", line => {
      if (!line.startsWith("{")) return;
      try { receive(JSON.parse(line)); } catch { return; }
    });
    readline.createInterface({ input: child.stderr }).on("line", line => {
      try { logger.warn?.(`[window graphics] ${line.slice(0, 2048)}`); } catch {}
    });
    child.stdin?.on?.("error", () => {});
    current.exited = new Promise(resolve => {
      current.onError = error => { resolve();end(error); };current.onExit = () => { resolve();end(null); };
      child.on?.("error", current.onError);
      child.on?.("exit", current.onExit);
    });
  };
  const start = async () => {
    if (current.ended) return;
    try {
      if (!current.ended) attach(spawn(executable, ["--catalog", "--exclude-pid", String(excludePid)], { env: helperEnvironment(), stdio: ["pipe", "pipe", "pipe"] }));
    }
    catch (error) { end(error); }
  };
  current.started = exiting.then(start);
  return current;
}
// Ends the catalog helper: its input closes, and it exits once its in-flight
// previews finish. One still running two seconds later gets SIGTERM, and
// SIGKILL two seconds after that. Resolves when no catalog helper runs.
function stopCatalog() {
  const current = catalog;
  if (!current) return exiting;
  catalog = null;current.ended = true;current.watchers.clear();
  const previous = exiting;
  exiting = previous.then(async () => {
    await current.started;
    const { child } = current;
    if (!child || child.exitCode != null || child.signalCode != null) return;
    try { child.stdin?.end?.(); } catch {}
    const signal = (name, ms) => {
      const timer = setTimeout(() => { if (child.exitCode == null && child.signalCode == null) try { child.kill(name); } catch {} }, ms);
      timer.unref?.();return timer;
    };
    const timers = [signal("SIGTERM", 2000), signal("SIGKILL", 4000)];
    return current.exited.then(() => { for (const timer of timers) clearTimeout(timer); });
  });
  return exiting;
}

module.exports = { HELPER, availability, listApplications, installedApplications, catalogEvent, watchCatalog, stopCatalog };

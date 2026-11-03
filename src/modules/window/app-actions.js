const path = require("node:path");
const GameData = require("../shared/game-data");
const Applications = require("./applications");
const Stacks = require("../shared/effects/application-stacks");

function targetList(data) { return Array.isArray(data?.targets) ? data.targets : data?.target ? [data] : []; }
function targetId(data) { return data?.id || (data?.target === "window" ? "w" + data.windowID : data?.target === "display" ? "d" + data.displayID : data?.target === "application" ? "p" + data.pid : "all-displays"); }

const served = new Map();
function isServed(target, registry = served) {
  const key = targetId({ ...target, target: target.target || target.kind });
  return registry.has(key) || (key.startsWith("w") && registry.has("p" + target.pid))
    || (key.startsWith("d") && registry.has("all-displays"))
    || (key === "all-displays" && [...registry.keys()].some(value => /^d\d+$/.test(value)));
}

const SCREEN_RECORDING_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const validName = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
const validId = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;

// Running apps, for the graphics shortcut, which acts on the frontmost app.
// Their presence also makes the File and Dock items available.
async function targets(context = {}) {
  const helper = (context.windowGraphics || Applications.availability)({ root: context.graphicsRuntimeRoot });
  if (!helper.available) return [];
  const apps = await (context.listApplications || Applications.listApplications)({ executable: helper.executable, excludePid: context.excludePid });
  return apps.slice(0, 64).map(app => applicationTarget({ ...app, frontWindow: true }));
}
function applicationTarget(app) {
  return { id: "application:" + app.pid, label: app.name, ...(app.path ? { iconPath: app.path } : {}), target: { kind: "application", ...app } };
}

// The Apply Graphics window: every display, All Displays when there are
// several, and every capturable window grouped by app, with thumbnails. An
// app's icon comes from the catalog, by bundle path, else from its path.
// Windows the catalog leaves out of its list (`more`) are search-only
// targets without a preview, placed after their app's listed windows so each
// app stays one group while searching.
function catalogModel({ displays, windows, more = [] }, icons = new Map(), registry = served) {
  const screens = displays.map(display => ({ id: "display:" + display.id, label: display.name,
    ...(display.width && display.height ? { detail: `${Math.round(display.width)} × ${Math.round(display.height)}` } : {}), preview: true,
    target: { kind: "display", displayID: display.id, name: display.name, ...(display.uuid ? { uuid: display.uuid } : {}) } }));
  if (screens.length > 1) screens.push({ id: "displays:all", label: "All Displays", detail: `${screens.length} displays`,
    previews: screens.map(screen => screen.id), target: { kind: "all-displays", displayIDs: displays.map(display => display.id),
      displays: displays.map(display => ({ id: display.id, name: display.name, ...(display.uuid ? { uuid: display.uuid } : {}) })) } });
  const model = { sections: [
    { id: "displays", label: "Displays", targets: screens },
    { id: "windows", label: "Windows", empty: "No windows to show.", targets: searchableWindows(windows, more).map(window => ({
      id: "window:" + window.id, label: window.title || window.application, ...(window.searchOnly ? { searchOnly: true } : { preview: true }),
      ...(window.onScreen ? {} : { detail: "Other Space or minimized" }),
      group: { id: "application:" + window.pid, label: window.application,
        ...(icons.get(window.path) ? { icon: icons.get(window.path) } : window.path ? { iconPath: window.path } : {}) },
      target: { kind: "window", windowID: window.id, pid: window.pid, name: window.application,
        ...(window.title ? { title: window.title } : {}), ...(window.bundleIdentifier ? { bundleIdentifier: window.bundleIdentifier } : {}),
        ...(window.path ? { path: window.path } : {}), ...(window.executable ? { executable: window.executable } : {}) } })) }
  ] };
  for (const section of model.sections) for (const row of section.targets) if (isServed(row.target, registry))
    row.detail = [row.detail, "Has window graphics"].filter(Boolean).join(" · ");
  return model;
}
function searchableWindows(windows, more) {
  const extra = new Map();
  for (const window of more) { if (!extra.has(window.pid)) extra.set(window.pid, []);extra.get(window.pid).push({ ...window, searchOnly: true }); }
  const rows = [];
  windows.forEach((window, index) => {
    rows.push(window);
    if (windows[index + 1]?.pid !== window.pid && extra.has(window.pid)) { rows.push(...extra.get(window.pid));extra.delete(window.pid); }
  });
  for (const list of extra.values()) rows.push(...list);
  return rows;
}
// Without Screen Recording, apps are listed without previews, and choosing
// one opens the system window picker for it, which needs no permission.
function permissionModel(apps) {
  return { refreshOnFocus: true,
    notice: { message: "Previews and displays need the Screen & System Audio Recording permission. Choosing an app opens the macOS window picker for it.",
      link: { label: "Open Privacy Settings", url: SCREEN_RECORDING_SETTINGS } },
    sections: [
      { id: "displays", label: "Displays", targets: [], empty: "Displays need the Screen & System Audio Recording permission." },
      { id: "windows", label: "Apps", targets: apps.slice(0, 64).map(applicationTarget), empty: "No apps to show." }
    ] };
}
// A list that could not be read; refocusing the window tries again.
function unavailableModel(reason) {
  return { refreshOnFocus: true, sections: [], notice: { message: "The window list is unavailable." + (reason ? " " + reason : "") } };
}
// Runs while the Apply Graphics window is open. MacLauncher itself asks for
// Screen Recording, once, through context.screenAccess; without it the apps
// are listed for the system picker and no catalog runs.
function picker(context = {}, update = () => {}) {
  const helper = (context.windowGraphics || Applications.availability)({ root: context.graphicsRuntimeRoot });
  if (!helper.available) { update({ sections: [], notice: { message: helper.reason } });return { stop() {} }; }
  let stopped = false, watcher = null;
  const icons = new Map();
  async function withoutPermission() {
    let apps = [];
    try { apps = await (context.listApplications || Applications.listApplications)({ executable: helper.executable, excludePid: context.excludePid }); }
    catch (error) { context.logger?.warn?.("[window graphics] The app list is unavailable:", error.message); }
    if (!stopped) update(permissionModel(apps));
  }
  function watch() {
    watcher = (context.watchCatalog || Applications.watchCatalog)({ executable: helper.executable, excludePid: context.excludePid, logger: context.logger,
      onEvent: event => {
        if (stopped) return;
        // Icons arrive before the list that first names their apps.
        if (event.event === "icon") { icons.set(event.path, event.image);if (icons.size > 256) icons.delete(icons.keys().next().value); }
        else if (event.event === "catalog") update(catalogModel(event, icons));
        else if (event.event === "thumbnail") update({ thumbnails: { [event.target]: event.image } });
        else if (event.event === "permission" && !event.screenRecording) void withoutPermission();
        // The next list replaces the notice.
        else if (event.event === "failed") update(unavailableModel(event.reason));
      },
      onExit: error => {
        if (stopped) return;
        if (error) update(unavailableModel(error.message));
      } });
  }
  void Promise.resolve(context.screenAccess?.()).catch(() => null).then(status => {
    if (stopped) return;
    if (status === "denied" || status === "restricted") void withoutPermission();
    else watch();
  });
  // Resolves when the catalog helper has exited.
  return { stop() { stopped = true;return Promise.resolve(watcher?.stop()); } };
}

// A saved stack belongs to the app that owns the window, by bundle, else by
// executable and name; to one display; or to All Displays.
function targetIdentity(data = {}, name) {
  const defined = value => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
  if (data.target === "all-displays" || data.allDisplays === true) return { target: "all-displays" };
  if (data.target === "display") return defined({ target: "display", uuid: data.displayUUID, name: data.displayName || name });
  return defined({ target: "application", bundleIdentifier: data.bundleIdentifier, executablePath: data.executablePath, name: data.applicationName || name });
}
function identity(entry) { return targetIdentity(targetList(entry?.moduleData)[0], entry?.name); }
// Every app and display a session has served, kept after its targets leave,
// so the session saves its stack for them when it ends. An app whose window
// is still to be picked has served nothing yet, and the displays of All
// Displays count as All Displays.
const MAX_SERVED = 64;
function servedIdentities(entry, targets = targetList(entry?.moduleData)) {
  const served = new Map();
  const add = value => { if (value?.target && served.size < MAX_SERVED) served.set(JSON.stringify(value), value); };
  for (const value of Array.isArray(entry?.moduleData?.served) ? entry.moduleData.served : []) add(value);
  for (const target of targets) if (target.target !== "application" || target.windowID) add(targetIdentity(target, entry?.name));
  return [...served.values()];
}

// The entry's game path is its own session folder, which exists exactly as
// long as the entry. An app's own bundle supplies the library icon. The entry
// starts from the saved stack of its app or display, or from the default stack.
function createEntry(target, { userDataDir, gameId = GameData.createGameId() } = {}) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("The library folder is unavailable.");
  const folder = GameData.resolveGameDir(userDataDir, gameId);
  const common = { gameId, ephemeral: true, gamePath: folder, importPath: folder, contentRootDir: folder,
    moduleId: "window", engine: "window", gameType: "window", runtimeId: "capture" };
  const kind = target?.kind;
  let entry;
  if (kind === "display") {
    if (!validId(target.displayID)) throw new Error("Choose a display.");
    const name = validName(target.name) ? target.name : "Display";
    entry = { ...common, name, moduleData: { target: "display", displayID: target.displayID, displayName: name, ...(validName(target.uuid) ? { displayUUID: target.uuid } : {}) } };
  } else if (kind === "all-displays") {
    const displays = (Array.isArray(target.displays) ? target.displays : []).filter(display => validId(display?.id)).slice(0, 16).map(display => ({
      displayID: display.id, ...(validName(display.name) ? { displayName: display.name } : {}), ...(validName(display.uuid) ? { displayUUID: display.uuid } : {}) }));
    entry = { ...common, name: "All Displays", moduleData: { target: "all-displays", ...(Array.isArray(target.displayIDs) ? { displayIDs: target.displayIDs.filter(validId) } : {}),
      ...(displays.length ? { displays } : {}) } };
  } else if (kind === "window" || kind === "application") {
    if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || !validName(target.name) || (kind === "window" && !validId(target.windowID)))
      throw new Error("Choose a window or a running app.");
    const bundle = typeof target.path === "string" && /\.app$/i.test(target.path) ? target.path : null;
    entry = { ...common, name: target.name, ...(bundle ? { nativeAppPath: bundle } : {}),
      moduleData: { target: kind, pid: target.pid,
        ...(kind === "application" && target.frontWindow === true ? { frontWindow: true } : {}),
        ...(kind === "window" ? { windowID: target.windowID, applicationName: target.name, ...(validName(target.title) ? { windowTitle: target.title } : {}) } : {}),
        ...(validName(target.bundleIdentifier) ? { bundleIdentifier: target.bundleIdentifier } : {}),
        ...(bundle ? { applicationPath: bundle } : {}),
        ...(typeof target.executable === "string" && path.isAbsolute(target.executable) ? { executablePath: target.executable } : {}) } };
  } else throw new Error("Choose a window, an app or a display.");
  if (isServed(entry.moduleData)) throw new Error(entry.name + " already has window graphics. Its library entry controls them.");
  const registryKey = targetId(entry.moduleData);
  entry.moduleData = { targets: [entry.moduleData] };
  const stack = Stacks.lookup(userDataDir, identity(entry), { prepareEffects: effects => ({ ...effects,
    video: Array.isArray(effects?.video) ? effects.video.map(row => row?.kind === "frame-generation"
      ? { ...row, settings: { keepStaticContent: true, ...row.settings } } : row) : effects?.video }) });
  served.set(registryKey, gameId);
  return { ...entry, ...(stack?.effects ? { effects: stack.effects } : {}), ...(stack?.runtimeSettings ? { runtimeSettings: { capture: stack.runtimeSettings } } : {}) };
}

// The ended session's stack becomes the saved stack of every app and display
// it served, including those whose windows already left.
function endEntry(entry, { userDataDir, logger } = {}) {
  for (const [key, gameId] of served) if (gameId === entry?.gameId) served.delete(key);
  let result;
  for (const value of servedIdentities(entry)) result = Stacks.save(userDataDir, value,
    { effects: entry?.effects, runtimeSettings: entry?.runtimeSettings?.capture }, { logger });
  return result;
}

// Once per launcher start: stacks of apps that are no longer installed are
// removed, using the helper's offline check.
async function maintain({ userDataDir, logger, windowGraphics, installedApplications } = {}) {
  const ids = Stacks.bundleIdentifiers(userDataDir);
  const helper = (windowGraphics || Applications.availability)({});
  const installed = ids.length && helper.available
    ? await (installedApplications || Applications.installedApplications)(ids, { executable: helper.executable }) : {};
  return Stacks.prune(userDataDir, installed, { logger });
}

// The session's windows, apps and displays, for its inspector and menus: a
// window by its title with its app beside it, an app whose window is still to
// be picked, and a display by name.
function sessionTargets(entry) {
  return targetList(entry?.moduleData).map(target => {
    const app = target.applicationName || target.name;
    const label = target.windowTitle || app || target.displayName || (target.target === "all-displays" ? "All Displays"
      : target.target === "display" ? `Display ${target.displayID}` : targetId(target));
    const detail = target.reason || (target.target === "display" || target.target === "all-displays" ? "Display"
      : target.target === "application" && !target.windowID ? "Choosing a window" : app && app !== label ? app : null);
    return { id: targetId(target), label, ...(detail ? { detail } : {}), ...(Number.isSafeInteger(target.pid) ? { pid: target.pid } : {}) };
  });
}
function removeTarget(entry, id, context) { return context.request("windowRemoveTarget", { id }); }

module.exports = { targetList, targetId, servedIdentities, applyGraphics: { targets, picker, createEntry, endEntry, maintain, removeTarget, sessionTargets }, catalogModel, permissionModel };

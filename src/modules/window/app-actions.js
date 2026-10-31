const path = require("node:path");
const GameData = require("../shared/game-data");
const Applications = require("./applications");
const Stacks = require("../shared/effects/application-stacks");

// File > Apply Graphics To and the Dock menu list running apps and the whole
// display. Choosing one creates an ephemeral library entry for the session.
async function targets(context = {}) {
  const helper = (context.windowGraphics || Applications.availability)({ root: context.graphicsRuntimeRoot });
  if (!helper.available) return [];
  const apps = await (context.listApplications || Applications.listApplications)({ executable: helper.executable, excludePid: context.excludePid });
  // Reserve one of the generic menu's 64 target slots for the display.
  return [
    ...apps.slice(0, 63).map(app => ({ id: "application:" + app.pid, label: app.name, ...(app.path ? { iconPath: app.path } : {}),
      target: { kind: "application", ...app } })),
    { id: "display", label: "Entire Display", separatorBefore: apps.length > 0, target: { kind: "display" } }
  ];
}

// The app's saved stack identifies it by bundle, else by executable and name.
function identity(entry) {
  const data = entry?.moduleData || {};
  return data.target === "display" ? { target: "display" }
    : { target: "application", bundleIdentifier: data.bundleIdentifier, executablePath: data.executablePath, name: data.applicationName || entry?.name };
}

// The entry's game path is its own session folder, which exists exactly as
// long as the entry. An app's own bundle supplies the library icon. The entry
// starts from the app's saved stack, or from the default stack.
function createEntry(target, { userDataDir, gameId = GameData.createGameId() } = {}) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("The library folder is unavailable.");
  const folder = GameData.resolveGameDir(userDataDir, gameId);
  const common = { gameId, ephemeral: true, gamePath: folder, importPath: folder, contentRootDir: folder,
    moduleId: "window", engine: "window", gameType: "window", runtimeId: "capture" };
  let entry;
  if (target?.kind === "display") entry = { ...common, name: "Entire Display", moduleData: { target: "display" } };
  else {
    if (target?.kind !== "application" || !Number.isSafeInteger(target.pid) || target.pid <= 0 || typeof target.name !== "string")
      throw new Error("Choose a running app or the display.");
    const bundle = typeof target.path === "string" && /\.app$/i.test(target.path) ? target.path : null;
    entry = { ...common, name: target.name, ...(bundle ? { nativeAppPath: bundle } : {}),
      moduleData: { target: "application", pid: target.pid,
        ...(target.bundleIdentifier ? { bundleIdentifier: target.bundleIdentifier } : {}),
        ...(bundle ? { applicationPath: bundle } : {}),
        ...(target.executable ? { executablePath: target.executable } : {}) } };
  }
  const stack = Stacks.lookup(userDataDir, identity(entry));
  return { ...entry, ...(stack?.effects ? { effects: stack.effects } : {}), ...(stack?.runtimeSettings ? { runtimeSettings: { capture: stack.runtimeSettings } } : {}) };
}

// The ended session's stack becomes its app's saved stack.
function endEntry(entry, { userDataDir, logger } = {}) {
  return Stacks.save(userDataDir, identity(entry), { effects: entry?.effects, runtimeSettings: entry?.runtimeSettings?.capture }, { logger });
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

module.exports = { applyGraphics: { targets, createEntry, endEntry, maintain } };

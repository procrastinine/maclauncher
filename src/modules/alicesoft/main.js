const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame, inspectRoot } = require("./detect");
const Native = require("../shared/runtime/local-native");
const { createPinnedNativeManager } = require("../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime, resolveInstalledAsset } = require("../shared/runtime/bundled-native");
const { getUiServices } = require("../shared/ui-services");
const GameData = require("../shared/game-data");
const { runtimeVersionChoices } = require("../shared/runtime/version-choices");
const { createCatalogDiscovery } = require("./catalog");
const LiveVariables = require("./live-variables");
const Decompiler = require("./decompiler");
const decompilerManagers = require("./decompiler-managers").managers;
const System4Tools = require("./system4-tools");

const managers = Object.fromEntries([
  { id: "system3", label: "AliceSoft System 1–3 (SDL2)", owner: "kichikuou", repo: "system3-sdl2" },
  { id: "xsystem35", label: "AliceSoft System 3.5–3.9", owner: "kichikuou", repo: "xsystem35-sdl2" },
  { id: "xsystem4", label: "AliceSoft System 4", owner: "nunuhara", repo: "xsystem4" }
].map(({ id, label, owner, repo }) => [id, createPinnedNativeManager({
  id, label, projectBuilds: { projectId: id, repository: "procrastinine/maclauncher-builds" },
  sourceUrl: `https://github.com/${owner}/${repo}/releases`,
  legacyInstalledRuntime: createBundledNativeRuntime({ managerId: id }),
  discoverCatalog: createCatalogDiscovery(repo), catalog: []
})]));

managers.system3.payloadPolicy = require("./system3-payload-policy.json");

function runtimeFor(entry) { return entry.moduleData?.generation === "system4" ? "xsystem4" : entry.moduleData?.generation === "system35" ? "xsystem35" : "system3"; }
function managerFor(entry) { return managers[runtimeFor(entry)]; }

async function registerRuntime(entry, payload, context) {
  const manager = managerFor(entry);
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir, { version: context.runtimeSettings?.version });
  const requested = payload?.version || context.runtimeSettings?.version;
  const version = requested && requested !== "auto" ? requested : selected.version;
  let runtimePath = payload?.runtimePath || context.runtimeSettings?.runtimePath;
  if (!runtimePath) {
    const result = await getUiServices(context).dialog.showOpenDialog({
      title: `Select ${manager.label} ${version} macOS build`, properties: ["openFile", "openDirectory"]
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    runtimePath = result.filePaths[0];
  }
  const installed = manager.core.registerLocal({ userDataDir: context.userDataDir, version, runtimePath });
  entry.runtimeData = { ...entry.runtimeData, [manager.id]: { ...entry.runtimeData?.[manager.id], version } };
  context.onRuntimeStateChange?.();
  return { ready: true, version: installed.version, upstreamRevision: installed.upstreamRevision, sha256: installed.sha256 };
}

function resolveSaveLocations(entry, context = {}) {
  if (!entry.gameId || !context.userDataDir) return { primaryDirectory: null, directories: [] };
  const directory = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id), "saves");
  return { primaryDirectory: directory, directories: [{ directory, label: "Saves", source: "managed native interpreter" }] };
}

function resolveLaunchSpec(runtimeId, entry, context) {
  const expected = runtimeFor(entry);
  if (!managers[runtimeId]) return null;
  if (runtimeId !== expected) throw new Error(`This AliceSoft generation requires ${expected}.`);
  const rootDir = entry.contentRootDir;
  const detected = inspectRoot(rootDir);
  if (!detected || detected.generation !== entry.moduleData?.generation) throw new Error("AliceSoft game files no longer match the imported engine generation.");
  const manager = managers[runtimeId];
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir, { version: context.runtimeSettings?.version });
  if (!selected.install) throw new Error(`${selected.reason} Install a compatible version in Runtimes.`);
  if (!entry.gameId || !context.userDataDir) throw new Error("Import this game before launching so saves have a stable directory.");
  const defaultSaveDir = resolveSaveLocations(entry, context).primaryDirectory;
  const override = typeof entry.saveDirOverride === "string" ? entry.saveDirOverride.trim() : "";
  if (override && !path.isAbsolute(override)) throw new Error("Save directory override must be an absolute local path.");
  const saveDir = override || defaultSaveDir;
  fs.mkdirSync(saveDir, { recursive: true });
  entry.defaultSaveDir = defaultSaveDir;
  context.onEntryChange?.({ defaultSaveDir });
  const args = [runtimeId === "xsystem4" ? "--save-folder" : "-savedir", saveDir];
  const settings = context.runtimeSettings || {};
  let fontGothic = null;
  let fontMincho = null;
  if (settings.fontPath) {
    if (!path.isAbsolute(settings.fontPath) || !fs.statSync(settings.fontPath).isFile()) throw new Error("Font path must point to an existing local font file.");
    fontGothic = settings.fontPath;
    fontMincho = settings.fontPath;
  } else if (selected.install.catalogEntry?.projectPackage || selected.install.source === "bundled") {
    fontGothic = resolveInstalledAsset(selected.install, "fontGothic");
    if (runtimeId !== "system3") fontMincho = resolveInstalledAsset(selected.install, "fontMincho");
    if (!fontGothic || runtimeId !== "system3" && !fontMincho) throw new Error("The runtime is missing its default fonts. Install a complete runtime package or choose a local font in Runtime Settings.");
  }
  if (fontGothic) {
    if (runtimeId === "system3") args.push("-fontfile", fontGothic);
    else if (runtimeId === "xsystem35") args.push("-ttfont_gothic", fontGothic, "-ttfont_mincho", fontMincho);
    else args.push("--font-gothic", fontGothic, "--font-mincho", fontMincho);
  }
  if (settings.gameId && runtimeId !== "xsystem4") args.push("-game", settings.gameId);
  if (settings.textHook && settings.textHook !== "none") {
    if (!["print", "copy"].includes(settings.textHook)) throw new Error("Unsupported text hook mode.");
    if (runtimeId === "xsystem4") {
      if (settings.textHook !== "print") throw new Error("System 4 text capture supports Console only.");
      args.push("--echo-message");
    } else args.push("-texthook", settings.textHook);
  }
  if (settings.fullscreen === true && runtimeId !== "xsystem4") args.push("-fullscreen");
  args.push(...(context.gameArguments || []));
  if (runtimeId === "xsystem4") args.push(detected.configPath);
  // A refreshed catalog entry carries the current record's capabilities.
  const pin = manager.core.listCatalog({ userDataDir: context.userDataDir }).find(row => row?.version === selected.version) || selected.install.catalogEntry;
  return { runtimePath: selected.install.runtimePath, runtimeVersion: selected.version,
    upstreamRevision: selected.install.upstreamRevision, expectedSha256: selected.install.binarySha256,
    debugAdapter: pin?.debugAdapter, args, cwd: rootDir, detected };
}

async function launchRuntime(runtimeId, entry, context) {
  const spec = resolveLaunchSpec(runtimeId, entry, context);
  if (!spec) return null;
  if (context.moduleLaunchOptions?.mode === "liveVariables") {
    if (runtimeId !== "xsystem35") throw new Error("Live variables require the System 3.5–3.9 runtime.");
    const runtime = { ...Native.resolveLocalRuntime(spec), debugAdapter: spec.debugAdapter };
    const spawn = context.spawnOwnedChecked || context.spawnDetachedChecked;
    if (typeof spawn !== "function") throw new Error("Native process launcher is unavailable.");
    const session = await LiveVariables.startSession({ entry, userDataDir: context.userDataDir, runtime,
      scenarioPath: spec.detected.scenarioPath,
      spawn: directory => spawn(runtime.executablePath, [...spec.args, "-debug_dap"],
        { cwd: directory, detached: false, stdio: ["pipe", "pipe", "pipe"] }, runtime.needsRosetta) });
    return session.child;
  }
  return Native.launchLocalRuntime({ ...spec, context });
}

async function openLiveVariables(entry, _payload, context) {
  if (runtimeFor(entry) !== "xsystem35") throw new Error("Live variables are available for System 3.5–3.9 games only.");
  let session = LiveVariables.findSession(entry, context);
  if (!session) {
    if (context.isGameRunning?.()) throw new Error("Quit the game before opening live variables.");
    if (typeof context.launchForTools !== "function") throw new Error("This game host does not support starting live-variable tools.");
    const result = await context.launchForTools({ runtimeId: "xsystem35", moduleOptions: { mode: "liveVariables" } });
    if (result?.kind === "cancelled") return { canceled: true };
    session = LiveVariables.findSession(entry, context);
    if (!session) throw new Error("The game did not start a live-variable session.");
  } else if (session.phase === "running") await session.pause();
  if (session.phase === "unavailable") throw new Error("The game's live-variable connection ended. Quit the game before reopening it.");
  const state = session.getState();
  if (typeof context.ui?.openLiveVariableEditor === "function") {
    try { await context.ui.openLiveVariableEditor({ gamePath: entry.gamePath, moduleId: manifest.id,
      sessionId: session.id, title: entry.name || "Live variables",
      actions: { status: "liveVariableStatus", list: "listLiveVariables", set: "setLiveVariable",
        pause: "pauseLiveVariables", resume: "resumeLiveVariables", close: "closeLiveVariables" } }); }
    catch (error) { await session.closeEditor().catch(() => {}); throw error; }
  }
  return state;
}

module.exports = {
  id: manifest.id, manifest, detectGame, runtimeManagers: [...Object.values(managers), ...Object.values(decompilerManagers), System4Tools.manager],
  normalizeRuntimeId: id => ["xsystem35", "xsystem4"].includes(id) ? id : "system3",
  filterRuntimeSupport: entry => [runtimeFor(entry)], launchRuntime, resolveLaunchSpec, resolveSaveLocations,
  isActionAvailable: (actionId, entry) => {
    if (actionId === "openLiveVariables") return runtimeFor(entry) === "xsystem35";
    if (actionId === "decompile") return ["system3", "system35", "system4"].includes(entry.moduleData?.generation);
    if (actionId === "registerDecompiler") return ["system3", "system35"].includes(entry.moduleData?.generation);
    if (actionId === "revealSourceExport") return Boolean(entry.moduleData?.sourceExportDir);
    return true;
  },
  settingsActions: {
    listRuntimeVersions: (payload, context) => {
      if (!Object.hasOwn(managers, payload?.runtimeId)) throw new Error("Choose an AliceSoft runtime.");
      return runtimeVersionChoices(manifest, managers[payload.runtimeId], context);
    }
  },
  actions: {
    listRuntimeVersions: (entry, _payload, context) => runtimeVersionChoices(manifest, managerFor(entry), context),
    decompile: Decompiler.decompile,
    revealSourceExport: Decompiler.revealExport,
    registerDecompiler: Decompiler.registerDecompiler,
    openLiveVariables,
    liveVariableStatus: (entry, payload, context) => LiveVariables.getSessionState(entry, context, payload),
    listLiveVariables: (entry, payload, context) => LiveVariables.getSession(entry, context, payload).list(payload),
    setLiveVariable: (entry, payload, context) => LiveVariables.getSession(entry, context, payload).set(payload),
    pauseLiveVariables: (entry, payload, context) => LiveVariables.getSession(entry, context, payload).pause(),
    resumeLiveVariables: (entry, payload, context) => LiveVariables.getSession(entry, context, payload).resume(),
    closeLiveVariables: (entry, payload, context) => LiveVariables.closeEditor(entry, context, payload),
    stopLiveVariables: (entry, payload, context) => LiveVariables.getSession(entry, context, payload).stop(),
    registerRuntime,
    runtimeStatus: (entry, _payload, context) => {
      const manager = managerFor(entry);
      const selected = manager.resolveSelection(entry, context.settings, context.userDataDir, { version: context.runtimeSettings?.version });
      return { ready: selected.ready, backend: manager.id, version: selected.version, runtimePath: selected.install?.runtimePath || null,
        upstreamRevision: selected.install?.upstreamRevision || manager.core.catalog.find(row => row.version === selected.version)?.upstreamRevision || null,
        sha256: selected.install?.sha256 || null, reason: selected.reason };
    }
  }
};

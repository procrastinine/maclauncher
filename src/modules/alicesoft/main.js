const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame, inspectRoot } = require("./detect");
const Native = require("../shared/runtime/local-native");
const { createPinnedNativeManager } = require("../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime, resolveInstalledAsset } = require("../shared/runtime/bundled-native");
const { getUiServices } = require("../shared/ui-services");
const GameData = require("../shared/game-data");
const { buildRuntime, buildManagedRuntime } = require("./build");
const { createCatalogDiscovery } = require("./catalog");
const System4 = require("./system4-build");
const PortableSystem4 = require("./system4-portable");
const LiveVariables = require("./live-variables");
const Decompiler = require("./decompiler");
const decompilerManagers = require("./decompiler-managers").managers;

const managers = {
  system3: createPinnedNativeManager({ id: "system3", label: "AliceSoft System 1–3 (SDL2)",
    bundledExecution: "direct", distributionRequired: true,
    recommendedVersion: "1.8.0-macos-v2",
    sourceUrl: "https://github.com/kichikuou/system3-sdl2/tree/461673bec729e7e0ec905921fc3e03aecf977a70", buildRuntime: buildManagedRuntime,
    buildSourcePath: path.resolve(__dirname, "../../external/system3-sdl2"),
    buildHelpUrl: "https://github.com/kichikuou/system3-sdl2/blob/461673bec729e7e0ec905921fc3e03aecf977a70/README.md",
    bundledRuntime: createBundledNativeRuntime({ managerId: "system3" }),
    discoverCatalog: createCatalogDiscovery("system3-sdl2"),
    catalog: [{ version: "1.8.0-macos-v2", upstreamRevision: "461673bec729e7e0ec905921fc3e03aecf977a70",
      sourceTreeSha256: "7d5074ef5cce68c9f0f4246fb91f17ba8482f7ae798ddda9dd6208d8530f695c",
      overlaySha256: "1f6f843ed4ac0ae7e45c3e77f339c7c36646aaa01f2b7270877a6ee7a2efef94",
      hostArchitectures: ["arm64"], minimumMacOS: "13.0", localBuild: false,
      sourceArtifact: { directoryRelative: "system3/1.8.0-macos-v2-source.tar.gz", bytes: 75268579,
        sha256: "4730f6ce3a71fb406350ab338c9d1eb7a187d2b27feeda0c8f218f722b34b376" } },
      { version: "1.8.0", upstreamRevision: "461673bec729e7e0ec905921fc3e03aecf977a70" }] }),
  xsystem35: createPinnedNativeManager({ id: "xsystem35", label: "AliceSoft System 3.5–3.9",
    bundledExecution: "direct",
    recommendedVersion: "2.20.0-macos-v2", distributionRequired: true,
    sourceUrl: "https://github.com/kichikuou/xsystem35-sdl2/tree/82c8b76a58a19ff1f87b4bdadbaef169c4b37f46", buildRuntime: buildManagedRuntime,
    buildSourcePath: path.resolve(__dirname, "../../external/xsystem35-sdl2"),
    buildHelpUrl: "https://github.com/kichikuou/xsystem35-sdl2/blob/82c8b76a58a19ff1f87b4bdadbaef169c4b37f46/README.md",
    bundledRuntime: createBundledNativeRuntime({ managerId: "xsystem35" }),
    discoverCatalog: createCatalogDiscovery("xsystem35-sdl2"),
    catalog: [{ version: "2.20.0-macos-v2", upstreamRevision: "82c8b76a58a19ff1f87b4bdadbaef169c4b37f46",
      sourceTreeSha256: "0f9ed54898badb68428e0dcafc1b69044b5ecb5e2f86ff6cc261a8a2ca558c1d",
      overlaySha256: "8e646576bb00ea0b95a52426606166e31133d5ba27c5bdbd80658ca4e8a9e58b",
      hostArchitectures: ["arm64"], minimumMacOS: "13.0", localBuild: false,
      sourceArtifact: { directoryRelative: "xsystem35/2.20.0-macos-v2-source.tar.gz", bytes: 108633778,
        sha256: "ab9e241d7efa959c1821e3430ad42d36d4a798aa6a6609829a3938461c6efcd8" } },
      { version: "2.20.0", upstreamRevision: "82c8b76a58a19ff1f87b4bdadbaef169c4b37f46" }] }),
  xsystem4: createPinnedNativeManager({ id: "xsystem4", label: "AliceSoft System 4",
    bundledExecution: "direct",
    recommendedVersion: PortableSystem4.VERSION, distributionRequired: true,
    sourceUrl: `https://github.com/nunuhara/xsystem4/tree/${System4.REVISION}`, buildRuntime: buildManagedRuntime,
    buildSourcePath: System4.sourcePath,
    buildRequirements: "Source builds require Apple Command Line Tools, Meson, Ninja, flex/bison and native libraries.",
    buildHelpUrl: `https://github.com/nunuhara/xsystem4/blob/${System4.REVISION}/README.md`,
    bundledRuntime: createBundledNativeRuntime({ managerId: "xsystem4" }), discoverCatalog: createCatalogDiscovery("xsystem4"),
    catalog: [{ version: PortableSystem4.VERSION, upstreamRevision: PortableSystem4.REVISION,
      sourceTreeSha256: PortableSystem4.SOURCE_SHA256,
      overlaySha256: "e5b718c2aec5e288f1d9cd65fe09669d6a36a7489a568790823cd5584a71b78b",
      hostArchitectures: ["arm64"], minimumMacOS: "13.0", localBuild: false,
      sourceArtifact: { directoryRelative: "xsystem4/snapshot-04333ad-macos-v2-source.tar.gz", bytes: 126056105,
        sha256: "7c2a9bee717b99d88bf7ff5a3a53b65bc43e33cf26cdd398113916a399e1437a" } },
      { version: System4.VERSION, upstreamRevision: System4.REVISION }] })
};
managers.xsystem35.distributionVersions = ["2.20.0-macos-v2"];
managers.xsystem35.distributionArchitectures = { arm64: ["arm64"], x64: [] };
managers.xsystem4.distributionVersions = [PortableSystem4.VERSION];
managers.xsystem4.distributionArchitectures = { arm64: ["arm64"], x64: [] };

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

function resolveLaunchSpec(runtimeId, entry, context) {
  const expected = runtimeFor(entry);
  if (!managers[runtimeId]) return null;
  if (runtimeId !== expected) throw new Error(`This AliceSoft generation requires ${expected}.`);
  const rootDir = entry.contentRootDir;
  const detected = inspectRoot(rootDir);
  if (!detected || detected.generation !== entry.moduleData?.generation) throw new Error("AliceSoft game files no longer match the imported engine generation.");
  const manager = managers[runtimeId];
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir, { version: context.runtimeSettings?.version });
  if (!selected.install) throw new Error(`${selected.reason} Select Automatic in Runtime Settings to use the included runtime.`);
  if (!entry.gameId || !context.userDataDir) throw new Error("Import this game before launching so saves have a stable directory.");
  const defaultSaveDir = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id), "saves");
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
  } else if (selected.install.source === "bundled") {
    fontGothic = resolveInstalledAsset(selected.install, "fontGothic");
    if (runtimeId !== "system3") fontMincho = resolveInstalledAsset(selected.install, "fontMincho");
    if (!fontGothic || runtimeId !== "system3" && !fontMincho) throw new Error("The bundled runtime is missing its default fonts. Reinstall a complete runtime bundle or choose a local font in Runtime Settings.");
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
  if (runtimeId === "xsystem4") args.push(detected.configPath);
  return { runtimePath: selected.install.runtimePath, runtimeVersion: selected.version,
    upstreamRevision: selected.install.upstreamRevision, expectedSha256: selected.install.binarySha256,
    args, cwd: rootDir, detected };
}

async function launchRuntime(runtimeId, entry, context) {
  const spec = resolveLaunchSpec(runtimeId, entry, context);
  if (!spec) return null;
  if (context.moduleLaunchOptions?.mode === "liveVariables") {
    if (runtimeId !== "xsystem35") throw new Error("Live variables require the System 3.5–3.9 runtime.");
    const runtime = Native.resolveLocalRuntime(spec);
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
  id: manifest.id, manifest, detectGame, runtimeManagers: [...Object.values(managers), ...Object.values(decompilerManagers)],
  normalizeRuntimeId: id => ["xsystem35", "xsystem4"].includes(id) ? id : "system3",
  filterRuntimeSupport: entry => [runtimeFor(entry)], launchRuntime, resolveLaunchSpec,
  isActionAvailable: (actionId, entry) => {
    if (actionId === "openLiveVariables") return runtimeFor(entry) === "xsystem35";
    if (["decompile", "registerDecompiler"].includes(actionId)) return ["system3", "system35"].includes(entry.moduleData?.generation);
    if (actionId === "revealSourceExport") return Boolean(entry.moduleData?.sourceExportDir);
    return true;
  },
  actions: {
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
    buildRuntime: (entry, payload, context) => buildRuntime(managerFor(entry), entry, payload, context),
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

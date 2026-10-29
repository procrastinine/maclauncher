// The demo's stand-in for the launcher's preload bridge. Reads answer from an
// in-memory copy of the launcher state, and actions change that copy so the
// real launcher UI responds. Instead of doing the action, each one names a
// topic that the page shows an article for. Nothing touches files, processes
// or the network.
import type {
  EffectsChainTemplate, GameEffectsInfo, GameEffectsPlan, GraphicsOwnerStatus, GraphicsStatusEvent, LauncherApi,
  LauncherState, ReShadeState, RecentGame, RuntimeManagerState
} from "../../../../src/renderer/src/ui/types";
import { normalizeUtilityWindowRequest, utilityWindowDefinition } from "../../../../src/core/utility-window-model.mjs";
import { createExternalStores } from "./external";
import type { DemoStore } from "./store";

export type DemoGraphics = {
  catalog: ReShadeState;
  hosts: Record<string, { info: GameEffectsInfo; templates: EffectsChainTemplate[] }>;
};
type Answer = { result: unknown } | { error: string };
/** Settings-action answers recorded by data/generate.cjs, keyed "module:action:runtime". */
export type DemoSettingsActions = Record<string, Answer>;
/** One example entry's own action answers (such as a playlist's videos), by game path and action. */
export type DemoGameActions = Record<string, Record<string, Answer>>;

type Handlers = { [K in keyof LauncherApi]?: LauncherApi[K] };
type Section = Record<string, any>;

const resolved = <T,>(value: T) => Promise.resolve(value);
const unsubscribe = () => () => {};
const DEMO_ROOT = "/Users/Shared/MacLauncher Demo";

// Example versions offered after Refresh, so Install and Set default have
// something to act on. Any manager not listed here offers one example version.
const EXAMPLE_VERSIONS: Record<string, string[]> = {
  sdk: ["8.4.1", "8.3.7", "7.8.7"], godot: ["4.5.1", "4.4.1", "3.6.1"], love: ["11.5", "11.4"],
  mkxpz: ["2.4.2"], nwjs: ["0.104.0", "0.103.1"], unity: ["6000.2.6f2", "2022.3.62f2"]
};

// Module actions that only read state. The inspector and Settings call them
// on their own, so they get no article, and one without a recorded answer
// fails visibly instead of leaving its view waiting.
const STATUS_READ = /^(list|read|get)|(Status|Options|Recommendation|Inputs|Accounts)$/;
const unavailable = () => Promise.reject(new Error("This information isn't part of the demo."));

export function createLauncherApi(store: DemoStore, graphics: DemoGraphics, settingsActions: DemoSettingsActions,
  gameActions: DemoGameActions): LauncherApi {
  const external = createExternalStores();
  const answered = (answer: Answer | undefined) =>
    !answer ? null : "error" in answer ? Promise.reject(new Error(answer.error)) : resolved(answer.result);
  const settingsAnswer = (moduleId: string | undefined, action: string, runtimeId: unknown) =>
    answered(settingsActions[[moduleId, action, typeof runtimeId === "string" ? runtimeId : ""].join(":")]);
  // Choosing one of an entry's own options (a playlist's starting video)
  // answers with its recorded choices, now selected.
  const chooseEntry = (gamePath: string, action: string, value: unknown) => {
    const entry = game(gamePath), info = store.state.modules.find(item => item.id === entry?.moduleId);
    const selector = info?.ui?.entrySelectors?.find(item => item.setAction === action);
    if (!selector) return null;
    store.topic({ kind: "entry", id: action, moduleId: entry?.moduleId });
    const choices = gameActions[gamePath]?.[selector.optionsAction];
    if (!choices || "error" in choices) return unavailable();
    return resolved({ ...(choices.result as object), value });
  };
  const moduleAction = (moduleId: string | undefined, action: string, runtimeId: unknown, fallback: () => Promise<any>) => {
    if (!STATUS_READ.test(action)) {
      store.topic({ kind: "tool", id: action, moduleId });
      return resolved(null);
    }
    return settingsAnswer(moduleId, action, runtimeId) || fallback();
  };
  const game = (gamePath: string) => store.state.recents.find(entry => entry.gamePath === gamePath);
  const moduleOf = (gamePath: string) => game(gamePath)?.moduleId;
  const updateGame = (gamePath: string, patch: (entry: RecentGame) => Partial<RecentGame>) => store.update(state => ({
    ...state, recents: state.recents.map(entry => entry.gamePath === gamePath ? { ...entry, ...patch(entry) } : entry)
  }));
  const updateManager = (managerId: string, sectionId: string, patch: (section: Section) => Section) => store.update(state => {
    const manager = state.runtimeManagers[managerId];
    if (!manager) return state;
    const sections = Array.isArray(manager.sections) ? manager.sections : null;
    const next: RuntimeManagerState = sections?.some(section => section.id === sectionId)
      ? { ...manager, sections: sections.map(section => section.id === sectionId ? patch(section) : section) }
      : { ...manager, ...patch(manager) };
    return { ...state, runtimeManagers: { ...state.runtimeManagers, [managerId]: next } };
  });

  const hostKey = (entry: RecentGame | undefined) => {
    const info = store.state.modules.find(item => item.id === entry?.moduleId);
    return String(info?.runtime?.entries?.[entry?.runtimeId || ""]?.graphicsHost ?? "none");
  };
  const effectsFor = (gamePath: string): GameEffectsInfo => {
    const entry = game(gamePath), host = graphics.hosts[hostKey(entry)] || Object.values(graphics.hosts)[0];
    return { ...host.info, plan: entry?.effects || host.info.plan };
  };
  let graphicsRevision = 0, shownGame = "";
  const graphicsListeners = new Set<(event: GraphicsStatusEvent) => void>();
  const graphicsStatus = (gamePath: string): GraphicsOwnerStatus =>
    ({ gamePath, desiredSeq: graphicsRevision, desiredRevision: String(graphicsRevision), planSource: "effects", running: false, live: false, phase: "saved", rows: {} });

  // The first difference from the saved plan names the topic: the whole chain
  // switched on or off, the game's own resolution, a row's effect, a row
  // switched, removed or moved, then an output setting.
  function effectTopic(before: GameEffectsPlan | null | undefined, after: GameEffectsPlan) {
    type Node = GameEffectsPlan["video"][number];
    const effect = (id: string, detail?: string) => store.topic({ kind: "effect", id, detail });
    const effectKey = (node: Node) => String(("method" in node ? node.method : node.shader?.preset ?? node.shader?.effectPath) ?? "");
    const previous = before?.video || [], rows = new Map(previous.map(node => [node.id, node]));
    if ((before?.enabled ?? true) !== (after.enabled ?? true)) return effect("master");
    if (JSON.stringify(before?.renderResolution ?? null) !== JSON.stringify(after.renderResolution ?? null)) return effect("game-resolution");
    const replaced = after.video.find(node => {
      const old = rows.get(node.id);
      return !old || old.kind !== node.kind || effectKey(old) !== effectKey(node);
    });
    if (replaced) return effect(replaced.kind, effectKey(replaced));
    if (after.video.some(node => (rows.get(node.id)?.enabled ?? true) !== (node.enabled ?? true))) return effect("row-toggle");
    if (previous.length > after.video.length) return effect("row-remove");
    if (previous.some((node, index) => after.video[index]?.id !== node.id)) return effect("row-order");
    const output = { ...before?.output } as Record<string, unknown>, next = { ...after.output } as Record<string, unknown>;
    const setting = Object.keys({ ...output, ...next }).find(key => JSON.stringify(output[key]) !== JSON.stringify(next[key]));
    if (setting) return effect("output", setting);
    const edited = after.video.find(node => JSON.stringify(node) !== JSON.stringify(rows.get(node.id)));
    return edited ? effect(edited.kind, effectKey(edited)) : effect("chain");
  }

  const handlers: Handlers = {
    getState: () => resolved(store.snapshot()),
    onState: callback => store.subscribe(callback),
    onActivity: unsubscribe,
    onGameImported: unsubscribe,
    onGameFailed: unsubscribe,
    onEffectsPresetsChanged: unsubscribe,
    onGraphicsCatalog: unsubscribe,
    onGraphicsStatus: callback => {
      graphicsListeners.add(callback);
      return () => { graphicsListeners.delete(callback); };
    },
    getPathForFile: () => null,
    confirmAction: () => resolved(true),
    openExternal: url => { window.open(url, "_blank", "noopener"); return resolved(true); },
    revealInFinder: () => { store.topic({ kind: "action", id: "revealInFinder" }); return resolved(true); },

    openUtilityWindow: request => {
      const { view, managerId, sectionId, shaderCategory } = normalizeUtilityWindowRequest(request);
      store.topic({ kind: "window", id: view, detail: managerId });
      const search = Object.fromEntries(Object.entries({ view, managerId, sectionId, shaderCategory })
        .filter((item): item is [string, string] => typeof item[1] === "string" && item[1] !== ""));
      store.openWindow({ title: utilityWindowDefinition(view)?.title || view, search });
      return resolved(true);
    },
    openRuntimeSettings: context => {
      const entry = context.scope === "game" ? game(context.gamePath || "") : undefined;
      const moduleId = entry?.moduleId || context.moduleId || "", runtimeId = entry?.runtimeId || context.runtimeId || "";
      const info = store.state.modules.find(item => item.id === moduleId);
      const label = info?.runtime?.entries?.[runtimeId]?.label || runtimeId;
      store.topic({ kind: "runtime-settings", id: runtimeId, moduleId });
      store.openWindow({ title: `${label} settings`, search: { view: "runtime-settings", scope: context.scope, moduleId, runtimeId,
        ...(entry ? { gamePath: entry.gamePath } : {}) } });
      return resolved(true);
    },
    openGameDialog: () => { store.topic({ kind: "add", id: "dialog" }); return resolved([]); },
    addRecent: () => { store.topic({ kind: "add", id: "drop" }); return resolved(null); },
    findMissingGames: () => resolved([]),

    // Library and inspector.
    setGameFavorite: (gamePath, favorite) => { updateGame(gamePath, () => ({ favorite } as Partial<RecentGame>)); return resolved(true); },
    setGameNotes: (gamePath, notes) => { updateGame(gamePath, () => ({ notes })); return resolved(true); },
    setGameLaunchArguments: (gamePath, value) => {
      updateGame(gamePath, () => ({ launchArguments: value }));
      store.topic({ kind: "runtime-settings", id: "arguments", moduleId: moduleOf(gamePath) });
      return resolved(true);
    },
    setGameNetworkAccess: (gamePath, value) => {
      updateGame(gamePath, () => ({ networkAccess: value }));
      store.topic({ kind: "runtime-settings", id: "network", moduleId: moduleOf(gamePath) });
      return resolved(true);
    },
    setGameRuntime: (gamePath, runtime) => {
      updateGame(gamePath, () => ({ runtimeId: runtime }));
      const info = store.state.modules.find(item => item.id === moduleOf(gamePath));
      store.topic({ kind: "runtime", id: runtime, moduleId: moduleOf(gamePath), detail: info?.runtime?.entries?.[runtime]?.label });
      return resolved(true);
    },
    setGameRuntimeSettings: (gamePath, runtimeId, settings) => {
      updateGame(gamePath, entry => ({ runtimeSettings: { ...entry.runtimeSettings, [runtimeId]: settings } }));
      store.topic({ kind: "runtime-settings", id: runtimeId, moduleId: moduleOf(gamePath) });
      return resolved(true);
    },
    setGameRuntimeData: (gamePath, runtimeId, patch) => {
      updateGame(gamePath, entry => ({ runtimeData: { ...entry.runtimeData, [runtimeId]: { ...entry.runtimeData?.[runtimeId], ...patch } } }));
      store.topic({ kind: "version", id: runtimeId, moduleId: moduleOf(gamePath) });
      return resolved(true);
    },
    setGameModuleData: (gamePath, patch) => { updateGame(gamePath, entry => ({ moduleData: { ...entry.moduleData, ...patch } })); return resolved(true); },
    launchGame: gamePath => { store.topic({ kind: "play", id: game(gamePath)?.runtimeId || "", moduleId: moduleOf(gamePath) }); return resolved(true); },
    launchGameWithRuntime: (gamePath, runtime) => { store.topic({ kind: "play", id: runtime, moduleId: moduleOf(gamePath) }); return resolved(true); },
    stopGame: () => resolved(true),
    createGameCommand: gamePath => { store.topic({ kind: "action", id: "createGameCommand" }); return resolved(`${gamePath}.command`); },
    forgetGame: gamePath => {
      store.update(state => ({ ...state, recents: state.recents.filter(entry => entry.gamePath !== gamePath) }));
      return resolved(true);
    },
    // A game's own reads use the answers recorded for its game type.
    moduleAction: (gamePath, action, payload, options) =>
      chooseEntry(gamePath, String(action), payload?.value) || answered(gameActions[gamePath]?.[String(action)]) ||
      moduleAction(moduleOf(gamePath), String(action), options?.runtimeId ?? game(gamePath)?.runtimeId, () => resolved({ ok: true })),
    moduleSettingsAction: (moduleId, action, payload) => moduleAction(moduleId, String(action), payload?.runtimeId, unavailable),
    getSaveInfo: gamePath => {
      store.topic({ kind: "saves", id: "info", moduleId: moduleOf(gamePath) });
      const entry = game(gamePath);
      return resolved({ saveDir: `${DEMO_ROOT}/saves/${entry?.name || "game"}`, moduleId: entry?.moduleId || "", moduleLabel: entry?.moduleLabel || "" } as never);
    },
    listSaveFiles: () => resolved([]),
    // The inspector reads this on its own whenever the game changes, so it names no topic.
    getCheatsPatchStatus: () => resolved(null),
    setCheats: gamePath => { store.topic({ kind: "cheats", id: "set", moduleId: moduleOf(gamePath) }); return resolved(true); },

    // Graphics.
    getGameEffects: gamePath => {
      // The inspector reloads effects after other changes; the game's articles
      // follow only a change of game.
      if (gamePath !== shownGame) store.topic({ kind: "game", id: gamePath, moduleId: moduleOf(gamePath) });
      shownGame = gamePath;
      return resolved(effectsFor(gamePath));
    },
    getGameEffectTemplates: gamePath => resolved((graphics.hosts[hostKey(game(gamePath))] || Object.values(graphics.hosts)[0]).templates),
    requestGraphicsCatalog: request => resolved(request.open ? { revision: 1, reshade: graphics.catalog } : { revision: 1 }),
    getGraphicsStatus: gamePath => resolved(graphicsStatus(gamePath)),
    getGameGraphicsStatus: () => resolved({ state: "off", contexts: [] }),
    getGameEffectParameters: (_gamePath, nodeId) => resolved({ key: nodeId, parameters: [] }),
    setGameEffects: (gamePath, plan) => {
      effectTopic(game(gamePath)?.effects, plan);
      updateGame(gamePath, () => ({ effects: plan }));
      graphicsRevision += 1;
      const event: GraphicsStatusEvent = { gamePath, status: graphicsStatus(gamePath), plan };
      for (const listener of [...graphicsListeners]) listener(event);
      return resolved(true);
    },
    resetGameEffects: gamePath => { updateGame(gamePath, () => ({ effects: null })); store.topic({ kind: "effect", id: "clear" }); return resolved(true); },
    listEffectsPresets: () => resolved([]),
    getEffectsPresetNotices: () => resolved([]),

    // Runtimes and settings.
    runtimeAction: (managerId, action, payload) => {
      const sectionId = typeof payload?.sectionId === "string" ? payload.sectionId : "default";
      const version = typeof payload?.version === "string" ? payload.version : null;
      const variant = typeof payload?.variant === "string" ? payload.variant : undefined;
      if (action === "refreshCatalog") {
        const versions = EXAMPLE_VERSIONS[managerId] || ["1.0.0"];
        updateManager(managerId, sectionId, section => ({ ...section,
          catalog: { ...section.catalog, status: "idle", versions, fetchedAt: Date.now(), error: null } }));
      } else if (action === "install" && version) {
        updateManager(managerId, sectionId, section => ({ ...section,
          defaultVersion: section.defaultVersion ?? version,
          installed: [...(section.installed || []).filter((item: Section) => item.version !== version),
            { version, ...(variant ? { variant } : {}), installDir: `${DEMO_ROOT}/runtimes/${managerId}/${version}`, ready: true }] }));
      } else if (action === "setDefault") {
        updateManager(managerId, sectionId, section => ({ ...section, defaultVersion: version, ...(variant ? { defaultVariant: variant } : {}) }));
      } else if (action === "uninstall" && version) {
        updateManager(managerId, sectionId, section => ({ ...section,
          installed: (section.installed || []).filter((item: Section) => item.version !== version),
          defaultVersion: section.defaultVersion === version ? null : section.defaultVersion }));
      }
      store.topic({ kind: "runtime-action", id: action });
      return resolved(true);
    },
    setLauncherSettings: patch => {
      store.update(state => ({ ...state, launcherSettings: { ...state.launcherSettings, ...patch } }));
      store.topic({ kind: "settings", id: Object.keys(patch).join(",") });
      return resolved(true);
    },
    setModuleSettings: (moduleId, patch) => {
      store.update(state => ({ ...state, moduleSettings: { ...state.moduleSettings, [moduleId]: { ...state.moduleSettings[moduleId], ...patch } } }));
      store.topic({ kind: "runtime-settings", id: "module", moduleId });
      return resolved(true);
    },
    setModuleRuntimeSettings: (moduleId, runtimeId) => { store.topic({ kind: "runtime-settings", id: runtimeId, moduleId }); return resolved(true); },

    // External stores.
    steamState: () => resolved(external.steamState()),
    onSteamState: callback => external.onSteamState(callback),
    steamScan: () => { store.topic({ kind: "store", id: "scan" }); return resolved(external.scan()); },
    externalDownloaded: () => resolved([]),
    steamConnect: () => { store.topic({ kind: "store", id: "account" }); return resolved(external.connect()); },
    steamDisconnect: () => resolved(external.disconnect()),
    steamLibrary: () => resolved(external.steamState()),
    steamVersions: appId => { store.topic({ kind: "store", id: "versions" }); return resolved(external.versions(appId)); },
    steamPreviousVersions: () => resolved({ history: [], sourceUrl: "", sources: [], fetchedAt: new Date(0).toISOString() }),
    steamDownload: selection => { store.topic({ kind: "store", id: "download" }); return resolved(external.download(selection)); },
    steamImport: () => { store.topic({ kind: "store", id: "import" }); return resolved(true); },
    steamAuth: () => { store.topic({ kind: "store", id: "account" }); return resolved(external.connect()); },
    steamSelectAccount: () => resolved(external.steamState()),
    steamRemoveAccount: () => resolved(external.disconnect()),
    steamImportDownload: () => { store.topic({ kind: "store", id: "import" }); return resolved(true); },
    steamCancel: () => resolved(true),
    externalState: storeId => resolved(external.storeState(storeId)),
    onExternalState: callback => external.onStoreState(callback),
    externalConnect: storeId => { store.topic({ kind: "store", id: "account" }); return resolved(external.connectStore(storeId)); },
    externalAuth: storeId => { store.topic({ kind: "store", id: "account" }); return resolved(external.connectStore(storeId)); },
    externalOpenLogin: storeId => { store.topic({ kind: "store", id: "account" }); return resolved(external.storeState(storeId)); },
    externalDisconnect: storeId => resolved(external.disconnectStore(storeId)),
    externalForget: storeId => resolved(external.disconnectStore(storeId)),
    externalAccounts: () => resolved({ accounts: [] }),
    externalOpenAccounts: () => { store.topic({ kind: "store", id: "account" }); return resolved(true); },
    externalLibrary: storeId => resolved(external.storeState(storeId)),
    externalSearch: (storeId, query) => { store.topic({ kind: "store", id: "search" }); return resolved(external.search(storeId, query)); },
    externalAddGame: storeId => { store.topic({ kind: "store", id: "account" }); return resolved(external.storeState(storeId)); },
    externalAddToLibrary: storeId => resolved(external.storeState(storeId)),
    externalVersions: (storeId, appId) => { store.topic({ kind: "store", id: "versions" }); return resolved(external.storeVersions(storeId, appId)); },
    externalDownload: (storeId, selection) => { store.topic({ kind: "store", id: "download" }); return resolved(external.storeDownload(storeId, selection)); },
    externalCancel: () => resolved(true),
    externalImportDownload: () => { store.topic({ kind: "store", id: "import" }); return resolved(true); },
    externalImportCopies: () => { store.topic({ kind: "store", id: "import" }); return resolved(true); },
    externalOpenDownloads: () => { store.topic({ kind: "store", id: "download" }); return resolved(true); }
  };

  // A bridge method the demo has no explicit answer for still exists: a
  // subscription returns an unsubscribe function and anything else resolves
  // with no result, so a new launcher method never breaks the page. Reads
  // stay quiet; any other method names a topic after itself.
  const quietRead = /^(get|list|read)[A-Z]/;
  return new Proxy(handlers as LauncherApi, {
    get(target, property) {
      if (typeof property !== "string") return undefined;
      const own = (target as Record<string, unknown>)[property];
      if (own) return own;
      if (/^on[A-Z]/.test(property)) return unsubscribe;
      return (..._args: unknown[]) => {
        if (!quietRead.test(property)) store.topic({ kind: "action", id: property });
        return resolved(null);
      };
    }
  });
}

export type { LauncherState };

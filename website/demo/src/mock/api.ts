// The demo's stand-in for the launcher's preload bridge. Reads answer from an
// in-memory copy of the launcher state, and actions change that copy so the
// real launcher UI responds. Instead of doing the action, each one names a
// topic that the page shows an article for. Nothing touches files, processes
// or the network.
import type {
  EffectsChainTemplate, EffectsPreset, GameEffectsInfo, GameEffectsPlan, GraphicsOwnerStatus, GraphicsStatusEvent, LauncherApi,
  LauncherState, ReShadeState, RecentGame, RuntimeManagerState
} from "../../../../src/renderer/src/ui/types";
import type { AppActionPickerModel } from "../../../../src/renderer/src/ui/components/AppActionPicker";
import { normalizeUtilityWindowRequest, utilityWindowDefinition } from "../../../../src/core/utility-window-model.mjs";
import { ACTIONS as SHORTCUT_ACTIONS } from "../../../../src/modules/shared/graphics-shortcuts.mjs";
import { normalizeValues, withValues } from "../../../../src/modules/shared/runtime/translator-environment.mjs";
import { createExternalStores } from "./external";
import { runtimeTopic } from "./navigation";
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
/** Runtimes → Tools → Downloaded files as the launcher's component listing returned it for the demo profile. */
export type DemoComponents = { components: Array<{ id: string; items: Array<{ id: string }> } & Record<string, unknown>>; gameRunning: boolean };
/** The Apply Graphics window's targets, and the library entry each one starts. */
export type DemoPicker = { model: AppActionPickerModel; entries: Record<string, RecentGame> };

type Handlers = { [K in keyof LauncherApi]?: LauncherApi[K] };
type Section = Record<string, any>;

const resolved = <T,>(value: T) => Promise.resolve(value);
const unsubscribe = () => () => {};
const DEMO_ROOT = "/Users/Shared/MacLauncher Demo";

// Example versions offered after Refresh, so Install and Set default have
// something to act on. Any manager not listed here offers one example version.
const EXAMPLE_VERSIONS: Record<string, string[]> = {
  sdk: ["8.4.1", "8.3.7", "7.8.7"], godot: ["4.5.1", "4.4.1", "3.6.1"], love: ["11.5", "11.4"],
  mkxpz: ["2.4.2"], nwjs: ["0.104.0", "0.103.1"], unity: ["6000.2.6f2", "2022.3.62f2"], scummvm: ["2.9.1", "2.9.0", "2.8.1"]
};
// The processors each example version is built for. A runtime listed here
// publishes a build for each CPU, so Runtimes offers the other CPU's builds
// through its Build menu. Any other runtime with per-CPU lists publishes
// builds for the launcher's CPU only.
const EXAMPLE_BUILDS: Record<string, string[]> = { butterscotch: ["arm64", "x64"] };
// The demo has no files on disk, so each installed version shows one example
// size in Runtimes.
const EXAMPLE_INSTALL_BYTES = 64 * 1024 * 1024;
// Settings sidebar entries that belong to no game type.
const SETTINGS_SECTIONS = new Set(["launcher", "environment", "graphics"]);

// Module actions that only read state. The inspector and Settings call them
// on their own, so they get no article, and one without a recorded answer
// fails visibly instead of leaving its view waiting.
const STATUS_READ = /^(list|read|get)|(Status|Options|Recommendation|Inputs|Accounts)$/;
const unavailable = () => Promise.reject(new Error("This information isn't part of the demo."));

// One version list after Refresh: the list itself and each of its sources, or
// only the source refreshed. A CPU's list declares the builds made for it.
function listVersions(catalog: Section | undefined, versions: string[], architecture: string | null, sourceId?: string): Section {
  const requirements = { ...catalog?.versionRequirements };
  if (architecture) for (const version of versions) requirements[version] = { ...requirements[version], architecture };
  const list: Section = { ...catalog, status: "success", fetchedAt: Date.now(), error: null, installable: true, installReason: null,
    versions, installableVersions: versions, latestAvailableVersion: versions[0] || null, versionRequirements: requirements };
  if (Array.isArray(catalog?.sources)) list.sources = catalog.sources.map((source: Section) =>
    !sourceId || source.id === sourceId ? listVersions(source, versions, architecture) : source);
  return list;
}

/** A section after Refresh: its version list and each CPU's list. */
function refreshedSection(managerId: string, section: Section, sourceId?: string): Section {
  const versions = EXAMPLE_VERSIONS[managerId] || ["1.0.0"];
  const automatic = section.automaticArchitecture || section.launcherArchitecture || section.catalog?.architecture;
  const builds = EXAMPLE_BUILDS[managerId] || (automatic ? [automatic] : []);
  const build = (cpu: string) => builds.includes("universal") ? "universal" : builds.includes(cpu) ? cpu : null;
  const perCpu: Record<string, Section> | undefined = section.catalog?.architectureCatalogs;
  const catalog = listVersions(section.catalog, versions, perCpu && automatic ? build(automatic) : null, sourceId);
  if (perCpu) catalog.architectureCatalogs = Object.fromEntries(Object.entries(perCpu).map(([cpu, list]) =>
    [cpu, listVersions(list, build(cpu) ? versions : [], build(cpu), sourceId)]));
  return { ...section, catalog };
}

// Installed rows of one build: the same version, and the same variant and CPU
// where both name one.
const sameBuild = (row: Section, build: Section) => row.version === build.version &&
  (!row.variant || !build.variant || row.variant === build.variant) &&
  (!row.architecture || !build.architecture || row.architecture === build.architecture);

export function createLauncherApi(store: DemoStore, graphics: DemoGraphics, settingsActions: DemoSettingsActions,
  gameActions: DemoGameActions, components: DemoComponents, picker: DemoPicker): LauncherApi {
  let downloaded = components;
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

  // The first setting that differs from its saved or default value names the
  // topic, with the section of its field, such as a WINE runtime's Display.
  const settingChange = (moduleId: string | undefined, runtimeId: string, before: Section | null | undefined, after: Section | null) => {
    const schema = store.state.modules.find(item => item.id === moduleId)?.runtime?.entries?.[runtimeId]?.settings as
      { defaults?: Section; fields?: Array<{ key: string; section?: string }> } | undefined;
    const previous: Section = { ...schema?.defaults, ...before }, next: Section = { ...schema?.defaults, ...after };
    const fields = schema?.fields || [];
    const key = [...new Set([...fields.map(field => field.key), ...Object.keys(next), ...Object.keys(previous)])]
      .find(name => JSON.stringify(previous[name]) !== JSON.stringify(next[name]));
    const section = fields.find(field => field.key === key)?.section;
    return key ? { key, value: next[key], ...(section ? { section } : {}) } : undefined;
  };
  // A session entry, such as window graphics, leaves the library when its
  // session ends.
  const endSession = (gamePath: string) => store.update(state => {
    const { [gamePath]: _ended, ...running } = state.running;
    return { ...state, running, recents: state.recents.filter(entry => entry.gamePath !== gamePath) };
  });
  // Saved graphics presets, kept for the page's visit.
  let presets: EffectsPreset[] = [];
  const presetListeners = new Set<(presets: EffectsPreset[]) => void>();
  const setPresets = (next: EffectsPreset[]) => { presets = next; for (const listener of [...presetListeners]) listener(presets); return presets; };

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
  function effectTopic(before: GameEffectsPlan | null | undefined, after: GameEffectsPlan, moduleId?: string) {
    type Node = GameEffectsPlan["video"][number];
    const effect = (id: string, detail?: string) => store.topic({ kind: "effect", id, detail, moduleId });
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
    prioritizeGame: () => resolved(true),
    onState: callback => store.subscribe(callback),
    onActivity: unsubscribe,
    onGameImported: unsubscribe,
    onGameFailed: unsubscribe,
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
      // Settings names a game type's section as SettingsView reads it; its own
      // sections, such as Graphics, name no game type.
      const section = view === "settings" && typeof sectionId === "string" ? sectionId.replace(/^module:/, "").split(":")[0] : "";
      const own = SETTINGS_SECTIONS.has(section);
      const moduleId = section && !own ? section : "";
      store.topic(view === "runtimes" && typeof managerId === "string" && managerId ? runtimeTopic(store.state, "window", managerId)
        : { kind: "window", id: view, ...(moduleId ? { moduleId } : {}), ...(own ? { detail: section } : {}) });
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
    findMissingGames: gamePaths => {
      store.topic({ kind: "action", id: "findMissingGames" });
      return resolved(gamePaths.filter(gamePath => game(gamePath)?.availability));
    },

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
      const moduleId = moduleOf(gamePath), detail = settingChange(moduleId, runtimeId, game(gamePath)?.runtimeSettings?.[runtimeId], settings);
      updateGame(gamePath, entry => ({ runtimeSettings: { ...entry.runtimeSettings, [runtimeId]: settings } }));
      store.topic({ kind: "runtime-settings", id: runtimeId, moduleId, ...(detail ? { detail } : {}) });
      return resolved(true);
    },
    setGameTranslatorEnvironment: (gamePath, translatorId, values) => {
      const declaration = store.state.translatorEnvironments?.find(item => item.id === translatorId);
      if (!declaration) return Promise.reject(new Error("Unknown translator."));
      const normalized = normalizeValues(values, { declarations: [declaration] });
      updateGame(gamePath, entry => ({ translatorEnvironment: withValues(entry.translatorEnvironment, translatorId, normalized) }));
      store.topic({ kind: "runtime-settings", id: "environment", moduleId: moduleOf(gamePath) });
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
    stopGame: gamePath => {
      if (!game(gamePath)?.ephemeral) return resolved(true);
      endSession(gamePath);
      store.topic({ kind: "action", id: "stopSession" });
      return resolved(true);
    },
    removeSessionTarget: (gamePath, id) => {
      const targets = (game(gamePath)?.sessionTargets || []).filter(target => target.id !== id);
      if (targets.length) updateGame(gamePath, () => ({ sessionTargets: targets }));
      else endSession(gamePath);
      store.topic({ kind: "action", id: "removeSessionTarget" });
      return resolved(true);
    },
    // File → Apply Graphics…: the windows and displays to choose from, marked
    // when a running session already serves them. Choosing one closes the
    // window and starts its session, whose entry joins the library.
    appActionPickerState: () => {
      const served = new Set(Object.entries(picker.entries).filter(([, entry]) => store.state.running[entry.gamePath]).map(([id]) => id));
      return resolved({ ...picker.model, sections: picker.model.sections.map(section => ({ ...section, targets: section.targets.map(target =>
        served.has(target.id) ? { ...target, detail: [target.detail, "Has window graphics"].filter(Boolean).join(" · ") } : target) })) });
    },
    onAppActionPicker: unsubscribe,
    chooseAppActionTarget: targetId => {
      const entry = picker.entries[targetId];
      if (!entry) return resolved(false);
      if (!store.state.running[entry.gamePath]) store.update(state => ({ ...state, running: { ...state.running, [entry.gamePath]: 1 },
        recents: [...state.recents.filter(item => item.gamePath !== entry.gamePath), { ...entry, order: state.recents.length }] }));
      store.topic({ kind: "action", id: "chooseAppActionTarget" });
      store.closeWindow();
      return resolved(true);
    },
    openAppActionPickerLink: () => { store.topic({ kind: "action", id: "openAppActionPickerLink" }); return resolved(true); },
    setGameSteamClientStart: (gamePath, value) => {
      updateGame(gamePath, () => ({ startSteamClient: value || undefined }));
      store.topic({ kind: "action", id: "setGameSteamClientStart" });
      return resolved(true);
    },
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
    // Settings shows a shortcut recorder for each game action. Window graphics
    // need a running app to capture, so the demo has no recorder for them.
    getGraphicsShortcuts: () => {
      const assigned = store.state.launcherSettings?.graphicsShortcuts || {};
      return resolved((["bypass", "screenshot"] as const).map(action =>
        ({ action, label: SHORTCUT_ACTIONS[action], accelerator: assigned[action] || null })));
    },
    getGameEffectParameters: (_gamePath, nodeId) => resolved({ key: nodeId, parameters: [] }),
    setGameEffects: (gamePath, plan) => {
      effectTopic(game(gamePath)?.effects, plan, moduleOf(gamePath));
      updateGame(gamePath, () => ({ effects: plan }));
      graphicsRevision += 1;
      const event: GraphicsStatusEvent = { gamePath, status: graphicsStatus(gamePath), plan };
      for (const listener of [...graphicsListeners]) listener(event);
      return resolved(true);
    },
    resetGameEffects: gamePath => { updateGame(gamePath, () => ({ effects: null })); store.topic({ kind: "effect", id: "clear", moduleId: moduleOf(gamePath) }); return resolved(true); },
    listEffectsPresets: () => resolved(presets),
    onEffectsPresetsChanged: callback => {
      presetListeners.add(callback);
      return () => { presetListeners.delete(callback); };
    },
    saveEffectsPreset: value => {
      const saved: EffectsPreset = { id: value.id || `demo-preset-${Date.now()}`, name: value.name, updatedAt: Date.now(), plan: value.plan };
      setPresets([...presets.filter(item => item.id !== saved.id), saved]);
      store.topic({ kind: "action", id: "saveEffectsPreset" });
      return resolved(saved);
    },
    deleteEffectsPreset: id => { store.topic({ kind: "action", id: "deleteEffectsPreset" }); return resolved(setPresets(presets.filter(item => item.id !== id))); },
    // Settings → Graphics → Presets edits a chain for the window host, as the launcher does.
    getEffectsPresetEditor: plan => resolved({ ...graphics.hosts.window.info, plan: plan || graphics.hosts.window.info.plan }),
    getEffectsPresetParameters: nodeId => resolved({ key: nodeId, parameters: [] }),
    getEffectsPresetNotices: () => resolved([]),

    // Runtimes and settings.
    runtimeAction: (managerId, action, payload) => {
      const sectionId = typeof payload?.sectionId === "string" ? payload.sectionId : "default";
      const version = typeof payload?.version === "string" ? payload.version : null;
      const variant = typeof payload?.variant === "string" ? payload.variant : undefined;
      const architecture = typeof payload?.architecture === "string" ? payload.architecture : undefined;
      // The build choice: another CPU's list, or the one an installation was made from.
      const choice = architecture || /^architecture:(.+)$/.exec(variant || "")?.[1];
      // A section with a list per CPU records each installation's build choice
      // as its variant, as the launcher's architecture manager does.
      const buildOf = (section: Section) => ({ version, ...(variant ? { variant }
        : choice && section.catalog?.architectureCatalogs ? { variant: `architecture:${choice}` } : {}), ...(architecture ? { architecture } : {}) });
      let otherCpu = false;
      if (action === "refreshCatalog") {
        updateManager(managerId, sectionId, section =>
          refreshedSection(managerId, section, typeof payload?.sourceId === "string" ? payload.sourceId : undefined));
      } else if (action === "install" && version) {
        // Installing again replaces the same build, which repairs a damaged one.
        updateManager(managerId, sectionId, section => {
          const build = buildOf(section);
          const cpu = (choice && section.catalog?.architectureCatalogs?.[choice]?.versionRequirements?.[version]?.architecture) || choice;
          otherCpu = Boolean(cpu && cpu !== "universal" && section.automaticArchitecture && cpu !== section.automaticArchitecture);
          return { ...section, defaultVersion: section.defaultVersion ?? version,
            installed: [...(section.installed || []).filter((item: Section) => !sameBuild(item, build)),
              { ...build, ...(cpu ? { architecture: cpu } : {}), installDir: `${DEMO_ROOT}/runtimes/${managerId}/${choice ? `${choice}/` : ""}${version}`,
                source: "download", ready: true, status: "ready" }] };
        });
      } else if (action === "setDefault") {
        updateManager(managerId, sectionId, section => {
          otherCpu = Boolean(choice && section.automaticArchitecture && choice !== section.automaticArchitecture);
          return { ...section, defaultVersion: version, ...(variant && !variant.startsWith("architecture:") ? { defaultVariant: variant } : {}),
            ...(choice ? { defaultArchitecture: choice } : {}) };
        });
      } else if (action === "uninstall" && version) {
        updateManager(managerId, sectionId, section => {
          const installed = (section.installed || []).filter((item: Section) => !sameBuild(item, buildOf(section)));
          return { ...section, installed, defaultVersion: section.defaultVersion === version &&
            !installed.some((item: Section) => item.version === version) ? null : section.defaultVersion };
        });
      }
      // A build for the other processor also names the processor builds topic.
      store.topic({ kind: "runtime-action", id: action, ...(otherCpu ? { detail: "build" } : {}) });
      return resolved(true);
    },
    // Check for Updates answers as GitHub would when this version is the
    // newest release. Nothing is downloaded or contacted.
    appUpdate: action => {
      store.topic({ kind: "action", id: "appUpdate" });
      const update = store.state.appUpdate;
      if (action !== "check" || !update || update.phase !== "idle") return resolved(false);
      const setUpdate = (patch: Partial<NonNullable<LauncherState["appUpdate"]>>) =>
        store.update(state => state.appUpdate ? { ...state, appUpdate: { ...state.appUpdate, ...patch } } : state);
      setUpdate({ phase: "checking" });
      setTimeout(() => setUpdate({ phase: "idle", lastCheck: { checkedAt: Date.now(), currentVersion: update.currentVersion,
        outcome: "current", version: update.currentVersion } }), 800);
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
    // Settings for every game of a type are saved as the runtime's defaults.
    setModuleRuntimeSettings: (moduleId, runtimeId, settings) => {
      const detail = settingChange(moduleId, runtimeId, store.state.runtimeDefaults[runtimeId], settings);
      store.update(state => {
        const { [runtimeId]: _previous, ...others } = state.runtimeDefaults;
        return { ...state, runtimeDefaults: settings ? { ...others, [runtimeId]: settings } : others };
      });
      store.topic({ kind: "runtime-settings", id: runtimeId, moduleId, ...(detail ? { detail } : {}) });
      return resolved(true);
    },
    // Settings → Environment variables and a game's Runtime Settings store
    // values the way the launcher does.
    setTranslatorEnvironment: (translatorId, values) => {
      const declaration = store.state.translatorEnvironments?.find(item => item.id === translatorId);
      if (!declaration) return Promise.reject(new Error("Unknown translator."));
      const normalized = normalizeValues(values, { declarations: [declaration] });
      store.update(state => ({ ...state, launcherSettings: { ...state.launcherSettings,
        translatorEnvironment: withValues(state.launcherSettings?.translatorEnvironment, translatorId, normalized) } }));
      store.topic({ kind: "settings", id: "translatorEnvironment" });
      return resolved(true);
    },
    // Downloaded files and the sizes of installed versions. Listing and
    // measuring are reads, so they name no topic.
    componentAction: ((action: string, payload?: Record<string, string>) => {
      if (action === "list") return resolved(downloaded);
      if (action === "sizes") {
        const manager = store.state.runtimeManagers[String(payload?.managerId || "")] as Section | undefined;
        const installed = [...(manager?.installed || []), ...(manager?.sections || []).flatMap((section: Section) => section.installed || [])];
        return resolved({ sizes: Object.fromEntries(installed.filter((item: Section) => typeof item.installDir === "string")
          .map((item: Section) => [item.installDir, { bytes: EXAMPLE_INSTALL_BYTES, complete: true }])) });
      }
      store.topic({ kind: "runtime-action", id: "downloaded-files" });
      if (action === "remove") {
        downloaded = { ...downloaded, components: downloaded.components.map(component => component.id !== payload?.componentId ? component
          : { ...component, items: component.items.filter(item => String(item.id) !== String(payload?.itemId)) }) };
        return resolved(true);
      }
      if (action === "refresh") return resolved("");
      return resolved(action === "reveal");
    }) as LauncherApi["componentAction"],

    // External stores.
    steamState: () => resolved(external.steamState()),
    onSteamState: callback => external.onSteamState(callback),
    steamScan: () => { store.topic({ kind: "store", id: "scan", detail: "installed" }); return resolved(external.scan()); },
    externalDownloaded: () => resolved([]),
    steamConnect: () => { store.topic({ kind: "store", id: "account", detail: "steam" }); return resolved(external.connect()); },
    steamDisconnect: () => resolved(external.disconnect()),
    steamLibrary: () => resolved(external.steamState()),
    steamVersions: appId => { store.topic({ kind: "store", id: "versions", detail: "steam" }); return resolved(external.versions(appId)); },
    steamPreviousVersions: () => resolved({ history: [], sourceUrl: "", sources: [], fetchedAt: new Date(0).toISOString() }),
    steamDownload: selection => { store.topic({ kind: "store", id: "download", detail: "steam" }); return resolved(external.download(selection)); },
    steamImport: () => { store.topic({ kind: "store", id: "import" }); return resolved(true); },
    steamAuth: () => { store.topic({ kind: "store", id: "account", detail: "steam" }); return resolved(external.connect()); },
    steamSelectAccount: () => resolved(external.steamState()),
    steamRemoveAccount: () => resolved(external.disconnect()),
    steamImportDownload: () => { store.topic({ kind: "store", id: "import" }); return resolved(true); },
    steamCancel: () => resolved(true),
    externalState: storeId => resolved(external.storeState(storeId)),
    onExternalState: callback => external.onStoreState(callback),
    externalConnect: storeId => { store.topic({ kind: "store", id: "account", detail: storeId }); return resolved(external.connectStore(storeId)); },
    externalAuth: storeId => { store.topic({ kind: "store", id: "account", detail: storeId }); return resolved(external.connectStore(storeId)); },
    externalOpenLogin: storeId => { store.topic({ kind: "store", id: "account", detail: storeId }); return resolved(external.storeState(storeId)); },
    externalDisconnect: storeId => resolved(external.disconnectStore(storeId)),
    externalForget: storeId => resolved(external.disconnectStore(storeId)),
    externalAccounts: () => resolved({ accounts: [] }),
    externalOpenAccounts: () => { store.topic({ kind: "store", id: "account" }); return resolved(true); },
    externalLibrary: storeId => resolved(external.storeState(storeId)),
    externalSearch: (storeId, query) => { store.topic({ kind: "store", id: "search", detail: storeId }); return resolved(external.search(storeId, query)); },
    externalAddGame: storeId => { store.topic({ kind: "store", id: "account", detail: storeId }); return resolved(external.storeState(storeId)); },
    externalAddToLibrary: storeId => resolved(external.storeState(storeId)),
    externalVersions: (storeId, appId) => { store.topic({ kind: "store", id: "versions", detail: storeId }); return resolved(external.storeVersions(storeId, appId)); },
    externalDownload: (storeId, selection) => { store.topic({ kind: "store", id: "download", detail: storeId }); return resolved(external.storeDownload(storeId, selection)); },
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

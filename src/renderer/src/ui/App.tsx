import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { filterGames } from "./search-utils.mjs";
import { prioritizeDroppedPaths } from "./drop-path-utils.mjs";
import { createInspectionRequests, shareLauncherValue, subscribeLauncherGameFailures, subscribeLauncherState, updatePathValue } from "./launcher-state-model.mjs";
import { readUtilityWindowContext } from "../../../core/utility-window-model.mjs";
import type {
  CheatsConfig,
  CheatsField,
  CheatsPatchStatus,
  CheatsSchema,
  LauncherState,
  LibsPatchStatus,
  ModuleUiAction,
  ModuleUiCheatsPatch,
  ModuleManifest,
  RecentGame,
  RuntimeId,
  RuntimeSettingsContext,
  RuntimeStatusEntry,
  RuntimeUiState,
  UtilityWindowRequest,
  SaveFileInfo,
  SaveInfo
} from "./types";
import {
  formatUserError,
  readRuntimeSettingsContext,
  readSaveEditorContext,
  resolveRuntimeManagerId,
  resolveRuntimeSection,
  resolveRuntimeSectionId,
  resolveRuntimeSections
} from "./ui-helpers";
import { SettingsIcon } from "./icons";
import { RuntimeSettingsWindow } from "./components/RuntimeSettingsWindow";
import { LiveVariablesWindow, readLiveVariableEditorContext } from "./components/LiveVariablesWindow";
import { SaveToolsModal } from "./components/modals/SaveToolsModal";
import { CheatsModal } from "./components/modals/CheatsModal";
import { SettingsView } from "./components/SettingsView";
import { CreditsView } from "./components/CreditsView";
import { RuntimesView } from "./components/RuntimesView";
import { groupRuntimeManagers, managedRuntimeSections, runtimeManagementPresentation, runtimeRemovalPresentation } from "./components/runtime-tabs-model";
import { nextInspectorSelection } from "./components/game-row-selection-model";
import { GameRow } from "./components/GameRow";
import { GameDetails, type GameDetailsState } from "./components/GameDetails";
import { LibrarySearch, LibraryToolbar, type LibraryScope } from "./components/LibraryToolbar";
import { ImportProgress } from "./components/ImportProgress";
import launcherLogo from "./assets/maclauncher.svg";
import sharedAcknowledgments from "../../../modules/shared/acknowledgments.json";
import { collectAcknowledgments } from "./acknowledgments-model";
import { toggleLibrarySelection } from "../../../core/library-selection.mjs";
import { normalizeLibrarySort, sortLibraryGames, reorderLibraryGames, type LibrarySort } from "../../../core/library-view.mjs";
import type { LibraryActions } from "./components/library-actions";

const EMPTY_ACTION_STATE = Object.freeze({});
const INTERNAL_GAME_DRAG_TYPE = "application/x-maclauncher-gamepath";
const reconcileLauncherState = (previous: LauncherState | null, incoming: LauncherState) => shareLauncherValue(previous, incoming);

const DROP_GAME_TARGETS: Array<{ label: string; mono?: boolean }> = [
  { label: "Game folder" },
  { label: "Game.app", mono: true },
  { label: "Game.love", mono: true },
  { label: "Game.AppImage", mono: true },
  { label: "Game.exe", mono: true },
  { label: "Game.x86_64", mono: true },
  { label: "Game.jar", mono: true },
  { label: "Game.swf", mono: true },
  { label: "Game.sh", mono: true },
  { label: "Game.py", mono: true }
];

type DropGameHintProps = {
  className?: string;
  title: string;
  action?: React.ReactNode;
};

function DropGameHint({ className, title, action }: DropGameHintProps) {
  return (
    <div className={["dropHint", className || ""].filter(Boolean).join(" ")}>
      <div className="dropHintTitle">{title}</div>
      <div className="dropHintSubtitle">Supported inputs</div>
      <div className="dropHintFormats" aria-label="Supported game inputs">
        {DROP_GAME_TARGETS.map(target => (
          <span
            key={target.label}
            className={["badge", "dropHintFormat", target.mono ? "mono" : ""]
              .filter(Boolean)
              .join(" ")}
          >
            {target.label}
          </span>
        ))}
      </div>
      {action ? <div className="dropHintAction">{action}</div> : null}
    </div>
  );
}

export default function App() {
  const api = window.MacLauncher?.launcher;
  const utilityWindowContext = useMemo(() => readUtilityWindowContext(window.location.search), []);
  const runtimesOpen = utilityWindowContext?.view === "runtimes";
  const [state, setState] = useReducer(reconcileLauncherState, null);
  const latestState = useRef(state);
  latestState.current = state;
  const [inspectionRequests] = useState(createInspectionRequests);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [gameTypeFilter, setGameTypeFilter] = useState<Record<string, boolean>>({});
  const [gameTypesOpen, setGameTypesOpen] = useState(false);
  const [libraryScope, setLibraryScope] = useState<LibraryScope>("all");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [missingPaths, setMissingPaths] = useState<string[]>([]);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const selectionAnchor = useRef<string | null>(null);
  const currentVisiblePaths = useRef<string[]>([]);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [runtimeManagerId, setRuntimeManagerId] = useState<string | null>(utilityWindowContext?.managerId || null);
  const [runtimeSectionId, setRuntimeSectionId] = useState<string | null>(null);
  const [runtimeUi, setRuntimeUi] = useState<RuntimeUiState>({});
  const runtimeActionLocks = useRef(new Set<string>());
  const [saveGame, setSaveGame] = useState<RecentGame | null>(null);
  const [saveInfo, setSaveInfo] = useState<SaveInfo | null>(null);
  const [saveFiles, setSaveFiles] = useState<SaveFileInfo[]>([]);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<SaveFileInfo | null>(null);
  const [editingJson, setEditingJson] = useState<string>("");
  const [editingSourceHash, setEditingSourceHash] = useState<string | null>(null);
  const [saveRevision, setSaveRevision] = useState(0);
  const [cheatGame, setCheatGame] = useState<RecentGame | null>(null);
  const [cheatSchema, setCheatSchema] = useState<CheatsSchema | null>(null);
  const [cheatDraft, setCheatDraft] = useState<CheatsConfig | null>(null);
  const [toolsButtonOverride, setToolsButtonOverride] = useState<boolean | null>(null);
  const [cheatBusy, setCheatBusy] = useState(false);
  const [cheatError, setCheatError] = useState<string | null>(null);
  const [cheatAddonStatusByPath, setCheatAddonStatusByPath] = useState<
    Record<string, CheatsPatchStatus | null>
  >({});
  const [cheatAddonBusy, setCheatAddonBusy] = useState(false);
  const cheatAutoSavePendingRef = useRef<{
    gamePath: string;
    moduleId: string;
    draft: CheatsConfig;
    toolsOverride: boolean | null;
  } | null>(null);
  const cheatAutoSaveInFlightRef = useRef(false);
  const cheatAutoSaveSkipRef = useRef(false);
  const cheatAutoSaveOverrideRef = useRef<{ gamePath: string; value: boolean | null } | null>(
    null
  );
  const [cheatsPatchStatusByPath, setCheatsPatchStatusByPath] = useState<
    Record<string, CheatsPatchStatus | null>
  >({});
  const [cheatsPatchBusyPath, setCheatsPatchBusyPath] = useState<string | null>(null);
  const [libsPatchStatusByPath, setLibsPatchStatusByPath] = useState<
    Record<string, LibsPatchStatus | null>
  >({});
  const latestLibsPatchStatus = useRef(libsPatchStatusByPath);
  latestLibsPatchStatus.current = libsPatchStatusByPath;
  const [libsPatchBusyPath, setLibsPatchBusyPath] = useState<string | null>(null);
  const [moduleActionResultsByPath, setModuleActionResultsByPath] = useState<
    Record<string, Record<string, any>>
  >({});
  const [moduleActionBusyByPath, setModuleActionBusyByPath] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const [moduleActionErrorByPath, setModuleActionErrorByPath] = useState<
    Record<string, string | null>
  >({});
  const [runtimeStatusByPath, setRuntimeStatusByPath] = useState<
    Record<string, RuntimeStatusEntry | null>
  >({});
  const [selectedGamePath, setSelectedGamePath] = useState<string | null>(null);
  const [draggingGamePath, setDraggingGamePath] = useState<string | null>(null);
  const [dragOrderPaths, setDragOrderPaths] = useState<string[] | null>(null);
  const [addDropActive, setAddDropActive] = useState(false);
  const addDropDepth = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inspectorSelection = useRef({ selectedGamePath, inspectorOpen });
  inspectorSelection.current = { selectedGamePath, inspectorOpen };
  const runtimeSettingsContext = useMemo(() => readRuntimeSettingsContext(), []);
  const saveEditorContext = useMemo(() => readSaveEditorContext(), []);
  const liveVariableEditorContext = useMemo(() => readLiveVariableEditorContext(), []);
  const saveEditorInitializedRef = useRef<string | null>(null);
  const isSecondaryView = Boolean(utilityWindowContext || runtimeSettingsContext || saveEditorContext || liveVariableEditorContext);

  useEffect(() => {
    if (!api) {
      setError("Could not load MacLauncher. Restart the app.");
      return;
    }

    return subscribeLauncherState(api, setState, error => setError(String(error?.message || error)));
  }, [api]);

  useEffect(() => {
    inspectionRequests.retain((state?.recents || []).map(game => game.gamePath));
  }, [inspectionRequests, state?.recents]);

  useEffect(() => {
    if (isSecondaryView) return;
    return subscribeLauncherGameFailures(api, setError);
  }, [api, isSecondaryView]);

  useEffect(() => {
    if (!api?.onGameImported || isSecondaryView) return;
    return api.onGameImported(gamePath => {
      setSearchQuery("");
      setGameTypeFilter({});
      setLibraryScope("all");
      setSelectionMode(false);
      setSelectedGamePath(gamePath);
      setInspectorOpen(true);
      setError(null);
    });
  }, [api, isSecondaryView]);

  useEffect(() => {
    if (!runtimesOpen || !state?.utilityWindow?.managerId) return;
    setRuntimeManagerId(state.utilityWindow.managerId);
    setRuntimeSectionId(null);
  }, [runtimesOpen, state?.utilityWindow?.revision]);

  useEffect(() => {
    if (!runtimesOpen) return;
    if (!state?.runtimeManagers) return;

    setRuntimeUi(prev => {
      let didChange = false;
      const next = { ...prev };
      for (const manager of groupRuntimeManagers(Object.values(state.runtimeManagers)).flatMap(group => group.managers)) {
        const sections = managedRuntimeSections(manager, resolveRuntimeSections);
        const existing = next[manager.id];
        const current = existing || {
          remoteOpen: {},
          installVersion: {},
          installVariant: {},
          installedSort: {},
          error: null
        };
        let managerChanged = !existing;
        const installVersion = { ...current.installVersion };
        const installVariant = { ...current.installVariant };
        const installedSort = { ...current.installedSort };
        for (const section of sections) {
          const versions = Array.isArray(section.catalog?.versions) ? section.catalog.versions : [];
          const currentVersion = installVersion[section.id];
          const fallback = versions[0] || "";
          const nextVersion =
            currentVersion && versions.includes(currentVersion) ? currentVersion : fallback;
          if (installVersion[section.id] !== nextVersion) {
            installVersion[section.id] = nextVersion;
            managerChanged = true;
          }
        const variantOptions = (Array.isArray(section.variants)
          ? section.variants
          : []) as Array<{ id?: string } & Record<string, any>>;
          const hasMultipleVariants = variantOptions.length > 1;
          const currentVariant = installVariant[section.id];
          const fallbackVariant = hasMultipleVariants
            ? section.defaultVariant || variantOptions[0]?.id || ""
            : "";
          const nextVariant =
            hasMultipleVariants &&
            currentVariant &&
            variantOptions.some((opt: { id?: string }) => opt.id === currentVariant)
              ? currentVariant
              : fallbackVariant;
          if (installVariant[section.id] !== nextVariant) {
            installVariant[section.id] = nextVariant;
            managerChanged = true;
          }
          const nextSort = installedSort[section.id] || "default";
          if (installedSort[section.id] !== nextSort) {
            installedSort[section.id] = nextSort;
            managerChanged = true;
          }
        }
        if (managerChanged) {
          next[manager.id] = {
            ...current,
            installVersion,
            installVariant,
            installedSort
          };
          didChange = true;
        }
      }
      return didChange ? next : prev;
    });
  }, [runtimesOpen, state?.runtimeManagers]);

  useEffect(() => {
    if (runtimesOpen) return;
    setDownloadsOpen(false);
  }, [runtimesOpen]);

  const inspectionGame = useMemo(() => state?.recents.find(game => game.gamePath === selectedGamePath) || null,
    [state?.recents, selectedGamePath]);
  const inspectionModule = useMemo(() => state?.modules.find(module => module.id === inspectionGame?.moduleId) || null,
    [state?.modules, inspectionGame?.moduleId]);
  const inspectionModuleState = inspectionGame ? state?.moduleStates[inspectionGame.moduleId] : undefined;
  const inspectionModuleSettings = inspectionGame ? state?.moduleSettings[inspectionGame.moduleId] : undefined;
  const inspectionManagerId = resolveRuntimeManagerId(inspectionModule, inspectionGame?.runtimeId || "");
  const inspectionManager = inspectionManagerId ? state?.runtimeManagers[inspectionManagerId] : undefined;
  const inspectionDefaults = inspectionManagerId ? state?.runtimeDefaults[inspectionManagerId] : undefined;
  const inspectionRunning = inspectionGame ? state?.running[inspectionGame.gamePath] || 0 : 0;
  const inspectionPreparing = inspectionGame ? state?.preparing?.[inspectionGame.gamePath] : undefined;
  const detailsState = useMemo<GameDetailsState>(() => ({
    modules: state?.modules || [],
    moduleStates: inspectionGame && inspectionModuleState ? { [inspectionGame.moduleId]: inspectionModuleState } : {},
    runtimeManagers: inspectionManagerId && inspectionManager ? { [inspectionManagerId]: inspectionManager } : {},
    running: inspectionGame ? { [inspectionGame.gamePath]: inspectionRunning } : {},
    preparing: inspectionGame && inspectionPreparing ? { [inspectionGame.gamePath]: inspectionPreparing } : {}
  }), [state?.modules, inspectionGame?.moduleId, inspectionGame?.gamePath, inspectionModuleState,
    inspectionManagerId, inspectionManager, inspectionRunning, inspectionPreparing]);

  useEffect(() => {
    if (!api || !inspectionGame) return;
    const gamePath = inspectionGame.gamePath;
    if (!inspectionGame.moduleSupports?.cheatsPatcher) {
      setCheatsPatchStatusByPath(previous => updatePathValue(previous, gamePath, null));
      return;
    }
    let active = true;
    api.getCheatsPatchStatus(gamePath).then(status => {
      if (active) setCheatsPatchStatusByPath(previous => updatePathValue(previous, gamePath, status));
    }).catch(() => {});
    return () => { active = false; };
  }, [api, inspectionGame?.gamePath, inspectionGame?.moduleSupports.cheatsPatcher,
    inspectionGame?.runtimeId, inspectionGame?.runtimeData, inspectionGame?.runtimeSettings, inspectionGame?.moduleData]);

  useEffect(() => {
    if (!api || !inspectionGame) return;
    const gamePath = inspectionGame.gamePath;
    if (!inspectionModuleState?.libs?.dependencies) {
      setLibsPatchStatusByPath(previous => updatePathValue(previous, gamePath, null));
      return;
    }
    let active = true;
    api.getLibsPatchStatus(gamePath).then(status => {
      if (active) setLibsPatchStatusByPath(previous => updatePathValue(previous, gamePath, status));
    }).catch(() => {});
    return () => { active = false; };
  }, [api, inspectionGame?.gamePath, inspectionGame?.runtimeId, inspectionGame?.runtimeData,
    inspectionGame?.runtimeSettings, inspectionGame?.moduleData, inspectionModuleState?.libs?.dependencies]);

  const automaticInspectionKey = useMemo(() => {
    if (!inspectionGame) return "";
    return JSON.stringify([inspectionModule?.ui?.actions?.filter(action => action.autoRun).map(action => action.id),
      inspectionGame.runtimeId, inspectionGame.moduleData, inspectionGame.runtimeData, inspectionGame.runtimeSettings,
      inspectionModuleSettings, inspectionModuleState, inspectionDefaults,
      inspectionManager && resolveRuntimeSections(inspectionManager).map(section => [section.id, section.defaultVersion,
        section.defaultVariant, section.installed?.map((install: any) => [install.version, install.ready,
          install.variant, install.binarySha256, install.libraries])])]);
  }, [inspectionGame, inspectionModule, inspectionModuleSettings, inspectionModuleState, inspectionDefaults, inspectionManager]);

  useEffect(() => {
    if (!api || !inspectionGame) return;
    let active = true;
    for (const action of inspectionModule?.ui?.actions?.filter(action => action.autoRun) || []) {
      inspectionRequests.run(inspectionGame.gamePath, action.id, automaticInspectionKey,
        () => api.moduleAction(inspectionGame.gamePath, action.id, {})).then(({ current, value }) => {
        if (!active || !current) return;
        setModuleActionResultsByPath(previous => updatePathValue(previous, inspectionGame.gamePath,
          updatePathValue(previous[inspectionGame.gamePath] || {}, action.id, value)));
      }).catch(() => {});
    }
    return () => { active = false; };
  }, [api, inspectionGame?.gamePath, automaticInspectionKey, inspectionRequests]);

  const runtimeInspectionKey = useMemo(() => {
    if (!inspectionGame) return "";
    const preLaunch = inspectionModule?.runtime?.preLaunch?.[inspectionGame.runtimeId];
    if (!preLaunch?.statusAction || inspectionGame.runtimeData?.[inspectionGame.runtimeId]?.version) return "";
    const sectionId = resolveRuntimeSectionId(inspectionModule, inspectionGame.runtimeId, inspectionGame);
    const section = resolveRuntimeSection(inspectionManager || null, sectionId);
    return JSON.stringify([preLaunch.statusAction, inspectionGame.runtimeId, inspectionGame.moduleData,
      inspectionGame.runtimeData, inspectionGame.runtimeSettings, inspectionModuleSettings, inspectionDefaults,
      section?.defaultVersion, section?.defaultVariant, section?.installed, section?.catalog?.fetchedAt]);
  }, [inspectionGame, inspectionModule, inspectionManager, inspectionModuleSettings, inspectionDefaults]);

  useEffect(() => {
    if (!api || !inspectionGame) return;
    const gamePath = inspectionGame.gamePath;
    if (!runtimeInspectionKey) {
      setRuntimeStatusByPath(previous => updatePathValue(previous, gamePath, null));
      return;
    }
    const action = inspectionModule!.runtime!.preLaunch![inspectionGame.runtimeId].statusAction!;
    let active = true;
    inspectionRequests.run(gamePath, `preLaunch:${action}`, runtimeInspectionKey,
      () => api.moduleAction(gamePath, action, {})).then(({ current, value }) => {
      if (active && current) setRuntimeStatusByPath(previous => updatePathValue(previous, gamePath,
        { runtimeId: inspectionGame.runtimeId, status: value }));
    }).catch(() => {
      if (active) setRuntimeStatusByPath(previous => updatePathValue(previous, gamePath,
        { runtimeId: inspectionGame.runtimeId, status: null }));
    });
    return () => { active = false; };
  }, [api, inspectionGame?.gamePath, runtimeInspectionKey, inspectionRequests]);

  const sorted = useMemo(() => state?.recents ?? [], [state?.recents]);
  const librarySort = useMemo(() => normalizeLibrarySort(state?.launcherSettings?.library?.sort), [state?.launcherSettings?.library?.sort]);
  const favoriteIds = useMemo(() => state?.launcherSettings?.library?.favorites || [], [state?.launcherSettings?.library?.favorites]);
  const favorites = useMemo(() => new Set(favoriteIds), [favoriteIds]);
  const manualGames = useMemo(() => sortLibraryGames(sorted, { mode: "custom" }, favoriteIds), [sorted, favoriteIds]);
  const orderedGames = useMemo(() => {
    if (!dragOrderPaths || dragOrderPaths.length === 0) return sorted;
    const byPath = new Map(sorted.map(g => [g.gamePath, g]));
    const ordered: RecentGame[] = [];
    for (const gamePath of dragOrderPaths) {
      const entry = byPath.get(gamePath);
      if (!entry) continue;
      ordered.push(entry);
      byPath.delete(gamePath);
    }
    if (byPath.size > 0) {
      ordered.push(...Array.from(byPath.values()));
    }
    return ordered;
  }, [dragOrderPaths, sorted]);

  const gameTypeOptions = useMemo(() => {
    const options = (state?.modules || []).map(mod => ({
      id: mod.id,
      label: mod.shortLabel || mod.label || mod.id,
      title: mod.label || mod.shortLabel || mod.id
    }));
    options.sort((a, b) => a.label.localeCompare(b.label));
    return options;
  }, [state?.modules]);

  const activeGameTypeIds = useMemo(() => {
    const ids: string[] = [];
    for (const option of gameTypeOptions) {
      if (gameTypeFilter[option.id] !== false) ids.push(option.id);
    }
    return ids;
  }, [gameTypeOptions, gameTypeFilter]);

  const allGameTypesSelected =
    gameTypeOptions.length === 0 ||
    gameTypeOptions.every(option => gameTypeFilter[option.id] !== false);
  const anyGameTypesSelected =
    gameTypeOptions.length > 0 &&
    gameTypeOptions.some(option => gameTypeFilter[option.id] !== false);

  const visibleGames = useMemo(
    () =>
      filterGames(
        sortLibraryGames(orderedGames, librarySort, favoriteIds),
        searchQuery,
        gameTypeOptions.length > 0 ? activeGameTypeIds : null
      ).filter(game => libraryScope === "all" || (libraryScope === "favorites"
        ? favorites.has(game.gameId) : (state?.running?.[game.gamePath] || 0) > 0)),
    [orderedGames, librarySort, favoriteIds, favorites, searchQuery, activeGameTypeIds, gameTypeOptions.length, libraryScope, state?.running]
  );

  const selectedGame = useMemo(
    () => visibleGames.find(g => g.gamePath === selectedGamePath) || null,
    [visibleGames, selectedGamePath]
  );

  useEffect(() => {
    if (selectedGamePath && !selectedGame) setSelectedGamePath(null);
  }, [selectedGamePath, selectedGame]);

  const isFiltering =
    Boolean(searchQuery.trim()) ||
    libraryScope !== "all" ||
    (gameTypeOptions.length > 0 && !allGameTypesSelected);
  const dragDisabled = librarySort.mode !== "custom" || selectionMode;
  const visiblePaths = useMemo(() => shareLauncherValue(currentVisiblePaths.current,
    visibleGames.map(game => game.gamePath)), [visibleGames]);
  currentVisiblePaths.current = visiblePaths;
  const latestLibraryView = useRef({ visibleGames, manualGames, favorites, dragDisabled });
  latestLibraryView.current = { visibleGames, manualGames, favorites, dragDisabled };
  const checkedPaths = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const missingGames = useMemo(() => new Set(missingPaths), [missingPaths]);

  useEffect(() => {
    const visible = new Set(visiblePaths);
    setSelectedPaths(previous => {
      const next = previous.filter(path => visible.has(path));
      return next.length === previous.length ? previous : next;
    });
    if (selectionAnchor.current && !visible.has(selectionAnchor.current)) selectionAnchor.current = null;
  }, [visiblePaths]);

  const onToggleSelection = useCallback((gamePath: string, range = false) => {
    if (selectionBusy) return;
    setSelectedPaths(previous => {
      const result = toggleLibrarySelection(previous, visiblePaths, gamePath, selectionAnchor.current, range);
      selectionAnchor.current = result.anchor;
      return result.selected;
    });
  }, [visiblePaths, selectionBusy]);

  function toggleSelectionMode() {
    setSelectionMode(previous => !previous);
    setSelectedPaths([]);
    selectionAnchor.current = null;
    clearReorderState();
  }

  async function detectMissing(select = false) {
    if (!api || selectionBusy) return;
    setSelectionBusy(true); setError(null);
    try {
      const missing = await api.findMissingGames(visiblePaths);
      setMissingPaths(missing);
      if (select) setSelectedPaths(missing.filter(path => currentVisiblePaths.current.includes(path)));
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setSelectionBusy(false); }
  }

  const selectedRemovalBusy = selectedPaths.some(gamePath => Boolean(state?.running?.[gamePath] || state?.preparing?.[gamePath]));
  async function removeSelected(trash = false) {
    const paths = selectedPaths.filter(path => visiblePaths.includes(path));
    if (!api || selectionBusy || selectedRemovalBusy || !paths.length) return;
    if (!trash && !window.confirm(`Forget ${paths.length} selected games? Game files stay on disk; per-game launcher data will be removed.`)) return;
    setSelectionBusy(true); setError(null);
    try {
      const result = await (trash ? api.deleteGames(paths) : api.forgetGames(paths));
      const removed = new Set(result.removedPaths);
      setSelectedPaths(previous => previous.filter(path => !removed.has(path)));
      if (result.failures.length) setError(result.failures.map(item => `${item.gamePath}: ${item.error}`).join("\n"));
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setSelectionBusy(false); }
  }

  useEffect(() => {
    if (!selectionMode || isSecondaryView) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (selectionBusy) return;
      const target = event.target as HTMLElement;
      if (target.closest(".modalBackdrop") || target.matches("input:not([type=checkbox]),textarea,select")) return;
      if (event.metaKey && event.key.toLowerCase() === "a") {
        event.preventDefault(); setSelectedPaths(visiblePaths);
      } else if (event.key === "Escape" && !selectionBusy) {
        setSelectionMode(false); setSelectedPaths([]); selectionAnchor.current = null;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectionMode, visiblePaths, selectionBusy, isSecondaryView]);

  const selectGame = useCallback((gamePath: string, options?: { toggleSelection: boolean; range: boolean }) => {
    if (options?.toggleSelection) {
      if (selectionBusy) return;
      setSelectionMode(true);
      onToggleSelection(gamePath, options.range);
      return;
    }
    const current = inspectorSelection.current;
    const next = nextInspectorSelection(current.selectedGamePath, current.inspectorOpen, gamePath);
    inspectorSelection.current = next;
    setSelectedGamePath(next.selectedGamePath);
    setInspectorOpen(next.inspectorOpen);
  }, [onToggleSelection, selectionBusy]);
  const closeInspector = useCallback(() => {
    const gamePath = inspectorSelection.current.selectedGamePath;
    inspectorSelection.current = { ...inspectorSelection.current, inspectorOpen: false };
    setInspectorOpen(false);
    const button = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(".gameSelect") || [])
      .find(button => button.dataset.gamePath === gamePath);
    button?.focus();
  }, []);

  useEffect(() => {
    if (isSecondaryView) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.key.toLowerCase() !== "f" || saveGame || cheatGame) return;
      event.preventDefault();
      const search = document.getElementById("game-search-input") as HTMLInputElement | null;
      search?.focus();
      search?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isSecondaryView, saveGame, cheatGame]);

  useEffect(() => {
    clearReorderState();
  }, [librarySort, searchQuery, libraryScope, activeGameTypeIds, favoriteIds]);

  useEffect(() => {
    if (gameTypeOptions.length === 0 && gameTypesOpen) {
      setGameTypesOpen(false);
    }
  }, [gameTypeOptions.length, gameTypesOpen]);

  const modulesById = useMemo(() => {
    const out = new Map<string, ModuleManifest>();
    for (const mod of state?.modules || []) out.set(mod.id, mod);
    return out;
  }, [state?.modules]);

  const acknowledgments = useMemo(
    () => collectAcknowledgments(state?.modules || [], sharedAcknowledgments),
    [state?.modules]
  );

  const runtimeManagers = useMemo(
    () => Object.values(state?.runtimeManagers || {}),
    [state?.runtimeManagers]
  );

  async function onOpenDialog() {
    if (!api) return;
    setError(null);
    try {
      const paths = await api.openGameDialog();
      for (const p of paths) await api.addRecent(p);
    } catch (e: any) {
      if (/Import cancelled\./.test(String(e?.message || e))) return;
      setError(String(e?.message || e));
    }
  }

  const openUtilityWindow = useCallback(async (request: UtilityWindowRequest) => {
    if (!api) return;
    setError(null);
    try { await api.openUtilityWindow(request); }
    catch (value: any) { setError(String(value?.message || value)); }
  }, [api]);

  const openRuntimesManager = useCallback((managerId?: string) => {
    void openUtilityWindow({ view: "runtimes", ...(managerId ? { managerId } : {}) });
  }, [openUtilityWindow]);

  function openSettings() {
    void openUtilityWindow({ view: "settings" });
  }

  function openAcknowledgments() {
    void openUtilityWindow({ view: "credits" });
  }

  function onOpenAcknowledgmentsLink(url: string) {
    if (!api || typeof api.openExternal !== "function") return;
    api.openExternal(url).catch(() => {});
  }

  const onSetRuntime = useCallback(async function onSetRuntime(gamePath: string, runtime: RuntimeId) {
    if (!api) return;
    setError(null);
    try {
      await api.setGameRuntime(gamePath, runtime);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, [api]);

  const onOpenRuntimeSettings = useCallback(async function onOpenRuntimeSettings(payload: RuntimeSettingsContext) {
    if (!api) return;
    setError(null);
    try {
      await api.openRuntimeSettings(payload);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, [api]);

  async function onSetModuleSettings(moduleId: string, patch: Record<string, any>) {
    if (!api) return;
    setError(null);
    try {
      await api.setModuleSettings(moduleId, patch);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onSetLauncherSettings(patch: Record<string, any>) {
    if (!api) return;
    setError(null);
    try {
      await api.setLauncherSettings(patch);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  const onSetRuntimeData = useCallback(async function onSetRuntimeData(
    gamePath: string,
    runtimeId: RuntimeId,
    patch: Record<string, any> | null
  ) {
    if (!api) return;
    setError(null);
    try {
      await api.setGameRuntimeData(gamePath, runtimeId, patch);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, [api]);

  const onSetGameLibVersion = useCallback(async function onSetGameLibVersion(
    gamePath: string,
    depId: string,
    value: string
  ) {
    if (!api) return;
    setError(null);
    try {
      const next = String(value || "").trim();
      await api.setGameLibVersion(gamePath, depId, next ? next : null);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, [api]);

  const refreshCheatsPatchStatus = useCallback(async function refreshCheatsPatchStatus(gamePath: string) {
    if (!api) return;
    const entry = latestState.current?.recents.find(g => g.gamePath === gamePath);
    if (!entry || !entry.moduleSupports?.cheatsPatcher) {
      setCheatsPatchStatusByPath(prev => ({ ...prev, [gamePath]: null }));
      return;
    }
    try {
      const status = await api.getCheatsPatchStatus(gamePath);
      setCheatsPatchStatusByPath(prev => ({ ...prev, [gamePath]: status }));
    } catch {}
  }, [api]);

  const refreshLibsPatchStatus = useCallback(async function refreshLibsPatchStatus(gamePath: string) {
    if (!api) return;
    const entry = latestState.current?.recents.find(g => g.gamePath === gamePath);
    if (!entry) return;
    try {
      const status = await api.getLibsPatchStatus(gamePath);
      setLibsPatchStatusByPath(prev => ({ ...prev, [gamePath]: status }));
    } catch {}
  }, [api]);

  const onPatchLibs = useCallback(async function onPatchLibs(gamePath: string) {
    if (!api) return;
    setError(null);
    const entry = latestState.current?.recents.find(g => g.gamePath === gamePath);
    const moduleState = entry ? latestState.current?.moduleStates[entry.moduleId] : null;
    const deps = (moduleState?.libs?.dependencies || []) as Array<{
      versions: any[];
    } & Record<string, any>>;
    if (!entry || deps.length === 0) {
      setError("Library patching is not available for this game.");
      return;
    }
    const hasVersions = deps.some(dep => dep.versions.length > 0);
    if (!hasVersions) {
      setError("No managed library versions are available yet.");
      return;
    }

    const warnings = latestLibsPatchStatus.current[gamePath]?.warnings || [];
    const warningText = warnings.length
      ? ["", "Warnings:", ...warnings.map((w: string) => `- ${w}`)].join("\n")
      : "";

    const ok = window.confirm(
      [
        "Patch this game’s libraries?",
        "",
        "MacLauncher will back up the original files next to the originals and apply the selected bundles.",
        "Use Unpatch to restore the backups.",
        warningText
      ]
        .filter(Boolean)
        .join("\n")
    );
    if (!ok) return;

    setLibsPatchBusyPath(gamePath);
    try {
      const status = await api.patchLibs(gamePath);
      setLibsPatchStatusByPath(prev => ({ ...prev, [gamePath]: status }));
    } catch (e: any) {
      setError(String(e?.message || e));
      await refreshLibsPatchStatus(gamePath);
    } finally {
      setLibsPatchBusyPath(null);
    }
  }, [api, refreshLibsPatchStatus]);

  const onUnpatchLibs = useCallback(async function onUnpatchLibs(gamePath: string) {
    if (!api) return;
    setError(null);
    const entry = latestState.current?.recents.find(g => g.gamePath === gamePath);
    const moduleState = entry ? latestState.current?.moduleStates[entry.moduleId] : null;
    if (!entry || !moduleState?.libs?.dependencies) {
      setError("Library patching is not available for this game.");
      return;
    }
    const ok = window.confirm(
      [
        "Unpatch library files from this game?",
        "",
        "MacLauncher will restore .maclauncher-old backups and remove any files that were added."
      ].join("\n")
    );
    if (!ok) return;

    setLibsPatchBusyPath(gamePath);
    try {
      const status = await api.unpatchLibs(gamePath);
      setLibsPatchStatusByPath(prev => ({ ...prev, [gamePath]: status }));
    } catch (e: any) {
      setError(String(e?.message || e));
      await refreshLibsPatchStatus(gamePath);
    } finally {
      setLibsPatchBusyPath(null);
    }
  }, [api, refreshLibsPatchStatus]);

  const onPatchCheatsIntoGame = useCallback(async function onPatchCheatsIntoGame(gamePath: string) {
    if (!api) return;
    setError(null);
    const entry = latestState.current?.recents.find(g => g.gamePath === gamePath);
    if (!entry || !entry.moduleSupports?.cheatsPatcher) {
      setError("Tools patching is not available for this game type.");
      return;
    }
    const ok = window.confirm(
      [
        "Patch this game’s files to load Tools?",
        "",
        "This will modify the game’s main.js and add files under js/plugins/.",
        "Unpatch restores the original files."
      ].join("\n")
    );
    if (!ok) return;

    setCheatsPatchBusyPath(gamePath);
    try {
      const status = await api.patchCheatsIntoGame(gamePath);
      setCheatsPatchStatusByPath(prev => ({ ...prev, [gamePath]: status }));
    } catch (e: any) {
      setError(String(e?.message || e));
      await refreshCheatsPatchStatus(gamePath);
    } finally {
      setCheatsPatchBusyPath(null);
    }
  }, [api, refreshCheatsPatchStatus]);

  const onUnpatchCheatsFromGame = useCallback(async function onUnpatchCheatsFromGame(gamePath: string) {
    if (!api) return;
    setError(null);
    const entry = latestState.current?.recents.find(g => g.gamePath === gamePath);
    if (!entry || !entry.moduleSupports?.cheatsPatcher) {
      setError("Tools patching is not available for this game type.");
      return;
    }
    const ok = window.confirm(
      [
        "Unpatch Tools from this game’s files?",
        "",
        "This will remove the MacLauncher Tools line from main.js and delete the files MacLauncher added under js/plugins/."
      ].join("\n")
    );
    if (!ok) return;

    setCheatsPatchBusyPath(gamePath);
    try {
      const status = await api.unpatchCheatsFromGame(gamePath);
      setCheatsPatchStatusByPath(prev => ({ ...prev, [gamePath]: status }));
    } catch (e: any) {
      setError(String(e?.message || e));
      await refreshCheatsPatchStatus(gamePath);
    } finally {
      setCheatsPatchBusyPath(null);
    }
  }, [api, refreshCheatsPatchStatus]);

  function updateRuntimeUiSection(
    managerId: string,
    sectionId: string,
    key: "remoteOpen" | "installVersion" | "installVariant" | "installedSort",
    value: any
  ) {
    setRuntimeUi(prev => {
      const current = prev[managerId] || {
        remoteOpen: {},
        installVersion: {},
        installVariant: {},
        installedSort: {},
        error: null
      };
      return {
        ...prev,
        [managerId]: {
          ...current,
          [key]: { ...current[key], [sectionId]: value }
        }
      };
    });
  }

  async function onRuntimeAction(
    managerId: string,
    action: string,
    payload: Record<string, any>
  ) {
    if (!api) return;
    const sectionId = payload.sectionId || "default";
    const key = JSON.stringify([managerId, sectionId]);
    if (runtimeActionLocks.current.has(key)) return;
    runtimeActionLocks.current.add(key);
    const updateAction = (pending: string | null, message: string | null, error: string | null = null) => {
      setRuntimeUi(prev => {
        const current = prev[managerId] || { remoteOpen: {}, installVersion: {}, installVariant: {}, installedSort: {}, error: null };
        return { ...prev, [managerId]: { ...current, error,
          pendingActions: { ...current.pendingActions, [sectionId]: pending },
          messages: { ...current.messages, [sectionId]: message } } };
      });
    };
    updateAction(action, null);
    try {
      const result = await api.runtimeAction(managerId, action, payload);
      const section = resolveRuntimeSection(state?.runtimeManagers[managerId] || null, sectionId);
      const local = runtimeManagementPresentation(section).local;
      const message = result === false ? null : action === "refreshCatalog"
        ? local ? "Applications updated." : `Versions updated at ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`
        : action === "import" ? local ? "Application added." : "Runtime imported." : action === "install" ? "Runtime installed."
        : action === "setup" ? "Tool setup complete."
        : action === "installedAction" ? "Updated."
        : action === "uninstall" ? "Runtime removed." : "Default updated.";
      updateAction(null, message);
    } catch (e: any) {
      updateAction(null, null, String(e?.message || e));
    } finally {
      runtimeActionLocks.current.delete(key);
    }
  }

  async function onRuntimeRefresh(
    managerId: string,
    sectionId: string,
    options: { latestOnly?: boolean } = {}
  ) {
    const payload: Record<string, any> = { sectionId, latestOnly: options.latestOnly === true };
    return onRuntimeAction(managerId, "refreshCatalog", payload);
  }

  async function onRuntimeImport(managerId: string, sectionId: string) {
    return onRuntimeAction(managerId, "import", { sectionId });
  }

  async function onRuntimeSetupAction(managerId: string, sectionId: string, setupActionId: string, toolVersion?: string) {
    return onRuntimeAction(managerId, "setup", { sectionId, setupActionId, toolVersion });
  }

  async function onRuntimeInstalledAction(managerId: string, sectionId: string, version: string, installedActionId: string) {
    return onRuntimeAction(managerId, "installedAction", { sectionId, version, installedActionId });
  }

  async function onRuntimeInstall(
    managerId: string,
    sectionId: string,
    version: string,
    variant?: string
  ) {
    return onRuntimeAction(managerId, "install", { sectionId, version, variant });
  }

  async function onRuntimeSetDefault(
    managerId: string,
    sectionId: string,
    version: string | null,
    variant?: string
  ) {
    return onRuntimeAction(managerId, "setDefault", { sectionId, version, variant });
  }

  async function onRuntimeUninstall(
    managerId: string,
    sectionId: string,
    install: Record<string, any>
  ) {
    if (!api) return;
    const section = resolveRuntimeSection(state?.runtimeManagers[managerId] || null, sectionId);
    const ok = window.confirm(runtimeRemovalPresentation(install, section).confirm);
    if (!ok) return;
    return onRuntimeAction(managerId, "uninstall", {
      sectionId,
      version: install.version,
      variant: install.variant,
      platformKey: install.platformKey,
      installDir: install.installDir
    });
  }

  const onModuleAction = useCallback(async function onModuleAction(
    gamePath: string,
    actionId: string,
    actionMeta?: ModuleUiAction
  ) {
    if (!api) return;
    const confirmText = actionMeta?.confirm;
    if (confirmText && !window.confirm(confirmText)) return;
    inspectionRequests.invalidate(gamePath, actionId);
    inspectionRequests.invalidate(gamePath, `preLaunch:${actionId}`);
    setModuleActionBusyByPath(prev => ({
      ...prev,
      [gamePath]: { ...(prev[gamePath] || {}), [actionId]: true }
    }));
    setModuleActionErrorByPath(prev => ({ ...prev, [gamePath]: null }));
    try {
      const result = await api.moduleAction(gamePath, actionId, {});
      setModuleActionResultsByPath(prev => ({
        ...prev,
        [gamePath]: { ...(prev[gamePath] || {}), [actionId]: result }
      }));
    } catch (e: any) {
      setModuleActionErrorByPath(prev => ({
        ...prev,
        [gamePath]: String(e?.message || e)
      }));
    } finally {
      inspectionRequests.invalidate(gamePath, actionId);
      inspectionRequests.invalidate(gamePath, `preLaunch:${actionId}`);
      setModuleActionBusyByPath(prev => ({
        ...prev,
        [gamePath]: { ...(prev[gamePath] || {}), [actionId]: false }
      }));
    }
  }, [api, inspectionRequests]);

  function isInternalGameDrag(ev: React.DragEvent) {
    return Array.from(ev.dataTransfer.types || []).includes(INTERNAL_GAME_DRAG_TYPE);
  }

  function onAppDragEnter(ev: React.DragEvent) {
    if (isInternalGameDrag(ev)) return;
    addDropDepth.current += 1;
    setAddDropActive(true);
  }

  function onAppDragLeave(ev: React.DragEvent) {
    if (isInternalGameDrag(ev)) return;
    addDropDepth.current = Math.max(0, addDropDepth.current - 1);
    if (addDropDepth.current === 0) setAddDropActive(false);
  }

  function onAppDragOver(ev: React.DragEvent) {
    if (isInternalGameDrag(ev)) return;
    ev.preventDefault();
  }

  async function onDropAdd(ev: React.DragEvent) {
    ev.preventDefault();
    if (isInternalGameDrag(ev)) return;
    if (!api) return;
    const launcherApi = api;
    addDropDepth.current = 0;
    setAddDropActive(false);
    setError(null);
    try {
      const paths = new Set<string>();

      async function addFilePath(f: any) {
        if (!f) return;
        if (typeof f?.path === "string" && f.path) {
          paths.add(f.path);
          return;
        }
        if (typeof launcherApi.getPathForFile === "function") {
          const maybe = launcherApi.getPathForFile(f);
          const p = await Promise.resolve(maybe as any);
          if (typeof p === "string" && p) paths.add(p);
        }
      }

      const files = Array.from(ev.dataTransfer.files || []);
      for (const f of files as any[]) {
        await addFilePath(f);
      }

      const items = Array.from(ev.dataTransfer.items || []);
      for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile() as any;
        await addFilePath(file);
      }

      function addFileUrl(url: string) {
        try {
          const u = new URL(url);
          if (u.protocol !== "file:") return;
          let p = decodeURIComponent(u.pathname);
          p = p.replace(/^\/([a-zA-Z]:\/)/, "$1");
          if (p) paths.add(p);
        } catch {}
      }

      function addPlainPath(raw: string) {
        let p = String(raw || "").trim();
        if (!p) return;
        p = p.replace(/^["']+|["']+$/g, "").trim();
        if (!p) return;
        if (p.startsWith("file:")) {
          addFileUrl(p);
          return;
        }
        if (p.includes("%")) {
          try {
            p = decodeURIComponent(p);
          } catch {}
        }
        if (p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p)) {
          paths.add(p);
        }
      }

      const uriList = ev.dataTransfer.getData("text/uri-list");
      if (uriList) {
        for (const line of uriList.split(/\r?\n/g)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          if (trimmed.startsWith("file:")) addFileUrl(trimmed);
          else addPlainPath(trimmed);
        }
      }

      const text = ev.dataTransfer.getData("text/plain");
      if (text) {
        for (const line of text.split(/\r?\n/g)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          addPlainPath(trimmed);
        }
      }

      const candidates = prioritizeDroppedPaths(paths);
      if (candidates.length === 0) {
        throw new Error("Could not read dropped file paths. Try Add game… or drag from Finder again.");
      }

      let firstError: unknown = null;
      let importedCount = 0;
      for (const p of candidates) {
        try {
          await api.addRecent(p);
          importedCount += 1;
        } catch (err) {
          if (firstError == null) firstError = err;
        }
      }
      if (importedCount === 0 && firstError) throw firstError;
    } catch (e: any) {
      if (/Import cancelled\./.test(String(e?.message || e))) return;
      setError(String(e?.message || e));
    }
  }

  function toggleGameTypeFilter(typeId: string) {
    setGameTypeFilter(prev => {
      const current = prev[typeId] !== false;
      return { ...prev, [typeId]: !current };
    });
  }

  function toggleGameTypesOpen() {
    setGameTypesOpen(prev => !prev);
  }

  function selectAllGameTypes() {
    setSearchQuery("");
    setGameTypeFilter({});
  }

  function deselectAllGameTypes() {
    if (gameTypeOptions.length === 0) return;
    const next: Record<string, boolean> = {};
    for (const option of gameTypeOptions) {
      next[option.id] = false;
    }
    setGameTypeFilter(next);
  }

  const clearReorderState = useCallback(function clearReorderState() {
    setDraggingGamePath(null);
    setDragOrderPaths(null);
  }, []);

  const onGameDragStart = useCallback(function onGameDragStart(ev: React.DragEvent, gamePath: string) {
    if (dragDisabled) {
      ev.preventDefault();
      return;
    }
    setDraggingGamePath(gamePath);
    setDragOrderPaths(latestLibraryView.current.manualGames.map(g => g.gamePath));
    try {
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData(INTERNAL_GAME_DRAG_TYPE, gamePath);
      ev.dataTransfer.setData("text/plain", gamePath);
    } catch {}
  }, [dragDisabled]);

  function computeDropIndex(ev: React.DragEvent) {
    const listEl = listRef.current;
    if (!listEl) return null;
    const items = Array.from(listEl.querySelectorAll<HTMLElement>(".gameItem"));
    if (items.length === 0) return 0;
    const y = ev.clientY;
    for (let i = 0; i < items.length; i++) {
      const row = items[i].querySelector<HTMLElement>(".gameRow");
      const rect = (row || items[i]).getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      if (y < midpoint) return i;
    }
    return items.length;
  }

  function onGameListDragOver(ev: React.DragEvent) {
    if (dragDisabled) return;
    if (!isInternalGameDrag(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const idx = computeDropIndex(ev);
    if (idx == null) return;
    if (!draggingGamePath) return;
    setDragOrderPaths(prev => {
      const order = prev ? prev.slice() : manualGames.map(g => g.gamePath);
      const fromIndex = order.indexOf(draggingGamePath);
      if (fromIndex < 0) return prev;
      const target = visibleGames[Math.min(idx, visibleGames.length - 1)];
      if (!target) return prev;
      let toIndex = order.indexOf(target.gamePath) + (idx >= visibleGames.length ? 1 : 0);
      if (fromIndex < toIndex) toIndex -= 1;
      if (toIndex === fromIndex) return prev;
      const byPath = new Map(sorted.map(game => [game.gamePath, game]));
      return reorderLibraryGames(order.map(path => byPath.get(path)!).filter(Boolean), favoriteIds, draggingGamePath, toIndex)
        .map(game => game.gamePath);
    });
  }

  function onGameListDragLeave(ev: React.DragEvent) {
    if (dragDisabled) return;
    if (!isInternalGameDrag(ev)) return;
    const listEl = listRef.current;
    if (!listEl) return;
    const next = ev.relatedTarget as Node | null;
    if (next && listEl.contains(next)) return;
    setDragOrderPaths(null);
  }

  async function onGameListDrop(ev: React.DragEvent) {
    if (dragDisabled) return;
    if (!api) return;
    if (!isInternalGameDrag(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();

    const draggedPath =
      ev.dataTransfer.getData(INTERNAL_GAME_DRAG_TYPE) || draggingGamePath;
    if (!draggedPath) return;

    const fromIndex = manualGames.findIndex(g => g.gamePath === draggedPath);
    if (fromIndex < 0) return;

    const order = dragOrderPaths ?? manualGames.map(g => g.gamePath);
    const toIndex = order.indexOf(draggedPath);
    if (toIndex < 0) return;

    if (fromIndex === toIndex) {
      clearReorderState();
      return;
    }
    setError(null);
    try {
      await api.reorderGame(draggedPath, toIndex);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      clearReorderState();
    }
  }

  const onPlay = useCallback(async function onPlay(gamePath: string) {
    if (!api) return;
    setError(null);
    try {
      await api.launchGame(gamePath);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, [api]);

  const onCreateCommand = useCallback(async function onCreateCommand(gamePath: string) {
    if (!api) return;
    setError(null);
    try {
      const savedPath = await api.createGameCommand(gamePath);
      if (savedPath) {
        window.alert(`Shortcut saved:\n${savedPath}`);
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, [api]);

  const onStop = useCallback(async function onStop(gamePath: string) {
    if (!api) return;
    setError(null);
    try {
      await api.stopGame(gamePath);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, [api]);

  const onForgetGame = useCallback(async function onForgetGame(gamePath: string) {
    if (!api) return;
    const ok = window.confirm("Remove this game and its launcher data? Original files stay on disk.");
    if (!ok) return;
    setError(null);
    try {
      await api.forgetGame(gamePath);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, [api]);

  const refreshCheatAddonStatus = useCallback(async function refreshCheatAddonStatus(
    gamePath: string,
    statusActionId: string | null
  ) {
    if (!api || !statusActionId) return;
    setCheatError(null);
    setCheatAddonBusy(true);
    try {
      const status = await api.moduleAction(gamePath, statusActionId, {});
      setCheatAddonStatusByPath(prev => ({
        ...prev,
        [gamePath]: status
      }));
    } catch (e: any) {
      setCheatError(String(e?.message || e));
    } finally {
      setCheatAddonBusy(false);
    }
  }, [api]);

  async function onCheatAddonAction(
    gamePath: string,
    actionId: string,
    actionMeta?: ModuleUiAction
  ) {
    if (!api) return;
    const confirmText = actionMeta?.confirm;
    if (confirmText && !window.confirm(confirmText)) return;
    setCheatError(null);
    setCheatAddonBusy(true);
    try {
      const result = await api.moduleAction(gamePath, actionId, {});
      if (result && typeof result === "object") {
        setCheatAddonStatusByPath(prev => ({
          ...prev,
          [gamePath]: result
        }));
      } else if (cheatAddonStatusAction) {
        await refreshCheatAddonStatus(gamePath, cheatAddonStatusAction);
      }
    } catch (e: any) {
      setCheatError(String(e?.message || e));
    } finally {
      setCheatAddonBusy(false);
    }
  }

  async function flushCheatAutoSaveQueue() {
    if (!api) return;
    if (cheatAutoSaveInFlightRef.current) return;
    cheatAutoSaveInFlightRef.current = true;
    setCheatError(null);
    try {
      while (cheatAutoSavePendingRef.current) {
        const payload = cheatAutoSavePendingRef.current;
        cheatAutoSavePendingRef.current = null;
        await api.setCheats(payload.gamePath, payload.draft);
        const moduleInfo = modulesById.get(payload.moduleId) || null;
        const supportsToolsButton = Boolean(
          moduleInfo?.settingsDefaults &&
            Object.prototype.hasOwnProperty.call(moduleInfo.settingsDefaults, "toolsButtonVisible")
        );
        if (supportsToolsButton) {
          const lastOverride = cheatAutoSaveOverrideRef.current;
          const shouldUpdateOverride =
            !lastOverride ||
            lastOverride.gamePath !== payload.gamePath ||
            lastOverride.value !== payload.toolsOverride;
          if (shouldUpdateOverride) {
            await api.setGameModuleData(payload.gamePath, {
              toolsButtonVisibleOverride: payload.toolsOverride
            });
            cheatAutoSaveOverrideRef.current = {
              gamePath: payload.gamePath,
              value: payload.toolsOverride
            };
          }
        }
      }
    } catch (e: any) {
      setCheatError(String(e?.message || e));
    } finally {
      cheatAutoSaveInFlightRef.current = false;
    }
  }

  function queueCheatAutoSave(nextDraft: CheatsConfig, nextToolsOverride: boolean | null) {
    if (!api || !cheatGame) return;
    cheatAutoSavePendingRef.current = {
      gamePath: cheatGame.gamePath,
      moduleId: cheatGame.moduleId,
      draft: nextDraft,
      toolsOverride: nextToolsOverride
    };
    void flushCheatAutoSaveQueue();
  }

  const openCheats = useCallback(function openCheats(g: RecentGame) {
    if (!g.moduleSupports?.cheats) {
      setError("Cheats are not available for this game type.");
      return;
    }
    const moduleState = latestState.current?.moduleStates[g.moduleId];
    const schema = moduleState?.cheats?.schema as CheatsSchema | undefined;
    if (!schema) {
      setError("Cheat schema is not available for this game type.");
      return;
    }
    setCheatError(null);
    setCheatBusy(false);
    setCheatAddonBusy(false);
    setCheatGame(g);
    setCheatSchema(schema);
    cheatAutoSaveSkipRef.current = true;
    setCheatDraft({ ...(g.cheats || schema.defaults || {}) });
    const moduleInfo = modulesById.get(g.moduleId);
    const supportsToolsButton = Boolean(
      moduleInfo?.settingsDefaults &&
        Object.prototype.hasOwnProperty.call(moduleInfo.settingsDefaults, "toolsButtonVisible")
    );
    const override = g.moduleData?.toolsButtonVisibleOverride;
    setToolsButtonOverride(
      supportsToolsButton && typeof override === "boolean" ? override : null
    );
    if (moduleInfo?.ui?.cheatsStatusAction && Array.isArray(moduleInfo?.ui?.cheatsPatches)) {
      void refreshCheatAddonStatus(g.gamePath, moduleInfo.ui.cheatsStatusAction);
    }
  }, [modulesById, refreshCheatAddonStatus]);

  function closeCheats() {
    setCheatGame(null);
    setCheatSchema(null);
    setCheatDraft(null);
    setToolsButtonOverride(null);
    setCheatBusy(false);
    setCheatError(null);
    setCheatAddonBusy(false);
  }

  useEffect(() => {
    if (!cheatGame || !cheatDraft || !api) return;
    if (cheatAutoSaveSkipRef.current) {
      cheatAutoSaveSkipRef.current = false;
      return;
    }
    queueCheatAutoSave(cheatDraft, toolsButtonOverride ?? null);
  }, [api, cheatGame, cheatDraft, toolsButtonOverride]);

  const onPickSaveDir = useCallback(async function onPickSaveDir(gamePath: string) {
    if (!api) return;
    setError(null);
    try {
      await api.pickSaveDir(gamePath);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, [api]);

  const onResetSaveDir = useCallback(async function onResetSaveDir(gamePath: string) {
    if (!api) return;
    setError(null);
    try {
      await api.resetSaveDir(gamePath);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, [api]);

  const onReveal = useCallback(async function onReveal(targetPath: string) {
    if (!api) return;
    try {
      await api.revealInFinder(targetPath);
    } catch {}
  }, [api]);

  const refreshSaveFiles = useCallback(async function refreshSaveFiles(gamePath: string) {
    if (!api) return;
    const files = await api.listSaveFiles(gamePath);
    setSaveFiles(files);
  }, [api]);

  const onOpenSaveTools = useCallback(async function onOpenSaveTools(g: RecentGame) {
    if (!api) return;
    if (g.moduleSupports && !g.moduleSupports.saveLocation) {
      setError("Save tools are not available for this game type.");
      return;
    }
    if (!saveEditorContext && api.openSaveEditor) {
      try { await api.openSaveEditor(g.gamePath); }
      catch (error: any) { setError(String(error?.message || error)); }
      return;
    }
    setSaveError(null);
    setSaveBusy(true);
    setSaveGame(g);
    setSaveInfo(null);
    setSaveFiles([]);
    setEditingFile(null);
    setEditingJson("");
    setEditingSourceHash(null);
    setSaveRevision(0);
    try {
      const info = await api.getSaveInfo(g.gamePath);
      setSaveInfo(info);
      await refreshSaveFiles(g.gamePath);
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }, [api, refreshSaveFiles, saveEditorContext]);

  useEffect(() => {
    if (!saveEditorContext || !api) return;
    const entry = state?.recents.find(game => game.gamePath === saveEditorContext.gamePath);
    if (!entry || saveEditorInitializedRef.current === entry.gamePath) return;
    saveEditorInitializedRef.current = entry.gamePath;
    void onOpenSaveTools(entry);
  }, [api, saveEditorContext, state?.recents, onOpenSaveTools]);

  function closeSaveTools() {
    if (saveBusy) return;
    setSaveGame(null);
    setSaveInfo(null);
    setSaveFiles([]);
    setSaveBusy(false);
    setSaveError(null);
    setEditingFile(null);
    setEditingJson("");
    setEditingSourceHash(null);
  }

  async function onSelectSaveLocation(directory: string) {
    if (!api || !saveGame) return;
    setSaveBusy(true);
    setSaveError(null);
    try {
      await api.selectSaveLocation(saveGame.gamePath, directory);
      setSaveInfo(await api.getSaveInfo(saveGame.gamePath));
      await refreshSaveFiles(saveGame.gamePath);
      setEditingFile(null);
      setEditingJson("");
      setEditingSourceHash(null);
      setSaveRevision(value => value + 1);
    } catch (error: any) {
      setSaveError(String(error?.message || error));
    } finally {
      setSaveBusy(false);
    }
  }

  const runSaveAction = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    if (!api || !saveGame) throw new Error("Save tools are unavailable.");
    setSaveError(null);
    setSaveBusy(true);
    try {
      const result = await api.moduleAction(saveGame.gamePath, action, payload);
      if (action === "createSaveSnapshot" || action === "restoreSaveSnapshot" || action === saveInfo?.structuredActions?.editAction) {
        await refreshSaveFiles(saveGame.gamePath);
        setSaveRevision(previous => previous + 1);
      }
      return result;
    } finally { setSaveBusy(false); }
  }, [api, saveGame, saveInfo?.structuredActions?.editAction, refreshSaveFiles]);

  async function onImportSaveDir() {
    if (!api || !saveGame) return;
    setSaveError(null);
    setSaveBusy(true);
    try {
      const ok = await api.importSaveDir(saveGame.gamePath);
      if (ok) { await refreshSaveFiles(saveGame.gamePath); setSaveRevision(previous => previous + 1); }
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function onExportSaveDir() {
    if (!api || !saveGame) return;
    setSaveError(null);
    setSaveBusy(true);
    try {
      const out = await api.exportSaveDir(saveGame.gamePath);
      if (out) await onReveal(out);
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function onImportSaveFiles() {
    if (!api || !saveGame) return;
    setSaveError(null);
    setSaveBusy(true);
    try {
      const ok = await api.importSaveFiles(saveGame.gamePath);
      if (ok) { await refreshSaveFiles(saveGame.gamePath); setSaveRevision(previous => previous + 1); }
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function onEditSaveFile(f: SaveFileInfo) {
    if (!api || !saveGame) return;
    setSaveError(null);
    setSaveBusy(true);
    try {
      const document = await api.moduleAction(saveGame.gamePath, "readSaveDocument", { fileName: f.name });
      setEditingFile(f);
      setEditingJson(document.json);
      setEditingSourceHash(document.sourceHash);
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function onSaveEditedJson() {
    if (!api || !saveGame || !editingFile || !editingSourceHash) return;
    setSaveError(null);
    setSaveBusy(true);
    try {
      await api.moduleAction(saveGame.gamePath, "writeSaveDocument", {
        fileName: editingFile.name, json: editingJson, expectedHash: editingSourceHash
      });
      await refreshSaveFiles(saveGame.gamePath);
      setSaveRevision(previous => previous + 1);
      setEditingFile(null);
      setEditingJson("");
      setEditingSourceHash(null);
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function onOpenEditedJsonExternal() {
    if (!api || !saveGame || !editingFile) return;
    setSaveError(null);
    setSaveBusy(true);
    try {
      await api.openSaveJsonInExternalEditor(
        saveGame.gamePath,
        editingFile.name,
        editingJson
      );
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function onReloadEditedJsonExternal() {
    if (!api || !saveGame || !editingFile) return;
    setSaveError(null);
    setSaveBusy(true);
    try {
      const next = await api.readExternalSaveJson(saveGame.gamePath, editingFile.name);
      setEditingJson(next);
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  function onFormatJson() {
    try {
      setEditingJson(JSON.stringify(JSON.parse(editingJson), null, 2));
    } catch {}
  }


  const onMoveGame = useCallback(async (gamePath: string, delta: number) => {
    const view = latestLibraryView.current;
    if (!api || view.dragDisabled) return;
    setError(null);
    try {
      const index = view.visibleGames.findIndex(game => game.gamePath === gamePath);
      const target = view.visibleGames[index + delta];
      if (!target || view.favorites.has(target.gameId) !== view.favorites.has(view.visibleGames[index]?.gameId)) return;
      await api.reorderGame(gamePath, view.manualGames.findIndex(game => game.gamePath === target.gamePath));
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, [api]);

  const onSetFavorite = useCallback(async (gamePath: string, favorite: boolean) => {
    if (!api) return;
    setError(null);
    try { await api.setGameFavorite(gamePath, favorite); }
    catch (e: any) { setError(String(e?.message || e)); }
  }, [api]);

  async function onSetLibrarySort(sort: LibrarySort) {
    if (!api) return;
    setError(null);
    try { await api.setLibrarySort(sort); }
    catch (e: any) { setError(String(e?.message || e)); }
  }

  const onSaveGameNotes = useCallback(async (gamePath: string, notes: string) => {
    if (!api) throw new Error("Launcher connection is unavailable.");
    setError(null);
    try { await api.setGameNotes(gamePath, notes); }
    catch (error: any) { setError(String(error?.message || error)); throw error; }
  }, [api]);

  const libraryActions = useMemo<LibraryActions>(() => ({
    onPlay,
    onStop,
    onMoveGame,
    onSetFavorite,
    onSaveGameNotes,
    onToggleSelection,
    onOpenSaveTools,
    openCheats,
    onCreateCommand,
    onForgetGame,
    onReveal,
    onPickSaveDir,
    onResetSaveDir,
    onSetRuntime,
    onOpenRuntimeSettings,
    onSetRuntimeData,
    openRuntimesManager,
    refreshLibsPatchStatus,
    onPatchLibs,
    onUnpatchLibs,
    onSetGameLibVersion,
    refreshCheatsPatchStatus,
    onPatchCheatsIntoGame,
    onUnpatchCheatsFromGame,
    onModuleAction
  }), [
    onPlay, onStop, onMoveGame, onSetFavorite, onSaveGameNotes, onToggleSelection, onOpenSaveTools, openCheats, onCreateCommand,
    onForgetGame, onReveal, onPickSaveDir, onResetSaveDir, onSetRuntime,
    onOpenRuntimeSettings, onSetRuntimeData, openRuntimesManager,
    refreshLibsPatchStatus, onPatchLibs, onUnpatchLibs, onSetGameLibVersion,
    refreshCheatsPatchStatus, onPatchCheatsIntoGame, onUnpatchCheatsFromGame,
    onModuleAction
  ]);

  const cheatFields = useMemo(
    () => (cheatSchema?.fields || []) as CheatsField[],
    [cheatSchema]
  );
  const cheatNumbers = useMemo(
    () => cheatFields.filter(field => field.type === "number"),
    [cheatFields]
  );
  const cheatToggles = useMemo(
    () => cheatFields.filter(field => field.type === "boolean" && field.key !== "enabled"),
    [cheatFields]
  );
  const cheatDefaults = cheatSchema?.defaults || {};

  const cheatModuleInfo = cheatGame ? modulesById.get(cheatGame.moduleId) : null;
  const cheatModuleSettings = cheatGame
    ? state?.moduleSettings?.[cheatGame.moduleId]
    : null;
  const cheatModuleUi = cheatModuleInfo?.ui || null;
  const cheatMode = cheatModuleUi?.cheatsMode === "patches" ? "patches" : "default";
  const showCheatFields = cheatMode !== "patches";
  const cheatAddonPatches = Array.isArray(cheatModuleUi?.cheatsPatches)
    ? (cheatModuleUi?.cheatsPatches as ModuleUiCheatsPatch[])
    : [];
  const cheatAddonStatusAction =
    typeof cheatModuleUi?.cheatsStatusAction === "string"
      ? cheatModuleUi.cheatsStatusAction
      : null;
  const cheatAddonStatus =
    cheatGame && cheatAddonStatusByPath[cheatGame.gamePath]
      ? cheatAddonStatusByPath[cheatGame.gamePath]
      : null;
  const cheatModuleActionsById = useMemo(() => {
    const actions = (cheatModuleInfo?.ui?.actions || []) as ModuleUiAction[];
    return new Map(actions.map(action => [action.id, action]));
  }, [cheatModuleInfo]);
  const toolsButtonSettingAvailable = Boolean(
    cheatModuleInfo?.settingsDefaults &&
      Object.prototype.hasOwnProperty.call(cheatModuleInfo.settingsDefaults, "toolsButtonVisible")
  );
  const toolsButtonVisible = toolsButtonSettingAvailable
    ? cheatModuleSettings?.toolsButtonVisible !== false
    : true;
  const toolsButtonUsesDefault = toolsButtonOverride == null;
  const toolsButtonEffective =
    toolsButtonOverride == null ? toolsButtonVisible : toolsButtonOverride;
  const canOpenExternal = Boolean(api?.openExternal);
  const showIcons = state?.launcherSettings?.showIcons !== false;
  const showNonDefaultTags = state?.launcherSettings?.showNonDefaultTags !== false;
  const downloadTasks = useMemo(
    () => (state?.downloads || []).filter(task => task.status === "downloading"),
    [state?.downloads]
  );
  const totalGameCount = sorted.length;
  const filteredGameCount = visibleGames.length;
  const hasGameTypes = gameTypeOptions.length > 0;
  const inspectorVisible = Boolean(selectedGame && inspectorOpen && !selectionMode);
  const visibleFavorites = visibleGames.filter(game => favorites.has(game.gameId)).length;

  const saveToolsPanel = saveGame && <SaveToolsModal
    windowMode={Boolean(saveEditorContext)}
    saveGame={saveGame} saveInfo={saveInfo} saveFiles={saveFiles} saveBusy={saveBusy} saveError={saveError}
    editingFile={editingFile} editingJson={editingJson} runSaveAction={runSaveAction} saveRevision={saveRevision}
    onClose={saveEditorContext ? () => window.close() : closeSaveTools}
    onReveal={onReveal} onImportSaveDir={onImportSaveDir} onSelectSaveLocation={onSelectSaveLocation}
    onExportSaveDir={onExportSaveDir} onImportSaveFiles={onImportSaveFiles} onEditSaveFile={onEditSaveFile}
    onFormatJson={onFormatJson} onOpenEditedJsonExternal={onOpenEditedJsonExternal}
    onReloadEditedJsonExternal={onReloadEditedJsonExternal} onSaveEditedJson={onSaveEditedJson}
    onEditingJsonChange={setEditingJson}
    onCancelEdit={() => { setEditingFile(null); setEditingJson(""); setEditingSourceHash(null); }}
  />;

  if (liveVariableEditorContext) return <LiveVariablesWindow context={liveVariableEditorContext} />;

  if (saveEditorContext) {
    if (!state) return <div className="saveEditorWindow empty" role="status">Loading saves…</div>;
    if (!state.recents.some(game => game.gamePath === saveEditorContext.gamePath)) {
      return <div className="saveEditorWindow empty" role="alert">This game is no longer in the library.</div>;
    }
    return saveToolsPanel || <div className="saveEditorWindow empty" role="status">Loading saves…</div>;
  }

  if (runtimeSettingsContext) {
    return (
      <RuntimeSettingsWindow
        api={api}
        state={state}
        context={runtimeSettingsContext}
        error={error}
      />
    );
  }

  if (utilityWindowContext) {
    return <div className="app utilityWindow">
      {error && <div className="error" role="alert">Error: {formatUserError(error)}</div>}
      {!state && !error && <div className="empty" role="status">Loading…</div>}
      {state && utilityWindowContext.view === "settings" && <SettingsView
        state={state} api={api || undefined} showIcons={showIcons} showNonDefaultTags={showNonDefaultTags}
        onSetLauncherSettings={onSetLauncherSettings} onSetModuleSettings={onSetModuleSettings}
      />}
      {state && utilityWindowContext.view === "credits" && <CreditsView
        acknowledgments={acknowledgments} canOpenExternal={canOpenExternal} onOpenLink={onOpenAcknowledgmentsLink}
      />}
      {state && runtimesOpen && <RuntimesView
        runtimeManagers={runtimeManagers} runtimeUi={runtimeUi} runtimeManagerId={runtimeManagerId}
        runtimeSectionId={runtimeSectionId} downloadTasks={downloadTasks} downloadsOpen={downloadsOpen}
        setDownloadsOpen={setDownloadsOpen} setRuntimeManagerId={setRuntimeManagerId}
        setRuntimeSectionId={setRuntimeSectionId} updateRuntimeUiSection={updateRuntimeUiSection}
        onRuntimeRefresh={onRuntimeRefresh} onRuntimeInstall={onRuntimeInstall} onRuntimeImport={onRuntimeImport}
        onRuntimeSetupAction={onRuntimeSetupAction} onRuntimeInstalledAction={onRuntimeInstalledAction}
        onRuntimeSetDefault={onRuntimeSetDefault} onRuntimeUninstall={onRuntimeUninstall}
        onCancelDownload={id => api?.cancelDownload(id)} onOpenSource={canOpenExternal ? onOpenAcknowledgmentsLink : undefined}
      />}
    </div>;
  }

  return (
    <div
      className="app"
      onDragEnter={onAppDragEnter}
      onDragLeave={onAppDragLeave}
      onDragOver={onAppDragOver}
      onDrop={onDropAdd}
    >
      {addDropActive && (
        <div className="dropOverlay">
          <DropGameHint className="dropHintOverlay" title="Drop a game to add it" />
        </div>
      )}
      <ImportProgress jobs={state?.importing || []} onCancel={input => { api?.cancelImport(input).catch(value => setError(String(value))); }} />
      <div className="libraryWorkspace">
      <header className="header">
        <div className="headerLeft">
          <img className="brandLogo" src={launcherLogo} alt="" />
          <div className="title">MacLauncher</div>
        </div>
        <LibrarySearch query={searchQuery} onQueryChange={setSearchQuery} />
        <button className={["btn", "selectionModeButton", selectionMode ? "primary" : ""].join(" ")}
          aria-label={selectionMode ? "Finish selecting games" : "Select games"} aria-pressed={selectionMode}
          disabled={selectionBusy} onClick={toggleSelectionMode}>{selectionMode ? "Done" : "Select"}</button>
        <div className="headerActions">
          {state && (
            <>
              {state.debug && <span className="dim">Debug</span>}
              <button
                className="btn iconOnly"
                onClick={openSettings}
                title="Settings"
                aria-label="Settings"
              >
                <SettingsIcon size={18} />
              </button>
              <button className="btn runtimesLauncherButton" onClick={() => openRuntimesManager()}>
                <span>Runtimes</span>
                {downloadTasks.length > 0 && (
                  <span className="runtimeDownloadBadge runtimesLauncherBadge">
                    {downloadTasks.length}
                  </span>
                )}
              </button>
              <button className="btn" onClick={() => onReveal(state.logPath)}>
                Logs
              </button>
              <button className="btn" onClick={openAcknowledgments}>
                Credits
              </button>
            </>
          )}
          <button className="btn primary" onClick={onOpenDialog}>
            Add game…
          </button>
        </div>
      </header>

      {error && <div className="error">Error: {formatUserError(error)}</div>}

      <div className="workspaceToolbar">
        <LibraryToolbar sort={librarySort} onSortChange={onSetLibrarySort} scope={libraryScope} onScopeChange={setLibraryScope}
          count={isFiltering ? `${filteredGameCount} of ${totalGameCount} games` : `${totalGameCount} ${totalGameCount === 1 ? "game" : "games"}`}
          typesOpen={gameTypesOpen} onToggleTypes={toggleGameTypesOpen} typesFiltered={!allGameTypesSelected}
          hasTypes={hasGameTypes} inspectorOpen={inspectorVisible} hasSelection={Boolean(selectedGame) && !selectionMode}
          onToggleInspector={() => inspectorOpen ? closeInspector() : setInspectorOpen(true)} />
        {gameTypesOpen && (
          <div className="gameSearchDropdown" id="game-types-dropdown">
            <div className="gameSearchDropdownHeader">
              <div className="gameSearchDropdownTitle">Game types</div>
              <div className="gameSearchDropdownActions">
                <button className="link" type="button" onClick={() => setGameTypeFilter({})} disabled={allGameTypesSelected}>Select all</button>
                <button className="link" type="button" onClick={deselectAllGameTypes} disabled={!hasGameTypes || !anyGameTypesSelected}>Deselect all</button>
              </div>
            </div>
            <div className="gameSearchOptions">
              {gameTypeOptions.map(option => (
                <label className="gameTypeCheck" key={option.id} title={option.title}>
                  <input type="checkbox" checked={gameTypeFilter[option.id] !== false} onChange={() => toggleGameTypeFilter(option.id)} />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        {selectionMode && (
          <div className="selectionToolbar" aria-label="Game selection">
            <label className="inlineCheck">
              <input type="checkbox" aria-label="Select all visible games" disabled={selectionBusy || !visiblePaths.length}
                checked={visiblePaths.length > 0 && visiblePaths.every(path => checkedPaths.has(path))}
                onChange={event => setSelectedPaths(event.target.checked ? visiblePaths : [])} />
              <span>Select all</span>
            </label>
            <span className="selectionCount" aria-live="polite">{selectedPaths.length} selected</span>
            <button className="btn small" disabled={selectionBusy} onClick={() => detectMissing()}>Detect all missing</button>
            <button className="btn small" disabled={selectionBusy} onClick={() => detectMissing(true)}>Select all missing</button>
            {missingPaths.length > 0 && <span className="dim">{visiblePaths.filter(path => missingGames.has(path)).length} missing</span>}
            <div className="selectionActions">
              <button className="btn small" disabled={selectionBusy || selectedRemovalBusy || !selectedPaths.length} onClick={() => removeSelected()}>Forget selected</button>
              <button className="btn small danger" disabled={selectionBusy || selectedRemovalBusy || !selectedPaths.length} onClick={() => removeSelected(true)}>Move to Trash…</button>
            </div>
          </div>
        )}
      </div>
      <main className={["content libraryLayout", inspectorVisible ? "hasDetails" : ""].filter(Boolean).join(" ")}>
        <section className="card libraryPane" aria-label="Games">
          {totalGameCount === 0 ? (
            <div className="empty">
              <DropGameHint
                className="dropHintEmpty"
                title="Drop a game to get started"
                action="Or click Add game…"
              />
            </div>
          ) : filteredGameCount === 0 ? (
            <div className="empty">
              <div>No games match the search and filters.</div>
              <button className="link" onClick={() => { selectAllGameTypes(); setLibraryScope("all"); }}>Clear search and filters</button>
            </div>
          ) : (
            <div
              className="gameList"
              ref={listRef}
              onDragOver={onGameListDragOver}
              onDragLeave={onGameListDragLeave}
              onDrop={onGameListDrop}
            >
              <ul className="gameListItems" aria-label="Games">
                {visibleGames.map((g, index) => (
                  <React.Fragment key={g.gamePath}>
                    {librarySort.mode === "custom" && visibleFavorites > 0 && (index === 0 || !favorites.has(g.gameId) && favorites.has(visibleGames[index - 1]?.gameId)) && (
                      <li className="libraryGroupLabel" role="presentation">
                        <span>{favorites.has(g.gameId) ? "Favorites" : "Games"}</span>
                        <span>{favorites.has(g.gameId) ? visibleFavorites : visibleGames.length - visibleFavorites}</span>
                      </li>
                    )}
                  <GameRow
                    key={g.gamePath}
                    g={g}
                    moduleSettings={state!.moduleSettings}
                    runtimeDefaults={state!.runtimeDefaults}
                    isRunning={(state?.running?.[g.gamePath] ?? 0) > 0}
                    preparation={state?.preparing?.[g.gamePath]}
                    showIcons={showIcons}
                    showNonDefaultTags={showNonDefaultTags}
                    moduleInfo={modulesById.get(g.moduleId) || null}
                    selected={selectionMode ? checkedPaths.has(g.gamePath) : selectedGame?.gamePath === g.gamePath}
                    dragging={draggingGamePath === g.gamePath}
                    dragDisabled={dragDisabled || selectionMode}
                    selectionMode={selectionMode}
                    selectionDisabled={selectionBusy}
                    checked={checkedPaths.has(g.gamePath)}
                    missing={missingGames.has(g.gamePath)}
                    favorite={favorites.has(g.gameId)}
                    actions={libraryActions}
                    onSelect={selectGame}
                    onDragStart={onGameDragStart}
                    onDragEnd={clearReorderState}
                  />
                  </React.Fragment>
                ))}
              </ul>
            </div>
          )}
        </section>
        <section className="card detailsPane" id="game-details" aria-labelledby="game-details-title" hidden={!inspectorVisible}>
          {selectedGame && state ? (
            <GameDetails
              key={selectedGame.gamePath}
              g={selectedGame}
              state={detailsState}
              moduleInfo={modulesById.get(selectedGame.moduleId) || null}
              actions={libraryActions}
              onClose={closeInspector}
              cheatsStatus={cheatsPatchStatusByPath[selectedGame.gamePath] || null}
              libsStatus={libsPatchStatusByPath[selectedGame.gamePath] || null}
              runtimeStatusEntry={runtimeStatusByPath[selectedGame.gamePath] || null}
              cheatsPatchBusy={cheatsPatchBusyPath === selectedGame.gamePath}
              libsPatchBusy={libsPatchBusyPath === selectedGame.gamePath}
              moduleActionResults={moduleActionResultsByPath[selectedGame.gamePath] || EMPTY_ACTION_STATE}
              moduleActionBusy={moduleActionBusyByPath[selectedGame.gamePath] || EMPTY_ACTION_STATE}
              moduleActionError={moduleActionErrorByPath[selectedGame.gamePath] || null}
            />
          ) : (
            <div className="detailsEmpty">
              <h2 className="cardTitle" id="game-details-title">Game details</h2>
              <p>{totalGameCount === 0 ? "Add a game to view its details." : "Select a game to view its details and tools."}</p>
            </div>
          )}
        </section>
      </main>
      </div>

      {saveToolsPanel}

      {cheatGame && cheatDraft && (
        <CheatsModal
          cheatGame={cheatGame}
          cheatDraft={cheatDraft}
          cheatError={cheatError}
          cheatBusy={cheatBusy}
          cheatAddonBusy={cheatAddonBusy}
          showCheatFields={showCheatFields}
          cheatNumbers={cheatNumbers}
          cheatToggles={cheatToggles}
          cheatDefaults={cheatDefaults}
          toolsButtonSettingAvailable={toolsButtonSettingAvailable}
          toolsButtonUsesDefault={toolsButtonUsesDefault}
          toolsButtonEffective={toolsButtonEffective}
          toolsButtonVisible={toolsButtonVisible}
          setCheatDraft={setCheatDraft}
          setToolsButtonOverride={setToolsButtonOverride}
          onClose={closeCheats}
          cheatAddonStatusAction={cheatAddonStatusAction}
          onRefreshCheatAddonStatus={() => {
            if (cheatAddonStatusAction) {
              refreshCheatAddonStatus(cheatGame.gamePath, cheatAddonStatusAction);
            }
          }}
          cheatAddonPatches={cheatAddonPatches}
          cheatAddonStatus={cheatAddonStatus}
          cheatModuleActionsById={cheatModuleActionsById}
          onCheatAddonAction={onCheatAddonAction}
        />
      )}

    </div>
  );
}

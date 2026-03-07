import React, { useEffect, useMemo, useRef, useState } from "react";
import { filterGames } from "./search-utils.mjs";
import { prioritizeDroppedPaths } from "./drop-path-utils.mjs";
import type {
  CheatsConfig,
  CheatsField,
  CheatsPatchStatus,
  CheatsSchema,
  LauncherState,
  LibsPatchStatus,
  ModuleUiAction,
  ModuleUiCheatsPatch,
  ModuleUiGroup,
  ModuleManifest,
  RecentGame,
  RuntimeId,
  RuntimeSettingsContext,
  RuntimeStatusEntry,
  RuntimeUiState,
  SaveFileInfo,
  SaveInfo
} from "./types";
import {
  buildRuntimeSettingsDefaults,
  compareSemver,
  defaultSaveDirForGame,
  formatFieldValue,
  formatIconFallbackText,
  formatModuleBadge,
  formatSettingLabel,
  formatRuntimeLabel,
  formatRuntimeOption,
  formatRuntimeVersionTag,
  formatSaveDirDisplay,
  formatWhen,
  getByPath,
  matchesConditionOnTarget,
  matchesAnyCondition,
  normalizeRuntimeSettings,
  readRuntimeSettingsContext,
  resolveDefaultRuntime,
  resolveModuleRuntimeSettings,
  resolveRuntimeManagerId,
  resolveRuntimeSection,
  resolveRuntimeSectionId,
  resolveRuntimeSections,
  resolveRuntimeSettingsSchema,
  runtimeSettingsEqual
} from "./ui-helpers";
import { ActionIcon, FolderIcon, RefreshIcon, SettingsIcon } from "./icons";
import { RuntimeSettingsWindow } from "./components/RuntimeSettingsWindow";
import { SaveToolsModal } from "./components/modals/SaveToolsModal";
import { CheatsModal } from "./components/modals/CheatsModal";
import { SettingsModal } from "./components/modals/SettingsModal";
import { AcknowledgmentsModal } from "./components/modals/AcknowledgmentsModal";
import { RuntimesModal } from "./components/modals/RuntimesModal";

const INTERNAL_GAME_DRAG_TYPE = "application/x-maclauncher-gamepath";

type ToggleActionButtonProps = {
  active: boolean;
  onEnable: () => void;
  onDisable: () => void;
  enableLabel: string;
  disableLabel: string;
  enableDisabled?: boolean;
  disableDisabled?: boolean;
};

function ToggleActionButton({
  active,
  onEnable,
  onDisable,
  enableLabel,
  disableLabel,
  enableDisabled,
  disableDisabled
}: ToggleActionButtonProps) {
  if (active) {
    return (
      <button className="btn small danger" disabled={disableDisabled} onClick={onDisable}>
        {disableLabel}
      </button>
    );
  }

  return (
    <button className="btn small" disabled={enableDisabled} onClick={onEnable}>
      {enableLabel}
    </button>
  );
}

export default function App() {
  const api = window.MacLauncher?.launcher;
  const [state, setState] = useState<LauncherState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [gameTypeFilter, setGameTypeFilter] = useState<Record<string, boolean>>({});
  const [gameTypesOpen, setGameTypesOpen] = useState(false);
  const [runtimesOpen, setRuntimesOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [runtimeManagerId, setRuntimeManagerId] = useState<string | null>(null);
  const [runtimeSectionId, setRuntimeSectionId] = useState<string | null>(null);
  const [runtimeUi, setRuntimeUi] = useState<RuntimeUiState>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [acknowledgmentsOpen, setAcknowledgmentsOpen] = useState(false);
  const [saveGame, setSaveGame] = useState<RecentGame | null>(null);
  const [saveInfo, setSaveInfo] = useState<SaveInfo | null>(null);
  const [saveFiles, setSaveFiles] = useState<SaveFileInfo[]>([]);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<SaveFileInfo | null>(null);
  const [editingJson, setEditingJson] = useState<string>("");
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
  const [expandedGamePath, setExpandedGamePath] = useState<string | null>(null);
  const [draggingGamePath, setDraggingGamePath] = useState<string | null>(null);
  const [dragOrderPaths, setDragOrderPaths] = useState<string[] | null>(null);
  const [addDropActive, setAddDropActive] = useState(false);
  const addDropDepth = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const autoRunActionKeyRef = useRef<{ gamePath: string | null; key: string | null }>({
    gamePath: null,
    key: null
  });
  const runtimeStatusKeyRef = useRef<{ gamePath: string | null; key: string | null }>({
    gamePath: null,
    key: null
  });
  const runtimeSettingsContext = useMemo(() => readRuntimeSettingsContext(), []);
  const isRuntimeSettingsView = Boolean(runtimeSettingsContext);

  useEffect(() => {
    if (!api) {
      setError(
        [
          "Missing preload bridge: window.MacLauncher.launcher.",
          "Open the launcher app window. This UI does not work in a regular browser.",
          "Run `npm run dev` and use the launcher app window."
        ].join(" ")
      );
      return;
    }

    api.getState().then(setState).catch(e => setError(String(e?.message || e)));
    return api.onState(setState);
  }, [api]);

  useEffect(() => {
    if (!api?.onOpenSettings || isRuntimeSettingsView) return;
    return api.onOpenSettings(() => setSettingsOpen(true));
  }, [api, isRuntimeSettingsView]);

  useEffect(() => {
    if (!runtimesOpen) return;
    if (!state?.runtimeManagers) return;

    setRuntimeUi(prev => {
      let didChange = false;
      const next = { ...prev };
      for (const manager of Object.values(state.runtimeManagers)) {
        const sections = resolveRuntimeSections(manager);
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

  useEffect(() => {
    if (!api) return;
    if (!expandedGamePath) return;
    const entry = state?.recents?.find(g => g.gamePath === expandedGamePath);
    if (!entry || !entry.moduleSupports?.cheatsPatcher) {
      setCheatsPatchStatusByPath(prev => ({ ...prev, [expandedGamePath]: null }));
      return;
    }
    api
      .getCheatsPatchStatus(expandedGamePath)
      .then(status =>
        setCheatsPatchStatusByPath(prev => ({ ...prev, [expandedGamePath]: status }))
      )
      .catch(() => {});
  }, [api, expandedGamePath, state?.recents]);

  useEffect(() => {
    if (!api) return;
    if (!expandedGamePath) return;
    const entry = state?.recents?.find(g => g.gamePath === expandedGamePath);
    if (!entry) return;
    const moduleState = state?.moduleStates?.[entry.moduleId];
    if (!moduleState?.libs?.dependencies) {
      setLibsPatchStatusByPath(prev => ({ ...prev, [expandedGamePath]: null }));
      return;
    }
    api
      .getLibsPatchStatus(expandedGamePath)
      .then(status =>
        setLibsPatchStatusByPath(prev => ({ ...prev, [expandedGamePath]: status }))
      )
      .catch(() => {});
  }, [api, expandedGamePath, state?.recents, state?.moduleStates]);

  useEffect(() => {
    if (!api) return;
    if (!expandedGamePath) {
      autoRunActionKeyRef.current = { gamePath: null, key: null };
      return;
    }
    const entry = state?.recents?.find(g => g.gamePath === expandedGamePath);
    if (!entry) return;
    const moduleInfo = state?.modules?.find(mod => mod.id === entry.moduleId);
    const actions = moduleInfo?.ui?.actions?.filter(a => a.autoRun) || [];
    if (actions.length === 0) return;
    const actionKey = actions.map(action => action.id).join("|");
    const lastActionKey = autoRunActionKeyRef.current;
    // Avoid re-running auto-run actions on every state broadcast.
    if (lastActionKey.gamePath === expandedGamePath && lastActionKey.key === actionKey) return;
    autoRunActionKeyRef.current = { gamePath: expandedGamePath, key: actionKey };
    for (const action of actions) {
      api
        .moduleAction(entry.gamePath, action.id, {})
        .then(result => {
          setModuleActionResultsByPath(prev => ({
            ...prev,
            [entry.gamePath]: {
              ...(prev[entry.gamePath] || {}),
              [action.id]: result
            }
          }));
        })
        .catch(() => {});
    }
  }, [api, expandedGamePath, state?.modules, state?.recents]);

  useEffect(() => {
    if (!api) return;
    if (!expandedGamePath) {
      runtimeStatusKeyRef.current = { gamePath: null, key: null };
      return;
    }
    const entry = state?.recents?.find(g => g.gamePath === expandedGamePath);
    if (!entry) return;
    const moduleInfo = state?.modules?.find(mod => mod.id === entry.moduleId) || null;
    const preLaunch = moduleInfo?.runtime?.preLaunch?.[entry.runtimeId];
    if (!preLaunch?.statusAction) {
      runtimeStatusKeyRef.current = { gamePath: expandedGamePath, key: null };
      setRuntimeStatusByPath(prev => ({ ...prev, [expandedGamePath]: null }));
      return;
    }
    const runtimeVersionOverride = entry.runtimeData?.[entry.runtimeId]?.version || "";
    if (runtimeVersionOverride) {
      runtimeStatusKeyRef.current = { gamePath: expandedGamePath, key: null };
      setRuntimeStatusByPath(prev => ({ ...prev, [expandedGamePath]: null }));
      return;
    }

    const runtimeManagerId = resolveRuntimeManagerId(moduleInfo, entry.runtimeId);
    const runtimeManagerState = runtimeManagerId
      ? state?.runtimeManagers?.[runtimeManagerId] || null
      : null;
    const runtimeSectionId = runtimeManagerId
      ? resolveRuntimeSectionId(moduleInfo, entry.runtimeId, entry)
      : null;
    const runtimeSection = resolveRuntimeSection(runtimeManagerState, runtimeSectionId);
    const installedKey = Array.isArray(runtimeSection?.installed)
      ? runtimeSection.installed.map((inst: any) => inst?.version || "").join("|")
      : "";
    const catalogKey = runtimeSection?.catalog?.fetchedAt
      ? String(runtimeSection.catalog.fetchedAt)
      : "";

    const key = [
      entry.gamePath,
      entry.runtimeId,
      String(entry.moduleData?.detectedVersion || ""),
      String(entry.moduleData?.detectedMajor ?? ""),
      installedKey,
      catalogKey,
      preLaunch.statusAction
    ].join("|");
    const last = runtimeStatusKeyRef.current;
    if (last.gamePath === expandedGamePath && last.key === key) return;
    runtimeStatusKeyRef.current = { gamePath: expandedGamePath, key };
    api
      .moduleAction(entry.gamePath, preLaunch.statusAction, {})
      .then(status => {
        setRuntimeStatusByPath(prev => ({
          ...prev,
          [entry.gamePath]: { runtimeId: entry.runtimeId, status }
        }));
      })
      .catch(() => {
        setRuntimeStatusByPath(prev => ({
          ...prev,
          [entry.gamePath]: { runtimeId: entry.runtimeId, status: null }
        }));
      });
  }, [api, expandedGamePath, state?.modules, state?.recents, state?.runtimeManagers]);

  const sorted = useMemo(() => state?.recents ?? [], [state]);
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
        orderedGames,
        searchQuery,
        gameTypeOptions.length > 0 ? activeGameTypeIds : null
      ),
    [orderedGames, searchQuery, activeGameTypeIds, gameTypeOptions.length]
  );

  const isFiltering =
    Boolean(searchQuery.trim()) ||
    (gameTypeOptions.length > 0 && !allGameTypesSelected);

  useEffect(() => {
    if (isFiltering) clearReorderState();
  }, [isFiltering]);

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

  const acknowledgments = useMemo(() => {
    const out: Array<{ label: string; url: string }> = [];
    const byUrl = new Map<string, { label: string; url: string }>();
    const normalizeUrl = (url: string) =>
      url.trim().replace(/\/+$/, "").toLowerCase();
    for (const mod of state?.modules || []) {
      for (const item of mod.acknowledgments || []) {
        const rawUrl = item?.url?.trim();
        if (!rawUrl) continue;
        const key = normalizeUrl(rawUrl);
        const label = (item.label || rawUrl).trim() || rawUrl;
        const existing = byUrl.get(key);
        if (!existing) {
          byUrl.set(key, { label, url: rawUrl });
          continue;
        }
        const existingLabel = existing.label.trim();
        const existingUrl = existing.url.trim();
        const existingIsFallback = existingLabel === existingUrl;
        const incomingIsFallback = label === rawUrl;
        if (existingIsFallback && !incomingIsFallback) {
          byUrl.set(key, { label, url: existing.url });
        }
      }
    }
    out.push(...byUrl.values());
    out.sort((a, b) => {
      const labelCompare = a.label.localeCompare(b.label, undefined, {
        sensitivity: "base",
        numeric: true
      });
      if (labelCompare !== 0) return labelCompare;
      return a.url.localeCompare(b.url, undefined, {
        sensitivity: "base",
        numeric: true
      });
    });
    return out;
  }, [state?.modules]);

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
      setError(String(e?.message || e));
    }
  }

  function openRuntimesManager(managerId?: string) {
    const managers = Object.values(state?.runtimeManagers || {});
    const nextId = managerId || managers[0]?.id || null;
    const nextSection =
      nextId && state?.runtimeManagers?.[nextId]
        ? resolveRuntimeSection(state.runtimeManagers[nextId], null)?.id || null
        : null;
    setRuntimeManagerId(nextId);
    setRuntimeSectionId(nextSection);
    setRuntimesOpen(true);
  }

  function closeRuntimesManager() {
    setRuntimesOpen(false);
  }

  function openSettings() {
    setSettingsOpen(true);
  }

  function closeSettings() {
    setSettingsOpen(false);
  }

  function openAcknowledgments() {
    setAcknowledgmentsOpen(true);
  }

  function closeAcknowledgments() {
    setAcknowledgmentsOpen(false);
  }

  function onOpenAcknowledgmentsLink(url: string) {
    if (!api || typeof api.openExternal !== "function") return;
    api.openExternal(url).catch(() => {});
  }

  async function onSetRuntime(gamePath: string, runtime: RuntimeId) {
    if (!api) return;
    setError(null);
    try {
      await api.setGameRuntime(gamePath, runtime);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onOpenRuntimeSettings(payload: RuntimeSettingsContext) {
    if (!api) return;
    setError(null);
    try {
      await api.openRuntimeSettings(payload);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

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

  async function onSetRuntimeData(
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
  }

  async function onSetGameLibVersion(
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
  }

  async function refreshCheatsPatchStatus(gamePath: string) {
    if (!api) return;
    const entry = state?.recents?.find(g => g.gamePath === gamePath);
    if (!entry || !entry.moduleSupports?.cheatsPatcher) {
      setCheatsPatchStatusByPath(prev => ({ ...prev, [gamePath]: null }));
      return;
    }
    try {
      const status = await api.getCheatsPatchStatus(gamePath);
      setCheatsPatchStatusByPath(prev => ({ ...prev, [gamePath]: status }));
    } catch {}
  }

  async function refreshLibsPatchStatus(gamePath: string) {
    if (!api) return;
    const entry = state?.recents?.find(g => g.gamePath === gamePath);
    if (!entry) return;
    try {
      const status = await api.getLibsPatchStatus(gamePath);
      setLibsPatchStatusByPath(prev => ({ ...prev, [gamePath]: status }));
    } catch {}
  }

  async function onPatchLibs(gamePath: string) {
    if (!api) return;
    setError(null);
    const entry = state?.recents?.find(g => g.gamePath === gamePath);
    const moduleState = entry ? state?.moduleStates?.[entry.moduleId] : null;
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

    const warnings = libsPatchStatusByPath[gamePath]?.warnings || [];
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
  }

  async function onUnpatchLibs(gamePath: string) {
    if (!api) return;
    setError(null);
    const entry = state?.recents?.find(g => g.gamePath === gamePath);
    const moduleState = entry ? state?.moduleStates?.[entry.moduleId] : null;
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
  }

  async function onPatchCheatsIntoGame(gamePath: string) {
    if (!api) return;
    setError(null);
    const entry = state?.recents?.find(g => g.gamePath === gamePath);
    if (!entry || !entry.moduleSupports?.cheatsPatcher) {
      setError("Tools patching is not available for this game type.");
      return;
    }
    const ok = window.confirm(
      [
        "Patch this game’s files to load Tools?",
        "",
        "This will modify the game’s main.js and add files under js/plugins/.",
        "You can undo it later with Unpatch."
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
  }

  async function onUnpatchCheatsFromGame(gamePath: string) {
    if (!api) return;
    setError(null);
    const entry = state?.recents?.find(g => g.gamePath === gamePath);
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
  }

  function updateRuntimeUiState(
    managerId: string,
    patch: Partial<{
      remoteOpen: Record<string, boolean>;
      installVersion: Record<string, string>;
      installVariant: Record<string, string>;
      installedSort: Record<string, "default" | "newest" | "oldest" | "path">;
      error: string | null;
    }>
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
        [managerId]: { ...current, ...patch }
      };
    });
  }

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
    updateRuntimeUiState(managerId, { error: null });
    try {
      await api.runtimeAction(managerId, action, payload);
    } catch (e: any) {
      updateRuntimeUiState(managerId, { error: String(e?.message || e) });
    }
  }

  async function onRuntimeRefresh(
    managerId: string,
    sectionId: string,
    options: { latestOnly?: boolean } = {}
  ) {
    const payload: Record<string, any> = { sectionId };
    if (typeof options.latestOnly === "boolean") {
      payload.latestOnly = options.latestOnly;
    }
    return onRuntimeAction(managerId, "refreshCatalog", payload);
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
    const label = install?.version ? `v${install.version}` : "this runtime";
    const ok = window.confirm(`Uninstall ${label}?`);
    if (!ok) return;
    return onRuntimeAction(managerId, "uninstall", {
      sectionId,
      version: install.version,
      variant: install.variant,
      platformKey: install.platformKey,
      installDir: install.installDir
    });
  }

  async function onModuleAction(
    gamePath: string,
    actionId: string,
    actionMeta?: ModuleUiAction
  ) {
    if (!api) return;
    const confirmText = actionMeta?.confirm;
    if (confirmText && !window.confirm(confirmText)) return;
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
      setModuleActionBusyByPath(prev => ({
        ...prev,
        [gamePath]: { ...(prev[gamePath] || {}), [actionId]: false }
      }));
    }
  }

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

  function toggleExpanded(gamePath: string) {
    setExpandedGamePath(prev => (prev === gamePath ? null : gamePath));
  }

  function clearReorderState() {
    setDraggingGamePath(null);
    setDragOrderPaths(null);
  }

  function onGameDragStart(ev: React.DragEvent, gamePath: string) {
    if (isFiltering) {
      ev.preventDefault();
      return;
    }
    setDraggingGamePath(gamePath);
    setDragOrderPaths(sorted.map(g => g.gamePath));
    try {
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData(INTERNAL_GAME_DRAG_TYPE, gamePath);
      ev.dataTransfer.setData("text/plain", gamePath);
    } catch {}
  }

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
    if (isFiltering) return;
    if (!isInternalGameDrag(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const idx = computeDropIndex(ev);
    if (idx == null) return;
    if (!draggingGamePath) return;
    setDragOrderPaths(prev => {
      const order = prev ? prev.slice() : sorted.map(g => g.gamePath);
      const fromIndex = order.indexOf(draggingGamePath);
      if (fromIndex < 0) return prev;
      let toIndex = Math.max(0, Math.min(order.length, idx));
      if (fromIndex < toIndex) toIndex -= 1;
      if (toIndex === fromIndex) return prev;
      order.splice(fromIndex, 1);
      order.splice(toIndex, 0, draggingGamePath);
      return order;
    });
  }

  function onGameListDragLeave(ev: React.DragEvent) {
    if (isFiltering) return;
    if (!isInternalGameDrag(ev)) return;
    const listEl = listRef.current;
    if (!listEl) return;
    const next = ev.relatedTarget as Node | null;
    if (next && listEl.contains(next)) return;
    setDragOrderPaths(null);
  }

  async function onGameListDrop(ev: React.DragEvent) {
    if (isFiltering) return;
    if (!api) return;
    if (!isInternalGameDrag(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();

    const draggedPath =
      ev.dataTransfer.getData(INTERNAL_GAME_DRAG_TYPE) || draggingGamePath;
    if (!draggedPath) return;

    const fromIndex = sorted.findIndex(g => g.gamePath === draggedPath);
    if (fromIndex < 0) return;

    const order = dragOrderPaths ?? sorted.map(g => g.gamePath);
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

  async function onPlay(gamePath: string) {
    if (!api) return;
    setError(null);
    try {
      const entry = state?.recents?.find(g => g.gamePath === gamePath);
      if (entry) {
        const moduleInfo = modulesById.get(entry.moduleId);
        const preLaunch = moduleInfo?.runtime?.preLaunch?.[entry.runtimeId];
        if (preLaunch?.statusAction) {
          let status: any = null;
          try {
            status = await api.moduleAction(entry.gamePath, preLaunch.statusAction, {});
          } catch {}
          const readyConditions = preLaunch.readyWhen
            ? Array.isArray(preLaunch.readyWhen)
              ? preLaunch.readyWhen
              : [preLaunch.readyWhen]
            : null;
          const isReady = readyConditions
            ? readyConditions.every(cond => matchesConditionOnTarget(status, cond))
            : Boolean(status);

          if (!isReady) {
            const prompt =
              preLaunch.prompt ||
              "This runtime needs preparation before launch. Run setup now?";
            const ok = window.confirm(prompt);
            if (!ok) {
              if (preLaunch.declineAction) {
                try {
                  await api.moduleAction(entry.gamePath, preLaunch.declineAction, { status });
                } catch {}
              }
              return;
            }

            if (preLaunch.fixAction) {
              await api.moduleAction(entry.gamePath, preLaunch.fixAction, {});
              if (preLaunch.statusAction) {
                const updated = await api.moduleAction(entry.gamePath, preLaunch.statusAction, {});
                const readyNow = readyConditions
                  ? readyConditions.every(cond => matchesConditionOnTarget(updated, cond))
                  : Boolean(updated);
                if (!readyNow) {
                  setError("Runtime preparation did not complete.");
                  return;
                }
              }
            }
          }
        }
      }
      await api.launchGame(gamePath);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onCreateCommand(gamePath: string) {
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
  }

  async function onStop(gamePath: string) {
    if (!api) return;
    setError(null);
    try {
      await api.stopGame(gamePath);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onForgetGame(gamePath: string) {
    if (!api) return;
    const ok = window.confirm("Remove this game from the launcher list? Files stay on disk.");
    if (!ok) return;
    setError(null);
    try {
      await api.forgetGame(gamePath);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function refreshCheatAddonStatus(
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
  }

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

  function openCheats(g: RecentGame) {
    if (!g.moduleSupports?.cheats) {
      setError("Cheats are not available for this game type.");
      return;
    }
    const moduleState = state?.moduleStates?.[g.moduleId];
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
  }

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

  async function onPickSaveDir(gamePath: string) {
    if (!api) return;
    setError(null);
    try {
      await api.pickSaveDir(gamePath);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onResetSaveDir(gamePath: string) {
    if (!api) return;
    setError(null);
    try {
      await api.resetSaveDir(gamePath);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onReveal(targetPath: string) {
    if (!api) return;
    try {
      await api.revealInFinder(targetPath);
    } catch {}
  }

  async function refreshSaveFiles(gamePath: string) {
    if (!api) return;
    const files = await api.listSaveFiles(gamePath);
    setSaveFiles(files);
  }

  async function onOpenSaveTools(g: RecentGame) {
    if (!api) return;
    if (g.moduleSupports && !g.moduleSupports.saveEditing) {
      setError("Save tools are not available for this game type.");
      return;
    }
    setSaveError(null);
    setSaveBusy(true);
    setSaveGame(g);
    setEditingFile(null);
    setEditingJson("");
    try {
      const info = await api.getSaveInfo(g.gamePath);
      setSaveInfo(info);
      await refreshSaveFiles(g.gamePath);
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  function closeSaveTools() {
    setSaveGame(null);
    setSaveInfo(null);
    setSaveFiles([]);
    setSaveBusy(false);
    setSaveError(null);
    setEditingFile(null);
    setEditingJson("");
  }

  async function onImportSaveDir() {
    if (!api || !saveGame) return;
    setSaveError(null);
    setSaveBusy(true);
    try {
      const ok = await api.importSaveDir(saveGame.gamePath);
      if (ok) await refreshSaveFiles(saveGame.gamePath);
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
      if (ok) await refreshSaveFiles(saveGame.gamePath);
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
      const json = await api.readSaveJson(saveGame.gamePath, f.name);
      setEditingFile(f);
      setEditingJson(json);
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function onSaveEditedJson() {
    if (!api || !saveGame || !editingFile) return;
    setSaveError(null);
    setSaveBusy(true);
    try {
      await api.writeSaveJson(saveGame.gamePath, editingFile.name, editingJson);
      await refreshSaveFiles(saveGame.gamePath);
      setEditingFile(null);
      setEditingJson("");
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
  const gameTypesToggleLabel = gameTypesOpen ? "Hide game types" : "Show game types";
  const gameListSubtitle = isFiltering
    ? "Search to filter · Click a game for details"
    : "Drag to reorder · Click a game for details";

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
          Drop a game folder / <span className="mono">Game.app</span> /{" "}
          <span className="mono">Game.exe</span> /{" "}
          <span className="mono">Game.x86_64</span> /{" "}
          <span className="mono">Game.jar</span> /{" "}
          <span className="mono">Game.swf</span> /{" "}
          <span className="mono">Game.sh</span> /{" "}
          <span className="mono">Game.py</span> to add
        </div>
      )}
      <header className="header">
        <div className="headerLeft">
          <div className="title">macOS Game Launcher</div>
        </div>
        <div className="headerActions">
          {state && (
            <>
              <span className="chip">
                {state.debug ? "Debug enabled" : "Debug disabled"}
              </span>
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
                Acknowledgments
              </button>
            </>
          )}
          <button className="btn primary" onClick={onOpenDialog}>
            Add game…
          </button>
        </div>
      </header>

      {error && <div className="error">Error: {error}</div>}

      <main className="content">
        <section className="card">
          <div className="cardHeader">
            <div>
              <div className="cardTitle">Games</div>
              <div className="cardSubtitle">{gameListSubtitle}</div>
            </div>
            <div className="cardHeaderRight">
              {isFiltering && totalGameCount > 0 ? (
                <>
                  <span className="chip">{filteredGameCount} shown</span>
                  <span className="chip">{totalGameCount} total</span>
                </>
              ) : (
                <span className="chip">{totalGameCount} total</span>
              )}
            </div>
          </div>
          <div className="gameSearch">
            <div className="gameSearchMain">
              <label className="gameSearchLabel" htmlFor="game-search-input">
                Search
              </label>
              <div className="gameSearchFieldWrap">
                <input
                  id="game-search-input"
                  className="input gameSearchField"
                  type="text"
                  placeholder="Search by title or path"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  aria-label="Search games"
                />
                <button
                  className="gameSearchToggleIcon"
                  type="button"
                  onClick={toggleGameTypesOpen}
                  disabled={!hasGameTypes}
                  title={gameTypesToggleLabel}
                  aria-label={gameTypesToggleLabel}
                  aria-expanded={gameTypesOpen}
                  aria-controls="game-types-dropdown"
                >
                  {gameTypesOpen ? (
                    <svg
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path
                        fill="currentColor"
                        d="M7 15l5-5 5 5H7z"
                      />
                    </svg>
                  ) : (
                    <svg
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path
                        fill="currentColor"
                        d="M7 9l5 5 5-5H7z"
                      />
                    </svg>
                  )}
                </button>
              </div>
            </div>
            {gameTypesOpen && (
              <div className="gameSearchDropdown" id="game-types-dropdown">
                <div className="gameSearchDropdownHeader">
                  <div className="gameSearchDropdownTitle">Game types</div>
                  <div className="gameSearchDropdownActions">
                    <button
                      className="link"
                      type="button"
                      onClick={selectAllGameTypes}
                      disabled={!isFiltering}
                    >
                      Select all
                    </button>
                    <button
                      className="link"
                      type="button"
                      onClick={deselectAllGameTypes}
                      disabled={!hasGameTypes || !anyGameTypesSelected}
                    >
                      Deselect all
                    </button>
                  </div>
                </div>
                <div className="gameSearchOptions">
                  {!hasGameTypes ? (
                    <span className="dim">None</span>
                  ) : (
                    gameTypeOptions.map(option => (
                      <label
                        className="gameTypeCheck"
                        key={option.id}
                        title={option.title}
                      >
                        <input
                          type="checkbox"
                          checked={gameTypeFilter[option.id] !== false}
                          onChange={() => toggleGameTypeFilter(option.id)}
                        />
                        <span>{option.label}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
          {totalGameCount === 0 ? (
            <div className="empty">
              Drop a game folder / <span className="mono">Game.app</span> /{" "}
              <span className="mono">Game.exe</span> /{" "}
              <span className="mono">Game.x86_64</span> /{" "}
              <span className="mono">Game.jar</span> /{" "}
              <span className="mono">Game.swf</span> /{" "}
              <span className="mono">Game.sh</span>, or click Add game...
            </div>
          ) : filteredGameCount === 0 ? (
            <div className="empty">No games match your search and filters.</div>
          ) : (
            <div
              className="gameList"
              ref={listRef}
              onDragOver={onGameListDragOver}
              onDragLeave={onGameListDragLeave}
              onDrop={onGameListDrop}
            >
              {visibleGames.map((g: RecentGame) => {
                const expanded = expandedGamePath === g.gamePath;
                const dragging = draggingGamePath === g.gamePath;
                const dragDisabled = isFiltering;
                const moduleInfo = modulesById.get(g.moduleId) || null;
                const moduleState = state?.moduleStates?.[g.moduleId] || null;
                const moduleUi = moduleInfo?.ui || null;
                const moduleActions = (moduleUi?.actions || []) as ModuleUiAction[];
                const moduleActionsById = new Map(
                  moduleActions.map(action => [action.id, action])
                );
                const moduleActionGroups: ModuleUiGroup[] =
                  moduleUi?.actionGroups && moduleUi.actionGroups.length > 0
                    ? (moduleUi.actionGroups as ModuleUiGroup[])
                    : moduleActions.map(action => ({
                        id: action.id,
                        label: action.label,
                        actions: [action.id]
                      }));
                const visibleModuleActionGroups = moduleActionGroups.filter(
                  group => !matchesAnyCondition(g, group.hiddenWhen)
                );
                const hasSaveLocation = g.moduleSupports?.saveLocation === true;
                const saveDir = hasSaveLocation
                  ? g.saveDirOverride || defaultSaveDirForGame(g)
                  : "";
                const hasSaveDir = Boolean(saveDir);
                const canLaunchNative = Boolean(
                  (g.nativeAppPath && g.nativeAppPath.toLowerCase().endsWith(".app")) ||
                    g.gamePath.toLowerCase().endsWith(".app")
                );
                const canEditSaves = g.moduleSupports?.saveEditing !== false;
                const canUseCheats = g.moduleSupports?.cheats === true;
                const canPatchCheats = g.moduleSupports?.cheatsPatcher === true;
                const cheatsStatus = cheatsPatchStatusByPath[g.gamePath] || null;
                const cheatsPatched = Boolean(cheatsStatus?.patched || cheatsStatus?.partial);
                const runtimeSupport: RuntimeId[] =
                  Array.isArray(g.moduleRuntimeSupport) && g.moduleRuntimeSupport.length > 0
                    ? g.moduleRuntimeSupport
                    : moduleInfo?.runtime?.supported || [];
                const runtimeOptions = runtimeSupport.filter((rt: RuntimeId) => {
                  if (rt === "native" && !canLaunchNative) return false;
                  return true;
                });
                const runtimeManagerId = moduleInfo
                  ? resolveRuntimeManagerId(moduleInfo, g.runtimeId)
                  : null;
                const runtimeManagerState = runtimeManagerId
                  ? state?.runtimeManagers?.[runtimeManagerId] || null
                  : null;
                const runtimeSectionId = runtimeManagerId
                  ? resolveRuntimeSectionId(moduleInfo, g.runtimeId, g)
                  : null;
                const runtimeSection = resolveRuntimeSection(
                  runtimeManagerState,
                  runtimeSectionId
                );
                const runtimeSectionOverrideKey =
                  moduleInfo?.runtime?.managerSectionOverrideKey?.[g.runtimeId] || "";
                const runtimeSectionMap = (moduleInfo?.runtime?.managerSectionMap?.[
                  g.runtimeId
                ] || {}) as Record<string, string>;
                const runtimeSectionOverrideRaw = runtimeSectionOverrideKey
                  ? g.runtimeData?.[g.runtimeId]?.[runtimeSectionOverrideKey]
                  : null;
                const runtimeSectionOverride =
                  runtimeSectionOverrideRaw === null || runtimeSectionOverrideRaw === undefined
                    ? ""
                    : String(runtimeSectionOverrideRaw);
                const runtimeSectionOverrideLabel = runtimeSectionOverrideKey
                  ? formatSettingLabel(runtimeSectionOverrideKey)
                  : "Runtime section";
                const runtimeSectionOverrideOptions: Array<{ value: string; label: string }> = [];
                if (runtimeManagerState && runtimeSectionOverrideKey) {
                  const mappedEntries = Object.entries(runtimeSectionMap);
                  if (mappedEntries.length > 0) {
                    for (const [value, sectionId] of mappedEntries) {
                      if (!value) continue;
                      const section = resolveRuntimeSection(runtimeManagerState, String(sectionId));
                      runtimeSectionOverrideOptions.push({
                        value: String(value),
                        label: section?.label || String(sectionId)
                      });
                    }
                  } else {
                    for (const section of resolveRuntimeSections(runtimeManagerState)) {
                      const sectionId = String(section?.id || "").trim();
                      if (!sectionId) continue;
                      runtimeSectionOverrideOptions.push({
                        value: sectionId,
                        label: section.label || sectionId
                      });
                    }
                  }
                }
                const runtimeSectionAutoLabel = runtimeSection?.label
                  ? `Auto (${runtimeSection.label})`
                  : "Auto";
                const runtimeSectionOverrideDisplay = runtimeSectionOverride
                  ? runtimeSectionOverrideOptions.find(
                      option => option.value === runtimeSectionOverride
                    )?.label ||
                    runtimeSection?.label ||
                    runtimeSectionOverride
                  : runtimeSectionAutoLabel;
                const runtimeVersionOverride = g.runtimeData?.[g.runtimeId]?.version || "";
                const runtimeVariantOverride = g.runtimeData?.[g.runtimeId]?.variant || "";
                const runtimeStatusEntry = runtimeStatusByPath[g.gamePath] || null;
                const runtimeStatus =
                  runtimeStatusEntry && runtimeStatusEntry.runtimeId === g.runtimeId
                    ? runtimeStatusEntry.status
                    : null;
                const runtimeInstalledVersions: string[] = runtimeSection
                  ? Array.from(
                      new Set<string>(
                        (runtimeSection.installed || [])
                          .map((inst: any) => String(inst?.version || ""))
                          .filter((value: string) => value.length > 0)
                      )
                    ).sort((a, b) => compareSemver(String(b || ""), String(a || "")))
                  : [];
                const runtimeDefaultVersion = runtimeSection?.defaultVersion || "";
                const runtimeLabel = formatRuntimeLabel(g.runtimeId, moduleInfo);
                const runtimeVersionLabelText = runtimeLabel
                  ? `${runtimeLabel} version`
                  : "Runtime version";
                const runtimeOverrideLabel = runtimeVersionOverride
                  ? formatRuntimeVersionTag(runtimeVersionOverride, runtimeSection)
                  : "";
                const runtimeStatusDefaultVersion =
                  !runtimeVersionOverride &&
                  runtimeStatus &&
                  typeof runtimeStatus === "object" &&
                  typeof (runtimeStatus as any).resolvedVersion === "string" &&
                  (runtimeStatus as any).resolvedVersion.trim()
                    ? (runtimeStatus as any).resolvedVersion.trim()
                    : !runtimeVersionOverride &&
                        runtimeStatus &&
                        typeof runtimeStatus === "object" &&
                        typeof (runtimeStatus as any).requiredVersion === "string" &&
                        (runtimeStatus as any).requiredVersion.trim()
                      ? (runtimeStatus as any).requiredVersion.trim()
                      : "";
                const runtimeDefaultLabel = runtimeStatusDefaultVersion || runtimeDefaultVersion
                  ? formatRuntimeVersionTag(
                      runtimeStatusDefaultVersion || runtimeDefaultVersion,
                      runtimeSection
                    )
                  : "";
                const runtimeVersionLabel = runtimeOverrideLabel
                  ? runtimeOverrideLabel
                  : runtimeDefaultLabel
                    ? `Default (${runtimeDefaultLabel})`
                    : "Default";
                const runtimeVariantOptions = (Array.isArray(runtimeSection?.variants)
                  ? runtimeSection.variants
                  : []) as Array<{ id?: string; label?: string } & Record<string, any>>;
                const runtimeHasMultipleVariants = runtimeVariantOptions.length > 1;
                const runtimeVariantValue =
                  runtimeVariantOverride || runtimeSection?.defaultVariant || "";
                const runtimeVariantLabel = runtimeHasMultipleVariants
                  ? runtimeVariantOptions.find(
                      (opt: { id?: string; label?: string }) =>
                        opt.id === runtimeVariantValue
                    )?.label ||
                    runtimeVariantValue ||
                    "Default"
                  : "";
                const runtimeDefaultVariantLabel = runtimeHasMultipleVariants
                  ? runtimeVariantOptions.find(
                      (opt: { id?: string; label?: string }) =>
                        opt.id === runtimeSection?.defaultVariant
                    )?.label ||
                    runtimeSection?.defaultVariant ||
                    "Default"
                  : "";
                const libsDependencies = (moduleState?.libs?.dependencies || []) as Array<{
                  id: string;
                  label: string;
                  versions: Array<{ id: string; label: string }> | any[];
                  defaultVersion?: string;
                  [key: string]: any;
                }>;
                const libsAvailable = libsDependencies.some(
                  (dep: { versions: any[] }) => dep.versions.length > 0
                );
                const libsStatus = libsPatchStatusByPath[g.gamePath] || null;
                const libsPatched = Boolean(libsStatus?.patched || libsStatus?.partial);
                const libOverrides =
                  g.moduleData && typeof g.moduleData === "object"
                    ? g.moduleData.libVersions || {}
                    : {};
                const moduleActionResults = moduleActionResultsByPath[g.gamePath] || {};
                const moduleActionBusy = moduleActionBusyByPath[g.gamePath] || {};
                const moduleActionError = moduleActionErrorByPath[g.gamePath] || null;
                const runningCount = state?.running?.[g.gamePath] ?? 0;
                const isRunning = runningCount > 0;
                const moduleSettings = state?.moduleSettings?.[g.moduleId] || {};
                const defaultRuntime = resolveDefaultRuntime(moduleInfo, moduleSettings);
                const runtimeIsCustom = Boolean(defaultRuntime && g.runtimeId !== defaultRuntime);
                const runtimeSchema = resolveRuntimeSettingsSchema(moduleInfo, g.runtimeId);
                const moduleRuntimeSettings = runtimeSchema
                  ? resolveModuleRuntimeSettings(state, g.moduleId, moduleInfo, g.runtimeId)
                  : null;
                const gameRuntimeOverrides =
                  g.runtimeSettings && typeof g.runtimeSettings === "object"
                    ? g.runtimeSettings[g.runtimeId]
                    : null;
                const normalizedGameOverride =
                  runtimeSchema && gameRuntimeOverrides && typeof gameRuntimeOverrides === "object"
                    ? normalizeRuntimeSettings(
                        runtimeSchema,
                        gameRuntimeOverrides,
                        moduleRuntimeSettings || {}
                      )
                    : null;
                const runtimeSettingsModified =
                  runtimeSchema && moduleRuntimeSettings && normalizedGameOverride
                    ? !runtimeSettingsEqual(
                        runtimeSchema,
                        normalizedGameOverride,
                        moduleRuntimeSettings
                      )
                    : false;
                const runtimeSettingsBadge =
                  runtimeIsCustom && runtimeSettingsModified ? "Modified" : null;

                return (
                  <div
                    className={[
                      "gameItem",
                      expanded ? "expanded" : "",
                      dragging ? "dragging" : ""
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    key={g.gamePath}
                    onClick={() => toggleExpanded(g.gamePath)}
                  >
                    <div
                      className={["gameRow", showIcons ? "withIcon" : ""]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <button
                        className={[
                          "dragHandle",
                          dragDisabled ? "disabled" : ""
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        draggable={!dragDisabled}
                        onDragStart={ev => onGameDragStart(ev, g.gamePath)}
                        onDragEnd={clearReorderState}
                        onClick={e => e.stopPropagation()}
                        title={
                          dragDisabled
                            ? "Reordering is disabled while filtering"
                            : "Drag to reorder"
                        }
                        aria-disabled={dragDisabled}
                      >
                        ⋮⋮
                      </button>

                      {showIcons && (
                        <div className="gameIcon" aria-hidden="true">
                          {g.iconUrl ? (
                            <img
                              src={g.iconUrl}
                              alt=""
                              loading="lazy"
                              className="gameIconImage"
                            />
                          ) : (
                            <span className="gameIconText">
                              {formatIconFallbackText(g, moduleInfo)}
                            </span>
                          )}
                        </div>
                      )}

                      <div className="gameMain">
                        <div className="gameTopLine">
                          <span className="gameName">{g.name}</span>
                          <span className="badge">
                            {formatModuleBadge(g.moduleShortLabel, g.moduleLabel, g.moduleId)}
                          </span>
                          {showNonDefaultTags && runtimeIsCustom && (
                            <span className="badge badgeWarn">
                              {formatRuntimeLabel(g.runtimeId, moduleInfo)}
                            </span>
                          )}
                          {showNonDefaultTags && runtimeSettingsBadge && (
                            <span className="badge badgeWarn">{runtimeSettingsBadge}</span>
                          )}
                          {showNonDefaultTags && g.saveDirOverride && (
                            <span className="badge badgeAccent">Custom saves</span>
                          )}
                        </div>
                        <div className="gameBottomLine">
                          <span className="dim">
                            Last played {formatWhen(g.lastPlayedAt)}
                          </span>
                          <span className="dot">·</span>
                          <span className="mono ellipsis">{g.gamePath}</span>
                        </div>
                      </div>

                      <div
                        className="gameActions"
                        onClick={e => e.stopPropagation()}
                      >
                        <button
                          className={[
                            "btn",
                            "iconOnly",
                            isRunning ? "danger" : "primary"
                          ].join(" ")}
                          onClick={() =>
                            isRunning ? onStop(g.gamePath) : onPlay(g.gamePath)
                          }
                          title={isRunning ? "Stop" : "Play"}
                          aria-label={isRunning ? "Stop" : "Play"}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            width="18"
                            height="18"
                            aria-hidden="true"
                            focusable="false"
                          >
                            {isRunning ? (
                              <path
                                fill="currentColor"
                                d="M6 6h12v12H6z"
                              />
                            ) : (
                              <path
                                fill="currentColor"
                                d="M8 5v14l11-7z"
                              />
                            )}
                          </svg>
                        </button>
                        <button
                          className="btn small"
                          title={
                            canEditSaves
                              ? "Save tools"
                              : "Save tools not available for this game type"
                          }
                          onClick={() => onOpenSaveTools(g)}
                          disabled={!canEditSaves}
                        >
                          Saves
                        </button>
                        <button
                          className="btn small"
                          title={
                            canUseCheats
                              ? "Cheats"
                              : "Cheats not available for this game type"
                          }
                          onClick={() => openCheats(g)}
                          disabled={!canUseCheats}
                        >
                          Cheats
                        </button>
                        <button
                          className="btn small"
                          title="Create a .command shortcut"
                          onClick={() => onCreateCommand(g.gamePath)}
                        >
                          Shortcut
                        </button>
                        <button
                          className="btn iconOnly danger"
                          title="Forget game"
                          aria-label="Forget game"
                          onClick={() => onForgetGame(g.gamePath)}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            width="18"
                            height="18"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <path
                              fill="currentColor"
                              d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v9h-2V9zm4 0h2v9h-2V9zM6 7h12l-1 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7z"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {expanded && (
                      <div
                        className="gameDetails"
                        onClick={e => e.stopPropagation()}
                      >
                        <div className="detailGrid">
                          <div className="detailRow">
                            <div className="detailLabel">Game</div>
                            <div className="detailValue mono ellipsis">
                              {g.gamePath}
                            </div>
                            <div className="detailActions">
                              <button
                                className="btn small iconOnly"
                                onClick={() => onReveal(g.gamePath)}
                                title="Reveal in Finder"
                                aria-label="Reveal in Finder"
                              >
                                <FolderIcon />
                              </button>
                            </div>
                          </div>

                          {hasSaveLocation && (
                            <div className="detailRow">
                              <div className="detailLabel">Saves</div>
                              <div className="detailValue mono ellipsis">
                                {formatSaveDirDisplay(saveDir)}
                              </div>
                              <div className="detailActions">
                                <button
                                  className="btn small iconOnly"
                                  onClick={() => onReveal(saveDir)}
                                  disabled={!hasSaveDir}
                                  title="Reveal in Finder"
                                  aria-label="Reveal in Finder"
                                >
                                  <FolderIcon />
                                </button>
                                <button
                                  className="btn small"
                                  onClick={() => onPickSaveDir(g.gamePath)}
                                  disabled={!canEditSaves}
                                >
                                  Change…
                                </button>
                                {g.saveDirOverride && (
                                  <button
                                    className="btn small"
                                    onClick={() => onResetSaveDir(g.gamePath)}
                                    disabled={!canEditSaves}
                                  >
                                    Reset
                                  </button>
                                )}
                              </div>
                            </div>
                          )}

                          <div className="detailRow">
                            <div className="detailLabel">Runtime</div>
                            <div className="detailValue">
                              {formatRuntimeLabel(g.runtimeId, moduleInfo)}
                            </div>
                            <div className="detailActions">
                              <select
                                className="input"
                                value={g.runtimeId}
                                onChange={e =>
                                  onSetRuntime(g.gamePath, e.target.value as RuntimeId)
                                }
                              >
                                {runtimeOptions.map(rt => (
                                  <option key={rt} value={rt}>
                                    {formatRuntimeOption(rt, moduleInfo)}
                                  </option>
                                ))}
                              </select>
                              <button
                                className="btn small iconOnly"
                                onClick={() =>
                                  onOpenRuntimeSettings({
                                    scope: "game",
                                    moduleId: g.moduleId,
                                    runtimeId: g.runtimeId,
                                    gamePath: g.gamePath
                                  })
                                }
                                disabled={!runtimeSchema}
                                title="Runtime settings"
                                aria-label="Runtime settings"
                              >
                                <SettingsIcon />
                              </button>
                            </div>
                          </div>

                          {runtimeManagerState && runtimeSection && (
                            <>
                              {runtimeSectionOverrideKey &&
                                runtimeSectionOverrideOptions.length > 0 && (
                                <div className="detailRow">
                                  <div className="detailLabel">{runtimeSectionOverrideLabel}</div>
                                  <div className="detailValue">{runtimeSectionOverrideDisplay}</div>
                                  <div className="detailActions">
                                    <select
                                      className="input"
                                      value={runtimeSectionOverride}
                                      onChange={e => {
                                        const nextValue = e.target.value || null;
                                        onSetRuntimeData(g.gamePath, g.runtimeId, {
                                          [runtimeSectionOverrideKey]: nextValue,
                                          version: null,
                                          variant: null
                                        });
                                      }}
                                    >
                                      <option value="">{runtimeSectionAutoLabel}</option>
                                      {runtimeSectionOverrideOptions.map(option => (
                                        <option key={option.value} value={option.value}>
                                          {option.label}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                </div>
                                )}

                              <div className="detailRow">
                                <div className="detailLabel">{runtimeVersionLabelText}</div>
                                <div className="detailValue">
                                  {runtimeVersionLabel}
                                  {runtimeHasMultipleVariants && runtimeVariantLabel ? (
                                    <span className="dim"> · {runtimeVariantLabel}</span>
                                  ) : null}
                                </div>
                                <div className="detailActions">
                                  <select
                                    className="input"
                                    value={runtimeVersionOverride}
                                    onChange={e =>
                                      onSetRuntimeData(g.gamePath, g.runtimeId, {
                                        version: e.target.value || null
                                      })
                                    }
                                  >
                                    <option value="">Default</option>
                                    {runtimeInstalledVersions.map(v => (
                                      <option key={v} value={v}>
                                        {formatRuntimeVersionTag(v, runtimeSection)}
                                      </option>
                                    ))}
                                  </select>
                                  {runtimeHasMultipleVariants && (
                                    <select
                                      className="input"
                                      value={runtimeVariantOverride || ""}
                                      onChange={e =>
                                        onSetRuntimeData(g.gamePath, g.runtimeId, {
                                          variant: e.target.value || null
                                        })
                                      }
                                    >
                                      <option value="">
                                        Default: {runtimeDefaultVariantLabel}
                                      </option>
                                      {runtimeVariantOptions.map(
                                        (variant: { id?: string; label?: string }) => (
                                          <option key={variant.id} value={variant.id}>
                                            {variant.label || variant.id}
                                          </option>
                                        )
                                      )}
                                    </select>
                                  )}
                                  <button
                                    className="btn small"
                                    onClick={() => openRuntimesManager(runtimeManagerId || undefined)}
                                  >
                                    Runtimes…
                                  </button>
                                </div>
                              </div>
                            </>
                          )}

                          {(moduleUi?.infoFields || [])
                            .filter(field => !matchesAnyCondition(g, field.hiddenWhen))
                            .map(field => {
                              const rawValue = getByPath(g, field.key);
                              const pathValue =
                                typeof rawValue === "string" ? rawValue : "";
                              const isPath = field.format === "path" && Boolean(pathValue);
                              const formatted = formatFieldValue(
                                rawValue,
                                field.format,
                                field.empty
                              );
                              return (
                                <div className="detailRow" key={`info-${field.key}`}>
                                  <div className="detailLabel">{field.label}</div>
                                  <div className="detailValue">
                                    {isPath ? (
                                      <span className="mono ellipsis">{formatted}</span>
                                    ) : (
                                      formatted
                                    )}
                                  </div>
                                  <div className="detailActions">
                                    {isPath && (
                                      <button
                                        className="btn small iconOnly"
                                        onClick={() => onReveal(pathValue)}
                                        title="Reveal in Finder"
                                        aria-label="Reveal in Finder"
                                      >
                                        <FolderIcon />
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}

                          {libsDependencies.length > 0 && (
                            <div className="detailRow">
                              <div className="detailLabel">Libraries</div>
                              <div className="detailValue">
                                {(() => {
                                  if (!libsAvailable) {
                                    return <span className="dim">No managed versions</span>;
                                  }
                                  if (!libsStatus) return <span className="dim">—</span>;
                                  if (libsStatus.patched) {
                                    return <span className="badge badgeAccent">Patched</span>;
                                  }
                                  if (libsStatus.partial) {
                                    return <span className="badge badgeWarn">Partial</span>;
                                  }
                                  return <span className="badge">Not patched</span>;
                                })()}
                                {libsStatus?.warnings?.length ? (
                                  <>
                                    {" "}
                                    <span
                                      className="badge badgeWarn"
                                      title={libsStatus.warnings.join("\n")}
                                    >
                                      Warning
                                    </span>
                                  </>
                                ) : null}
                              </div>
                              <div className="detailActions">
                                <button
                                  className="btn small iconOnly"
                                  disabled={libsPatchBusyPath === g.gamePath}
                                  onClick={() => refreshLibsPatchStatus(g.gamePath)}
                                  title="Reload"
                                  aria-label="Reload"
                                >
                                  <RefreshIcon />
                                </button>
                                <ToggleActionButton
                                  active={libsPatched}
                                  enableLabel="Patch"
                                  disableLabel="Unpatch"
                                  enableDisabled={
                                    libsPatchBusyPath === g.gamePath || !libsAvailable
                                  }
                                  disableDisabled={libsPatchBusyPath === g.gamePath}
                                  onEnable={() => onPatchLibs(g.gamePath)}
                                  onDisable={() => onUnpatchLibs(g.gamePath)}
                                />
                              </div>
                            </div>
                          )}

                          {libsDependencies
                            .filter((dep: { versions: any[] }) => dep.versions.length > 1)
                            .map(
                              (dep: {
                                id: string;
                                label: string;
                                versions: Array<{ id?: string; label?: string }> | any[];
                                defaultVersion?: string;
                              }) => {
                              const override = dep.versions.some(
                                (v: { id?: string }) => v.id === libOverrides?.[dep.id]
                              )
                                ? libOverrides[dep.id]
                                : "";
                              const defaultVersion =
                                dep.versions.find(
                                  (v: { id?: string }) => v.id === dep.defaultVersion
                                ) || null;
                              const defaultLabel = defaultVersion
                                ? defaultVersion.label
                                : "No default";
                              const overrideLabel = dep.versions.find(
                                (v: { id?: string; label?: string }) => v.id === override
                              )?.label;
                              return (
                                <div className="detailRow" key={dep.id}>
                                  <div className="detailLabel">{dep.label}</div>
                                  <div className="detailValue">
                                    {override && overrideLabel ? (
                                      overrideLabel
                                    ) : (
                                      <span className="dim">Default: {defaultLabel}</span>
                                    )}
                                  </div>
                                  <div className="detailActions">
                                    <select
                                      className="input"
                                      value={override}
                                      onChange={e =>
                                        onSetGameLibVersion(
                                          g.gamePath,
                                          dep.id,
                                          e.target.value
                                        )
                                      }
                                    >
                                      <option value="">Default: {defaultLabel}</option>
                                      {dep.versions.map(
                                        (version: { id?: string; label?: string }) => (
                                        <option key={version.id} value={version.id}>
                                          {version.label}
                                        </option>
                                        )
                                      )}
                                    </select>
                                  </div>
                                </div>
                              );
                            })}

                          {canPatchCheats && (
                            <div className="detailRow">
                              <div className="detailLabel">Tools patch</div>
                              <div className="detailValue">
                                {(() => {
                                  if (!cheatsStatus) return <span className="dim">—</span>;
                                  if (cheatsStatus.patched)
                                    return (
                                      <span className={["badge", "badgeAccent"].join(" ")}>
                                        Patched
                                      </span>
                                    );
                                  if (cheatsStatus.partial)
                                    return (
                                      <span className={["badge", "badgeWarn"].join(" ")}>
                                        Partial
                                      </span>
                                    );
                                  return <span className="badge">Not patched</span>;
                                })()}
                              </div>
                              <div className="detailActions">
                                <button
                                  className="btn small iconOnly"
                                  disabled={cheatsPatchBusyPath === g.gamePath}
                                  onClick={() => refreshCheatsPatchStatus(g.gamePath)}
                                  title="Reload"
                                  aria-label="Reload"
                                >
                                  <RefreshIcon />
                                </button>
                                <ToggleActionButton
                                  active={cheatsPatched}
                                  enableLabel="Patch"
                                  disableLabel="Unpatch"
                                  enableDisabled={cheatsPatchBusyPath === g.gamePath}
                                  disableDisabled={cheatsPatchBusyPath === g.gamePath}
                                  onEnable={() => onPatchCheatsIntoGame(g.gamePath)}
                                  onDisable={() => onUnpatchCheatsFromGame(g.gamePath)}
                                />
                              </div>
                            </div>
                          )}

                          {visibleModuleActionGroups.map(group => {
                            const actions = group.actions
                              .map(id => moduleActionsById.get(id))
                              .filter(Boolean) as ModuleUiAction[];
                            if (actions.length === 0) return null;
                            const groupLabelValue = group.labelKey
                              ? getByPath(g, group.labelKey)
                              : null;
                            const groupLabel =
                              typeof groupLabelValue === "string" && groupLabelValue.trim()
                                ? groupLabelValue.trim()
                                : group.label;
                            const visibleActions = actions.filter(
                              action => !matchesAnyCondition(g, action.hiddenWhen)
                            );
                            const groupInfoItems: Array<{
                              key: string;
                              label: string;
                              value: string;
                            }> = [];
                            for (const field of group.infoFields || []) {
                              if (matchesAnyCondition(g, field.hiddenWhen)) continue;
                              const value = formatFieldValue(
                                getByPath(g, field.key),
                                field.format,
                                field.empty
                              );
                              groupInfoItems.push({
                                key: `group:${group.id}:${field.key}`,
                                label: field.label || "",
                                value
                              });
                            }
                            const actionsWithResults = visibleActions.filter(
                              action =>
                                Array.isArray(action.resultFields) &&
                                moduleActionResults[action.id]
                            );
                            const needsPrefix = actionsWithResults.length > 1;
                            const resultItems: Array<{
                              key: string;
                              label: string;
                              value: string;
                            }> = [];
                            for (const action of actionsWithResults) {
                              const result = moduleActionResults[action.id];
                              for (const field of action.resultFields || []) {
                                const value = formatFieldValue(
                                  getByPath(result, field.key),
                                  field.format,
                                  field.empty
                                );
                                const labelParts = needsPrefix
                                  ? [action.label, field.label]
                                  : [field.label];
                                const label = labelParts.filter(Boolean).join(" ");
                                resultItems.push({
                                  key: `${action.id}:${field.key}`,
                                  label,
                                  value
                                });
                              }
                            }
                            const valueItems = groupInfoItems.concat(resultItems);
                            const showRow =
                              visibleActions.length > 0 ||
                              valueItems.length > 0 ||
                              Boolean(group.note);
                            if (!showRow) return null;
                            return (
                              <div className="detailRow" key={`action-group-${group.id}`}>
                                <div className="detailLabel">{groupLabel}</div>
                                <div className="detailValue">
                                  {group.note && <div className="dim">{group.note}</div>}
                                  {valueItems.length > 0 ? (
                                    <div className="detailMeta">
                                      {valueItems.map((item, idx) => (
                                        <span key={item.key}>
                                          {item.label ? (
                                            <>
                                              <span className="dim">{item.label}:</span>{" "}
                                            </>
                                          ) : null}
                                          {item.value}
                                          {idx < valueItems.length - 1 && (
                                            <span className="sep">·</span>
                                          )}
                                        </span>
                                      ))}
                                    </div>
                                  ) : !group.note && !group.hideEmptyValue ? (
                                    <span className="dim">—</span>
                                  ) : null}
                                </div>
                                <div className="detailActions">
                                  {visibleActions.map(action => {
                                    const actionDisabled =
                                      Boolean(moduleActionBusy[action.id]) ||
                                      matchesAnyCondition(g, action.disabledWhen);
                                    const iconOnly = Boolean(action.icon && action.iconOnly);
                                    const actionClass = [
                                      "btn",
                                      "small",
                                      action.kind === "primary" ? "primary" : "",
                                      action.kind === "danger" ? "danger" : "",
                                      iconOnly ? "iconOnly" : ""
                                    ]
                                      .filter(Boolean)
                                      .join(" ");
                                    return (
                                      <button
                                        key={action.id}
                                        className={actionClass}
                                        disabled={actionDisabled}
                                        title={action.label}
                                        aria-label={action.label}
                                        onClick={() =>
                                          onModuleAction(g.gamePath, action.id, action)
                                        }
                                      >
                                        {action.icon ? (
                                          <>
                                            <ActionIcon icon={action.icon} />
                                            {!iconOnly && <span>{action.label}</span>}
                                          </>
                                        ) : (
                                          action.label
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}

                          {moduleActionError && (
                            <div className="detailRow">
                              <div className="detailLabel">Actions</div>
                              <div className="detailValue">
                                <span className="badge badgeDanger">
                                  Error: {moduleActionError}
                                </span>
                              </div>
                              <div className="detailActions" />
                            </div>
                          )}

                        </div>

                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>

      {saveGame && (
        <SaveToolsModal
          saveGame={saveGame}
          saveInfo={saveInfo}
          saveFiles={saveFiles}
          saveBusy={saveBusy}
          saveError={saveError}
          editingFile={editingFile}
          editingJson={editingJson}
          onClose={closeSaveTools}
          onReveal={onReveal}
          onImportSaveDir={onImportSaveDir}
          onExportSaveDir={onExportSaveDir}
          onImportSaveFiles={onImportSaveFiles}
          onEditSaveFile={onEditSaveFile}
          onFormatJson={onFormatJson}
          onOpenEditedJsonExternal={onOpenEditedJsonExternal}
          onReloadEditedJsonExternal={onReloadEditedJsonExternal}
          onSaveEditedJson={onSaveEditedJson}
          onEditingJsonChange={setEditingJson}
          onCancelEdit={() => {
            setEditingFile(null);
            setEditingJson("");
          }}
        />
      )}

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

      {settingsOpen && state && (
        <SettingsModal
          state={state}
          showIcons={showIcons}
          showNonDefaultTags={showNonDefaultTags}
          onSetLauncherSettings={onSetLauncherSettings}
          onSetModuleSettings={onSetModuleSettings}
          onOpenRuntimeSettings={onOpenRuntimeSettings}
          onClose={closeSettings}
        />
      )}

      {acknowledgmentsOpen && (
        <AcknowledgmentsModal
          acknowledgments={acknowledgments}
          canOpenExternal={canOpenExternal}
          onOpenLink={onOpenAcknowledgmentsLink}
          onClose={closeAcknowledgments}
        />
      )}

      {runtimesOpen && state && (
        <RuntimesModal
          runtimeManagers={runtimeManagers}
          runtimeUi={runtimeUi}
          runtimeManagerId={runtimeManagerId}
          runtimeSectionId={runtimeSectionId}
          downloadTasks={downloadTasks}
          downloadsOpen={downloadsOpen}
          setDownloadsOpen={setDownloadsOpen}
          setRuntimeManagerId={setRuntimeManagerId}
          setRuntimeSectionId={setRuntimeSectionId}
          updateRuntimeUiSection={updateRuntimeUiSection}
          onRuntimeRefresh={onRuntimeRefresh}
          onRuntimeInstall={onRuntimeInstall}
          onRuntimeSetDefault={onRuntimeSetDefault}
          onRuntimeUninstall={onRuntimeUninstall}
          onCancelDownload={id => api?.cancelDownload(id)}
          onClose={closeRuntimesManager}
        />
      )}
    </div>
  );
}

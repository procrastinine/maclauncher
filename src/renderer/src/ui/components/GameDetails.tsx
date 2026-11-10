import { Select } from "./Select";
import React, { memo, useRef, useState } from "react";
import type {
  CheatsPatchStatus, LauncherState, LibsPatchStatus, ModuleActionError, ModuleManifest,
  ModuleUiAction, RecentGame, RuntimeAutomaticEntry, RuntimeId, RuntimeStatusEntry
} from "../types";
import {
  defaultSaveDirForGame, filesUnavailableReason, formatRuntimeLabel,
  formatRuntimeOption, runtimeVersionTagger,
  formatSettingLabel, getByPath, matchesAnyCondition, resolveRuntimeManagerId,
  resolveRuntimeSection, resolveRuntimeSectionId, resolveRuntimeSections,
  resolveRuntimeSettingsSchema, resolveRuntimeVersionForSection, resolveRuntimeVersionOverride,
  withAvailability
} from "../ui-helpers";
import { FolderIcon, RefreshIcon, SettingsIcon, XIcon } from "../icons";
import type { LibraryActions } from "./library-actions";
import { GameNotes } from "./GameNotes";
import { GameActions } from "./GameActions";
import { GameArguments } from "./GameArguments";
import { GameIcon } from "./GameIcon";
import { HelpTip } from "./HelpTip";
import { ACTIONS, ACTION_HELP } from "../../../../modules/shared/graphics-shortcuts.mjs";
import { ModuleTools } from "./ModuleTools";
import { ModuleEntrySelectors } from "./ModuleEntrySelectors";
import { moduleToolGroups, presentModuleFields } from "./module-tools-model";
import { isRuntimeManageable } from "./runtime-tabs-model";
import { RuntimeDescription } from "./RuntimeDescription";
import { resolveInspectorRuntimeSection, runtimeInspectorInstall, runtimeInspectorRepair, runtimeInspectorVersions,
  runtimeInspectorVersionOptions, runtimeInspectorVersionPatch } from "./runtime-inspector-model";
import { EffectsControls } from "./EffectsControls";
import { ErrorText } from "./ErrorText";
import { StatusBadge } from "./StatusBadge";
import { PathDisplay } from "./PathDisplay";

export type GameDetailsState = Pick<LauncherState, "modules" | "moduleStates" | "runtimeManagers" | "running" | "preparing" | "moduleSettings" | "runtimeDefaults" | "launcherSettings">;

type GameDetailsProps = {
  g: RecentGame;
  state: GameDetailsState;
  moduleInfo: ModuleManifest | null;
  actions: LibraryActions;
  cheatsStatus: CheatsPatchStatus | null;
  libsStatus: LibsPatchStatus | null;
  runtimeStatusEntry: RuntimeStatusEntry | null;
  runtimeAutomaticEntry?: RuntimeAutomaticEntry | null;
  visible?: boolean;
  cheatsPatchBusy: boolean;
  libsPatchBusy: boolean;
  moduleActionResults: Record<string, any>;
  moduleActionBusy: Record<string, boolean>;
  moduleActionCancelling?: Record<string, boolean>;
  moduleActionError: ModuleActionError | null;
  onClose?: () => void;
};

type PatchState = { patched?: boolean; partial?: boolean; warnings?: string[] } | null;

const steamClientStartLabels = { ask: "Ask", automatic: "Start automatically", never: "Don't start" } as const;

function PatchStatus({ status }: { status: PatchState }) {
  if (!status) return null;
  return <>
    {status.patched ? <StatusBadge tone="positive">Patched</StatusBadge>
      : status.partial ? <StatusBadge tone="warning">Partial</StatusBadge> : <StatusBadge>Not patched</StatusBadge>}
    {status.warnings?.length ? <> <StatusBadge tone="warning" title={status.warnings.join("\n")}>Warning</StatusBadge></> : null}
  </>;
}

// Graphics is long; its collapsed state follows the user across games for the session.

type ToggleActionButtonProps = {
  active: boolean;
  onEnable: () => void;
  onDisable: () => void;
  enableLabel: string;
  disableLabel: string;
  enableDisabled?: boolean;
  disableDisabled?: boolean;
  title?: string;
};

function ToggleActionButton({
  active,
  onEnable,
  onDisable,
  enableLabel,
  disableLabel,
  enableDisabled,
  disableDisabled,
  title
}: ToggleActionButtonProps) {
  if (active) {
    return (
      <button className="btn small danger" disabled={disableDisabled} onClick={onDisable} title={title}>
        {disableLabel}
      </button>
    );
  }

  return (
    <button className="btn small" disabled={enableDisabled} onClick={onEnable} title={title}>
      {enableLabel}
    </button>
  );
}

// The windows, apps and displays of a running session share its graphics;
// removing the last one ends the session. A removal in progress disables its
// button until the session answers.
function SessionTargets({ gamePath, targets, onRemove }: {
  gamePath: string;
  targets: NonNullable<RecentGame["sessionTargets"]>;
  onRemove: LibraryActions["onRemoveSessionTarget"];
}) {
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());
  const remove = (id: string) => {
    setRemoving(current => new Set(current).add(id));
    void onRemove(gamePath, id).finally(() => setRemoving(current => { const next = new Set(current);next.delete(id);return next; }));
  };
  return <>
    <h3 className="detailSectionHeading">Applied to</h3>
    {targets.map(target => {
      const name = target.detail ? `${target.label} (${target.detail})` : target.label;
      const description = targets.length > 1 ? `Remove ${name}` : `Remove ${name} and end the session`;
      return <div className="detailRow" key={target.id}>
        <div className="detailLabel">{target.detail || "Window"}</div>
        <div className="detailValue" title={target.label}>{target.label}</div>
        <div className="detailActions">
          <button className="btn small iconOnly" disabled={removing.has(target.id)} onClick={() => remove(target.id)}
            title={description} aria-label={description}><XIcon /></button>
        </div>
      </div>;
    })}
  </>;
}

// An app action's shortcut also ends the front app's session. The row names
// its assignment in macOS menu glyphs, or opens the Launcher section of
// Settings, where graphics shortcuts are assigned.
function SessionShortcut({ moduleInfo, assigned }: { moduleInfo: ModuleManifest | null; assigned?: Record<string, string> }) {
  const appActions = (moduleInfo?.ui as (NonNullable<ModuleManifest["ui"]> & { appActions?: Array<{ shortcut?: unknown; sessionShortcuts?: Array<{ shortcut?: unknown }> }> }) | null | undefined)?.appActions;
  const shortcuts = [...new Set(appActions?.flatMap(action => [action.shortcut, ...(action.sessionShortcuts || []).map(item => item.shortcut)]).filter((name): name is string => typeof name === "string") || [])];
  const labels = ACTIONS as Record<string, string>, help = ACTION_HELP as Record<string, string>;
  const glyphs: Record<string, string> = { Control: "⌃", Option: "⌥", Shift: "⇧", Command: "⌘", Return: "↩", Escape: "⎋", Up: "↑", Down: "↓", Left: "←",
    Right: "→", Backspace: "⌫", Delete: "⌦", Tab: "⇥" };
  return <>{shortcuts.map(shortcut => {
    const label = labels[shortcut] || shortcut, accelerator = assigned?.[shortcut];
    return <div className="detailRow" key={shortcut}>
      <div className="detailLabel">Keyboard shortcut{help[shortcut] && <HelpTip label={"About " + label}>{help[shortcut]}</HelpTip>}</div>
      <div className="detailValue"><span>{label}</span>{accelerator
        ? <>: <kbd>{accelerator.split("+").map(part => glyphs[part] ?? part).join("")}</kbd></>
        : <> <button className="btn small iconOnly" title="Assign in Settings…" aria-label={"Assign " + label + " in Settings"}
          onClick={() => void window.MacLauncher?.launcher.openUtilityWindow({ view: "settings", sectionId: "launcher" }).catch(() => {})}><SettingsIcon /></button></>}</div>
    </div>;
  })}</>;
}

function detectionText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

// Present existing module/report metadata uniformly. Engine parsing and all
// filesystem probes stay in the backend; the renderer never executes content.
function detectionDisplay(game: RecentGame, moduleInfo: ModuleManifest | null, state: GameDetailsState, report: any) {
  const selectedId = detectionText(report?.selectedModuleId) || game.moduleId;
  const selectedModule = state.modules.find(module => module.id === selectedId) || moduleInfo;
  const selectedVersion = Array.isArray(report?.versions)
    ? report.versions.find((version: any) => version.moduleId === selectedId)
    : null;
  const data = report?.detected?.moduleData || game.moduleData || {};
  const version = detectionText(selectedVersion?.value) || detectionText(data.detectedVersion)
    || detectionText(data.version) || detectionText(data.rawVersion) || detectionText(data.classicVersion);
  const confidence = detectionText(selectedVersion?.certainty) || detectionText(data.detectedVersionConfidence)
    || detectionText(data.versionConfidence) || (!version ? "unknown" : data.rawVersionReliable === false || /(?:\.x|unknown|inferred)/i.test(version) ? "inferred" : "reported");
  const source = detectionText(selectedVersion?.source) || detectionText(data.detectedVersionSource)
    || detectionText(data.detectedSource) || detectionText(data.versionSource);
  const selectedCandidate = Array.isArray(report?.candidates)
    ? report.candidates.find((candidate: any) => candidate.moduleId === selectedId)
    : null;
  const evidenceSource = Array.isArray(selectedCandidate?.evidence)
    ? selectedCandidate.evidence.find((item: any) => ["web-marker", "root-marker", "validated-selected-artifact"].includes(item.type))?.path
    : null;
  // A named engine generation describes the format; a numbered platform
  // generation, such as Switch 2, is not a format name.
  const format = detectionText(data.rgssVersion) || (typeof data.generation === "string" ? detectionText(data.generation) : null) || detectionText(data.executionKind)
    || detectionText(data.sourceKind) || detectionText(data.packagedType) || detectionText(game.gameType);
  const rows = [
    ...(selectedModule && selectedModule.id !== game.moduleId ? [{ label: "Engine", value: selectedModule.label || selectedId }] : []),
    { label: "Format", value: format ? formatSettingLabel(format) : "Unknown" },
    { label: "Version", value: version || "Unknown" },
    { label: "Source", value: source || detectionText(evidenceSource) || "Unknown" },
    { label: "Confidence", value: formatSettingLabel(confidence) }
  ];
  const showVersion = moduleInfo?.ui?.detection?.showVersion !== false;
  return { rows: rows.filter(row => showVersion || !["Version", "Confidence"].includes(row.label)),
    version: showVersion && version && !/unknown/i.test(version) ? version : null };
}

export const GameDetails = memo(function GameDetails({
  g, state, moduleInfo, actions, cheatsStatus, libsStatus, runtimeStatusEntry, runtimeAutomaticEntry, visible = true,
  cheatsPatchBusy, libsPatchBusy, moduleActionResults, moduleActionBusy, moduleActionCancelling, moduleActionError, onClose
}: GameDetailsProps) {
  const {
    onReveal, onPickSaveDir, onResetSaveDir, onSetRuntime, onOpenRuntimeSettings,
    onSetRuntimeData, openRuntimesManager, onInstallRuntime, refreshLibsPatchStatus, onPatchLibs,
    onUnpatchLibs, onSetGameLibVersion, refreshCheatsPatchStatus,
    onPatchCheatsIntoGame, onUnpatchCheatsFromGame, onModuleAction, onCancelModuleAction, onRevealToolPath
  } = actions;
  const moduleState = state.moduleStates?.[g.moduleId] || null;
  const moduleUi = moduleInfo?.ui || null;
  const moduleActions = (moduleUi?.actions || []) as ModuleUiAction[];
  const moduleActionsById = new Map(
    moduleActions.map(action => [action.id, action])
  );
  const moduleActionGroups = moduleToolGroups(moduleActions, moduleUi?.actionGroups);
  const visibleModuleActionGroups = moduleActionGroups.filter(
    group => !matchesAnyCondition(g, group.hiddenWhen)
  );
  const infoFields = presentModuleFields(g, (moduleUi?.infoFields || []).filter(field => !matchesAnyCondition(g, field.hiddenWhen)));
  const hasModuleTools = visibleModuleActionGroups.some(group => group.actions.some(id => {
    const action = moduleActionsById.get(id);
    return action && action.inspector !== false && !matchesAnyCondition(g, action.hiddenWhen);
  }));
  const canLaunch = g.moduleSupports?.launch !== false;
  const hasSaveLocation = g.moduleSupports?.saveLocation === true;
  const canChangeSaveLocation = g.moduleSupports?.saveLocationOverride !== false;
  const saveDir = hasSaveLocation
    ? (canChangeSaveLocation && g.saveDirOverride) || defaultSaveDirForGame(g)
    : "";
  const hasSaveDir = Boolean(saveDir);
  const canLaunchNative = Boolean(
    (g.nativeAppPath && g.nativeAppPath.toLowerCase().endsWith(".app")) ||
      g.gamePath.toLowerCase().endsWith(".app")
  );
  const hasAppBundle = canLaunchNative || Boolean(g.importPath?.toLowerCase().endsWith(".app"));
  const canEditSaves = g.moduleSupports?.saveEditing !== false || hasSaveLocation;
  const canPatchCheats = g.moduleSupports?.cheatsPatcher === true;
  // Patches and tools read or change the game's files, so they wait for the drive.
  const filesUnavailable = filesUnavailableReason(g);
  const cheatsPatched = Boolean(cheatsStatus?.patched || cheatsStatus?.partial);
  const runtimeSupport: RuntimeId[] =
    Array.isArray(g.moduleRuntimeSupport)
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
    ? resolveRuntimeSectionId(moduleInfo, g.runtimeId, g, { managerState: runtimeManagerState })
    : null;
  const runtimeSection = resolveInspectorRuntimeSection(moduleInfo, g.runtimeId, runtimeManagerState, runtimeSectionId);
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
      for (const sectionId of Object.keys(runtimeManagerState.selectionSections || {})) {
        if (!mappedEntries.some(([value]) => value === sectionId)) mappedEntries.push([sectionId, sectionId]);
      }
      if (runtimeSectionId && !mappedEntries.some(([value]) => value === runtimeSectionId) && runtimeManagerState.selectionSectionTemplate) {
        mappedEntries.push([runtimeSectionId, runtimeSectionId]);
      }
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
  const runtimeAutoSectionId = resolveRuntimeSectionId(moduleInfo, g.runtimeId, g, { ignoreOverride: true, managerState: runtimeManagerState });
  const runtimeAutoMatch = resolveRuntimeSection(runtimeManagerState, runtimeAutoSectionId);
  // A section that is not listed yet, such as a release line before its
  // versions load, reads as plain Automatic rather than naming another line.
  const runtimeAutoSection = runtimeAutoSectionId && runtimeAutoMatch?.id !== runtimeAutoSectionId &&
    !runtimeManagerState?.selectionSections?.[runtimeAutoSectionId] ? null : runtimeAutoMatch;
  const runtimeSectionAutoLabel = runtimeAutoSection?.label
    ? `Automatic (${runtimeAutoSection.label})`
    : "Automatic";
  const runtimeVersionOverride = resolveRuntimeVersionOverride(moduleInfo, g.runtimeId, g, runtimeSectionId);
  const runtimeArchitectureOverride = g.runtimeData?.[g.runtimeId]?.architecture || "";
  const runtimeVariantOverride = g.runtimeData?.[g.runtimeId]?.variant || "";
  const runtimeStatus =
    runtimeStatusEntry && runtimeStatusEntry.runtimeId === g.runtimeId
      ? runtimeStatusEntry.status
      : null;
  // Translator rows come only from this runtime's current status. Until it
  // arrives, a game whose last Play recorded translators shows a pending line
  // rather than recorded rows that may describe other settings.
  const translatorRows: { id?: string; label: string; selected: string; used: string; reason?: string | null; reasonCode?: string | null; fallback?: boolean }[] =
    Array.isArray(runtimeStatus?.translatorRows) ? runtimeStatus.translatorRows : [];
  const recordedTranslators = Array.isArray(g.runtimeData?.[g.runtimeId]?.translatorRows) && g.runtimeData[g.runtimeId].translatorRows.length > 0;
  const translatorsPending = runtimeStatusEntry?.runtimeId !== g.runtimeId && recordedTranslators;
  // A check that returned no status says so instead of leaving the section out.
  const translatorsUnavailable = runtimeStatusEntry?.runtimeId === g.runtimeId && !runtimeStatus && recordedTranslators;
  const translatorLabels = new Set(translatorRows.map(row => row.label));
  const runtimeVersionChoices = runtimeInspectorVersions(runtimeSection, runtimeVersionOverride);
  const runtimeDefaultVersion = runtimeSection?.defaultVersion || "";
  const runtimeLabel = formatRuntimeLabel(g.runtimeId, moduleInfo);
  // The Version menu is named after the Runtimes tab or section that lists its
  // versions, unless the runtime's own name already includes that name
  // (VNDS-LOVE runs on versions from the LÖVE tab).
  const runtimeVersionSources = [runtimeManagerState?.ui?.sectionLabel, runtimeManagerState?.ui?.tabLabel]
    .map(value => typeof value === "string" ? value.trim() : "").filter(Boolean);
  const runtimeVersionOwner = runtimeVersionSources.length && !runtimeVersionSources.some(value => String(runtimeLabel || "").includes(value))
    ? runtimeVersionSources[0]
    : runtimeLabel;
  const runtimeVersionLabelText = runtimeVersionOwner
    ? `${runtimeVersionOwner} version`
    : "Runtime version";
  const runtimeStatusDefaultCandidate =
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
  const runtimeStatusDefaultVersion = resolveRuntimeVersionForSection(
    moduleInfo, g.runtimeId, runtimeStatusDefaultCandidate, runtimeSectionId);
  // The game's own recommendation precedes the Runtimes default; the inspector
  // offers to install it when it is missing. A recommended variant is the one
  // Play uses when the game has no variant override. A variant the game requires
  // applies whatever is chosen: the menu shows it, and a saved choice that Play
  // does not use stays saved without being shown as the selection.
  const runtimeRecommended = (runtimeStatus as any)?.runtimeRecommendation?.managerId === runtimeManagerId
    ? (runtimeStatus as any).runtimeRecommendation as { version?: string; sectionId?: string; variant?: string;
      requiredVariant?: string; requiredVariantReason?: string } : null;
  const runtimeRecommendation = runtimeRecommended?.version ? runtimeRecommended as { version: string; sectionId?: string } : null;
  // The version Play uses without a version choice, loaded separately.
  const runtimePlayVersion = runtimeAutomaticEntry?.runtimeId === g.runtimeId &&
    runtimeAutomaticEntry.value?.managerId === runtimeManagerId ? runtimeAutomaticEntry.value.version : "";
  const runtimeRequiredVariant = runtimeRecommended?.requiredVariant || "";
  const runtimeEffectiveVariantOverride = runtimeRequiredVariant && runtimeVariantOverride !== runtimeRequiredVariant ? "" : runtimeVariantOverride;
  const runtimeDefaultVariant = runtimeRequiredVariant || runtimeRecommended?.variant || runtimeSection?.defaultVariant || "";
  const runtimeRecommendedVariant = runtimeEffectiveVariantOverride || runtimeRequiredVariant || runtimeRecommended?.variant || "";
  const runtimeRecommendationInstalled = Boolean(runtimeRecommendation && (runtimeSection?.installed || [])
    .some((item: any) => item?.version === runtimeRecommendation.version && item.ready !== false &&
      (!runtimeRecommendedVariant || item.variant === runtimeRecommendedVariant)));
  const runtimeVersionTag = runtimeVersionTagger(runtimeSection,
    [...runtimeVersionChoices, runtimeRecommendation?.version, runtimePlayVersion, runtimeStatusDefaultVersion]);
  const runtimeVersionOptions = runtimeInspectorVersionOptions(runtimeSection, runtimeVersionOverride, runtimeVersionTag);
  const runtimePreferredArchitecture = runtimeArchitectureOverride || runtimeSection?.defaultArchitecture ||
    runtimeManagerState?.defaultArchitecture || runtimeSection?.launcherArchitecture || runtimeManagerState?.launcherArchitecture;
  const runtimeVersionOption = runtimeVersionOptions.find(option => option.version === runtimeVersionOverride && option.architecture === runtimePreferredArchitecture) ||
    runtimeVersionOptions.find(option => option.version === runtimeVersionOverride);
  // Automatic names the version Play uses without a version choice, as the
  // launcher selects it: a compatible installed version, otherwise the one Play
  // installs. It reads Automatic until that version arrives, and stays so when
  // none is known; the menu's width does not depend on the label.
  const runtimeAutomaticLabel = runtimePlayVersion ? `Automatic (${runtimeVersionTag(runtimePlayVersion)})` : "Automatic";
  const runtimeVariantOptions = (Array.isArray(runtimeSection?.variants)
    ? runtimeSection.variants
    : []) as Array<{ id?: string; label?: string } & Record<string, any>>;
  const runtimeHasMultipleVariants = runtimeVariantOptions.length > 1;
  const runtimeDefaultVariantLabel = runtimeHasMultipleVariants
    ? runtimeVariantOptions.find(
        (opt: { id?: string; label?: string }) =>
          opt.id === runtimeDefaultVariant
      )?.label ||
      runtimeDefaultVariant
    : "";
  // Damaged or incomplete installations stay in the menu marked Needs repair.
  // When the game's choice, otherwise the recommended or default version, is
  // one of them, Repair installs it again through the same install action as
  // Reinstall in Runtimes. It does not wait for the Automatic entry's version.
  const runtimeVariantInUse = runtimeHasMultipleVariants ? runtimeEffectiveVariantOverride || runtimeDefaultVariant : "";
  const runtimeVersionAvailability = (version: string, architecture = "") => {
    const { availability } = runtimeInspectorInstall(runtimeSection, version, runtimeVariantInUse, architecture);
    return availability === "installed" ? null : availability;
  };
  const runtimeRepair = runtimeInspectorRepair(runtimeSection,
    runtimeVersionOverride || runtimeRecommendation?.version || runtimeDefaultVersion || runtimeStatusDefaultVersion, runtimeVariantInUse,
    runtimeVersionOption?.architecture || runtimePreferredArchitecture);
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
  const libsPatched = Boolean(libsStatus?.patched || libsStatus?.partial);
  const libOverrides =
    g.moduleData && typeof g.moduleData === "object"
      ? g.moduleData.libVersions || {}
      : {};
  const runtimeSchema = resolveRuntimeSettingsSchema(moduleInfo, g.runtimeId);
  const actionError = (actionId: string) => moduleActionError?.actionId === actionId ? moduleActionError.message : null;
  const toolActionIds = new Set(visibleModuleActionGroups.flatMap(group => group.actions));
  const otherActionError = moduleActionError && !["explainDetection", "removeAppQuarantine", "locateGame"].includes(moduleActionError.actionId) &&
    !toolActionIds.has(moduleActionError.actionId) ? moduleActionError.message : null;
  const networkConfigurable = moduleInfo?.runtime?.entries?.[g.runtimeId]?.networkAccess !== false;
  const defaultNetworkAccess = state.launcherSettings?.networkAccess === true;
  const detectionReport = moduleActionResults.explainDetection;
  const detection = detectionDisplay(g, moduleInfo, state, detectionReport);
  const requestedDetection = useRef(false);
  function requestDetection() {
    if (requestedDetection.current || detectionReport || moduleActionBusy.explainDetection) return;
    requestedDetection.current = true;
    void onModuleAction(g.gamePath, "explainDetection");
  }
  const gameRunning = Boolean(state.running?.[g.gamePath]), graphicsLive = runtimeStatus?.graphicsLive === true;

  return (
    <>
      <div className="gameDetailsHeader">
        <div className="gameDetailsIdentity">
          <GameIcon game={g} inspector />
          <div className="gameDetailsIdentityText">
            <h2 id="game-details-title" className="cardTitle" title={g.name}>{g.name}</h2>
            <div className="cardSubtitle">{g.moduleLabel || g.moduleShortLabel || g.moduleId}{detection.version ? ` · ${detection.version}` : ""}</div>
          </div>
        </div>
        {onClose && <button className="btn small iconOnly" onClick={onClose} title="Close details" aria-label="Close details"><XIcon /></button>}
      </div>
      <GameActions g={g} isRunning={Boolean(state.running?.[g.gamePath])} preparation={state.preparing?.[g.gamePath]} actions={actions} inspector />
      {g.availability && <div className="gameUnavailableNotice">
        <div className="detailMeta gameUnavailableMessage" role="status">Files unavailable. {g.availability.message}</div>
        <button className="btn small" disabled={Boolean(moduleActionBusy.locateGame)} onClick={() => actions.onLocateGame(g.gamePath)}
          title="Choose the game's new location">Locate…</button>
        <ErrorText error={actionError("locateGame")} inline />
      </div>}
      {g.launchNotices?.map((notice, index) => <div className="detailMeta gameLaunchNotice" role="status" key={index}>{notice}</div>)}
      <div className="gameDetails" tabIndex={0} aria-label={`${g.name} details`}>
        <div className="detailGrid">
          {/* An entry that exists only while its session runs has no files,
              launch settings, patches, tools or notes of its own; its
              inspector holds Stop and Graphics. */}
          {!g.ephemeral && <>
          <h3 className="detailSectionHeading">Files</h3>
          <div className="detailRow">
            <div className="detailLabel">Game</div>
            <div className="detailValue mono">
              <PathDisplay path={g.gamePath} />
            </div>
            <div className="detailActions">
              <button
                className="btn small iconOnly"
                onClick={() => onReveal(g.gamePath)}
                disabled={Boolean(filesUnavailable)}
                title={filesUnavailable || "Reveal in Finder"}
                aria-label="Reveal in Finder"
              >
                <FolderIcon />
              </button>
            </div>
          </div>
          <ModuleEntrySelectors game={g} fields={moduleUi?.entrySelectors} visible={visible}
            running={Boolean(state.running?.[g.gamePath])} preparing={Boolean(state.preparing?.[g.gamePath])} />

          {canLaunch && hasSaveLocation && (
            <div className="detailRow">
              <div className="detailLabel">Saves</div>
              <div className={`detailValue${g.managedSaveDir ? "" : " mono"}`}>
                <PathDisplay path={saveDir} managed={g.managedSaveDir} />
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
                {canChangeSaveLocation && <button
                  className="btn small"
                  onClick={() => onPickSaveDir(g.gamePath)}
                  disabled={!canEditSaves}
                >
                  Change…
                </button>}
                {canChangeSaveLocation && g.saveDirOverride && (
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

          {hasAppBundle && (
            <div className="detailRow detailToolRow">
              <div className="detailLabel">App quarantine<HelpTip label="About app quarantine">Remove the download quarantine attribute if macOS reports this app as damaged.</HelpTip></div>
              <div className="detailValue">
                {moduleActionResults.removeAppQuarantine?.status && <div className="detailMeta">{moduleActionResults.removeAppQuarantine.status}</div>}
                <ErrorText error={actionError("removeAppQuarantine")} inline />
              </div>
              <div className="detailActions">
                <button className="btn small" disabled={Boolean(moduleActionBusy.removeAppQuarantine) || Boolean(filesUnavailable)}
                  title={filesUnavailable} onClick={() => onModuleAction(g.gamePath, "removeAppQuarantine")}>
                  Remove quarantine
                </button>
              </div>
            </div>
          )}

          <details className="detectionDiagnostics detailDisclosure" onToggle={event => { if (event.currentTarget.open) requestDetection(); }}>
            <summary>Detection</summary>
            {detection.rows.map(row => <div className="detailRow" key={`detection-${row.label}`}>
              <div className="detailLabel" title={row.label}>{row.label}</div>
              <div className={["detailValue", row.value === "Unknown" ? "dim" : ""].filter(Boolean).join(" ")} title={row.value}>{row.value}</div>
            </div>)}
            {infoFields.map(field => {
              const raw = getByPath(g, field.key);
              return <div className="detailRow" key={`info-${field.key}`}>
                <div className="detailLabel" title={field.label}>{field.label}</div>
                <div className="detailValue">{field.value}</div>
                {field.format === "path" && typeof raw === "string" && <button className="btn small iconOnly" onClick={() => onReveal(raw)} title="Reveal in Finder" aria-label="Reveal in Finder"><FolderIcon /></button>}
              </div>;
            })}
            {detectionReport?.error?.message && <div className="detailMeta">{detectionReport.error.message}</div>}
            {detectionReport ? <>
              {(detectionReport.candidates || []).map((candidate: any, index: number) => <div className="detailMeta" key={`candidate-${index}`}>
                {candidate.label || candidate.moduleId} · {candidate.stage}
                {candidate.version?.value ? ` · ${candidate.version.value}` : ""}
              </div>)}
              {(detectionReport.trace || []).filter((probe: any) => probe.moduleId).map((probe: any, index: number) => <div className="detailMeta" key={`probe-${index}`}>
                {probe.stage} · {probe.moduleId} · {probe.outcome}{probe.reason ? ` (${probe.reason})` : ""}
              </div>)}
            </> : <div className="detailMeta">{moduleActionBusy.explainDetection ? "Checking local game files…" : "No detailed report available."}</div>}
            <ErrorText error={actionError("explainDetection")} inline />
            <button className="btn small iconOnly" disabled={Boolean(moduleActionBusy.explainDetection) || Boolean(filesUnavailable)}
              onClick={() => onModuleAction(g.gamePath, "explainDetection")}
              title={filesUnavailable || "Refresh detection diagnostics"} aria-label="Refresh detection diagnostics"><RefreshIcon /></button>
          </details>

          <h3 className="detailSectionHeading">{canLaunch ? "Launch" : "Runtime"}</h3>
          {canLaunch && <GameArguments key={`arguments:${g.gamePath}`} value={g.launchArguments || ""}
            onSave={value => actions.onSetLaunchArguments(g.gamePath, value)} />}
          <div className="detailRow detailControlRow">
            <div className="detailLabel">Runtime <RuntimeDescription moduleInfo={moduleInfo} runtimeId={g.runtimeId} /></div>
            <div className="detailActions menuWithIcon">
              <Select aria-label="Runtime"
                className="input"
                value={g.runtimeId}
                onChange={e =>
                  onSetRuntime(g.gamePath, e.target.value as RuntimeId)
                }
              >
                {!runtimeOptions.includes(g.runtimeId) && (
                  <option value={g.runtimeId} disabled>
                    {formatRuntimeOption(g.runtimeId, moduleInfo)} (saved; incompatible input)
                  </option>
                )}
                {runtimeOptions.map(rt => (
                  <option key={rt} value={rt}>
                    {formatRuntimeOption(rt, moduleInfo)}
                  </option>
                ))}
              </Select>
              {runtimeSchema && <button
                className="btn small iconOnly"
                onClick={() =>
                  onOpenRuntimeSettings({
                    scope: "game",
                    moduleId: g.moduleId,
                    runtimeId: g.runtimeId,
                    gamePath: g.gamePath
                  })
                }
                title="Runtime settings"
                aria-label="Runtime settings"
              >
                <SettingsIcon />
              </button>}
            </div>
          </div>

          {canLaunch && <>
          <div className="detailRow detailControlRow">
            <div className="detailLabel">Network access<HelpTip label="About network access">{networkConfigurable
              ? "Allow Internet and local-network connections for this game. Changes apply on the next launch. New games start with the default set in Settings."
              : "This runtime runs applications offline."}</HelpTip></div>
            <div className="detailActions">
              <label className="inlineCheck settingsToggle">
                <input type="checkbox" aria-label="Network access" disabled={!networkConfigurable}
                  checked={networkConfigurable && (g.networkAccess ?? defaultNetworkAccess)}
                  onChange={event => actions.onSetNetworkAccess(g.gamePath, event.target.checked)} />
              </label>
            </div>
          </div>

          {g.steamClientEligible && <div className="detailRow detailControlRow">
            <div className="detailLabel">Steam client on Play<HelpTip label="About Steam client on Play">Starting Steam connects to the Internet. Ask requests permission at Play when Steam is not running. Don't start launches the game without starting or waiting for Steam. Default follows Settings.</HelpTip></div>
            <div className="detailActions"><Select className="input" aria-label="Steam client on Play" value={g.startSteamClient || "inherit"}
              onChange={event => actions.onSetSteamClientStart(g.gamePath, event.target.value === "inherit" ? null : event.target.value as "ask" | "automatic" | "never")}>
              <option value="inherit">{`Default (${steamClientStartLabels[state.launcherSettings?.startSteamClient || "ask"]})`}</option><option value="ask">Ask</option><option value="automatic">Start automatically</option><option value="never">Don't start</option>
            </Select></div>
          </div>}

          {runtimeManagerState && runtimeSection && (
            <>
              {runtimeSectionOverrideKey &&
                runtimeSectionOverrideOptions.length > 0 && (
                <div className="detailRow detailControlRow">
                  <div className="detailLabel" title={runtimeSectionOverrideLabel}>{runtimeSectionOverrideLabel}</div>
                  <div className="detailActions">
                    <Select aria-label={runtimeSectionOverrideLabel}
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
                    </Select>
                  </div>
                </div>
                )}

              <div className="detailRow detailControlRow">
                <div className="detailLabel">Version</div>
                <div className="detailActions">
                  <Select aria-label={runtimeVersionLabelText}
                    className="input"
                    value={runtimeVersionOption?.value || runtimeVersionOverride}
                    onChange={e => {
                      const option = runtimeVersionOptions.find(option => option.value === e.target.value);
                      const patch = runtimeInspectorVersionPatch(moduleInfo, g.runtimeId, runtimeManagerState,
                        option?.version || e.target.value, option?.architecture ?? null);
                      if (runtimeVariantOverride.startsWith("architecture:")) patch.variant = null;
                      onSetRuntimeData(g.gamePath, g.runtimeId, patch);
                    }}
                  >
                    <option value="" title={runtimePlayVersion || undefined}>{runtimeAutomaticLabel}</option>
                    {runtimeVersionOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {withAvailability(option.label, runtimeVersionAvailability(option.version, option.architecture))}
                      </option>
                    ))}
                  </Select>
                  {runtimeRepair && runtimeManagerId && onInstallRuntime && <button
                    className="btn small"
                    title={`Reinstall ${runtimeVersionTag(runtimeRepair.version)}`}
                    aria-label="Repair runtime version"
                    onClick={() => void onInstallRuntime(runtimeManagerId, runtimeRepair.sectionId, runtimeRepair.version,
                      runtimeRepair.variant, runtimeRepair.architecture)}
                  >
                    Repair
                  </button>}
                  {/* A recommended version that is not installed installs from here. */}
                  {runtimeRecommendation && !runtimeRecommendationInstalled && runtimeRepair?.version !== runtimeRecommendation.version &&
                    runtimeManagerId && onInstallRuntime && <button
                    className="btn small"
                    title={`Install recommended version ${runtimeVersionTag(runtimeRecommendation.version)}`}
                    aria-label="Install recommended version"
                    onClick={() => void onInstallRuntime(runtimeManagerId, runtimeRecommendation.sectionId || runtimeSection?.id || runtimeSectionId || "default",
                      runtimeRecommendation.version, runtimeEffectiveVariantOverride || runtimeDefaultVariant || undefined)}
                  >
                    Install
                  </button>}
                  {isRuntimeManageable(runtimeManagerState, runtimeSection?.id || runtimeSectionId) && <button
                    className="btn small"
                    onClick={() => openRuntimesManager(runtimeManagerId || undefined)}
                  >
                    Runtimes…
                  </button>}
                </div>
              </div>
              {runtimeHasMultipleVariants && (
                <div className="detailRow detailControlRow">
                  <div className="detailLabel">Variant</div>
                  <div className="detailActions">
                    <Select aria-label="Runtime variant"
                      className="input"
                      value={runtimeEffectiveVariantOverride || ""}
                      onChange={e =>
                        onSetRuntimeData(g.gamePath, g.runtimeId, {
                          variant: e.target.value || null
                        })
                      }
                    >
                      <option value="">
                        {runtimeDefaultVariantLabel ? `Default (${runtimeDefaultVariantLabel})` : "Default"}
                      </option>
                      {runtimeVariantOptions.map(
                        (variant: { id?: string; label?: string }) => (
                          <option key={variant.id} value={variant.id}
                            disabled={Boolean(runtimeRequiredVariant && variant.id !== runtimeRequiredVariant)}
                            title={runtimeRequiredVariant && variant.id !== runtimeRequiredVariant ? runtimeRecommended?.requiredVariantReason : undefined}>
                            {variant.label || variant.id}
                          </option>
                        )
                      )}
                    </Select>
                  </div>
                  {runtimeRequiredVariant && runtimeRecommended?.requiredVariantReason &&
                    <div className="detailMeta">{runtimeRecommended.requiredVariantReason}</div>}
                </div>
              )}
            </>
          )}

          </>}

          {translatorsPending && <div className="detailRow" aria-busy="true">
            <div className="detailLabel">Translators</div>
            <div className="detailValue dim">Checking…</div>
          </div>}
          {translatorsUnavailable && <div className="detailRow">
            <div className="detailLabel">Translators</div>
            <div className="detailValue dim">Unavailable</div>
          </div>}
          {translatorRows.map((row, index) => (
            <div className="detailRow" key={`translator:${row.id || index}`}>
              <div className="detailLabel">{row.label}</div>
              <div className="detailValue">{row.selected} → {row.used}
                {(row.selected !== row.used || row.reasonCode === 'dlss-forwarding') && row.reason && (!row.fallback || row.reasonCode) && <div className="detailMeta">{row.reason}</div>}
              </div>
            </div>
          ))}
          {Array.isArray(runtimeStatus?.details) && runtimeStatus.details.filter((row: {label: string}) => !translatorLabels.has(row.label)).map((row: {label: string; value: string; detail?: string}, index: number) => (
            <div className="detailRow" key={index}>
              <div className="detailLabel">{row.label}</div>
              <div className="detailValue">{row.value}{row.detail && <div className="detailMeta">{row.detail}</div>}</div>
            </div>
          ))}

          {(libsDependencies.length > 0 || canPatchCheats) && <h3 className="detailSectionHeading">Patches</h3>}
          {libsDependencies.length > 0 && (
            <div className="detailRow">
              <div className="detailLabel">Libraries</div>
              <div className="detailValue">
                {libsAvailable ? <PatchStatus status={libsStatus} /> : <span className="dim">No managed versions</span>}
              </div>
              <div className="detailActions">
                <button
                  className="btn small iconOnly"
                  disabled={libsPatchBusy || Boolean(filesUnavailable)}
                  onClick={() => refreshLibsPatchStatus(g.gamePath)}
                  title={filesUnavailable || "Reload"}
                  aria-label="Reload"
                >
                  <RefreshIcon />
                </button>
                <ToggleActionButton
                  active={libsPatched}
                  enableLabel="Patch"
                  disableLabel="Unpatch"
                  enableDisabled={
                    libsPatchBusy || !libsAvailable || Boolean(filesUnavailable)
                  }
                  disableDisabled={libsPatchBusy || Boolean(filesUnavailable)}
                  title={filesUnavailable}
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
              return (
                <div className="detailRow detailControlRow" key={dep.id}>
                  <div className="detailLabel" title={dep.label}>{dep.label}</div>
                  <div className="detailActions">
                    <Select aria-label={dep.label}
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
                      <option value="">{defaultVersion ? `Default (${defaultVersion.label})` : "Default"}</option>
                      {dep.versions.map(
                        (version: { id?: string; label?: string }) => (
                        <option key={version.id} value={version.id}>
                          {version.label}
                        </option>
                        )
                      )}
                    </Select>
                  </div>
                </div>
              );
            })}

          {canPatchCheats && (
            <div className="detailRow">
              <div className="detailLabel">Tools patch</div>
              <div className="detailValue">
                <PatchStatus status={cheatsStatus} />
              </div>
              <div className="detailActions">
                <button
                  className="btn small iconOnly"
                  disabled={cheatsPatchBusy || Boolean(filesUnavailable)}
                  onClick={() => refreshCheatsPatchStatus(g.gamePath)}
                  title={filesUnavailable || "Reload"}
                  aria-label="Reload"
                >
                  <RefreshIcon />
                </button>
                <ToggleActionButton
                  active={cheatsPatched}
                  enableLabel="Patch"
                  disableLabel="Unpatch"
                  enableDisabled={cheatsPatchBusy || Boolean(filesUnavailable)}
                  disableDisabled={cheatsPatchBusy || Boolean(filesUnavailable)}
                  title={filesUnavailable}
                  onEnable={() => onPatchCheatsIntoGame(g.gamePath)}
                  onDisable={() => onUnpatchCheatsFromGame(g.gamePath)}
                />
              </div>
            </div>
          )}

          {(hasModuleTools || otherActionError) && <h3 className="detailSectionHeading">Tools</h3>}
          <ModuleTools game={g} groups={visibleModuleActionGroups} actions={moduleActions}
            results={moduleActionResults} busy={moduleActionBusy} cancelling={moduleActionCancelling}
            error={moduleActionError && toolActionIds.has(moduleActionError.actionId) ? moduleActionError : null}
            onAction={onModuleAction} onCancel={onCancelModuleAction} onRevealPath={onRevealToolPath}
            unavailable={filesUnavailable} />
          <ErrorText error={otherActionError} inline />
          </>}

          {g.ephemeral && <SessionShortcut moduleInfo={moduleInfo} assigned={state.launcherSettings?.graphicsShortcuts} />}

          {g.ephemeral && Boolean(g.sessionTargets?.length) &&
            <SessionTargets gamePath={g.gamePath} targets={g.sessionTargets!} onRemove={actions.onRemoveSessionTarget} />}

          {canLaunch && <EffectsControls key={`effects:${g.gamePath}`} game={g} running={gameRunning}
            live={graphicsLive} warnings={g.graphicsWarnings}
            graphicsHost={moduleInfo?.runtime.entries?.[g.runtimeId]?.graphicsHost}
            visible={visible}
            onManageModels={() => openRuntimesManager("graphics-models")} />}

          {!g.ephemeral && <GameNotes key={`notes:${g.gameId || g.gamePath}`} notes={g.notes || ""}
            onSave={notes => actions.onSaveGameNotes(g.gamePath, notes)} />}
        </div>

      </div>
    </>
  );
});

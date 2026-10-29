import { Select } from "./Select";
import React, { memo, useRef } from "react";
import type {
  CheatsPatchStatus, LauncherState, LibsPatchStatus, ModuleActionError, ModuleManifest,
  ModuleUiAction, RecentGame, RuntimeId, RuntimeStatusEntry
} from "../types";
import {
  defaultSaveDirForGame, formatRuntimeLabel,
  formatRuntimeOption, formatRuntimeVersionTag,
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
import { ModuleTools } from "./ModuleTools";
import { ModuleEntrySelectors } from "./ModuleEntrySelectors";
import { moduleToolGroups, presentModuleFields } from "./module-tools-model";
import { isRuntimeManageable } from "./runtime-tabs-model";
import { RuntimeDescription } from "./RuntimeDescription";
import { resolveInspectorRuntimeSection, runtimeInspectorVersions, runtimeInspectorVersionPatch } from "./runtime-inspector-model";
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
  const format = detectionText(data.rgssVersion) || detectionText(data.generation) || detectionText(data.executionKind)
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
  g, state, moduleInfo, actions, cheatsStatus, libsStatus, runtimeStatusEntry, visible = true,
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
  const runtimeAutoSection = resolveRuntimeSection(runtimeManagerState,
    resolveRuntimeSectionId(moduleInfo, g.runtimeId, g, { ignoreOverride: true, managerState: runtimeManagerState }));
  const runtimeSectionAutoLabel = runtimeAutoSection?.label
    ? `Automatic (${runtimeAutoSection.label})`
    : "Automatic";
  const runtimeVersionOverride = resolveRuntimeVersionOverride(moduleInfo, g.runtimeId, g, runtimeSectionId);
  const runtimeVariantOverride = g.runtimeData?.[g.runtimeId]?.variant || "";
  const runtimeStatus =
    runtimeStatusEntry && runtimeStatusEntry.runtimeId === g.runtimeId
      ? runtimeStatusEntry.status
      : null;
  const runtimeVersionChoices = runtimeInspectorVersions(runtimeSection, runtimeVersionOverride);
  const runtimeDefaultVersion = runtimeSection?.defaultVersion || "";
  const runtimeLabel = formatRuntimeLabel(g.runtimeId, moduleInfo);
  const runtimeVersionLabelText = runtimeLabel
    ? `${runtimeLabel} version`
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
  // offers to install it when it is missing.
  const runtimeRecommendation = (runtimeStatus as any)?.runtimeRecommendation?.managerId === runtimeManagerId
    ? (runtimeStatus as any).runtimeRecommendation as { version: string; sectionId?: string } : null;
  const runtimeRecommendationInstalled = Boolean(runtimeRecommendation && (runtimeSection?.installed || [])
    .some((item: any) => item?.version === runtimeRecommendation.version && item.ready !== false));
  const runtimeDefaultLabel = runtimeRecommendation || runtimeDefaultVersion || runtimeStatusDefaultVersion
    ? formatRuntimeVersionTag(
        runtimeRecommendation?.version || runtimeDefaultVersion || runtimeStatusDefaultVersion,
        runtimeSection
      )
    : "";
  const runtimeAutomaticLabel = runtimeRecommendation ? "Recommended" : "Default";
  const runtimeVariantOptions = (Array.isArray(runtimeSection?.variants)
    ? runtimeSection.variants
    : []) as Array<{ id?: string; label?: string } & Record<string, any>>;
  const runtimeHasMultipleVariants = runtimeVariantOptions.length > 1;
  const runtimeDefaultVariantLabel = runtimeHasMultipleVariants
    ? runtimeVariantOptions.find(
        (opt: { id?: string; label?: string }) =>
          opt.id === runtimeSection?.defaultVariant
      )?.label ||
      runtimeSection?.defaultVariant ||
      ""
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
  const libsPatched = Boolean(libsStatus?.patched || libsStatus?.partial);
  const libOverrides =
    g.moduleData && typeof g.moduleData === "object"
      ? g.moduleData.libVersions || {}
      : {};
  const runtimeSchema = resolveRuntimeSettingsSchema(moduleInfo, g.runtimeId);
  const actionError = (actionId: string) => moduleActionError?.actionId === actionId ? moduleActionError.message : null;
  const toolActionIds = new Set(visibleModuleActionGroups.flatMap(group => group.actions));
  const otherActionError = moduleActionError && !["explainDetection", "removeAppQuarantine"].includes(moduleActionError.actionId) &&
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
          <GameIcon game={g} moduleInfo={moduleInfo} inspector />
          <div className="gameDetailsIdentityText">
            <h2 id="game-details-title" className="cardTitle" title={g.name}>{g.name}</h2>
            <div className="cardSubtitle">{g.moduleLabel || g.moduleShortLabel || g.moduleId}{detection.version ? ` · ${detection.version}` : ""}</div>
          </div>
        </div>
        {onClose && <button className="btn small iconOnly" onClick={onClose} title="Close details" aria-label="Close details"><XIcon /></button>}
      </div>
      <GameActions g={g} isRunning={Boolean(state.running?.[g.gamePath])} preparation={state.preparing?.[g.gamePath]} actions={actions} inspector />
      {g.launchNotices?.map((notice, index) => <div className="detailMeta gameLaunchNotice" role="status" key={index}>{notice}</div>)}
      <div className="gameDetails" tabIndex={0} aria-label={`${g.name} details`}>
        <div className="detailGrid">
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
                title="Reveal in Finder"
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
              <div className="detailLabel">App quarantine <HelpTip label="About app quarantine">Remove the download quarantine attribute if macOS reports this app as damaged.</HelpTip></div>
              <div className="detailValue">
                {moduleActionResults.removeAppQuarantine?.status && <div className="detailMeta">{moduleActionResults.removeAppQuarantine.status}</div>}
                <ErrorText error={actionError("removeAppQuarantine")} inline />
              </div>
              <div className="detailActions">
                <button className="btn small" disabled={Boolean(moduleActionBusy.removeAppQuarantine)}
                  onClick={() => onModuleAction(g.gamePath, "removeAppQuarantine")}>
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
            <button className="btn small iconOnly" disabled={Boolean(moduleActionBusy.explainDetection)}
              onClick={() => onModuleAction(g.gamePath, "explainDetection")}
              title="Refresh detection diagnostics" aria-label="Refresh detection diagnostics"><RefreshIcon /></button>
          </details>

          <h3 className="detailSectionHeading">{canLaunch ? "Launch" : "Runtime"}</h3>
          {canLaunch && <GameArguments key={`arguments:${g.gamePath}`} value={g.launchArguments || ""}
            onSave={value => actions.onSetLaunchArguments(g.gamePath, value)} />}
          <div className="detailRow detailControlRow">
            <div className="detailLabel">Runtime <RuntimeDescription moduleInfo={moduleInfo} runtimeId={g.runtimeId} /></div>
            <div className="detailActions">
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
            <div className="detailLabel">Network access <HelpTip label="About network access">{networkConfigurable
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
            <div className="detailLabel">Steam client on Play <HelpTip label="About Steam client on Play">Starting Steam connects to the Internet. Ask requests permission at Play when Steam is not running. Don't start launches the game without starting or waiting for Steam. Default follows Settings.</HelpTip></div>
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
                    value={runtimeVersionOverride}
                    onChange={e =>
                      onSetRuntimeData(g.gamePath, g.runtimeId,
                        runtimeInspectorVersionPatch(moduleInfo, g.runtimeId, runtimeManagerState, e.target.value))
                    }
                  >
                    <option value="" title={runtimeRecommendation?.version || runtimeStatusDefaultVersion || runtimeDefaultVersion || undefined}>{runtimeDefaultLabel ? `${runtimeAutomaticLabel} (${runtimeDefaultLabel})` : runtimeAutomaticLabel}</option>
                    {runtimeVersionChoices.map(v => (
                      <option key={v} value={v}>
                        {formatRuntimeVersionTag(v, runtimeSection)}
                      </option>
                    ))}
                  </Select>
                  {/* The menu already names the recommended version; a missing one installs from here. */}
                  {runtimeRecommendation && !runtimeRecommendationInstalled && runtimeManagerId && onInstallRuntime && <button
                    className="btn small"
                    title={`Install recommended version ${formatRuntimeVersionTag(runtimeRecommendation.version, runtimeSection)}`}
                    aria-label="Install recommended version"
                    onClick={() => void onInstallRuntime(runtimeManagerId, runtimeRecommendation.sectionId || runtimeSection?.id || runtimeSectionId || "default",
                      runtimeRecommendation.version, runtimeVariantOverride || runtimeSection?.defaultVariant || undefined)}
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
                      value={runtimeVariantOverride || ""}
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
                          <option key={variant.id} value={variant.id}>
                            {variant.label || variant.id}
                          </option>
                        )
                      )}
                    </Select>
                  </div>
                </div>
              )}
            </>
          )}

          </>}

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
                  disabled={libsPatchBusy}
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
                    libsPatchBusy || !libsAvailable
                  }
                  disableDisabled={libsPatchBusy}
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
                  disabled={cheatsPatchBusy}
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
                  enableDisabled={cheatsPatchBusy}
                  disableDisabled={cheatsPatchBusy}
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
            onAction={onModuleAction} onCancel={onCancelModuleAction} onRevealPath={onRevealToolPath} />
          <ErrorText error={otherActionError} inline />

          {canLaunch && <EffectsControls key={`effects:${g.gamePath}`} game={g} running={gameRunning}
            live={graphicsLive} warnings={g.graphicsWarnings}
            graphicsHost={moduleInfo?.runtime.entries?.[g.runtimeId]?.graphicsHost}
            visible={visible}
            onManageModels={() => openRuntimesManager("graphics-models")} />}

          <GameNotes key={`notes:${g.gameId || g.gamePath}`} notes={g.notes || ""}
            onSave={notes => actions.onSaveGameNotes(g.gamePath, notes)} />
        </div>

      </div>
    </>
  );
});

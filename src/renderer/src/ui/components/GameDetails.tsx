import React, { memo, useEffect, useRef } from "react";
import type {
  CheatsPatchStatus, LauncherState, LibsPatchStatus, ModuleManifest,
  ModuleUiAction, ModuleUiGroup, RecentGame, RuntimeId, RuntimeStatusEntry
} from "../types";
import {
  compareSemver, defaultSaveDirForGame, formatRuntimeLabel,
  formatRuntimeOption, formatRuntimeVersionTag, formatSaveDirDisplay,
  formatSettingLabel, formatUserError, getByPath, matchesAnyCondition, resolveRuntimeManagerId,
  resolveRuntimeSection, resolveRuntimeSectionId, resolveRuntimeSections,
  resolveRuntimeSettingsSchema
} from "../ui-helpers";
import { FolderIcon, RefreshIcon, SettingsIcon, XIcon } from "../icons";
import type { LibraryActions } from "./library-actions";
import { GameNotes } from "./GameNotes";
import { GameActions } from "./GameActions";
import { GameIcon } from "./GameIcon";
import { HelpTip } from "./HelpTip";
import { ModuleTools } from "./ModuleTools";
import { presentModuleFields } from "./module-tools-model";
import { isRuntimeManageable } from "./runtime-tabs-model";

export type GameDetailsState = Pick<LauncherState, "modules" | "moduleStates" | "runtimeManagers" | "running" | "preparing">;

type GameDetailsProps = {
  g: RecentGame;
  state: GameDetailsState;
  moduleInfo: ModuleManifest | null;
  actions: LibraryActions;
  cheatsStatus: CheatsPatchStatus | null;
  libsStatus: LibsPatchStatus | null;
  runtimeStatusEntry: RuntimeStatusEntry | null;
  cheatsPatchBusy: boolean;
  libsPatchBusy: boolean;
  moduleActionResults: Record<string, any>;
  moduleActionBusy: Record<string, boolean>;
  moduleActionError: string | null;
  onClose?: () => void;
};

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
    { label: "Engine", value: selectedModule?.label || game.moduleLabel || selectedId },
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
  g, state, moduleInfo, actions, cheatsStatus, libsStatus, runtimeStatusEntry,
  cheatsPatchBusy, libsPatchBusy, moduleActionResults, moduleActionBusy, moduleActionError, onClose
}: GameDetailsProps) {
  const {
    onReveal, onPickSaveDir, onResetSaveDir, onSetRuntime, onOpenRuntimeSettings,
    onSetRuntimeData, openRuntimesManager, refreshLibsPatchStatus, onPatchLibs,
    onUnpatchLibs, onSetGameLibVersion, refreshCheatsPatchStatus,
    onPatchCheatsIntoGame, onUnpatchCheatsFromGame, onModuleAction
  } = actions;
  const moduleState = state.moduleStates?.[g.moduleId] || null;
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
  const infoFields = presentModuleFields(g, (moduleUi?.infoFields || []).filter(field => !matchesAnyCondition(g, field.hiddenWhen)));
  const hasModuleTools = visibleModuleActionGroups.some(group => group.actions.some(id => {
    const action = moduleActionsById.get(id);
    return action && !matchesAnyCondition(g, action.hiddenWhen);
  }));
  const hasSaveLocation = g.moduleSupports?.saveLocation === true;
  const saveDir = hasSaveLocation
    ? g.saveDirOverride || defaultSaveDirForGame(g)
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
  const runtimeVersionOverride = g.runtimeData?.[g.runtimeId]?.version || "";
  const runtimeVariantOverride = g.runtimeData?.[g.runtimeId]?.variant || "";
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
  const libsPatched = Boolean(libsStatus?.patched || libsStatus?.partial);
  const libOverrides =
    g.moduleData && typeof g.moduleData === "object"
      ? g.moduleData.libVersions || {}
      : {};
  const runtimeSchema = resolveRuntimeSettingsSchema(moduleInfo, g.runtimeId);
  const detectionReport = moduleActionResults.explainDetection;
  const detection = detectionDisplay(g, moduleInfo, state, detectionReport);
  const requestedDetection = useRef(false);
  useEffect(() => {
    if (requestedDetection.current || detectionReport || moduleActionBusy.explainDetection) return;
    requestedDetection.current = true;
    void onModuleAction(g.gamePath, "explainDetection");
  }, [g.gamePath, detectionReport, moduleActionBusy.explainDetection, onModuleAction]);

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
      <div className="gameDetails" tabIndex={0} aria-label={`${g.name} details`}>
        <div className="detailGrid">
          <h3 className="detailSectionHeading">Files</h3>
          <div className="detailRow">
            <div className="detailLabel">Game</div>
            <div className="detailValue mono ellipsis" title={g.gamePath}>
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

              <details className="detectionDiagnostics detailDisclosure">
                <summary>Details</summary>
                {detection.rows.map(row => <div className="detailRow" key={`detection-${row.label}`}>
                  <div className="detailLabel">{row.label}</div>
                  <div className={["detailValue", row.value === "Unknown" ? "dim" : ""].filter(Boolean).join(" ")} title={row.value}>{row.value}</div>
                </div>)}
                {infoFields.map(field => {
                  const raw = getByPath(g, field.key);
                  return <div className="detailRow" key={`info-${field.key}`}>
                    <div className="detailLabel">{field.label}</div>
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
                <button className="btn small iconOnly" disabled={Boolean(moduleActionBusy.explainDetection)}
                  onClick={() => onModuleAction(g.gamePath, "explainDetection")}
                  title="Refresh detection diagnostics" aria-label="Refresh detection diagnostics"><RefreshIcon /></button>
              </details>

          <GameNotes key={g.gameId || g.gamePath} notes={g.notes || ""}
            onSave={notes => actions.onSaveGameNotes(g.gamePath, notes)} />

          {hasAppBundle && (
            <div className="detailRow detailToolRow">
              <div className="detailLabel">App quarantine <HelpTip label="About app quarantine">Remove the download quarantine attribute if macOS reports this app as damaged.</HelpTip></div>
              <div className="detailValue">
                {moduleActionResults.removeAppQuarantine?.status && <div className="detailMeta">{moduleActionResults.removeAppQuarantine.status}</div>}
              </div>
              <div className="detailActions">
                <button className="btn small" disabled={Boolean(moduleActionBusy.removeAppQuarantine)}
                  onClick={() => onModuleAction(g.gamePath, "removeAppQuarantine")}>
                  Remove quarantine
                </button>
              </div>
            </div>
          )}

          {hasSaveLocation && (
            <div className="detailRow">
              <div className="detailLabel">Saves</div>
              <div className="detailValue mono ellipsis" title={saveDir}>
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

          <h3 className="detailSectionHeading">Runtime</h3>
          <div className="detailRow detailControlRow">
            <div className="detailLabel">Runtime</div>
            <div className="detailActions">
              <select aria-label="Runtime"
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
                <div className="detailRow detailControlRow">
                  <div className="detailLabel">{runtimeSectionOverrideLabel}</div>
                  <div className="detailActions">
                    <select aria-label={runtimeSectionOverrideLabel}
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

              <div className="detailRow detailControlRow">
                <div className="detailLabel">Version</div>
                <div className="detailActions">
                  <select aria-label={runtimeVersionLabelText}
                    className="input"
                    value={runtimeVersionOverride}
                    onChange={e =>
                      onSetRuntimeData(g.gamePath, g.runtimeId, {
                        version: e.target.value || null
                      })
                    }
                  >
                    <option value="">{runtimeDefaultLabel ? `Default (${runtimeDefaultLabel})` : "Default"}</option>
                    {runtimeInstalledVersions.map(v => (
                      <option key={v} value={v}>
                        {formatRuntimeVersionTag(v, runtimeSection)}
                      </option>
                    ))}
                  </select>
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
                    <select aria-label="Runtime variant"
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
                  </div>
                </div>
              )}
            </>
          )}

          {(libsDependencies.length > 0 || canPatchCheats) && <h3 className="detailSectionHeading">Patches</h3>}
          {libsDependencies.length > 0 && (
            <div className="detailRow">
              <div className="detailLabel">Libraries</div>
              <div className="detailValue">
                {(() => {
                  if (!libsAvailable) {
                    return <span className="dim">No managed versions</span>;
                  }
                  if (!libsStatus) return null;
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
              const defaultLabel = defaultVersion
                ? defaultVersion.label
                : "No default";
              return (
                <div className="detailRow detailControlRow" key={dep.id}>
                  <div className="detailLabel">{dep.label}</div>
                  <div className="detailActions">
                    <select aria-label={dep.label}
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
                  if (!cheatsStatus) return null;
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

          {hasModuleTools && <h3 className="detailSectionHeading">Tools</h3>}
          <ModuleTools game={g} groups={visibleModuleActionGroups} actions={moduleActions}
            results={moduleActionResults} busy={moduleActionBusy} onAction={onModuleAction} />

          {moduleActionError && (
            <div className="detailRow">
              <div className="detailLabel">Actions</div>
              <div className="detailValue">
                <span className="badge badgeDanger">
                  Error: {formatUserError(moduleActionError)}
                </span>
              </div>
              <div className="detailActions" />
            </div>
          )}

        </div>

      </div>
    </>
  );
});

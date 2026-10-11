import React, { useEffect, useMemo, useRef, useState } from "react";
import type { DownloadTask, RuntimeManagerState, RuntimeUiState } from "../types";
import {
  formatDownloadPercent,
  formatRuntimeVersionTag,
  formatUserError,
  isRuntimeVersionInstalled,
  resolveRuntimeNotice,
  resolveRuntimeSections,
  sortInstalled
} from "../ui-helpers";
import { DownloadIcon, RefreshIcon, XIcon } from "../icons";
import { groupRuntimeManagers, resolveRuntimeTabSelection, runtimeGroupSections,
  runtimeTabMovement, runtimeCatalogPresentation, runtimeSummaryPresentation, runtimeManagementPresentation,
  runtimeRemovalPresentation, isRuntimeIncluded } from "./runtime-tabs-model";
import type { RuntimeTabGroup, RuntimeTabSection } from "./runtime-tabs-model";
import { HelpTip } from "./HelpTip";
import { LauncherViewHeader } from "./LauncherViewHeader";
import { ScrollableTabStrip } from "./ScrollableTabStrip";

const EMPTY_RUNTIME_UI: RuntimeUiState[string] = {
  remoteOpen: {},
  installVersion: {},
  installVariant: {},
  installedSort: {},
  error: null
};

type RuntimesViewProps = {
  runtimeManagers: RuntimeManagerState[];
  runtimeUi: RuntimeUiState;
  runtimeManagerId: string | null;
  runtimeSectionId: string | null;
  downloadTasks: DownloadTask[];
  downloadsOpen: boolean;
  setDownloadsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setRuntimeManagerId: React.Dispatch<React.SetStateAction<string | null>>;
  setRuntimeSectionId: React.Dispatch<React.SetStateAction<string | null>>;
  updateRuntimeUiSection: (
    managerId: string,
    sectionId: string,
    key: "remoteOpen" | "installVersion" | "installVariant" | "installedSort",
    value: any
  ) => void;
  onRuntimeRefresh: (
    managerId: string,
    sectionId: string,
    options?: { latestOnly?: boolean }
  ) => void;
  onRuntimeInstall: (
    managerId: string,
    sectionId: string,
    version: string,
    variant?: string
  ) => void;
  onRuntimeImport?: (managerId: string, sectionId: string) => void;
  onRuntimeSetupAction?: (managerId: string, sectionId: string, setupActionId: string, toolVersion?: string) => void;
  onRuntimeInstalledAction?: (managerId: string, sectionId: string, version: string, installedActionId: string) => void;
  onRuntimeSetDefault: (
    managerId: string,
    sectionId: string,
    version: string | null,
    variant?: string
  ) => void;
  onRuntimeUninstall: (
    managerId: string,
    sectionId: string,
    install: Record<string, any>
  ) => void;
  onCancelDownload: (id: string) => void;
  onOpenSource?: (url: string) => void;
};

export function RuntimesView({
  runtimeManagers,
  runtimeUi,
  runtimeManagerId,
  runtimeSectionId,
  downloadTasks,
  downloadsOpen,
  setDownloadsOpen,
  setRuntimeManagerId,
  setRuntimeSectionId,
  updateRuntimeUiSection,
  onRuntimeRefresh,
  onRuntimeInstall,
  onRuntimeImport,
  onRuntimeSetupAction,
  onRuntimeInstalledAction,
  onRuntimeSetDefault,
  onRuntimeUninstall,
  onCancelDownload,
  onOpenSource
}: RuntimesViewProps) {
  const runtimeGroups = useMemo(() => groupRuntimeManagers(runtimeManagers), [runtimeManagers]);
  const selection = useMemo(() => resolveRuntimeTabSelection(runtimeGroups, runtimeManagerId,
    runtimeSectionId, resolveRuntimeSections), [runtimeGroups, runtimeManagerId, runtimeSectionId]);
  const activeRuntimeGroup = selection.group;
  const activeRuntimeChoices = selection.sections;
  const activeRuntimeChoice = selection.section;
  const activeRuntimeManager = activeRuntimeChoice?.manager || null;
  const activeRuntimeSection = activeRuntimeChoice?.section || null;
  const managementPresentation = runtimeManagementPresentation(activeRuntimeSection);
  const remembered = useRef(new Map<string, { managerId: string; sectionId: string }>());
  const [setupVersions, setSetupVersions] = useState<Record<string, string>>({});
  const runtimeNotice = resolveRuntimeNotice(activeRuntimeSection);
  const activeRuntimeSectionId = activeRuntimeChoice?.sectionId || null;
  const activeRuntimeUi = activeRuntimeManager
    ? runtimeUi[activeRuntimeManager.id] || EMPTY_RUNTIME_UI
    : EMPTY_RUNTIME_UI;

  useEffect(() => {
    if (!activeRuntimeManager) return;
    if (!activeRuntimeSectionId) return;
    if (runtimeManagerId !== activeRuntimeManager.id) setRuntimeManagerId(activeRuntimeManager.id);
    if (runtimeSectionId !== activeRuntimeSectionId) setRuntimeSectionId(activeRuntimeSectionId);
    if (activeRuntimeGroup) remembered.current.set(activeRuntimeGroup.id,
      { managerId: activeRuntimeManager.id, sectionId: activeRuntimeSectionId });
  }, [activeRuntimeManager, activeRuntimeGroup, activeRuntimeSectionId, runtimeManagerId, runtimeSectionId, setRuntimeManagerId, setRuntimeSectionId]);
  function selectSection(choice: RuntimeTabSection) {
    setRuntimeManagerId(choice.managerId);
    setRuntimeSectionId(choice.sectionId);
  }
  function selectGroup(group: RuntimeTabGroup) {
    const choices = runtimeGroupSections(group, resolveRuntimeSections);
    const prior = remembered.current.get(group.id);
    const next = choices.find(choice => choice.managerId === prior?.managerId && choice.sectionId === prior?.sectionId) || choices[0];
    if (next) selectSection(next);
  }
  function moveTab(event: React.KeyboardEvent<HTMLButtonElement>, index: number, count: number, select: (index: number) => void) {
    const next = runtimeTabMovement(event.key, index, count);
    if (next === null) return;
    event.preventDefault(); select(next);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus({ preventScroll: true });
  }
  const hasAvailableVersions = (activeRuntimeSection?.catalog?.versions?.length || 0) > 0;

  const activeRuntimeRemoteOpen =
    activeRuntimeManager && activeRuntimeSectionId
      ? Boolean(activeRuntimeUi.remoteOpen[activeRuntimeSectionId])
      : false;
  const requestedRuntimeVersion =
    activeRuntimeManager && activeRuntimeSectionId
      ? activeRuntimeUi.installVersion[activeRuntimeSectionId] || activeRuntimeSection?.catalog?.recommendedVersion || activeRuntimeSection?.catalog?.versions?.[0] || ""
      : "";
  const availableVersions: string[] = activeRuntimeSection?.catalog?.versions || [];
  const activeRuntimeInstallVersion = availableVersions.includes(requestedRuntimeVersion)
    ? requestedRuntimeVersion : availableVersions[0] || "";
  const activeRuntimeInstallVariant =
    activeRuntimeManager && activeRuntimeSectionId
      ? activeRuntimeUi.installVariant[activeRuntimeSectionId] || ""
      : "";
  const activeRuntimeInstalledSort =
    activeRuntimeManager && activeRuntimeSectionId
      ? activeRuntimeUi.installedSort[activeRuntimeSectionId] || "default"
      : "default";
  const activeRuntimeSupportsLatestOnly = Boolean(
    activeRuntimeSection?.catalog?.supportsLatestOnly
  );
  const pendingAction = activeRuntimeSectionId ? activeRuntimeUi.pendingActions?.[activeRuntimeSectionId] : null;
  const refreshing = pendingAction === "refreshCatalog" || activeRuntimeSection?.catalog?.status === "loading";
  const runtimeBusy = Boolean(pendingAction) || refreshing;
  const activeRuntimeRefreshLabel = refreshing ? managementPresentation.refreshingLabel : managementPresentation.refreshLabel;
  const activeRuntimeRefreshAllLabel = refreshing ? "Refreshing all versions" : "All versions";
  const runtimeMessage = activeRuntimeSectionId ? activeRuntimeUi.messages?.[activeRuntimeSectionId] : null;
  const setupActions = activeRuntimeSection?.setupActions || activeRuntimeManager?.setupActions || [];
  const activeRuntimeInstalled = Array.isArray(activeRuntimeSection?.installed)
    ? activeRuntimeSection.installed
    : [];
  const activeRuntimeVariants = Array.isArray(activeRuntimeSection?.variants)
    ? activeRuntimeSection.variants
    : [];
  const activeRuntimeHasVariants = activeRuntimeVariants.length > 0;
  const activeRuntimeHasMultipleVariants = activeRuntimeVariants.length > 1;
  const activeRuntimeResolvedInstallVariant = activeRuntimeHasVariants
    ? activeRuntimeInstallVariant ||
      activeRuntimeSection?.defaultVariant ||
      activeRuntimeVariants[0]?.id ||
      ""
    : "";
  const catalogMetadata = runtimeCatalogPresentation(activeRuntimeSection?.catalog, activeRuntimeInstallVersion, activeRuntimeResolvedInstallVariant);
  const catalogPresentation = { ...catalogMetadata, included: catalogMetadata.included || activeRuntimeInstalled.some(inst =>
    inst.version === activeRuntimeInstallVersion && isRuntimeIncluded(inst) &&
    (!activeRuntimeHasVariants || inst.variant === activeRuntimeResolvedInstallVariant)) };
  const summaryPresentation = runtimeSummaryPresentation(activeRuntimeSection, activeRuntimeInstallVersion, runtimeMessage);
  const variantRequirement = activeRuntimeSection?.catalog?.versionRequirements?.[activeRuntimeInstallVersion]?.variants?.[activeRuntimeResolvedInstallVariant];
  const activeRuntimeInstalledSorted = sortInstalled(
    activeRuntimeInstalled,
    activeRuntimeInstalledSort,
    activeRuntimeSection?.defaultVersion || null,
    activeRuntimeHasVariants ? activeRuntimeSection?.defaultVariant || null : null
  );
  const activeRuntimeSelectedInstalled = isRuntimeVersionInstalled(
    activeRuntimeInstalled,
    activeRuntimeInstallVersion,
    activeRuntimeResolvedInstallVariant,
    activeRuntimeHasVariants
  );
  const activeRuntimeCanInstall = activeRuntimeSection?.catalog?.installable !== false &&
    variantRequirement?.installable !== false &&
    (!Array.isArray(activeRuntimeSection?.catalog?.installableVersions) ||
      activeRuntimeSection.catalog.installableVersions.includes(activeRuntimeInstallVersion));
  const activeRuntimeDownloads = useMemo(() => {
    if (!activeRuntimeManager?.id || !activeRuntimeSectionId) return [];
    return downloadTasks.filter(
      task =>
        task.managerId === activeRuntimeManager.id &&
        task.sectionId === activeRuntimeSectionId
    );
  }, [downloadTasks, activeRuntimeManager?.id, activeRuntimeSectionId]);
  const activeRuntimeSelectedDownloading = activeRuntimeDownloads.some(task => {
    if (!activeRuntimeInstallVersion) return false;
    if (task.version !== activeRuntimeInstallVersion) return false;
    if (!activeRuntimeHasVariants) return true;
    return task.variant === activeRuntimeResolvedInstallVariant;
  });
  const activeRuntimeDownloadSummary = useMemo(() => {
    if (activeRuntimeDownloads.length === 0) return null;
    if (activeRuntimeDownloads.length > 1) {
      return `Downloading ${activeRuntimeDownloads.length} items`;
    }
    const task = activeRuntimeDownloads[0];
    const percent = formatDownloadPercent(task);
    const label = task.detail || (task.version ? `v${task.version}` : task.label);
    return percent !== null ? `Downloading ${label} · ${percent}%` : `Downloading ${label}`;
  }, [activeRuntimeDownloads]);
  const activeRuntimeDefaultVariantLabel = activeRuntimeHasMultipleVariants
    ? activeRuntimeVariants.find(
        (variant: any) => variant.id === activeRuntimeSection?.defaultVariant
      )?.label || activeRuntimeSection?.defaultVariant || ""
    : "";
  const activeRuntimeSubtitleParts = [] as string[];
  if (summaryPresentation.showDefaultVersion && activeRuntimeSection?.defaultVersion) {
    activeRuntimeSubtitleParts.push(
      `Default ${formatRuntimeVersionTag(
        activeRuntimeSection.defaultVersion,
        activeRuntimeSection
      )}`
    );
  }
  if (summaryPresentation.showDefaultVersion && activeRuntimeDefaultVariantLabel) {
    activeRuntimeSubtitleParts.push(activeRuntimeDefaultVariantLabel);
  }
  const activeRuntimeSubtitle = activeRuntimeSubtitleParts.join(" · ");
  const showRuntimeIdentity = runtimeGroups.length <= 1;

  return (
    <main className="launcherView runtimesView" aria-labelledby="runtimes-title">
        <div className="runtimeViewHeader">
          <LauncherViewHeader title="Runtimes" titleId="runtimes-title">
              <div className="runtimeDownloadMenu">
                <button
                  className="btn iconOnly runtimeDownloadToggle"
                  onClick={() => setDownloadsOpen(open => !open)}
                  title="Downloads"
                  aria-label="Downloads"
                >
                  <DownloadIcon />
                  {downloadTasks.length > 0 && (
                    <span className="runtimeDownloadBadge">
                      {downloadTasks.length}
                    </span>
                  )}
                </button>
                {downloadsOpen && (
                  <div className="runtimeDownloadDropdown" role="menu">
                    {downloadTasks.length === 0 ? (
                      <div className="runtimeDownloadEmpty">
                        No active downloads.
                      </div>
                    ) : (
                      downloadTasks.map(task => {
                        const percent = formatDownloadPercent(task);
                        const label =
                          task.detail || (task.version ? `v${task.version}` : task.label);
                        return (
                          <div key={task.id} className="runtimeDownloadItem">
                            <div className="runtimeDownloadMeta">
                              <div className="runtimeDownloadLabel">{task.label}</div>
                              <div className="runtimeDownloadDetail">{label}</div>
                            </div>
                            <div className="runtimeDownloadRow">
                              <div
                                className={[
                                  "runtimeDownloadBar",
                                  percent == null ? "indeterminate" : ""
                                ]
                                  .filter(Boolean)
                                  .join(" ")}
                              >
                                <div
                                  className="runtimeDownloadBarFill"
                                  style={
                                    percent == null
                                      ? { width: "40%" }
                                      : { width: `${percent}%` }
                                  }
                                />
                              </div>
                              {percent != null && (
                                <div className="runtimeDownloadPercent">{percent}%</div>
                              )}
                              <button
                                className="btn iconOnly danger"
                                title="Cancel download"
                                aria-label="Cancel download"
                                onClick={() => onCancelDownload(task.id)}
                              >
                                <XIcon size="0.9em" />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
          </LauncherViewHeader>
          {runtimeGroups.length > 1 && <ScrollableTabStrip label="Runtimes" className="runtimeGroupTabs" tabsClassName="runtimeTabs"
            selectedTabId={activeRuntimeGroup ? `runtime-group-tab-${activeRuntimeGroup.id}` : null}>
            {runtimeGroups.map((group, index) => {
              const active = activeRuntimeGroup?.id === group.id;
              return <button key={group.id} type="button" id={`runtime-group-tab-${group.id}`} role="tab" aria-selected={active}
                aria-controls={`runtime-group-panel-${group.id}`} tabIndex={active ? 0 : -1}
                className={`runtimeTab${active ? " active" : ""}`} onClick={() => selectGroup(group)}
                onKeyDown={event => moveTab(event, index, runtimeGroups.length, next => selectGroup(runtimeGroups[next]))}>
                {group.label}
              </button>;
            })}
          </ScrollableTabStrip>}
          {activeRuntimeChoices.length > 1 && <ScrollableTabStrip label={`${activeRuntimeGroup?.label || "Runtime"} sections`}
            className="runtimeLineTabs" tabsClassName="runtimeTabs"
            selectedTabId={activeRuntimeChoice ? `runtime-section-tab-${encodeURIComponent(activeRuntimeChoice.id)}` : null}>
            {activeRuntimeChoices.map((choice, index) => {
              const active = activeRuntimeChoice?.id === choice.id;
              return <button key={choice.id} type="button" id={`runtime-section-tab-${encodeURIComponent(choice.id)}`} role="tab" aria-selected={active}
                aria-controls={`runtime-panel-${choice.managerId}-${choice.sectionId}`} tabIndex={active ? 0 : -1}
                className={`runtimeTab${active ? " active" : ""}`} onClick={() => selectSection(choice)}
                onKeyDown={event => moveTab(event, index, activeRuntimeChoices.length, next => selectSection(activeRuntimeChoices[next]))}>
                {choice.label}
              </button>;
            })}
          </ScrollableTabStrip>}
        </div>

        <div className="launcherViewBody runtimeViewBody" role="tabpanel" id={`runtime-group-panel-${activeRuntimeGroup?.id || "empty"}`}
          aria-labelledby={runtimeGroups.length > 1 && activeRuntimeGroup ? `runtime-group-tab-${activeRuntimeGroup.id}` : undefined}
          aria-label={runtimeGroups.length <= 1 ? activeRuntimeGroup?.label || "Runtime" : undefined}>
          {activeRuntimeManager && activeRuntimeSection ? (
            <div
              className="runtimeTabPanel"
              role={activeRuntimeChoices.length > 1 ? "tabpanel" : undefined}
              id={`runtime-panel-${activeRuntimeManager.id}-${activeRuntimeSection.id}`}
              aria-labelledby={activeRuntimeChoices.length > 1 && activeRuntimeChoice ? `runtime-section-tab-${encodeURIComponent(activeRuntimeChoice.id)}` : undefined}
            >
              <div className="runtimePanel">
                {(showRuntimeIdentity || activeRuntimeSubtitle || activeRuntimeDownloadSummary) && <div className="runtimePanelHeader">
                  <div>
                    {showRuntimeIdentity && <div className="runtimePanelTitle">{activeRuntimeGroup?.label || "Runtime"}</div>}
                    {activeRuntimeSubtitle && <div className="runtimePanelSubtitle">{activeRuntimeSubtitle}</div>}
                  </div>
                  <div className="runtimePanelHeaderActions">
                    {activeRuntimeDownloadSummary && (
                      <div className="chip">{activeRuntimeDownloadSummary}</div>
                    )}
                  </div>
                </div>}

                {activeRuntimeUi.error && (
                  <div className="error runtimeError">Error: {formatUserError(activeRuntimeUi.error)}</div>
                )}

                <div className="runtimeSectionCard">
                  <div className="runtimeSectionHeader">
                    <div>
                      <div className="runtimeSectionTitle">{managementPresentation.title}<HelpTip label={`About ${managementPresentation.title.toLowerCase()}`}>
                        <div className="runtimeCatalogDetails">
                          {catalogPresentation.sourceUrl && <div>Source:{" "}
                            {onOpenSource ? <a className="runtimeSourceLink" href={catalogPresentation.sourceUrl} title={catalogPresentation.sourceUrl}
                              onClick={event => { event.preventDefault(); onOpenSource(catalogPresentation.sourceUrl!); }}>{catalogPresentation.sourceLabel}</a>
                              : <span title={catalogPresentation.sourceUrl}>{catalogPresentation.sourceLabel}</span>}
                          </div>}
                          <div>{summaryPresentation.versionCount} {managementPresentation.local
                            ? summaryPresentation.versionCount === 1 ? "application" : "applications"
                            : summaryPresentation.versionCount === 1 ? "version" : "versions"}
                            {summaryPresentation.includedCount > 0 && ` · ${summaryPresentation.includedCount} included`}
                            {!managementPresentation.local && summaryPresentation.installedCount > 0 && ` · ${summaryPresentation.installedCount} installed`}
                          </div>
                          {summaryPresentation.checkedAt && <div>Last checked {new Date(summaryPresentation.checkedAt).toLocaleString()}</div>}
                          {!summaryPresentation.checkedAt && summaryPresentation.actionDetail && <div>{summaryPresentation.actionDetail}</div>}
                          {catalogPresentation.installReason && <div>{catalogPresentation.installReason}</div>}
                          {catalogPresentation.installLabel === "Build" && catalogPresentation.installHelpUrl && onOpenSource &&
                            <a className="runtimeSourceLink" href={catalogPresentation.installHelpUrl} title={catalogPresentation.installHelpUrl}
                              onClick={event => { event.preventDefault(); onOpenSource(catalogPresentation.installHelpUrl!); }}>Setup instructions</a>}
                          {runtimeNotice && <div className="runtimeNotice">
                            <div className="runtimeNoticeTitle">{runtimeNotice.title}</div>
                            {runtimeNotice.lines.map((line, index) => <div key={`${runtimeNotice.title}-${index}`}
                              className={["runtimeNoticeLine", line.mono ? "mono" : ""].filter(Boolean).join(" ")}>
                              {line.text}
                            </div>)}
                          </div>}
                        </div>
                      </HelpTip></div>
                      {!activeRuntimeCanInstall && !catalogPresentation.included && !activeRuntimeSelectedInstalled && catalogPresentation.installReason &&
                        <div className="runtimeSectionHint">{catalogPresentation.installReason}</div>}
                    </div>
                    <div className="runtimePanelHeaderActions">
                      <button
                        className={`btn iconOnly runtimeRefresh${refreshing ? " refreshing" : ""}`}
                        disabled={runtimeBusy}
                        aria-busy={refreshing}
                        onClick={() => {
                          updateRuntimeUiSection(
                            activeRuntimeManager.id,
                            activeRuntimeSection.id,
                            "remoteOpen",
                            true
                          );
                          onRuntimeRefresh(
                            activeRuntimeManager.id,
                            activeRuntimeSection.id,
                            activeRuntimeSupportsLatestOnly ? { latestOnly: true } : {}
                          );
                        }}
                        title={activeRuntimeRefreshLabel}
                        aria-label={activeRuntimeRefreshLabel}
                      >
                        <RefreshIcon />
                      </button>
                      {activeRuntimeSupportsLatestOnly && (
                        <button
                          className="btn"
                          disabled={runtimeBusy}
                          onClick={() => {
                            updateRuntimeUiSection(
                              activeRuntimeManager.id,
                              activeRuntimeSection.id,
                              "remoteOpen",
                              true
                            );
                            onRuntimeRefresh(
                              activeRuntimeManager.id,
                              activeRuntimeSection.id,
                              { latestOnly: false }
                            );
                          }}
                          title={activeRuntimeRefreshAllLabel}
                          aria-label={activeRuntimeRefreshAllLabel}
                        >
                          All versions
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="runtimeSectionBody">
                    {(refreshing || (!managementPresentation.local && !hasAvailableVersions) || summaryPresentation.latestAvailableVersion || summaryPresentation.latestInstalledVersion) && <div className="runtimeMeta">
                      {refreshing ? (
                        <span className="dim" role="status">{managementPresentation.refreshingLabel}…</span>
                      ) : summaryPresentation.latestAvailableVersion ? (
                        <span className="dim">
                          Latest available{" "}
                          {formatRuntimeVersionTag(
                            summaryPresentation.latestAvailableVersion,
                            activeRuntimeSection
                          )}
                        </span>
                      ) : !hasAvailableVersions ? (
                        <span className="dim">No versions loaded</span>
                      ) : null}
                      {!refreshing && summaryPresentation.latestInstalledVersion && (
                        <span className="dim">
                          Latest installed{" "}
                          {formatRuntimeVersionTag(
                            summaryPresentation.latestInstalledVersion,
                            activeRuntimeSection
                          )}
                        </span>
                      )}
                    </div>}
                    {summaryPresentation.actionMessage && <div className="dim runtimeActionStatus" role="status">{summaryPresentation.actionMessage}</div>}

                    {activeRuntimeSection.catalog?.status === "error" &&
                      activeRuntimeSection.catalog?.error && (
                        <div className="dim">
                          Version refresh failed: {formatUserError(activeRuntimeSection.catalog.error)}
                        </div>
                      )}

                    {!managementPresentation.local && (activeRuntimeRemoteOpen || hasAvailableVersions) && (
                      <div className="runtimeRemote">
                        <div className="runtimeRemoteField">
                          <div className="fieldLabel">Version</div>
                          <select
                            className="input"
                            value={activeRuntimeInstallVersion}
                            disabled={
                              !activeRuntimeSection.catalog?.versions ||
                              activeRuntimeSection.catalog.versions.length === 0
                            }
                            onChange={e =>
                              updateRuntimeUiSection(
                                activeRuntimeManager.id,
                                activeRuntimeSection.id,
                                "installVersion",
                                e.target.value
                              )
                            }
                          >
                            {activeRuntimeSection.catalog?.versions &&
                            activeRuntimeSection.catalog.versions.length > 0 ? (
                              activeRuntimeSection.catalog.versions.map((v: string) => {
                                const installed = isRuntimeVersionInstalled(
                                  activeRuntimeInstalled,
                                  v,
                                  activeRuntimeResolvedInstallVariant,
                                  activeRuntimeHasVariants
                                );
                                return (
                                  <option key={v} value={v}>
                                    {formatRuntimeVersionTag(v, activeRuntimeSection)}
                                    {installed ? (activeRuntimeInstalled.some(inst => inst.version === v && isRuntimeIncluded(inst) &&
                                      (!activeRuntimeHasVariants || inst.variant === activeRuntimeResolvedInstallVariant)) ? " [Included]" : " [Installed]") : ""}
                                  </option>
                                );
                              })
                            ) : (
                              <option value="">No versions available</option>
                            )}
                          </select>
                        </div>
                        {activeRuntimeHasMultipleVariants && (
                          <div className="runtimeRemoteField">
                            <div className="fieldLabel">Variant</div>
                            <select
                              className="input"
                              value={activeRuntimeResolvedInstallVariant}
                              onChange={e =>
                                updateRuntimeUiSection(
                                  activeRuntimeManager.id,
                                  activeRuntimeSection.id,
                                  "installVariant",
                                  e.target.value
                                )
                              }
                            >
                              {activeRuntimeVariants.map((variant: any) => (
                                <option key={variant.id} value={variant.id}>
                                  {variant.label || variant.id}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {!catalogPresentation.included && <button
                          className="btn primary"
                          disabled={
                            !activeRuntimeCanInstall || !activeRuntimeInstallVersion || Boolean(pendingAction) ||
                            activeRuntimeSelectedInstalled ||
                            activeRuntimeSelectedDownloading
                          }
                          title={!activeRuntimeCanInstall ? catalogPresentation.installReason || "This runtime version is unavailable for installation." : undefined}
                          onClick={() => {
                            onRuntimeInstall(
                              activeRuntimeManager.id,
                              activeRuntimeSection.id,
                              activeRuntimeInstallVersion,
                              activeRuntimeResolvedInstallVariant || undefined
                            );
                          }}
                        >
                          {catalogPresentation.installLabel}
                        </button>}
                      </div>
                    )}
                    {activeRuntimeSection.catalog?.importable && onRuntimeImport && <div className="runtimeImport">
                      <button className="btn" disabled={Boolean(pendingAction)}
                        onClick={() => onRuntimeImport(activeRuntimeManager.id, activeRuntimeSection.id)}>
                        {pendingAction === "import" ? managementPresentation.importBusyLabel : activeRuntimeSection.catalog.importLabel || "Import runtime…"}
                      </button>
                      {activeRuntimeSection.catalog?.importDescription && <HelpTip label="About importing runtimes">{activeRuntimeSection.catalog.importDescription}</HelpTip>}
                    </div>}
                    {setupActions.length > 0 && onRuntimeSetupAction && <div className="runtimeSetup">
                      {setupActions.map((setup: Record<string, any>) => {
                        const key = JSON.stringify([activeRuntimeManager.id, activeRuntimeSection.id, setup.id]);
                        const selected = setup.versions?.includes(setupVersions[key]) ? setupVersions[key] : setup.selectedVersion || setup.version;
                        const installed = setup.installed && (!setup.installedVersion || setup.installedVersion === selected);
                        const versionInstalled = installed || setup.installedVersions?.includes(selected);
                        return <div className="runtimeSetupRow" key={setup.id}>
                        <div>
                          <div>{setup.toolLabel || setup.label}{installed ? " · Installed" : ""}
                            {setup.description && <HelpTip label={`About ${setup.toolLabel || setup.label}`}>{setup.description}</HelpTip>}</div>
                          {setup.versions?.length > 0 ? <select className="input inputSmall" aria-label={`${setup.toolLabel || setup.label} version`}
                            value={selected} disabled={Boolean(pendingAction)} onChange={event => setSetupVersions(current => ({ ...current, [key]: event.target.value }))}>
                            {setup.versions.map((version: string) => <option key={version} value={version}>{setup.versionLabels?.[version] || version}</option>)}
                          </select> : setup.version && <div className="dim">{setup.version}</div>}
                        </div>
                        <button className="btn" disabled={Boolean(pendingAction) || installed || setup.available === false}
                          onClick={() => onRuntimeSetupAction(activeRuntimeManager.id, activeRuntimeSection.id, setup.id, selected)}>
                          {pendingAction === "setup" ? "Setting up…" : installed ? "Installed" : versionInstalled ? "Use version" : setup.buttonLabel || setup.label || "Install"}
                        </button>
                      </div>; })}
                    </div>}
                  </div>
                </div>

                <div className="saveSection runtimeSection">
                  <div className="saveSectionTitle runtimeInstalledHeader">
                    <span>{summaryPresentation.installedTitle}</span>
                    <span className="runtimeInstalledHeaderRight">
                      <select
                        className="input inputSmall"
                        value={activeRuntimeInstalledSort}
                        onChange={e =>
                          updateRuntimeUiSection(
                            activeRuntimeManager.id,
                            activeRuntimeSection.id,
                            "installedSort",
                            e.target.value
                          )
                        }
                      >
                        <option value="default">Default first</option>
                        <option value="newest">Newest first</option>
                        <option value="oldest">Oldest first</option>
                        <option value="path">Path</option>
                      </select>
                    </span>
                  </div>
                  {activeRuntimeInstalledSorted.length === 0 ? (
                    <div className="empty">{managementPresentation.emptyLabel}</div>
                  ) : (
                    <div className="saveList">
                      {activeRuntimeInstalledSorted.map(inst => {
                        const isDefault =
                          inst.version === activeRuntimeSection.defaultVersion &&
                          (activeRuntimeSection.defaultVariant
                            ? inst.variant === activeRuntimeSection.defaultVariant
                            : true);
                        const variantLabel = activeRuntimeHasMultipleVariants
                          ? activeRuntimeVariants.find(
                              (variant: any) => variant.id === inst.variant
                            )?.label || inst.variant
                          : "";
                        const installDetail =
                          typeof inst.detail === "string" && inst.detail.trim()
                            ? inst.detail.trim()
                            : "";
                        return (
                          <div
                            className="saveRow"
                            key={`${inst.version}-${inst.platformKey}-${inst.variant}`}
                          >
                            <div className="saveRowMain">
                              <div className="saveName">
                                {formatRuntimeVersionTag(inst.version, activeRuntimeSection)}
                                {isDefault && (
                                  <span className="badge badgeAccent">Default</span>
                                )}
                                {inst.ready === false && <span className="badge badgeWarn">{inst.external ? "Unavailable" : "Needs repair"}</span>}
                                {isRuntimeIncluded(inst) && <span className="badge">Included</span>}
                                {activeRuntimeHasMultipleVariants && inst.variant && (
                                  <span className="badge">{variantLabel}</span>
                                )}
                                {inst.platformKey && (
                                  <span className="dim">· {inst.platformKey}</span>
                                )}
                                {inst.minimumMacOS && <span className="dim">· macOS {inst.minimumMacOS}+</span>}
                              </div>
                              {installDetail && <div className="dim">{installDetail}</div>}
                              {inst.error && <div className="dim">{formatUserError(inst.error)}</div>}
                              {Object.entries(inst.libraries || {}).map(([id, library]: [string, any]) => library.ready &&
                                <div className="dim" key={id}>{library.label || id} {library.version || library.apiProfile || ""}</div>)}
                              {!isRuntimeIncluded(inst) && <div className="dim mono ellipsis runtimePath">
                                {inst.installDir}
                              </div>}
                            </div>
                            <div className="saveRowActions">
                              {onRuntimeInstalledAction && (inst.actions || []).filter((action: any) => action.available !== false).map((action: any) =>
                                <button className="btn" key={action.id} disabled={runtimeBusy}
                                  onClick={() => onRuntimeInstalledAction(activeRuntimeManager.id, activeRuntimeSection.id, inst.version, action.id)}>
                                  {action.label}
                                </button>)}
                              {!isDefault && inst.ready !== false && (
                                <>
                                  <button
                                    className="link"
                                    disabled={runtimeBusy}
                                    onClick={() =>
                                      onRuntimeSetDefault(
                                        activeRuntimeManager.id,
                                        activeRuntimeSection.id,
                                        inst.version,
                                        inst.variant
                                      )
                                    }
                                  >
                                    Set default
                                  </button>
                                </>
                              )}
                              {inst.removable !== false && <button
                                className="btn iconOnly danger"
                                disabled={runtimeBusy}
                                title={runtimeRemovalPresentation(inst, activeRuntimeSection).label}
                                aria-label={runtimeRemovalPresentation(inst, activeRuntimeSection).label}
                                onClick={() =>
                                  onRuntimeUninstall(
                                    activeRuntimeManager.id,
                                    activeRuntimeSection.id,
                                    inst
                                  )
                                }
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
                              </button>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="empty">No runtime managers available.</div>
          )}
        </div>
    </main>
  );
}

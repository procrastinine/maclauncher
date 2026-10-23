import React, { useEffect, useMemo, useRef, useState } from "react";
import type { DownloadTask, ReShadeFilter, RuntimeManagerState, RuntimeUiState } from "../types";
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
import { groupRuntimeManagers, resolveRuntimeTabSelection, runtimeGroupSections, runtimeSectionTabs,
  runtimeTabMovement, runtimeCatalogPresentation, runtimeSummaryPresentation, runtimeManagementPresentation,
  runtimeRemovalPresentation, isRuntimeIncluded } from "./runtime-tabs-model";
import type { RuntimeTabGroup, RuntimeTabSection, RuntimeSectionTab } from "./runtime-tabs-model";
import { HelpTip } from "./HelpTip";
import { LauncherViewHeader } from "./LauncherViewHeader";
import { ScrollableTabStrip } from "./ScrollableTabStrip";
import { SearchableSidebar } from "./SearchableSidebar";
import { ShaderLibraryFamily } from "./ShaderLibraryFamily";
import type { ReShadeFilterApi } from "./ReShadeFilterLibrary";
import { presentRuntimeManagers } from "../../../../modules/runtime-presentations";

const EMPTY_RUNTIME_UI: RuntimeUiState[string] = {
  remoteOpen: {},
  installVersion: {},
  installVariant: {},
  installedSort: {},
  error: null
};

type RuntimesViewProps = {
  shaderFilters?: ReShadeFilter[];
  shaderFiltersError?: string;
  filterApi?: Partial<ReShadeFilterApi>;
  runtimeManagers: RuntimeManagerState[];
  runtimeUi: RuntimeUiState;
  runtimeManagerId: string | null;
  runtimeSectionId: string | null;
  navigationKey?: number;
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
  onRuntimeImport?: (managerId: string, sectionId: string, version?: string) => void;
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
  shaderFilters = [], shaderFiltersError, filterApi,
  runtimeManagers,
  runtimeUi,
  runtimeManagerId,
  runtimeSectionId,
  navigationKey,
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
  const runtimeGroups = useMemo(() => groupRuntimeManagers(presentRuntimeManagers(runtimeManagers)), [runtimeManagers]);
  const selection = useMemo(() => resolveRuntimeTabSelection(runtimeGroups, runtimeManagerId,
    runtimeSectionId, resolveRuntimeSections), [runtimeGroups, runtimeManagerId, runtimeSectionId]);
  const activeRuntimeGroup = selection.group;
  const activeRuntimeChoices = selection.sections;
  const activeRuntimeChoice = selection.section;
  const sectionTabs = runtimeSectionTabs(activeRuntimeChoices);
  const activeSectionTab = sectionTabs.find(tab => tab.choices.some(choice => choice.id === activeRuntimeChoice?.id));
  const activeRuntimeManager = activeRuntimeChoice?.manager || null;
  const activeRuntimeSection = activeRuntimeChoice?.section || null;
  const shaderLibrary = activeRuntimeManager?.ui?.library === "shaders";
  const managementPresentation = runtimeManagementPresentation(activeRuntimeSection);
  const remembered = useRef(new Map<string, { managerId: string; sectionId: string }>());
  const rememberedSections = useRef(new Map<string, string>());
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
    rememberedSections.current.set(activeRuntimeManager.id, activeRuntimeSectionId);
  }, [activeRuntimeManager, activeRuntimeGroup, activeRuntimeSectionId, runtimeManagerId, runtimeSectionId, setRuntimeManagerId, setRuntimeSectionId]);
  function selectSection(choice: RuntimeTabSection) {
    setRuntimeManagerId(choice.managerId);
    setRuntimeSectionId(choice.sectionId);
  }
  function selectSectionTab(tab: RuntimeSectionTab) {
    const next = tab.choices.find(choice => choice.sectionId === rememberedSections.current.get(choice.managerId)) || tab.choices[0];
    if (next) selectSection(next);
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
  const activeRuntimeSupportsDefault = activeRuntimeSection?.supportsDefault !== false;
  const installedSort = !activeRuntimeSupportsDefault && activeRuntimeInstalledSort === "default" ? "newest" : activeRuntimeInstalledSort;
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
    installedSort,
    activeRuntimeSupportsDefault ? activeRuntimeSection?.defaultVersion || null : null,
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
  const activeRuntimeIdentity = activeRuntimeManager?.label || activeRuntimeSection?.label || activeRuntimeGroup?.label || "Runtime";
  const showRuntimeIdentity = !shaderLibrary && !(activeRuntimeChoices.length > 1 && activeRuntimeIdentity === activeRuntimeChoice?.label);

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
        </div>
        <div className="launcherSidebarLayout">
          <SearchableSidebar label="Runtime groups" searchLabel="Search runtimes" selectedId={activeRuntimeGroup?.id || null}
            selectionKey={`${navigationKey ?? 0}:${activeRuntimeChoice?.id || ""}`}
            panelId={`runtime-group-panel-${activeRuntimeGroup?.id || "empty"}`}
            items={runtimeGroups.map(group => ({ id: group.id, label: group.label,
              keywords: group.managers.flatMap(manager => [manager.id, manager.label,
                ...runtimeGroupSections(group, resolveRuntimeSections).map(choice => choice.label)]) }))}
            onSelect={id => { const group = runtimeGroups.find(group => group.id === id); if (group) selectGroup(group); }} />
          <div className="launcherSidebarContent">
          {sectionTabs.length > 1 && <ScrollableTabStrip label={`${activeRuntimeGroup?.label || "Runtime"} sections`}
            className="runtimeLineTabs" tabsClassName="runtimeTabs"
            selectedTabId={activeSectionTab ? `runtime-section-tab-${encodeURIComponent(activeSectionTab.id)}` : null}>
            {sectionTabs.map((tab, index) => {
              const active = activeSectionTab?.id === tab.id;
              return <button key={tab.id} type="button" id={`runtime-section-tab-${encodeURIComponent(tab.id)}`} role="tab" aria-selected={active}
                aria-controls={`runtime-section-panel-${encodeURIComponent(tab.id)}`} tabIndex={active ? 0 : -1}
                className={`runtimeTab${active ? " active" : ""}`} onClick={() => selectSectionTab(tab)}
                onKeyDown={event => moveTab(event, index, sectionTabs.length, next => selectSectionTab(sectionTabs[next]))}>
                {tab.label}
              </button>;
            })}
          </ScrollableTabStrip>}
        <div className="launcherViewBody runtimeViewBody" role="region" id={`runtime-group-panel-${activeRuntimeGroup?.id || "empty"}`}
          aria-label={activeRuntimeGroup?.label || "Runtime"}>
          <div role={sectionTabs.length > 1 ? "tabpanel" : undefined}
            id={activeSectionTab ? `runtime-section-panel-${encodeURIComponent(activeSectionTab.id)}` : undefined}
            aria-labelledby={sectionTabs.length > 1 && activeSectionTab ? `runtime-section-tab-${encodeURIComponent(activeSectionTab.id)}` : undefined}>
          <ShaderLibraryFamily active={shaderLibrary} collections={activeRuntimeChoices.filter(choice => choice.manager.ui?.library === "shaders")} selectedId={activeRuntimeChoice?.id}
            navigationKey={navigationKey} filters={shaderFilters} filtersError={shaderFiltersError}
            api={filterApi} onSelectCollection={selectSection}>
          {activeRuntimeManager && activeRuntimeSection ? (
            <div
              className="runtimeTabPanel"
              id={`runtime-panel-${activeRuntimeManager.id}-${activeRuntimeSection.id}`}
            >
              <div className="runtimePanel">
                {(showRuntimeIdentity || activeRuntimeDownloadSummary) && <div className="runtimePanelHeader">
                  <div>
                    {showRuntimeIdentity && <div className="runtimePanelTitle">{activeRuntimeIdentity}</div>}
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
                {Array.isArray(activeRuntimeSection.components) && activeRuntimeSection.components.length > 0 &&
                  <section className="runtimeSectionCard" aria-label={activeRuntimeSection.componentsTitle || "Components"}>
                    <div className="runtimeSectionHeader"><div>
                      <div className="runtimeSectionTitle">{activeRuntimeSection.componentsTitle || "Components"}
                        {activeRuntimeSection.componentsDescription && <HelpTip label="About runtime components">{activeRuntimeSection.componentsDescription}</HelpTip>}
                      </div>
                    </div></div>
                    <dl className="runtimeComponents">
                      {activeRuntimeSection.components.map((component: Record<string, any>) => <div className="runtimeComponent" key={component.id}>
                        <dt><span className="runtimeComponentName">{component.label}<HelpTip label={`About ${component.label}`}>
                          <p>{component.description}</p>{component.requirements && <p>{component.requirements}</p>}
                        </HelpTip></span>
                          {component.version && <span className="runtimeComponentVersion">{component.version}</span>}
                        </dt>
                        <dd><span className={`runtimeComponentStatus${component.available ? " available" : ""}`}>{component.status}</span></dd>
                      </div>)}
                    </dl>
                  </section>}
                <div className="runtimeSectionCard">
                  <div className="runtimeSectionHeader">
                    <div>
                      <div className="runtimeSectionTitle">{managementPresentation.title}<HelpTip label={`About ${managementPresentation.title.toLowerCase()}`}>
                        <div className="runtimeCatalogDetails">
                          {activeRuntimeSection.description && <p>{activeRuntimeSection.description}</p>}
                          {activeRuntimeSubtitle && <div>{activeRuntimeSubtitle}</div>}
                          {summaryPresentation.latestAvailableVersion && <div>Latest available {formatRuntimeVersionTag(summaryPresentation.latestAvailableVersion, activeRuntimeSection)}</div>}
                          {summaryPresentation.latestInstalledVersion && <div>Latest installed {formatRuntimeVersionTag(summaryPresentation.latestInstalledVersion, activeRuntimeSection)}</div>}
                          {catalogPresentation.sourceUrl && <div>Source:{" "}
                            {onOpenSource ? <a className="runtimeSourceLink" href={catalogPresentation.sourceUrl} title={catalogPresentation.sourceUrl}
                              onClick={event => { event.preventDefault(); onOpenSource(catalogPresentation.sourceUrl!); }}>{catalogPresentation.sourceLabel}</a>
                              : <span title={catalogPresentation.sourceUrl}>{catalogPresentation.sourceLabel}</span>}
                          </div>}
                          <div>{summaryPresentation.versionCount} {managementPresentation.localFiles
                            ? summaryPresentation.versionCount === 1 ? "file" : "files" : managementPresentation.local
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
                    {(refreshing || (!managementPresentation.local && !hasAvailableVersions)) && <div className="runtimeMeta">
                      {refreshing ? (
                        <span className="dim" role="status">{managementPresentation.refreshingLabel}…</span>
                      ) : !hasAvailableVersions ? (
                        <span className="dim">No versions loaded</span>
                      ) : null}
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
                      <button className="btn" disabled={Boolean(pendingAction) || Boolean(activeRuntimeSection.catalog.importVersionRequired && !activeRuntimeInstallVersion)}
                        onClick={() => onRuntimeImport(activeRuntimeManager.id, activeRuntimeSection.id,
                          activeRuntimeSection.catalog.importVersionRequired ? activeRuntimeInstallVersion : undefined)}>
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
                          <div>{setup.toolLabel || setup.label}
                            {(setup.description || setup.version) && <HelpTip label={`About ${setup.toolLabel || setup.label}`}>{setup.description && <p>{setup.description}</p>}{setup.version && <p>{setup.version}</p>}</HelpTip>}</div>
                          {setup.versions?.length > 0 ? <select className="input inputSmall" aria-label={`${setup.toolLabel || setup.label} version`}
                            value={selected} disabled={Boolean(pendingAction)} onChange={event => setSetupVersions(current => ({ ...current, [key]: event.target.value }))}>
                            {setup.versions.map((version: string) => <option key={version} value={version}>{setup.versionLabels?.[version] || version}</option>)}
                          </select> : null}
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
                        value={installedSort}
                        onChange={e =>
                          updateRuntimeUiSection(
                            activeRuntimeManager.id,
                            activeRuntimeSection.id,
                            "installedSort",
                            e.target.value
                          )
                        }
                      >
                        {activeRuntimeSupportsDefault && <option value="default">Default first</option>}
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
                          activeRuntimeSupportsDefault && inst.version === activeRuntimeSection.defaultVersion &&
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
                                {(inst.platformKey || inst.minimumMacOS || installDetail || inst.installDir || Object.keys(inst.libraries || {}).length > 0) && <HelpTip label={`About ${formatRuntimeVersionTag(inst.version, activeRuntimeSection)}`}>
                                  {inst.platformKey && <p>{inst.platformKey}</p>}
                                  {inst.minimumMacOS && <p>Requires macOS {inst.minimumMacOS} or later.</p>}
                                  {installDetail && <p>{installDetail}</p>}
                                  {Object.entries(inst.libraries || {}).map(([id, library]: [string, any]) => library.ready &&
                                    <p key={id}>{library.label || id} {library.version || library.apiProfile || ""}</p>)}
                                  {!isRuntimeIncluded(inst) && inst.installDir && <p className="mono">{inst.installDir}</p>}
                                </HelpTip>}
                              </div>
                              {inst.error && <div className="dim">{formatUserError(inst.error)}</div>}
                            </div>
                            <div className="saveRowActions">
                              {onRuntimeInstalledAction && (inst.actions || []).filter((action: any) => action.available !== false).map((action: any) =>
                                <button className="btn" key={action.id} disabled={runtimeBusy}
                                  onClick={() => onRuntimeInstalledAction(activeRuntimeManager.id, activeRuntimeSection.id, inst.version, action.id)}>
                                  {action.label}
                                </button>)}
                              {!isDefault && inst.ready !== false && activeRuntimeSection.supportsDefault !== false && (
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
          </ShaderLibraryFamily>
          </div>
        </div>
          </div>
        </div>
    </main>
  );
}

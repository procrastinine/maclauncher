import React, { useEffect, useMemo, useRef, useState } from "react";
import type { DownloadTask, LauncherState, ReShadeFilter, RuntimeManagerState, RuntimeRefreshOptions, RuntimeUiState } from "../types";
import {
  availabilityLabel,
  formatDownloadPercent,
  formatRuntimeVersionTag,
  formatUserError,
  resolveRuntimeNotice,
  resolveRuntimeSections,
  sortInstalled
} from "../ui-helpers";
import { DownloadIcon, RefreshIcon, TrashIcon } from "../icons";
import { groupRuntimeManagers, resolveRuntimeTabSelection, runtimeGroupSections, runtimeSectionTabs,
  runtimeTabMovement, runtimeCatalogPresentation, runtimeSummaryPresentation, runtimeManagementPresentation,
  runtimeRemovalPresentation, isRuntimeIncluded, isRuntimeSetupPending } from "./runtime-tabs-model";
import type { RuntimeTabGroup, RuntimeTabSection, RuntimeSectionTab } from "./runtime-tabs-model";
import { HelpTip } from "./HelpTip";
import { RuntimeCatalogSources } from "./RuntimeCatalogSources";
import { LauncherViewHeader } from "./LauncherViewHeader";
import { ScrollableTabStrip } from "./ScrollableTabStrip";
import { SearchableSidebar } from "./SearchableSidebar";
import { ShaderLibraryFamily } from "./ShaderLibraryFamily";
import { RuntimeSetupSelector } from "./RuntimeSetupSelector";
import { RuntimeModelTable } from "./RuntimeModelTable";
import type { ReShadeFilterApi } from "./ReShadeFilterLibrary";
import { presentRuntimeManagers, runtimeCategories, withLauncherLibraries } from "../../../../modules/runtime-presentations";
import { PluginLibrary } from "./PluginLibrary";
import type { RuntimeSettingsApi } from "./RuntimeSettingsWindow";
import { EffectsPresetManager } from "./EffectsPresetManager";
import { useGraphicsCatalog } from "../useGraphicsCatalog";
import { ErrorText } from "./ErrorText";
import { PopoverButton } from "./Popover";
import { StatusBadge } from "./StatusBadge";
import { RuntimeComponentGroup } from "./RuntimeComponentGroup";
import { DownloadProgress } from "./DownloadProgress";
import { isolatedItem } from "./ItemBoundary";

const EMPTY_RUNTIME_UI: RuntimeUiState[string] = {
  remoteOpen: {},
  installVersion: {},
  installVariant: {},
  installedSort: {},
  error: null
};

type RuntimesViewProps = {
  state?: LauncherState;
  settingsApi?: RuntimeSettingsApi;
  shaderFilters?: ReShadeFilter[];
  shaderFiltersError?: string;
  filterApi?: Partial<ReShadeFilterApi>;
  runtimeManagers: RuntimeManagerState[];
  runtimeUi: RuntimeUiState;
  runtimeManagerId: string | null;
  runtimeSectionId: string | null;
  navigationKey?: number;
  shaderCategory?: string;
  downloadTasks: DownloadTask[];
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
    options?: RuntimeRefreshOptions
  ) => void;
  onRuntimeInstall: (
    managerId: string,
    sectionId: string,
    version: string,
    variant?: string
  ) => unknown;
  onRuntimeImport?: (managerId: string, sectionId: string, version?: string) => void;
  onRuntimeRegister?: (managerId: string, sectionId: string) => void;
  onRuntimeSetupAction?: (managerId: string, sectionId: string, setupActionId: string, toolVersion?: string) => void;
  onRuntimeInstalledAction?: (managerId: string, sectionId: string, version: string, installedActionId: string) => void;
  onRuntimeSetDefault: (
    managerId: string,
    sectionId: string,
    version: string | null,
    variant?: string,
    selectionId?:string
  ) => void;
  onRuntimeUninstall: (
    managerId: string,
    sectionId: string,
    install: Record<string, any>
  ) => unknown;
  onCancelDownload: (id: string) => void;
  onOpenSource?: (url: string) => void;
};

export function RuntimesView({
  state, settingsApi,
  shaderFilters, shaderFiltersError, filterApi,
  runtimeManagers,
  runtimeUi,
  runtimeManagerId,
  runtimeSectionId,
  navigationKey,
  shaderCategory,
  downloadTasks,
  setRuntimeManagerId,
  setRuntimeSectionId,
  updateRuntimeUiSection,
  onRuntimeRefresh,
  onRuntimeInstall,
  onRuntimeImport,
  onRuntimeRegister,
  onRuntimeSetupAction,
  onRuntimeInstalledAction,
  onRuntimeSetDefault,
  onRuntimeUninstall,
  onCancelDownload,
  onOpenSource
}: RuntimesViewProps) {
  const runtimeGroups = useMemo(() => groupRuntimeManagers(presentRuntimeManagers(withLauncherLibraries(runtimeManagers)), runtimeCategories), [runtimeManagers]);
  const selection = useMemo(() => resolveRuntimeTabSelection(runtimeGroups, runtimeManagerId,
    runtimeSectionId, resolveRuntimeSections), [runtimeGroups, runtimeManagerId, runtimeSectionId]);
  const activeRuntimeGroup = selection.group;
  const activeRuntimeChoices = selection.sections;
  const componentGroup = Boolean(activeRuntimeGroup?.managers.some(manager => manager.ui?.componentGroup));
  const activeRuntimeChoice = selection.section;
  const sectionTabs = runtimeSectionTabs(activeRuntimeChoices);
  // A visible section tab names its panel.
  const tabStrip = !componentGroup && sectionTabs.length > 1;
  const activeSectionTab = sectionTabs.find(tab => tab.choices.some(choice => choice.id === activeRuntimeChoice?.id));
  const activeRuntimeManager = activeRuntimeChoice?.manager || null;
  const activeRuntimeSection = activeRuntimeChoice?.section || null;
  const shaderLibrary = activeRuntimeManager?.ui?.library === "shaders";
  const pluginLibrary = activeRuntimeManager?.ui?.library === "plugins";
  const presetLibrary = activeRuntimeManager?.ui?.library === "presets";
  // The shader library and presets read the graphics catalog while shown.
  const graphicsCatalog = useGraphicsCatalog((shaderLibrary || presetLibrary) && !shaderFilters);
  const filters = shaderFilters || graphicsCatalog?.shaderLibrary || graphicsCatalog?.filters || [];
  const filtersError = shaderFilters ? shaderFiltersError : graphicsCatalog?.shaderLibraryError || graphicsCatalog?.filtersError;
  const managementPresentation = runtimeManagementPresentation(activeRuntimeSection);
  const remembered = useRef(new Map<string, { managerId: string; sectionId: string }>());
  const rememberedSections = useRef(new Map<string, string>());
  const [setupVersions, setSetupVersions] = useState<Record<string, string>>({});
  const [itemGroup, setItemGroup] = useState<{section:string;id:string}>({section:"",id:"all"});
  const groupKey=`${activeRuntimeManager?.id}:${activeRuntimeSection?.id}`;
  const itemGroups=activeRuntimeSection?.itemGroups || [];
  const selectedItemGroup=itemGroup.section===groupKey&&itemGroups.some((row:Record<string,any>)=>row.id===itemGroup.id)?itemGroup.id:"all";
  const matchesItemGroup=(row:Record<string,any>)=>selectedItemGroup==="all"||row.itemGroup===selectedItemGroup||
    itemGroups.find((group:Record<string,any>)=>group.id===selectedItemGroup)?.operations?.some((operation:string)=>(row.compatibleMethods||[row.operation||row.method]).includes(operation));
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
  const refreshing = managementPresentation.local && (pendingAction === "refreshCatalog" || activeRuntimeSection?.catalog?.status === "loading");
  const runtimeBusy = Boolean(pendingAction && pendingAction !== "refreshCatalog") || refreshing;
  const activeRuntimeRefreshLabel = refreshing ? managementPresentation.refreshingLabel : managementPresentation.refreshLabel;
  const activeRuntimeRefreshAllLabel = refreshing ? "Refreshing all versions" : "All versions";
  const runtimeMessage = activeRuntimeSectionId ? activeRuntimeUi.messages?.[activeRuntimeSectionId] : null;
  const setupActions = (activeRuntimeSection?.setupActions || activeRuntimeManager?.setupActions || []).filter(matchesItemGroup);
  const activeRuntimeInstalled = Array.isArray(activeRuntimeSection?.installed)
    ? activeRuntimeSection.installed.filter(matchesItemGroup)
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
  const catalogPresentation = runtimeCatalogPresentation(activeRuntimeSection?.catalog, activeRuntimeInstallVersion, activeRuntimeResolvedInstallVariant);
  const summaryPresentation = runtimeSummaryPresentation(activeRuntimeSection, activeRuntimeInstallVersion, runtimeMessage);
  const activeRuntimeInstalledSorted = sortInstalled(
    activeRuntimeInstalled,
    installedSort,
    activeRuntimeSupportsDefault ? activeRuntimeSection?.defaultVersion || null : null,
    activeRuntimeHasVariants ? activeRuntimeSection?.defaultVariant || null : null
  );
  const defaultSelections = Array.isArray(activeRuntimeSection?.defaultSelections) ? activeRuntimeSection.defaultSelections : null;
  if (installedSort === "default" && defaultSelections) {
    const preferred = new Set(defaultSelections.map((row: Record<string, any>) => row.version));
    activeRuntimeInstalledSorted.sort((a, b) => Number(preferred.has(b.version)) - Number(preferred.has(a.version)));
  }
  const activeRuntimeDownloads = useMemo(() => {
    if (!activeRuntimeManager?.id || !activeRuntimeSectionId) return [];
    return downloadTasks.filter(
      task =>
        task.managerId === activeRuntimeManager.id &&
        task.sectionId === activeRuntimeSectionId
    );
  }, [downloadTasks, activeRuntimeManager?.id, activeRuntimeSectionId]);
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
  // Grouped providers are named by their tab and component rows.
  const sectionGroup = Boolean(activeRuntimeManager?.ui?.sectionGroupId);
  const showRuntimeIdentity = !shaderLibrary && !sectionGroup && !tabStrip && !(activeRuntimeChoices.length > 1 && activeRuntimeIdentity === activeRuntimeChoice?.label);
  const componentsSection=sectionGroup?activeSectionTab?.choices.find(choice=>Array.isArray(choice.section.components))?.section:activeRuntimeSection;
  const componentChoices = new Map((sectionGroup ? activeSectionTab?.choices || [] : [])
    .filter(choice => typeof choice.manager.ui?.componentId === "string").map(choice => [choice.manager.ui!.componentId as string, choice]));
  const showInstalledSort = activeRuntimeInstalled.length >= 4;

  return (
    <main className="launcherView runtimesView" aria-labelledby="runtimes-title">
        <div className="runtimeViewHeader">
          <LauncherViewHeader title="Runtimes" titleId="runtimes-title">
              <PopoverButton className="runtimeDownloadMenu" buttonClassName="btn iconOnly runtimeDownloadToggle"
                popoverClassName="menuPopover runtimeDownloadDropdown" ariaLabel="Downloads" title="Downloads"
                label={<><DownloadIcon />{downloadTasks.length > 0 && <span className="runtimeDownloadBadge">{downloadTasks.length}</span>}</>}>
                {downloadTasks.length === 0 ? (
                  <div className="runtimeDownloadEmpty">
                    No active downloads.
                  </div>
                ) : (
                  downloadTasks.map(task => <DownloadProgress key={task.id} task={task} onCancel={onCancelDownload} />)
                )}
              </PopoverButton>
          </LauncherViewHeader>
        </div>
        <div className="launcherSidebarLayout">
          <SearchableSidebar label="Runtime groups" searchLabel="Search runtimes" selectedId={activeRuntimeGroup?.id || null}
            selectionKey={`${navigationKey ?? 0}:${activeRuntimeChoice?.id || ""}`}
            panelId={`runtime-group-panel-${activeRuntimeGroup?.id || "empty"}`}
            items={runtimeGroups.map(group => ({ id: group.id, label: group.label, heading: group.heading,
              keywords: group.managers.flatMap(manager => [manager.id, manager.label,
                ...runtimeGroupSections(group, resolveRuntimeSections).map(choice => choice.label)]) }))}
            onSelect={id => { const group = runtimeGroups.find(group => group.id === id); if (group) selectGroup(group); }} />
          <div className="launcherSidebarContent">
          {tabStrip && <ScrollableTabStrip label={`${activeRuntimeGroup?.label || "Runtime"} sections`}
            className="runtimeLineTabs" tabsClassName="runtimeTabs"
            selectedTabId={activeSectionTab ? `runtime-section-tab-${encodeURIComponent(activeSectionTab.id)}` : null}>
            {sectionTabs.map((tab, index) => {
              const active = activeSectionTab?.id === tab.id;
              // The backend's own name, when it differs from the tab, is available on hover.
              const backend = tab.choices.length === 1 ? tab.choices[0].manager.label : "";
              return <button key={tab.id} type="button" id={`runtime-section-tab-${encodeURIComponent(tab.id)}`} role="tab" aria-selected={active}
                title={backend && backend !== tab.label ? backend : undefined}
                aria-controls={`runtime-section-panel-${encodeURIComponent(tab.id)}`} tabIndex={active ? 0 : -1}
                className={`runtimeTab${active ? " active" : ""}`} onClick={() => selectSectionTab(tab)}
                onKeyDown={event => moveTab(event, index, sectionTabs.length, next => selectSectionTab(sectionTabs[next]))}>
                {tab.label}
              </button>;
            })}
          </ScrollableTabStrip>}
        <div className="launcherViewBody runtimeViewBody" role="region" id={`runtime-group-panel-${activeRuntimeGroup?.id || "empty"}`}
          aria-label={activeRuntimeGroup?.label || "Runtime"}>
          <div role={tabStrip ? "tabpanel" : undefined}
            id={activeSectionTab ? `runtime-section-panel-${encodeURIComponent(activeSectionTab.id)}` : undefined}
            aria-labelledby={tabStrip && activeSectionTab ? `runtime-section-tab-${encodeURIComponent(activeSectionTab.id)}` : undefined}>
          {isolatedItem(activeSectionTab?.id || activeRuntimeGroup?.id || "runtimes", { label: activeSectionTab?.label || activeRuntimeGroup?.label || "Runtime", reset: navigationKey }, () => <RuntimeComponentGroup key={componentGroup ? activeRuntimeGroup?.id : undefined} enabled={componentGroup} label={activeRuntimeGroup?.label || "Runtime"}
            choices={activeRuntimeChoices} selectedId={activeRuntimeChoice?.id} navigationKey={navigationKey}
            downloads={downloadTasks} onSelect={selectSection} onCancel={onCancelDownload}>
          <ShaderLibraryFamily active={shaderLibrary} collections={activeRuntimeChoices.filter(choice => choice.manager.ui?.library === "shaders")} selectedId={activeRuntimeChoice?.id}
            navigationKey={navigationKey} shaderCategory={shaderCategory} filters={filters} filtersError={filtersError}
            api={filterApi} onSelectCollection={selectSection}>
          {presetLibrary && activeRuntimeManager ? <div className="runtimeTabPanel" id={`runtime-panel-${activeRuntimeManager.id}`}>
            <EffectsPresetManager status={graphicsCatalog} navigationKey={navigationKey}
              selectedId={state?.utilityWindow?.managerId === activeRuntimeManager.id ? state.utilityWindow.sectionId : undefined} />
          </div> : pluginLibrary && activeRuntimeManager ? <PluginLibrary key={activeRuntimeManager.id}
            manager={activeRuntimeManager} sections={activeRuntimeChoices.filter(choice => choice.managerId === activeRuntimeManager.id)}
            state={state} api={settingsApi} ui={activeRuntimeUi} downloads={downloadTasks}
            onInstall={onRuntimeInstall} onUninstall={onRuntimeUninstall} onOpenSource={onOpenSource} /> : activeRuntimeManager && activeRuntimeSection ? (
            <div
              className="runtimeTabPanel"
              id={`runtime-panel-${activeRuntimeManager.id}-${activeRuntimeSection.id}`}
            >
              <div className="runtimePanel">
                {(showRuntimeIdentity || activeRuntimeDownloadSummary || activeRuntimeSection.defaultSource === "saved") && <div className="runtimePanelHeader">
                  <div>
                    {showRuntimeIdentity && <div className="runtimePanelTitle">{activeRuntimeIdentity}</div>}
                  </div>
                  <div className="runtimePanelHeaderActions">
                    {activeRuntimeSupportsDefault && activeRuntimeSection.defaultSource === "saved" && <button className="btn small" disabled={runtimeBusy}
                      onClick={() => onRuntimeSetDefault(activeRuntimeManager.id, activeRuntimeSection.id, null)}>Clear default</button>}
                    {activeRuntimeDownloadSummary && (
                      <div className="chip">{activeRuntimeDownloadSummary}</div>
                    )}
                  </div>
                </div>}

                <ErrorText error={activeRuntimeUi.error} inline className="runtimeError" />
                {!componentGroup && activeRuntimeDownloads.map(task => <DownloadProgress key={task.id} task={task} onCancel={onCancelDownload} />)}
                {Array.isArray(componentsSection?.components) && componentsSection.components.length > 0 &&
                  <section className="runtimeSectionCard" aria-label={componentsSection.componentsTitle || "Components"}>
                    <div className="runtimeSectionHeader"><div>
                      <div className="runtimeSectionTitle">{componentsSection.componentsTitle || "Components"}
                        {componentsSection.componentsDescription && <HelpTip label="About runtime components">{componentsSection.componentsDescription}</HelpTip>}
                      </div>
                    </div></div>
                    <dl className="runtimeComponents">
                      {componentsSection.components.map((component: Record<string, any>) => <div className="runtimeComponent" key={component.id}>
                        <dt><span className="runtimeComponentName">{component.label}<HelpTip label={`About ${component.label}`}>
                          <p>{component.description}</p>{component.requirements && <p>{component.requirements}</p>}
                        </HelpTip></span>
                          {component.version && <span className="runtimeComponentVersion">{component.version}</span>}
                        </dt>
                        <dd><span className={`runtimeComponentStatus${component.available ? " available" : ""}`}>{component.status}</span>
                          {componentChoices.has(component.id) && (() => {
                            const choice = componentChoices.get(component.id)!, active = choice.id === activeRuntimeChoice?.id;
                            return <button type="button" className="btn small" aria-pressed={active}
                              aria-label={`Manage ${component.label}`} onClick={() => selectSection(choice)}>Manage</button>;
                          })()}
                        </dd>
                        {Array.isArray(componentChoices.get(component.id)?.section.capabilities) &&
                          <ul className="runtimeComponentCapabilities" aria-label={`${component.label} models`}>
                            {componentChoices.get(component.id)!.section.capabilities.map((row: Record<string, any>) => <li key={row.id}>
                              <span>{row.label}</span>
                              <StatusBadge tone={row.available ? "positive" : "neutral"}>{availabilityLabel(row.available ? "installed" : "notInstalled")}</StatusBadge>
                            </li>)}
                          </ul>}
                      </div>)}
                    </dl>
                  </section>}
                <div className="runtimeSectionCard">
                  <div className="saveSectionTitle runtimeInstalledHeader">
                    <div>
                      <div className="runtimeSectionTitle">{managementPresentation.title}<HelpTip label={`About ${managementPresentation.title.toLowerCase()}`}>
                        <div className="runtimeCatalogDetails">
                          {activeRuntimeSection.description && <p>{activeRuntimeSection.description}</p>}
                          {activeRuntimeSubtitle && <div>{activeRuntimeSubtitle}</div>}
                          {summaryPresentation.latestAvailableVersion && <div>Latest available {formatRuntimeVersionTag(summaryPresentation.latestAvailableVersion, activeRuntimeSection)}</div>}
                          {summaryPresentation.latestInstalledVersion && <div>Latest installed {formatRuntimeVersionTag(summaryPresentation.latestInstalledVersion, activeRuntimeSection)}</div>}
                          <div>{summaryPresentation.versionCount} {managementPresentation.localFiles
                            ? summaryPresentation.versionCount === 1 ? "file" : "files" : managementPresentation.local
                            ? summaryPresentation.versionCount === 1 ? "application" : "applications"
                            : summaryPresentation.versionCount === 1 ? "version" : "versions"}
                            {summaryPresentation.includedCount > 0 && ` · ${summaryPresentation.includedCount} included`}
                            {!managementPresentation.local && summaryPresentation.installedCount > 0 && ` · ${summaryPresentation.installedCount} installed`}
                          </div>
                          {summaryPresentation.checkedAt && <div>Last checked {new Date(summaryPresentation.checkedAt).toLocaleString()}</div>}
                          {!summaryPresentation.checkedAt && summaryPresentation.actionDetail && <div>{summaryPresentation.actionDetail}</div>}
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
                    {managementPresentation.local && <div className="runtimePanelHeaderActions">
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
                    </div>}
                  </div>

                  <div className="runtimeSectionBody">
                    {itemGroups.length > 0 && <div className="detailRow detailControlRow"><label htmlFor="runtime-item-group" className="detailLabel">Operation</label>
                      <select id="runtime-item-group" className="input" value={selectedItemGroup}
                        onChange={event=>setItemGroup({section:groupKey,id:event.target.value})}>
                        <option value="all">All operations</option>{itemGroups.map((group:Record<string,any>)=><option key={group.id} value={group.id}>{group.label}</option>)}
                      </select></div>}
                    {activeRuntimeSection.sourceLinks?.length > 0 && <div className="detailActions runtimeSourceLinks">
                      {activeRuntimeSection.sourceLinks.map((link:Record<string,any>)=><a key={link.url} href={link.url} className="runtimeSourceLink"
                        onClick={event=>{event.preventDefault();onOpenSource?.(link.url);}}>{link.label}</a>)}
                    </div>}
                    {refreshing && <div className="runtimeMeta">
                      <span className="dim" role="status">{managementPresentation.refreshingLabel}…</span>
                    </div>}
                    {summaryPresentation.actionMessage && (managementPresentation.local || !runtimeMessage?.startsWith("Versions updated")) && <div className="dim runtimeActionStatus" role="status">{summaryPresentation.actionMessage}</div>}

                    {managementPresentation.local && activeRuntimeSection.catalog?.status === "error" &&
                      <ErrorText error={activeRuntimeSection.catalog?.error} inline />}

                    {!managementPresentation.local && (
                      <RuntimeCatalogSources managerId={activeRuntimeManager.id} section={activeRuntimeSection}
                        ui={activeRuntimeUi} busy={runtimeBusy} variant={activeRuntimeResolvedInstallVariant}
                        downloads={activeRuntimeDownloads} onOpenSource={onOpenSource}
                        onRefresh={options => onRuntimeRefresh(activeRuntimeManager.id, activeRuntimeSection.id, options)}
                        onSelect={(key, field, value) => updateRuntimeUiSection(activeRuntimeManager.id, key, field, value)}
                        onInstall={(version, variant) => onRuntimeInstall(activeRuntimeManager.id, activeRuntimeSection.id, version, variant)} />
                    )}
                    {activeRuntimeSection.catalog?.importable && onRuntimeImport && <div className="runtimeImport">
                      <button className="btn" disabled={Boolean(pendingAction) || Boolean(activeRuntimeSection.catalog.importVersionRequired && !activeRuntimeInstallVersion)}
                        onClick={() => onRuntimeImport(activeRuntimeManager.id, activeRuntimeSection.id,
                          activeRuntimeSection.catalog.importVersionRequired ? activeRuntimeInstallVersion : undefined)}>
                        {pendingAction === "import" ? managementPresentation.importBusyLabel : activeRuntimeSection.catalog.importLabel || "Import runtime…"}
                      </button>
                      {activeRuntimeSection.catalog?.importDescription && <HelpTip label="About importing runtimes">{activeRuntimeSection.catalog.importDescription}</HelpTip>}
                    </div>}
                    {activeRuntimeSection.setupPresentation?.mode==='table'&&<RuntimeModelTable actions={setupActions} installed={activeRuntimeInstalledSorted} section={activeRuntimeSection} busy={runtimeBusy}
                      onInstall={id=>onRuntimeSetupAction?.(activeRuntimeManager.id,activeRuntimeSection.id,id)}
                      onRemove={row=>onRuntimeUninstall(activeRuntimeManager.id,activeRuntimeSection.id,row)}
                      onDefault={(row,selectionId)=>onRuntimeSetDefault(activeRuntimeManager.id,activeRuntimeSection.id,row.version,row.variant,selectionId)}/>}
                    {activeRuntimeSection.setupPresentation?.mode!=='table'&&setupActions.length > 0 && onRuntimeSetupAction && (activeRuntimeSection.setupPresentation?.mode === "select" && setupActions.every((row: Record<string, any>) => !row.versions?.length)
                      ? <RuntimeSetupSelector key={`${activeRuntimeManager.id}:${activeRuntimeSection.id}`}
                        id="runtime-setup-selection" actions={setupActions} label={activeRuntimeSection.setupPresentation.label || "Install"}
                        searchLabel={activeRuntimeSection.setupPresentation.searchLabel} busy={Boolean(pendingAction)}
                        onAction={id => onRuntimeSetupAction(activeRuntimeManager.id, activeRuntimeSection.id, id)} />
                      : <div className="runtimeSetup">
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
                          {isRuntimeSetupPending(pendingAction, setup.id) ? "Setting up…" : installed ? "Installed" : versionInstalled ? "Use version" : setup.buttonLabel || setup.label || "Install"}
                        </button>
                      </div>; })}
                    </div>)}
                  </div>
                </div>

                {activeRuntimeSection.setupPresentation?.mode!=='table'&&<div className="saveSection runtimeSection">
                  <div className="saveSectionTitle runtimeInstalledHeader">
                    <span>{summaryPresentation.installedTitle}</span>
                    {showInstalledSort && <span className="runtimeInstalledHeaderRight">
                      <select
                        className="input inputSmall"
                        aria-label="Sort installed items"
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
                    </span>}
                  </div>
                  {activeRuntimeInstalledSorted.length === 0 ? (
                    <div className="empty">{managementPresentation.emptyLabel}</div>
                  ) : (
                    <div className="saveList">
                      {activeRuntimeInstalledSorted.map(inst => {
                        const defaultFor = defaultSelections?.filter((row: Record<string, any>) => row.version === inst.version).map((row: Record<string, any>) => row.label) || [];
                        const isDefault =
                          defaultSelections ? defaultFor.length > 0 : (activeRuntimeSupportsDefault || inst.custom) && inst.version === activeRuntimeSection.defaultVersion &&
                          (activeRuntimeSection.defaultVariant
                            ? inst.variant === activeRuntimeSection.defaultVariant
                            : true);
                        const incompleteDefault = defaultSelections?.some((row: Record<string, any>) => row.version !== inst.version && row.compatibleVersions?.includes(inst.version));
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
                                  <span className="badge badgeAccent" title={defaultFor.length ? `Automatic for ${defaultFor.join(", ")}` : undefined}>Default</span>
                                )}
                                {inst.ready === false && <StatusBadge tone="warning">{availabilityLabel(inst.external ? "unavailable" : "needsRepair")}</StatusBadge>}
                                {isRuntimeIncluded(inst) && <StatusBadge>{availabilityLabel("included")}</StatusBadge>}
                                {inst.custom && <span className="badge">Custom</span>}
                                {activeRuntimeHasMultipleVariants && inst.variant && (
                                  <span className="badge">{variantLabel}</span>
                                )}
                                {(defaultFor.length > 0 || inst.platformKey || inst.minimumMacOS || installDetail || inst.installDir || Object.keys(inst.libraries || {}).length > 0) && <HelpTip label={`About ${formatRuntimeVersionTag(inst.version, activeRuntimeSection)}`}>
                                  {defaultFor.length > 0 && <p>Automatic for {defaultFor.join(", ")}.</p>}
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
                              {(!isDefault || incompleteDefault) && inst.ready !== false && (inst.custom || activeRuntimeSection.supportsDefault !== false) && (
                                <>
                                  <button
                                    className="btn small"
                                    disabled={runtimeBusy}
                                    title={incompleteDefault ? "Use as Automatic for all compatible operations." : undefined}
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
                                <TrashIcon />
                              </button>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>}
                {activeRuntimeSection.customRuntime && onRuntimeRegister && <div className="runtimeImport">
                  <button className="btn" disabled={runtimeBusy}
                    onClick={() => onRuntimeRegister(activeRuntimeManager.id, activeRuntimeSection.id)}>
                    {pendingAction === "registerCustom" ? "Registering…" : activeRuntimeSection.registrationPresentation?.label || "Register custom…"}
                  </button>
                  <HelpTip label={activeRuntimeSection.registrationPresentation ? "About existing packages" : "About custom runtimes"}>{activeRuntimeSection.registrationPresentation?.description || "Register a compatible executable, application or runtime directory in this list. Files remain in their original location."}</HelpTip>
                </div>}
              </div>
            </div>
          ) : (
            <div className="empty">No runtime managers available.</div>
          )}
          </ShaderLibraryFamily>
          </RuntimeComponentGroup>)}
          </div>
        </div>
          </div>
        </div>
    </main>
  );
}

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { DownloadTask, LauncherState, RuntimeManagerState, RuntimeRefreshOptions, RuntimeUiState } from "../types";
import {
  architectureLabel,
  availabilityLabel,
  formatDownloadPercent,
  formatRuntimeVersionTag,
  runtimeVersionTagger,
  formatUserError,
  resolveRuntimeNotice,
  resolveRuntimeSections, resolveRuntimeSection,
  sortInstalled
} from "../ui-helpers";
import { DownloadIcon, RefreshIcon, TrashIcon } from "../icons";
import { groupRuntimeManagers, splitRuntimeGroupsByHost, resolveRuntimeTabSelection, runtimeGroupSections, runtimeSectionTabs, runtimeChoiceForQuery, runtimeTabChoice, runtimeRequestPending, runtimeDefaultMenu, runtimeMakeDefaultChoice, runtimeOperationDefaults, runtimeRowDefaultable, runtimeDistinctLinks,
  runtimeTabMovement, runtimeCatalogPresentation, runtimeSummaryPresentation, runtimeManagementPresentation,
  runtimeRemovalPresentation, runtimeMinimumDetail, runtimeIncludedParts, runtimeInstallVersion, isRuntimeIncluded, isRuntimeSetupPending,
  managedRuntimeSections, runtimePendingAction, runtimeRefreshPayload, runtimeSourceUiKey,
  translatorInstallBuild, translatorInstallRequirement } from "./runtime-tabs-model";
import type { RuntimeTabGroup, RuntimeTabSection, RuntimeSectionTab } from "./runtime-tabs-model";
import { HelpTip } from "./HelpTip";
import { SectionHelp, helpItems } from "./HelpList";
import { PathDisplay } from "./PathDisplay";
import { RuntimeCatalogSources } from "./RuntimeCatalogSources";
import { LauncherViewHeader } from "./LauncherViewHeader";
import { ScrollableTabStrip } from "./ScrollableTabStrip";
import { SearchableSidebar } from "./SearchableSidebar";
import { ShaderCollections } from "./ShaderLibraryFamily";
import { RuntimeSetupSelector } from "./RuntimeSetupSelector";
import { RuntimeModelTable } from "./RuntimeModelTable";
import { presentRuntimeManagers, runtimeCategories, withLauncherLibraries } from "../../../../modules/runtime-presentations";
import { installedRuntimeAvailability } from "../../../../core/runtime-install-availability.mjs";
import { PluginLibrary } from "./PluginLibrary";
import type { RuntimeSettingsApi } from "./RuntimeSettingsWindow";
import { ComponentsView } from "./ComponentsView";
import { componentSizeText } from "./components-model";
import { cpuLabel } from "../../../../core/cpu-labels.mjs";
import { ErrorText } from "./ErrorText";
import { PopoverButton } from "./Popover";
import { StatusBadge } from "./StatusBadge";
import { RuntimeComponentGroup } from "./RuntimeComponentGroup";
import { RuntimeDefaultMenu } from "./RuntimeDefaultMenu";
import { DownloadProgress } from "./DownloadProgress";
import { isolatedItem } from "./ItemBoundary";

import { confirmAction } from "../confirm-action";

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
  /** Reads the path of a file dropped on a custom runtime field. */
  getPathForFile?: (file: File) => string | null;
  runtimeManagers: RuntimeManagerState[];
  runtimeUi: RuntimeUiState;
  runtimeManagerId: string | null;
  runtimeSectionId: string | null;
  navigationKey?: number;
  downloadTasks: DownloadTask[];
  setRuntimeManagerId: React.Dispatch<React.SetStateAction<string | null>>;
  setRuntimeSectionId: React.Dispatch<React.SetStateAction<string | null>>;
  updateRuntimeUiSection: (
    managerId: string,
    sectionId: string,
    key: "remoteOpen" | "installVersion" | "installVariant" | "installArchitecture" | "installedSort",
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
    variant?: string,
    architecture?: string
  ) => unknown;
  onRuntimeImport?: (managerId: string, sectionId: string, version?: string) => void;
  onRuntimeRegister?: (managerId: string, sectionId: string, runtimePath?: string) => void;
  onRuntimeSetupAction?: (managerId: string, sectionId: string, setupActionId: string, toolVersion?: string) => void;
  onRuntimeInstalledAction?: (managerId: string, sectionId: string, version: string, installedActionId: string, architecture?: string) => void;
  onRuntimeSetDefault: (
    managerId: string,
    sectionId: string,
    version: string | null,
    variant?: string,
    selectionId?:string,
    architecture?: string
  ) => void;
  onRuntimeUninstall: (
    managerId: string,
    sectionId: string,
    install: Record<string, any>
  ) => unknown;
  onCancelDownload: (id: string) => void;
  onOpenSource?: (url: string) => void;
};

// The CPU an installed build is shown with names the Macs that can run its
// package. A catalog's declared build CPU or host requirement wins over the
// file's own CPU: a library that x86_64 Wine loads but whose package runs only
// on Apple Silicon is not tagged Intel. Two installations of one version from
// different build choices are told apart by that build choice. Only a build for
// another CPU than the automatic one carries a tag.
function buildArchitecture(install: Record<string, any>, section: Record<string, any>, installed: Record<string, any>[]): string | null {
  const slot = (row: Record<string, any>) => /^architecture:(.+)$/.exec(String(row.variant || ""))?.[1] || null;
  if (slot(install) && installed.some(row => row !== install && row.version === install.version && slot(row) && slot(row) !== slot(install)))
    return slot(install);
  const catalogs = section.catalog?.architectureCatalogs || {};
  const catalog = slot(install) && catalogs[slot(install) as string] ? catalogs[slot(install) as string] : section.catalog;
  const requirement = install.custom ? null : catalog?.versionRequirements?.[install.version];
  const hosts = (Array.isArray(requirement?.hostArchitectures) ? requirement.hostArchitectures : [])
    .map((value: string) => value === "x86_64" ? "x64" : value);
  const declared = requirement?.architecture || (hosts.length > 1 ? "universal" : hosts[0]) || null;
  return declared || install.architecture || null;
}

// A component's explanation: its description, then its requirements on a line of their own.
function componentHelpText(component: Record<string, any>) {
  return [component.description, component.requirements].filter(text => typeof text === "string" && text.trim()).join("\n");
}

export function RuntimesView({
  state, settingsApi, getPathForFile,
  runtimeManagers,
  runtimeUi,
  runtimeManagerId,
  runtimeSectionId,
  navigationKey,
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
  const runtimeGroups = useMemo(() => splitRuntimeGroupsByHost(groupRuntimeManagers(presentRuntimeManagers(withLauncherLibraries(runtimeManagers)), runtimeCategories),
    resolveRuntimeSections), [runtimeManagers]);
  const [runtimeGroupId, setRuntimeGroupId] = useState<string | null>(null);
  const selection = useMemo(() => resolveRuntimeTabSelection(runtimeGroups, runtimeManagerId,
    runtimeSectionId, resolveRuntimeSections, runtimeGroupId), [runtimeGroups, runtimeManagerId, runtimeSectionId, runtimeGroupId]);
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
  const activeRuntimeVersionTag = useMemo(() => runtimeVersionTagger(activeRuntimeSection), [activeRuntimeSection]);
  const shaderLibrary = activeRuntimeManager?.ui?.library === "shaders";
  const pluginLibrary = activeRuntimeManager?.ui?.library === "plugins";
  const componentLibrary = activeRuntimeManager?.ui?.library === "components";
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
    if (runtimeRequestPending(activeRuntimeGroup, activeRuntimeChoices, runtimeManagerId)) return;
    if (runtimeManagerId !== activeRuntimeManager.id) setRuntimeManagerId(activeRuntimeManager.id);
    if (runtimeSectionId !== activeRuntimeSectionId) setRuntimeSectionId(activeRuntimeSectionId);
    if (activeRuntimeGroup) remembered.current.set(activeRuntimeGroup.id,
      { managerId: activeRuntimeManager.id, sectionId: activeRuntimeSectionId });
    rememberedSections.current.set(activeRuntimeManager.id, activeRuntimeSectionId);
  }, [activeRuntimeManager, activeRuntimeGroup, activeRuntimeChoices, activeRuntimeSectionId, runtimeManagerId, runtimeSectionId, setRuntimeManagerId, setRuntimeSectionId]);
  // A choice made inside the shown entry keeps that entry; choosing an entry in
  // the sidebar names its own.
  function selectSection(choice: RuntimeTabSection, group: RuntimeTabGroup | null = activeRuntimeGroup) {
    const next = runtimeTabChoice(group, choice);
    setRuntimeGroupId(next.groupId);
    setRuntimeManagerId(next.managerId);
    setRuntimeSectionId(next.sectionId);
  }
  function selectSectionTab(tab: RuntimeSectionTab) {
    const next = tab.choices.find(choice => choice.sectionId === rememberedSections.current.get(choice.managerId)) || tab.choices[0];
    if (next) selectSection(next);
  }
  // A search that names one of the entry's tabs opens that tab; otherwise the
  // entry opens at the tab it last showed.
  function selectGroup(group: RuntimeTabGroup, query = "") {
    setRuntimeGroupId(group.id);
    const choices = runtimeGroupSections(group, resolveRuntimeSections);
    const prior = remembered.current.get(group.id);
    const next = runtimeChoiceForQuery(choices, query, group.label) ||
      choices.find(choice => choice.managerId === prior?.managerId && choice.sectionId === prior?.sectionId) || choices[0];
    if (next) selectSection(next, group);
  }
  // Opening Runtimes at a runtime chooses its entry anew: the automatic CPU's
  // entry when the runtime has one for each CPU.
  useEffect(() => { setRuntimeGroupId(null); }, [navigationKey]);
  function moveTab(event: React.KeyboardEvent<HTMLButtonElement>, index: number, count: number, select: (index: number) => void) {
    const next = runtimeTabMovement(event.key, index, count);
    if (next === null) return;
    event.preventDefault(); select(next);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus({ preventScroll: true });
  }
  const activeRuntimeInstallVersion = runtimeInstallVersion(activeRuntimeSection,
    activeRuntimeSectionId ? activeRuntimeUi.installVersion[activeRuntimeSectionId] : undefined);
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
  const activeRuntimeInstalled = [
    ...(Array.isArray(activeRuntimeSection?.installed) ? activeRuntimeSection.installed : []),
    ...(Array.isArray(activeRuntimeSection?.references) ? activeRuntimeSection.references : [])
  ].filter(matchesItemGroup);
  const activeRuntimeVariants = !activeRuntimeSection?.architectureVariants && Array.isArray(activeRuntimeSection?.variants)
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
  // Each installed version shows its size on disk; the backend measures the
  // shown manager's folders inside the profile while the section is open.
  const [installSizes, setInstallSizes] = useState<Record<string, { bytes: number; complete: boolean }>>({});
  const installDirs = activeRuntimeInstalled.map(install => install.installDir).filter(Boolean).join("\n");
  useEffect(() => {
    const api = typeof window === "undefined" ? undefined : window.MacLauncher?.launcher;
    if (!activeRuntimeManager?.id || !installDirs || !api?.componentAction) return;
    let current = true;
    api.componentAction("sizes", { managerId: activeRuntimeManager.id })
      .then(result => { if (current) setInstallSizes(previous => ({ ...previous, ...result?.sizes })); }).catch(() => {});
    return () => { current = false; };
  }, [activeRuntimeManager?.id, installDirs]);
  const activeRuntimeDefaultVariantLabel = activeRuntimeHasMultipleVariants
    ? activeRuntimeVariants.find(
        (variant: any) => variant.id === activeRuntimeSection?.defaultVariant
      )?.label || activeRuntimeSection?.defaultVariant || ""
    : "";
  const activeRuntimeSubtitleParts = [] as string[];
  if (summaryPresentation.showDefaultVersion && activeRuntimeSection?.defaultVersion) {
    activeRuntimeSubtitleParts.push(
      `Default ${activeRuntimeVersionTag(activeRuntimeSection.defaultVersion)}`
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
  // Each installed row's presentation, shared by the list and the Default menu.
  const automaticArchitecture = activeRuntimeSection?.automaticArchitecture || activeRuntimeSection?.launcherArchitecture;
  const preferredArchitecture = activeRuntimeSection?.defaultArchitecture || automaticArchitecture;
  const installArchitecture = (row: Record<string, any>) => activeRuntimeSection ? buildArchitecture(row, activeRuntimeSection, activeRuntimeInstalledSorted) : null;
  const installedRows = activeRuntimeSection ? activeRuntimeInstalledSorted.map(inst => {
    const peOnly = inst.translator?.files?.some((file: any) => file.format === "pe") && !inst.translator.files.some((file: any) => file.format === "macho");
    const installBuild = peOnly ? null : installArchitecture(inst);
    // Translator views name every build, so two builds of one version read as two labeled rows.
    const translatorBuild = activeRuntimeManager?.ui?.cpuBuildLabels === true
      ? translatorInstallBuild(inst, translatorInstallRequirement(inst, activeRuntimeSection)) : "";
    const otherBuild = !translatorBuild && activeRuntimeManager?.ui?.cpuBuildLabels !== false && installBuild && installBuild !== "universal" &&
      automaticArchitecture && installBuild !== automaticArchitecture ? installBuild : "";
    const defaultFor: string[] = defaultSelections?.filter((row: Record<string, any>) => row.version === inst.version).map((row: Record<string, any>) => row.label) || [];
    const isDefault = activeRuntimeSupportsDefault && (!inst.reference || runtimeRowDefaultable(inst)) && (
      defaultSelections ? defaultFor.length > 0 : inst.version === activeRuntimeSection.defaultVersion &&
      // A version installed only for another CPU, such as an Intel-only
      // build on Apple Silicon, is still the default.
      (!installArchitecture(inst) || installArchitecture(inst) === "universal" || !preferredArchitecture || installArchitecture(inst) === preferredArchitecture ||
        !activeRuntimeInstalledSorted.some(row => row.version === inst.version && row.ready !== false && [preferredArchitecture, "universal"].includes(installArchitecture(row)))) &&
      (activeRuntimeSection.defaultVariant ? inst.variant === activeRuntimeSection.defaultVariant : true));
    const variantLabel = activeRuntimeHasMultipleVariants && inst.variant
      ? activeRuntimeVariants.find((variant: any) => variant.id === inst.variant)?.label || inst.variant : "";
    const label = [activeRuntimeVersionTag(inst.version), translatorBuild ? cpuLabel(translatorBuild) : otherBuild ? architectureLabel(otherBuild) : "",
      variantLabel, inst.custom ? "Custom" : ""].filter(Boolean).join(" · ");
    return { install: inst, isDefault, defaultFor, translatorBuild, otherBuild, variantLabel, label };
  }) : [];
  // A default shared by several sections can be installed in another one.
  // Only a downloaded runtime's default can be fetched later; a registered
  // application's list says only that none is registered.
  const defaultMissing = Boolean(activeRuntimeSection && activeRuntimeSupportsDefault && !defaultSelections && activeRuntimeSection.defaultVersion &&
    !managementPresentation.local &&
    ![activeRuntimeSection, ...(Array.isArray(activeRuntimeManager?.sections) ? activeRuntimeManager!.sections : [])]
      // A default can also be a copy that another runtime includes.
      .some((section: any) => ["installed", "references"].flatMap(key => Array.isArray(section?.[key]) ? section[key] : [])
        .some((inst: any) => inst.version === activeRuntimeSection.defaultVersion)));
  // Per-operation defaults keep their table's own choices.
  const defaultMenu = activeRuntimeSection && activeRuntimeSupportsDefault && !defaultSelections &&
    (installedRows.some(row => runtimeRowDefaultable(row.install)) || activeRuntimeSection.defaultSource === "saved")
    // The menu lists versions newest first, whatever order the list below uses.
    ? runtimeDefaultMenu(activeRuntimeSection, sortInstalled(activeRuntimeInstalledSorted, "newest")
      .map(install => installedRows.find(row => row.install === install)!), activeRuntimeVersionTag) : null;
  // A list of registered applications already has its own registration action, such as Add CrossOver…, so it offers no second one.
  const registerCustom = Boolean(activeRuntimeSection?.customRuntime && onRuntimeRegister &&
    !(activeRuntimeSection.catalog?.delivery === "local" && activeRuntimeSection.catalog?.importable) &&
    !activeRuntimeSection.catalog?.sources?.some((source: Record<string, any>) => source.delivery === "local-files" && source.registrationLabel));

  return (
    <main className="launcherView runtimesView" aria-labelledby="runtimes-title">
        <LauncherViewHeader title="Runtimes" titleId="runtimes-title" />
        <div className="launcherSidebarLayout">
          <SearchableSidebar label="Runtime groups" searchLabel="Search runtimes" selectedId={activeRuntimeGroup?.id || null}
            selectionKey={`${navigationKey ?? 0}:${activeRuntimeChoice?.id || ""}`}
            panelId={`runtime-group-panel-${activeRuntimeGroup?.id || "empty"}`}
            items={runtimeGroups.map(group => ({ id: group.id, label: group.label, heading: group.heading,
              keywords: group.managers.flatMap(manager => [manager.id, manager.label,
                ...runtimeGroupSections(group, resolveRuntimeSections).map(choice => choice.label)]) }))}
            accessory={<PopoverButton className="runtimeDownloadMenu" buttonClassName="btn iconOnly runtimeDownloadToggle"
              popoverClassName="menuPopover runtimeDownloadDropdown" ariaLabel="Downloads" title="Downloads"
              label={<><DownloadIcon />{downloadTasks.length > 0 && <span className="runtimeDownloadBadge">{downloadTasks.length}</span>}</>}>
              {downloadTasks.length === 0 ? (
                <div className="runtimeDownloadEmpty">
                  No active downloads.
                </div>
              ) : (
                downloadTasks.map(task => <DownloadProgress key={task.id} task={task} onCancel={onCancelDownload} />)
              )}
            </PopoverButton>}
            onSelect={(id, query) => { const group = runtimeGroups.find(group => group.id === id); if (group) selectGroup(group, query); }} />
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
          <ShaderCollections active={shaderLibrary} collections={activeRuntimeChoices.filter(choice => choice.manager.ui?.library === "shaders")} selectedId={activeRuntimeChoice?.id}
            onSelectCollection={selectSection}>
          {componentLibrary ? <ComponentsView navigationKey={navigationKey} /> : pluginLibrary && activeRuntimeManager ? <PluginLibrary key={activeRuntimeManager.id}
            manager={activeRuntimeManager} sections={activeRuntimeChoices.filter(choice => choice.managerId === activeRuntimeManager.id)}
            state={state} api={settingsApi} ui={activeRuntimeUi} downloads={downloadTasks}
            onInstall={onRuntimeInstall} onUninstall={onRuntimeUninstall} onOpenSource={onOpenSource}
            onRefresh={onRuntimeRefresh} onSetDefault={(managerId, sectionId, version) => onRuntimeSetDefault(managerId, sectionId, version)}
            onSelect={updateRuntimeUiSection} /> : activeRuntimeManager && activeRuntimeSection ? (
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

                <ErrorText error={activeRuntimeUi.error} inline className="runtimeError" />
                {!componentGroup && activeRuntimeDownloads.map(task => <DownloadProgress key={task.id} task={task} onCancel={onCancelDownload} />)}
                {Array.isArray(componentsSection?.components) && componentsSection.components.length > 0 &&
                  <section className="runtimeSectionCard" aria-label={componentsSection.componentsTitle || "Components"}>
                    <div className="runtimeSectionHeader"><div>
                      {/* One help button, beside the heading, explains each component by name; each name keeps its explanation as a tooltip. */}
                      <div className="runtimeSectionTitle">{componentsSection.componentsTitle || "Components"}
                        <SectionHelp label="About runtime components" items={helpItems(componentsSection.components.map((component: Record<string, any>) =>
                          ({ label: component.label, text: componentHelpText(component) })))}>
                          {componentsSection.componentsDescription && <p>{componentsSection.componentsDescription}</p>}
                        </SectionHelp>
                      </div>
                    </div></div>
                    <dl className="runtimeComponents">
                      {componentsSection.components.map((component: Record<string, any>) => <div className="runtimeComponent" key={component.id}>
                        <dt><span className="runtimeComponentName" title={componentHelpText(component) || undefined}>{component.label}</span>
                          {component.version && <span className="runtimeComponentVersion">{component.version}</span>}
                        </dt>
                        <dd><span className={`runtimeComponentStatus${component.available ? " available" : ""}`}>{component.status}</span>
                          {componentChoices.has(component.id) && (() => {
                            const choice = componentChoices.get(component.id)!, active = choice.id === activeRuntimeChoice?.id;
                            return <button type="button" className="btn small" aria-pressed={active}
                              aria-label={`Manage ${component.label}`} onClick={() => selectSection(choice)}>Manage</button>;
                          })()}
                        </dd>
                        {(component.capabilities || componentChoices.get(component.id)?.section.capabilities)?.length > 0 &&
                          <ul className="runtimeComponentCapabilities" aria-label={`${component.label} models`}>
                            {(component.capabilities || componentChoices.get(component.id)!.section.capabilities).map((row: Record<string, any>) => <li key={row.id}>
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
                          {summaryPresentation.latestAvailableVersion && <div>Latest available {activeRuntimeVersionTag(summaryPresentation.latestAvailableVersion)}</div>}
                          {summaryPresentation.latestInstalledVersion && <div>Latest installed {activeRuntimeVersionTag(summaryPresentation.latestInstalledVersion)}</div>}
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
                    {/* Small controls keep this header the height of the Versions header. */}
                    {managementPresentation.local && <div className="runtimePanelHeaderActions">
                      <button
                        className={`btn small iconOnly runtimeRefresh${refreshing ? " refreshing" : ""}`}
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
                          className="btn small"
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
                    {/* The Operation menu is laid out as the Version row below it: a muted label and a small menu sized to its choices. */}
                    {itemGroups.length > 0 && <div className="runtimeSourceRow runtimeItemGroupRow"><label htmlFor="runtime-item-group" className="runtimeSourceName">Operation</label>
                      <select id="runtime-item-group" className="input inputSmall runtimeVersionSelect runtimeItemGroup" value={selectedItemGroup}
                        onChange={event=>setItemGroup({section:groupKey,id:event.target.value})}>
                        <option value="all">All operations</option>{itemGroups.map((group:Record<string,any>)=><option key={group.id} value={group.id}>{group.label}</option>)}
                      </select></div>}
                    {managementPresentation.local && activeRuntimeSection.catalog?.description && <p className="dim">{activeRuntimeSection.catalog.description}</p>}
                    {/* A download source shows the section's links beside its own; other lists show them here. */}
                    {(managementPresentation.local || activeRuntimeSection.catalog?.packagesFrom) && runtimeDistinctLinks(activeRuntimeSection.sourceLinks || []).length > 0 &&
                      <div className="runtimeSourceLinks">
                        {runtimeDistinctLinks(activeRuntimeSection.sourceLinks || []).map(link => <a key={link.url} href={link.url} className="runtimeSourceLink"
                          title={link.url} onClick={event => { event.preventDefault(); onOpenSource?.(link.url); }}>{link.label}</a>)}
                      </div>}
                    {refreshing && <div className="runtimeMeta">
                      <span className="dim" role="status">{managementPresentation.refreshingLabel}…</span>
                    </div>}
                    {summaryPresentation.actionMessage && (managementPresentation.local || !runtimeMessage?.startsWith("Versions updated")) && <div className="dim runtimeActionStatus" role="status">{summaryPresentation.actionMessage}</div>}

                    {managementPresentation.local && activeRuntimeSection.catalog?.status === "error" &&
                      <ErrorText error={activeRuntimeSection.catalog?.error} inline />}

                    {/* A runtime whose packages another runtime installs names that runtime instead of an empty download list. */}
                    {!managementPresentation.local && activeRuntimeSection.catalog?.packagesFrom && (() => {
                      const from = activeRuntimeSection.catalog.packagesFrom;
                      const target = runtimeManagers.find(manager => manager.id === from.managerId);
                      const label = from.label || target?.label || from.managerId;
                      return <div className="runtimeMeta runtimePackagesFrom">
                        <span className="dim">{label} installs these versions, and its panel lists their downloads and updates.</span>
                        {target && <button type="button" className="btn small" onClick={() => {
                          setRuntimeManagerId(target.id);
                          setRuntimeSectionId(from.sectionId || target.sections?.[0]?.id || "default");
                        }}>Open {label}</button>}
                      </div>;
                    })()}
                    {!managementPresentation.local && !activeRuntimeSection.catalog?.packagesFrom && (
                      <RuntimeCatalogSources managerId={activeRuntimeManager.id} section={activeRuntimeSection}
                        identity={tabStrip ? activeSectionTab?.label : activeRuntimeIdentity} links={activeRuntimeSection.sourceLinks}
                        cpuBuildLabels={activeRuntimeManager.ui?.cpuBuildLabels === true}
                        ui={activeRuntimeUi} busy={runtimeBusy} variant={activeRuntimeResolvedInstallVariant}
                        downloads={activeRuntimeDownloads} onOpenSource={onOpenSource}
                        onRegister={activeRuntimeSection.customRuntime && onRuntimeRegister ? runtimePath => onRuntimeRegister(activeRuntimeManager.id, activeRuntimeSection.id, runtimePath) : undefined}
                        pathForFile={getPathForFile}
                        onRefresh={options => onRuntimeRefresh(activeRuntimeManager.id, activeRuntimeSection.id, options)}
                        onSelect={(key, field, value) => updateRuntimeUiSection(activeRuntimeManager.id, key, field, value)}
                        onInstall={(version, variant, architecture) => architecture ? onRuntimeInstall(activeRuntimeManager.id, activeRuntimeSection.id, version, variant, architecture) : onRuntimeInstall(activeRuntimeManager.id, activeRuntimeSection.id, version, variant)} />
                    )}
                    {activeRuntimeSection.catalog?.importable && onRuntimeImport && <div className="runtimeImport">
                      <button className="btn small" disabled={Boolean(pendingAction) || Boolean(activeRuntimeSection.catalog.importVersionRequired && !activeRuntimeInstallVersion)}
                        title={activeRuntimeSection.catalog?.importDescription || undefined}
                        onClick={() => onRuntimeImport(activeRuntimeManager.id, activeRuntimeSection.id,
                          activeRuntimeSection.catalog.importVersionRequired ? activeRuntimeInstallVersion : undefined)}>
                        {pendingAction === "import" ? managementPresentation.importBusyLabel : activeRuntimeSection.catalog.importLabel || "Import runtime…"}
                      </button>
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
                            {setup.versions.map((version: string) => <option key={version} value={version} title={version}>{formatRuntimeVersionTag(version, setup)}</option>)}
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
                    {(defaultMenu || showInstalledSort) && <span className="runtimeInstalledHeaderRight">
                      {defaultMenu && <RuntimeDefaultMenu id={`runtime-default-${encodeURIComponent(activeRuntimeManager.id)}-${encodeURIComponent(activeRuntimeSection.id)}`}
                        ariaLabel="Default version" menu={defaultMenu} disabled={runtimeBusy}
                        onChoose={choice => onRuntimeSetDefault(activeRuntimeManager.id, activeRuntimeSection.id, choice.version, choice.variant, undefined, choice.architecture)} />}
                      {showInstalledSort && <select
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
                      </select>}
                    </span>}
                  </div>
                  {/* An empty list says only that its default is not installed yet, in the empty line's place. */}
                  {defaultMissing && installedRows.length > 0 && <div className="dim runtimeAvailability runtimeDefaultMissing" data-runtime-default-missing="true">
                    The default version, {activeRuntimeVersionTag(activeRuntimeSection.defaultVersion)}, is not installed. MacLauncher asks before downloading it when a game needs it.
                  </div>}
                  {installedRows.length === 0 ? (
                    defaultMissing ? <div className="empty runtimeDefaultMissing" data-runtime-default-missing="true">
                      The default version, {activeRuntimeVersionTag(activeRuntimeSection.defaultVersion)}, is not installed. MacLauncher asks before downloading it when a game needs it.
                    </div> : <div className="empty">{managementPresentation.emptyLabel}</div>
                  ) : (
                    <div className="saveList">
                      {installedRows.map(({ install: inst, isDefault, defaultFor, translatorBuild, otherBuild, variantLabel, label }) => {
                        // Make default beside each usable row keeps the Default menu's choice one click away.
                        const makeDefault = runtimeMakeDefaultChoice({ install: inst, isDefault, label },
                          { supportsDefault: activeRuntimeSupportsDefault, perOperation: Boolean(defaultSelections) });
                        // A runtime with a default per operation offers Make default for each operation the row serves.
                        const operationDefaults = activeRuntimeSupportsDefault && defaultSelections
                          ? runtimeOperationDefaults(inst, defaultSelections).filter(scope => scope.makeDefault) : [];
                        const installDetail = typeof inst.detail === "string" && inst.detail.trim() ? inst.detail.trim() : "";
                        const apis = (Array.isArray(inst.apis) ? inst.apis : Array.isArray(inst.translator?.apis) ? inst.translator.apis : [])
                          .filter((api: unknown): api is string => typeof api === "string").sort((a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }));
                        // Where the row comes from and what it holds is on hover over its name.
                        const about = [inst.platformKey, installDetail,
                          ...Object.entries(inst.libraries || {}).flatMap(([id, library]: [string, any]) => library.ready
                            ? [`${library.label || id} ${library.version || library.apiProfile || ""}`.trim()] : []),
                          (!isRuntimeIncluded(inst) || inst.reference) && !inst.custom ? inst.installDir : ""].filter(Boolean).join("\n");
                        return (
                          <div
                            className="saveRow"
                            key={`${inst.version}-${inst.platformKey}-${inst.variant}-${inst.architecture}`}
                          >
                            <div className="saveRowMain">
                              <div className="saveName">
                                <span title={about || undefined}>{activeRuntimeVersionTag(inst.version)}</span>
                                {translatorBuild ? <span className="badge" data-cpu-build={translatorBuild} title="CPU build">{cpuLabel(translatorBuild)}</span>
                                  : otherBuild && <span className="badge">{architectureLabel(otherBuild)}</span>}
                                {isDefault && (
                                  <span className="badge badgeAccent" title={defaultFor.length ? `Automatic for ${defaultFor.join(", ")}` : undefined}>Default</span>
                                )}
                                {inst.ready === false && <StatusBadge tone="warning">{availabilityLabel(installedRuntimeAvailability(inst) || "needsRepair")}</StatusBadge>}
                                {isRuntimeIncluded(inst) && <StatusBadge>{availabilityLabel("included")}</StatusBadge>}
                                {inst.custom && <span className="badge">Custom</span>}
                                {variantLabel && <span className="badge">{variantLabel}</span>}
                              </div>
                              {/* A registration is told apart from an installed copy of the same release by its own folder. */}
                              {inst.custom && (inst.installDir || inst.version) && <div className="dim mono runtimeRegisteredPath"><PathDisplay path={inst.installDir || inst.version} /></div>}
                              {inst.installDir && installSizes[inst.installDir] && <div className="dim" data-runtime-size="true">
                                {componentSizeText({ path: inst.installDir, bytes: installSizes[inst.installDir].bytes, sizeComplete: installSizes[inst.installDir].complete })}</div>}
                              {runtimeMinimumDetail(inst.minimumMacOS) && <div className="dim">{runtimeMinimumDetail(inst.minimumMacOS)}</div>}
                              {apis.length > 0 && <div className="dim">{apis.join(", ")}</div>}
                              {runtimeIncludedParts(inst.componentSummary).length > 0 &&
                                <div className="dim" data-runtime-components="true">Includes {runtimeIncludedParts(inst.componentSummary).map((part, index) =>
                                  <React.Fragment key={index}>{index ? " · " : ""}<span className="runtimeIncludedPart">{part}</span></React.Fragment>)}</div>}
                              {inst.error && <div className="dim">{formatUserError(inst.error)}</div>}
                            </div>
                            {(!inst.reference || makeDefault) && <div className="saveRowActions">
                              {makeDefault && <button type="button" className="btn small" disabled={runtimeBusy} title={`Make ${makeDefault.label} the default`}
                                onClick={() => onRuntimeSetDefault(activeRuntimeManager.id, activeRuntimeSection.id, makeDefault.version,
                                  makeDefault.variant, undefined, makeDefault.architecture)}>Make default</button>}
                              {operationDefaults.map(scope => <button type="button" className="btn small" key={scope.id} disabled={runtimeBusy}
                                title={`Make ${label} the default for ${scope.label}`}
                                onClick={() => onRuntimeSetDefault(activeRuntimeManager.id, activeRuntimeSection.id, inst.version, inst.variant, scope.id)}>
                                Make default for {scope.label}</button>)}
                              {/* An included copy offers Make default only; it is never repaired or removed here. */}
                              {onRuntimeInstalledAction && !inst.reference && (inst.actions || []).filter((action: any) => action.available !== false).map((action: any) =>
                                <button className="btn small" key={action.id} disabled={runtimeBusy}
                                  onClick={() => onRuntimeInstalledAction(activeRuntimeManager.id, activeRuntimeSection.id, inst.version, action.id, inst.architecture)}>
                                  {action.label}
                                </button>)}
                              {!inst.reference && inst.removable !== false && <button
                                className="btn small iconOnly danger"
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
                            </div>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {registerCustom && <div className="runtimeInstalledFooter">
                    <button className="btn small" disabled={runtimeBusy}
                      title={activeRuntimeSection.registrationPresentation?.description || "Register a compatible executable, application or runtime directory in this list. Files remain in their original location."}
                      onClick={() => onRuntimeRegister!(activeRuntimeManager.id, activeRuntimeSection.id)}>
                      {pendingAction === "registerCustom" ? "Registering…" : activeRuntimeSection.registrationPresentation?.label || "Register custom…"}
                    </button>
                  </div>}
                </div>}
              </div>
            </div>
          ) : (
            <div className="empty">No runtime managers available.</div>
          )}
          </ShaderCollections>
          </RuntimeComponentGroup>)}
          </div>
        </div>
          </div>
        </div>
    </main>
  );
}

// Shared by the utility page and the library inspector's Install action.
export function useRuntimeManagement(api: NonNullable<Window["MacLauncher"]>["launcher"] | undefined, state: LauncherState | null, runtimesOpen: boolean, initialManager?: string) {
  const [runtimeManagerId, setRuntimeManagerId] = useState<string | null>(initialManager || null);
  const [runtimeSectionId, setRuntimeSectionId] = useState<string | null>(null);
  const [runtimeUi, setRuntimeUi] = useState<RuntimeUiState>({});
  const runtimeActionLocks = useRef(new Set<string>());
  const navigation = useRef<number | undefined>(undefined);
  if (runtimesOpen && state?.utilityWindow?.managerId && navigation.current !== state.utilityWindow.revision) {
    navigation.current = state.utilityWindow.revision;
    setRuntimeManagerId(state.utilityWindow.managerId);
    setRuntimeSectionId(null);
  }

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
          const currentVersion = installVersion[section.id];
          const nextVersion = currentVersion || runtimeInstallVersion(section);
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

  function updateRuntimeUiSection(
    managerId: string,
    sectionId: string,
    key: "remoteOpen" | "installVersion" | "installVariant" | "installArchitecture" | "installedSort",
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
    const sourceId = action === "refreshCatalog" && typeof payload.sourceId === "string" ? payload.sourceId : undefined;
    const sourceRefresh = action === "refreshCatalog" &&
      !runtimeManagementPresentation(resolveRuntimeSection(state?.runtimeManagers[managerId] || null, sectionId)).local;
    const actionKey = runtimeSourceUiKey(sectionId, sourceId);
    const key = JSON.stringify([managerId, actionKey]);
    if (runtimeActionLocks.current.has(key)) return;
    runtimeActionLocks.current.add(key);
    const updateAction = (pending: string | null, message: string | null, error: string | null = null) => {
      setRuntimeUi(prev => {
        const current = prev[managerId] || { remoteOpen: {}, installVersion: {}, installVariant: {}, installedSort: {}, error: null };
        return { ...prev, [managerId]: { ...current,
          ...(sourceRefresh ? { sourceErrors: { ...current.sourceErrors, [actionKey]: error } } : { error }),
          pendingActions: { ...current.pendingActions, [actionKey]: pending },
          messages: { ...current.messages, [actionKey]: message } } };
      });
    };
    updateAction(runtimePendingAction(action, payload), null);
    try {
      const result = await api.runtimeAction(managerId, action, payload);
      const section = resolveRuntimeSection(state?.runtimeManagers[managerId] || null, sectionId);
      const { local, localFiles } = runtimeManagementPresentation(section);
      const message = result === false ? null : action === "refreshCatalog"
        ? localFiles ? "Files updated." : local ? "Applications updated." : `Versions updated at ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`
        : action === "import" ? localFiles ? "File imported." : local ? "Application added." : "Runtime imported." : action === "install" ? "Runtime installed."
        : action === "registerCustom" ? "Runtime registered."
        : action === "setup" ? result?.message || "Tool setup complete."
        : action === "installedAction" ? "Updated."
        : action === "uninstall" ? localFiles ? "File removed." : "Runtime removed." : "Default updated.";
      updateAction(null, message);
      return result;
    } catch (e: any) {
      updateAction(null, null, String(e?.message || e));
      return false;
    } finally {
      runtimeActionLocks.current.delete(key);
    }
  }

  async function onRuntimeRefresh(
    managerId: string,
    sectionId: string,
    options: RuntimeRefreshOptions = {}
  ) {
    const payload = runtimeRefreshPayload(sectionId, options);
    return onRuntimeAction(managerId, "refreshCatalog", payload);
  }

  async function onRuntimeImport(managerId: string, sectionId: string, version?: string) {
    return onRuntimeAction(managerId, "import", { sectionId, ...(version ? { version } : {}) });
  }

  async function onRuntimeRegister(managerId: string, sectionId: string, runtimePath?: string) {
    return onRuntimeAction(managerId, "registerCustom", { sectionId, ...(runtimePath ? { runtimePath } : {}) });
  }

  async function onRuntimeSetupAction(managerId: string, sectionId: string, setupActionId: string, toolVersion?: string) {
    return onRuntimeAction(managerId, "setup", { sectionId, setupActionId, toolVersion });
  }

  async function onRuntimeInstalledAction(managerId: string, sectionId: string, version: string, installedActionId: string, architecture?: string) {
    return onRuntimeAction(managerId, "installedAction", { sectionId, version, installedActionId, ...(architecture ? {architecture} : {}) });
  }

  async function onRuntimeInstall(
    managerId: string,
    sectionId: string,
    version: string,
    variant?: string,
    architecture?: string
  ) {
    return onRuntimeAction(managerId, "install", { sectionId, version, variant, ...(architecture ? {architecture} : {}) });
  }

  async function onRuntimeSetDefault(
    managerId: string,
    sectionId: string,
    version: string | null,
    variant?: string,
    selectionId?:string,
    architecture?: string
  ) {
    return onRuntimeAction(managerId, "setDefault", { sectionId, version, variant,...(selectionId?{selectionId}:{}), ...(architecture ? {architecture} : {}) });
  }

  async function onRuntimeUninstall(
    managerId: string,
    sectionId: string,
    install: Record<string, any>
  ) {
    if (!api) return;
    const section = resolveRuntimeSection(state?.runtimeManagers[managerId] || null, sectionId);
    const removal = runtimeRemovalPresentation(install, section);
    const ok = await confirmAction({ message: removal.confirm, confirmLabel: removal.label, destructive: true });
    if (!ok) return;
    return onRuntimeAction(managerId, "uninstall", {
      sectionId,
      version: install.version,
      architecture: install.architecture,
      variant: install.variant,
      platformKey: install.platformKey,
      installDir: install.installDir
    });
  }

  return {runtimeManagerId, setRuntimeManagerId, runtimeSectionId, setRuntimeSectionId, runtimeUi,
    updateRuntimeUiSection, onRuntimeRefresh, onRuntimeInstall, onRuntimeImport, onRuntimeRegister,
    onRuntimeSetupAction, onRuntimeInstalledAction, onRuntimeSetDefault, onRuntimeUninstall};
}

// The native utility entry loads this component only when Runtimes is needed.
export function UtilityRuntimesView({state, api, navigationKey, onOpenSource}: {
  state: LauncherState;
  api: NonNullable<Window["MacLauncher"]>["launcher"] | undefined;
  navigationKey?: number;
  onOpenSource?: (url: string) => void;
}) {
  const management = useRuntimeManagement(api, state, true, state.utilityWindow?.managerId);
  const runtimeManagers = useMemo(() => Object.values(state.runtimeManagers || {}), [state.runtimeManagers]);
  const downloadTasks = useMemo(() => (state.downloads || []).filter(task => task.status === "downloading"), [state.downloads]);
  return <RuntimesView {...management} state={state} settingsApi={api} getPathForFile={api?.getPathForFile}
    runtimeManagers={runtimeManagers} navigationKey={navigationKey} downloadTasks={downloadTasks}
    onCancelDownload={id => api?.cancelDownload(id)} onOpenSource={onOpenSource} />;
}

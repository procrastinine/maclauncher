import React from "react";
import type { DownloadTask, RuntimeRefreshOptions, RuntimeUiState } from "../types";
import { isRuntimeVersionInstalled, runtimeVersionTagger, withAvailability } from "../ui-helpers";
import { cpuLabel } from "../../../../core/cpu-labels.mjs";
import { installedRuntimeAvailability } from "../../../../core/runtime-install-availability.mjs";
import { ErrorText } from "./ErrorText";
import { RefreshIcon } from "../icons";
import { Select } from "./Select";
import { isRuntimeIncluded, runtimeInstallVersion, runtimeCatalogPresentation, runtimeCatalogSources, runtimeDistinctLinks, runtimeRefreshFailure, runtimeSourceUrl, runtimeSourceUiKey,
  runtimeVersionBlocked, translatorVersionBuild } from "./runtime-tabs-model";

type Props = {
  managerId: string;
  section: Record<string, any>;
  ui: RuntimeUiState[string];
  busy: boolean;
  variant: string;
  downloads: DownloadTask[];
  onSelect: (key: string, field: "installVersion" | "installVariant" | "installArchitecture", value: string) => void;
  onInstall: (version: string, variant?: string, architecture?: string) => void;
  onRefresh: (options: RuntimeRefreshOptions) => void;
  onOpenSource?: (url: string) => void;
  onRegister?: (runtimePath?: string) => void;
  pathForFile?: (file: File) => string | null;
  /** Translator views name a version's CPU build when it differs from the chosen
   * build, and keep the Build menu under Additional sources. */
  cpuBuildLabels?: boolean;
  /** The panel's own name (its title or tab), which a single source does not repeat. */
  identity?: string;
  /** Links the section itself declares, shown with its source's links. */
  links?: Array<{ label?: string; url?: string }>;
};

// A source's own description; nothing is written for it from its URL.
function sourceDescription(source: Record<string, any>) {
  return typeof source.description === "string" ? source.description.trim() : "";
}

export function RuntimeCatalogSources({ managerId, section, ui, busy, variant, downloads, onSelect, onInstall, onRefresh, onOpenSource, onRegister, pathForFile, cpuBuildLabels = false, identity = "", links: sectionLinks = [] }: Props) {
  // The automatic CPU is the one Play uses: the launcher's own, or another CPU
  // this Mac runs when the launcher's CPU has no build.
  const defaultArchitecture = section.automaticArchitecture || section.launcherArchitecture || section.catalog?.architecture;
  const architectureCatalogs = section.catalog?.architectureCatalogs || {};
  // The Build override offers another CPU this Mac can run (the main process has
  // already removed the others) when that CPU's list declares builds made for
  // it. Universal builds and downloads that name no CPU serve every Mac and
  // appear in every list.
  const listed = (catalog: Record<string, any> | undefined) => runtimeCatalogSources(catalog).flatMap(source =>
    source.versions.map((version: string) => source.versionRequirements?.[version]?.architecture || null));
  // An automatic list made only of another CPU's builds, such as Intel-only
  // builds on Apple Silicon, already shows them. An empty one, such as an
  // Apple-Silicon-only runtime in the Intel app on Apple Silicon, offers them.
  const ownBuilds = listed(architectureCatalogs[defaultArchitecture] || section.catalog)
    .some(cpu => !cpu || cpu === defaultArchitecture || cpu === "universal");
  const overrides = ownBuilds || listed(section.catalog).length === 0 ? Object.keys(architectureCatalogs).filter(key =>
    key !== defaultArchitecture && listed(architectureCatalogs[key]).includes(key)) : [];
  const offersBuilds = overrides.length > 0;
  const chosenArchitecture = ui.installArchitecture?.[section.id];
  const architecture = offersBuilds && chosenArchitecture && overrides.includes(chosenArchitecture) ? chosenArchitecture : defaultArchitecture;
  const selectedCatalog = architecture !== defaultArchitecture ? architectureCatalogs[architecture] || section.catalog : section.catalog;
  const sources = runtimeCatalogSources(selectedCatalog);
  // An installed build counts for the selected CPU when it is made for it or when
  // the selected list itself offers that build, such as an Intel-only version.
  // With one list for every CPU, or an installation made with this build choice,
  // the installed version is that build even when its binary is for another CPU
  // (Wine and the libraries it loads are x86_64).
  const installed = (Array.isArray(section.installed) ? section.installed : []).filter((item: any) =>
    !architecture || !Object.keys(architectureCatalogs).length || item.variant === `architecture:${architecture}` ||
    !item.architecture || item.architecture === "universal" || item.architecture === architecture ||
    item.architecture === selectedCatalog?.versionRequirements?.[item.version]?.architecture);
  const incompleteInstalled = installed.filter((item:any)=>item.ready!==false&&Array.isArray(item.missingComponents)&&item.missingComponents.length>0);
  const readyInstalled = installed.filter((item: any) => item.ready !== false&&!incompleteInstalled.includes(item));
  // A copy that installing its version again repairs, or replaces with the different package its version lists.
  const repairableInstalled = installed.filter((item: any) => installedRuntimeAvailability(item) === "needsRepair" || item.status === "incompatible");
  // The reading of a version's unusable copy: needs repair, incompatible or unavailable.
  const unusableState = (value: string) => {
    const states = installed.filter((item: any) => isRuntimeVersionInstalled([item], value, selectedVariant, hasVariants))
      .map((item: any) => installedRuntimeAvailability(item));
    return (["needsRepair", "incompatible", "unavailable"] as const).find(state => states.includes(state)) || null;
  };
  const variants = !section.architectureVariants && Array.isArray(section.variants) ? section.variants : [];
  const hasVariants = variants.length > 0;
  const selectedVariant = hasVariants ? [variant, section.defaultVariant, variants[0]?.id]
    .find(value => variants.some((item: any) => item.id === value)) || "" : "";
  function link(url: string, label: string) {
    return <a className="runtimeSourceLink" href={url} title={url}
      onClick={event => { if (onOpenSource) { event.preventDefault(); onOpenSource(url); } }}>{label}</a>;
  }
  const primary = sources.filter(source => !source.secondary);
  const renderSource = (group: Record<string, any>) => {
      const groupKey = runtimeSourceUiKey(section.id, group.explicit ? group.id : undefined);
      const sourceVariants: Array<Record<string, any>> = Array.isArray(group.variants) ? group.variants : [];
      const availableVariants = sourceVariants.filter(item => item.catalog?.versions?.length > 0);
      const sourceVariant = availableVariants.find(item => item.id === ui.installVariant[groupKey]) || availableVariants[0] || sourceVariants[0];
      const source = sourceVariant ? { ...sourceVariant.catalog, id: group.id, label: group.label, description: group.description,
        explicit: group.explicit, secondary: group.secondary, status: group.status, error: group.error, failedAt: group.failedAt, fetchedAt: group.fetchedAt } : group;
      const key = runtimeSourceUiKey(section.id, source.explicit ? source.id : undefined);
      const versions: string[] = [...new Set([...(Array.isArray(source.versions) ? source.versions : []),
        ...installed.map((item: any) => item.version)])];
      const requested = ui.installVersion[key] || ui.installVersion[section.id];
      const recommendation = source.recommendedVersion || section.catalog?.recommendedVersion;
      const sourceSection = { ...section, installed, versionLabels: source.versionLabels || section.versionLabels, catalog: { ...source, versions } };
      const versionTag = runtimeVersionTagger(sourceSection);
      const version = runtimeInstallVersion(sourceSection, requested, recommendation);
      const presentation = runtimeCatalogPresentation(source, version, selectedVariant);
      const canInstallVersion = (value: string) => source.installable !== false && source.versionRequirements?.[value]?.installable !== false &&
        source.versionRequirements?.[value]?.variants?.[selectedVariant]?.installable !== false &&
        (!Array.isArray(source.installableVersions) || source.installableVersions.includes(value));
      const canInstall = canInstallVersion(version);
      const isInstalled = isRuntimeVersionInstalled(readyInstalled, version, selectedVariant, hasVariants);
      const needsCompletion=isRuntimeVersionInstalled(incompleteInstalled,version,selectedVariant,hasVariants);
      const needsRepair = !isInstalled&&!needsCompletion&&isRuntimeVersionInstalled(repairableInstalled, version, selectedVariant, hasVariants);
      const included = presentation.included || installed.some((item: any) => item.version === version && isRuntimeIncluded(item) &&
        (!hasVariants || item.variant === selectedVariant));
      const downloading = downloads.some(task => task.version === version && (!hasVariants || task.variant === selectedVariant));
      const recommended = typeof recommendation === "string" && versions.includes(recommendation) ? recommendation : null;
      const recommendedPresentation = recommended ? runtimeCatalogPresentation(source, recommended, selectedVariant) : null;
      const recommendedInstalled = recommended && isRuntimeVersionInstalled(readyInstalled, recommended, selectedVariant, hasVariants);
      const recommendedDownloading = recommended && downloads.some(task => task.version === recommended && (!hasVariants || task.variant === selectedVariant));
      const url = runtimeSourceUrl(source.source || source.url);
      const label = source.label || (url ? "Upstream" : "Versions");
      // One source in a panel is not named again: the panel's title or tab names
      // it, and its link carries a name that differs from it, such as MacLauncher
      // Builds, or else the site.
      const named = primary.length > 1;
      const distinctName = source.explicit && label && !["Upstream", "Versions"].includes(label) &&
        label.toLocaleLowerCase() !== identity.toLocaleLowerCase() ? label : "";
      const linkLabel = source.sourceLabel || (named ? source.explicit ? "Releases" : presentation.sourceLabel || "Source"
        : distinctName || presentation.sourceLabel || "Source");
      // The section's links and the catalog's code links follow the source link;
      // a link into the same repository as an earlier one is left out.
      const extraLinks = [...(primary[0] === group ? sectionLinks : []),
        ...(sources.length === 1 && Array.isArray(section.catalog?.sourceLinks) ? section.catalog.sourceLinks : [])];
      const links = runtimeDistinctLinks([...(url ? [{ url, label: linkLabel }] : []), ...extraLinks]);
      const pending = ui.pendingActions?.[key];
      const refreshing = pending === "refreshCatalog" || source.status === "loading";
      const sourceBusy = busy || Boolean(pending) || refreshing;
      const refreshLabel = source.explicit ? refreshing ? `Refreshing ${label} versions` : `Reload ${label} versions`
        : refreshing ? "Refreshing versions" : source.refreshLabel || "Reload versions";
      const message = ui.messages?.[key];
      const refreshMessage = source.explicit || message?.startsWith("Versions updated") ? message : null;
      const error = ui.sourceErrors?.[key] || (source.status === "error" ? source.error : null);
      // A source that loaded and lists nothing for this CPU keeps only the small
      // reload control; Load versions is for a source not loaded yet.
      const loaded = versions.length === 0 && source.status === "success" && !error;
      const reload = (latestOnly?: boolean) => onRefresh({ ...(source.explicit ? { sourceId: source.id } : {}),
        ...(latestOnly === undefined ? {} : { latestOnly }) });
      const fieldId = `runtime-version-${encodeURIComponent(managerId)}-${encodeURIComponent(section.id)}-${encodeURIComponent(source.id)}`;
      const description = sourceDescription(source);
      const linkList = links.length > 0 && <span className="runtimeSourceLinks">
        {links.map(item => <React.Fragment key={item.url}>{link(item.url, item.label)}</React.Fragment>)}
      </span>;
      // A file or folder dropped on a local-files card is registered like a chosen one.
      const registerDrop = !sourceBusy && onRegister ? (event: React.DragEvent) => {
        const file = event.dataTransfer.files?.[0] as (File & { path?: string }) | undefined;
        const runtimePath = file && (file.path || pathForFile?.(file));
        if (!runtimePath) return;
        event.preventDefault(); onRegister(runtimePath);
      } : undefined;
      if (source.delivery === "local-files") return <div className="runtimeSource" data-runtime-source={source.id} key={source.id}
        onDragOver={registerDrop ? event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } } : undefined}
        onDrop={registerDrop}>
        <div className="runtimeSourceRow">
          {named && <span className="runtimeSourceName">{label}</span>}
          <button className="btn small" disabled={sourceBusy || !onRegister} title={description || undefined}
            onClick={() => onRegister?.()}>{source.registrationLabel || "Register custom…"}</button>
          <span className="runtimeSourceTrail">{linkList}</span>
        </div>
      </div>;
      // A blocking reason explains the disabled button; otherwise the reason is a requirement note.
      const pendingInstall = Boolean(version) && !isInstalled && !included;
      const blocked = pendingInstall && !canInstall;
      const reason = blocked ? presentation.installReason || "No compatible macOS download is available." : pendingInstall ? presentation.installReason || "" : "";
      // What a version holds, such as its component versions or that they are known after download.
      const contents = pendingInstall && typeof source.versionRequirements?.[version]?.contents === "string" ? source.versionRequirements[version].contents : "";
      const variantChoices = (sourceVariants.length ? availableVariants : variants);
      return <div className="runtimeSource" data-runtime-source={source.id} key={source.id}>
        <div className="runtimeSourceRow">
          {/* Several sources are each named; one source's menu is simply Version. */}
          {versions.length > 0 ? <label className="runtimeSourceName" htmlFor={fieldId}>{named ? label : "Version"}</label>
            : named && <span className="runtimeSourceName">{label}</span>}
          {versions.length === 0 ? loaded ? <span className="dim runtimeAvailability">No downloadable versions found at this source.</span>
            : <button type="button" className="btn small primary" disabled={sourceBusy} aria-busy={refreshing}
              aria-label={source.explicit ? `Load ${label} versions` : "Load versions"}
              onClick={() => reload(source.supportsLatestOnly ? true : undefined)}>
              {refreshing ? "Loading versions…" : "Load versions"}
            </button> : <Select id={fieldId} className="input inputSmall runtimeVersionSelect" aria-label={source.explicit ? `${label} version` : "Version"}
              value={version} onChange={event => onSelect(key, "installVersion", event.target.value)}>
              <option value="" disabled>Choose version</option>
              {versions.map(value => {
                const ready = isRuntimeVersionInstalled(readyInstalled, value, selectedVariant, hasVariants);
                const incomplete=isRuntimeVersionInstalled(incompleteInstalled,value,selectedVariant,hasVariants);
                const unusable = !ready&&!incomplete ? unusableState(value) || (runtimeVersionBlocked(source, value) ? "unavailable" : null) : null;
                const includedVersion = ready && installed.some((item: any) => item.version === value && isRuntimeIncluded(item) &&
                  (!hasVariants || item.variant === selectedVariant));
                const build = cpuBuildLabels ? translatorVersionBuild(value, source, installed) : "";
                // A Universal build includes the chosen CPU, so it is not named either.
                const differs = build && build !== architecture && build !== "universal" ? cpuLabel(build) : "";
                return <option key={value} value={value}>
                  {withAvailability(differs ? `${versionTag(value)} · ${differs}` : versionTag(value), ready ? includedVersion ? "included" : "installed"
                    : incomplete ? "downloadNeeded" : unusable)}
                </option>;
              })}
            </Select>}
          {versions.length > 0 && variantChoices.length > 1 && <select id={`${fieldId}-variant`} className="input inputSmall runtimeVersionSelect"
            aria-label={`${source.explicit ? label + " " : ""}variant`}
            value={sourceVariants.length ? sourceVariant?.id : selectedVariant} onChange={event => onSelect(sourceVariants.length ? key : section.id, "installVariant", event.target.value)}>
            {variantChoices.map((item: any) => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}
          </select>}
          {/* The version menu tags an installed version; the button is only an action. */}
          {versions.length > 0 && !included && (!isInstalled || downloading) && <button className="btn small primary"
            disabled={!canInstall || !version || sourceBusy || downloading}
            title={blocked ? reason : undefined}
            aria-describedby={blocked ? `${fieldId}-reason` : undefined}
            onClick={() => architecture ? onInstall(version, section.architectureVariants ? architecture : selectedVariant || undefined, architecture) : onInstall(version, selectedVariant || undefined)}>
            {downloading ? "Installing…" : needsRepair ? "Reinstall" : presentation.installLabel}
          </button>}
          {recommended && !recommendedInstalled && !recommendedPresentation?.included && <button className="btn small"
            disabled={sourceBusy || !canInstallVersion(recommended) || Boolean(recommendedDownloading)}
            title={recommendedPresentation?.installReason || `Install ${recommended}`}
            onClick={() => architecture ? onInstall(recommended, section.architectureVariants ? architecture : selectedVariant || undefined, architecture) : onInstall(recommended, selectedVariant || undefined)}>Install recommended version</button>}
          <span className="runtimeSourceTrail">
            {linkList}
            {(versions.length > 0 || loaded) && <button type="button" className={`btn small iconOnly runtimeRefresh${refreshing ? " refreshing" : ""}`}
              disabled={sourceBusy} aria-busy={refreshing} title={refreshLabel} aria-label={refreshLabel}
              onClick={() => reload(source.supportsLatestOnly ? true : undefined)}>
              <RefreshIcon />
            </button>}
            {source.supportsLatestOnly && <button type="button" className="btn small" disabled={sourceBusy}
              title={`Reload all ${label} versions`} aria-label={`Reload all ${label} versions`}
              onClick={() => reload(false)}>All versions</button>}
          </span>
        </div>
        {description && <div className="dim runtimeAvailability">{description}</div>}
        {reason && <div className="dim runtimeAvailability" id={`${fieldId}-reason`}>{reason}</div>}
        {contents && <div className="dim runtimeAvailability" data-runtime-contents="true">{contents}</div>}
        {refreshing && <div className="dim runtimeActionStatus" role="status">Refreshing versions…</div>}
        {refreshMessage && !refreshing && <div className="dim runtimeActionStatus" role="status">{refreshMessage.startsWith("Versions updated at ") ? "Versions updated." : refreshMessage}</div>}
        {!refreshing && error && <div className="dim runtimeAvailability">{runtimeRefreshFailure(source.status === "error" ? source : null)}</div>}
        {!refreshing && <ErrorText error={error} inline className="runtimeAvailability" />}
      </div>;
  };
  // Play chooses the build a game needs. The Build menu reads Automatic (the
  // CPU Play uses) and each other CPU this Mac runs, Intel code on Apple
  // Silicon as Intel (Rosetta); translator views keep it under Additional sources.
  const buildField = offersBuilds && <div className="runtimeSourceRow runtimeBuildField">
    <label className="runtimeSourceName" htmlFor={`runtime-architecture-${managerId}-${section.id}`}>Build</label>
    <select id={`runtime-architecture-${managerId}-${section.id}`} className="input inputSmall runtimeVersionSelect"
      value={overrides.includes(architecture) ? architecture : ""}
      aria-label="Build architecture" onChange={event => onSelect(section.id, "installArchitecture", event.target.value)}>
      <option value="">Automatic ({cpuLabel(defaultArchitecture, { hostArchitecture: defaultArchitecture })})</option>
      {overrides.map(value => <option key={value} value={value}>{cpuLabel(value, { hostArchitecture: defaultArchitecture })}</option>)}
    </select>
  </div>;
  const additional = sources.filter(source => source.secondary);
  return <div className="runtimeSources">
    {!cpuBuildLabels && buildField}
    {primary.map(renderSource)}
    {(additional.length > 0 || cpuBuildLabels && buildField) && <details className="runtimeAdditionalSources">
      <summary>Additional sources</summary>
      {cpuBuildLabels && buildField}
      {additional.map(renderSource)}
    </details>}
  </div>;
}

import React from "react";
import type { DownloadTask, RuntimeRefreshOptions, RuntimeUiState } from "../types";
import { formatRuntimeVersionTag, formatUserError, isRuntimeVersionInstalled } from "../ui-helpers";
import { RefreshIcon } from "../icons";
import { isRuntimeIncluded, runtimeCatalogPresentation, runtimeCatalogSources, runtimeSourceUrl, runtimeSourceUiKey } from "./runtime-tabs-model";

type Props = {
  managerId: string;
  section: Record<string, any>;
  ui: RuntimeUiState[string];
  busy: boolean;
  variant: string;
  downloads: DownloadTask[];
  onSelect: (key: string, field: "installVersion" | "installVariant", value: string) => void;
  onInstall: (version: string, variant?: string) => void;
  onRefresh: (options: RuntimeRefreshOptions) => void;
  onOpenSource?: (url: string) => void;
};

export function RuntimeCatalogSources({ managerId, section, ui, busy, variant, downloads, onSelect, onInstall, onRefresh, onOpenSource }: Props) {
  const sources = runtimeCatalogSources(section.catalog);
  const installed = Array.isArray(section.installed) ? section.installed : [];
  const readyInstalled = installed.filter((item: any) => item.ready !== false);
  const variants = Array.isArray(section.variants) ? section.variants : [];
  const hasVariants = variants.length > 0;
  const selectedVariant = hasVariants ? [variant, section.defaultVariant, variants[0]?.id]
    .find(value => variants.some((item: any) => item.id === value)) || "" : "";
  function link(url: string, label: string) {
    return <a className="runtimeSourceLink" href={url} title={url}
      onClick={event => { if (onOpenSource) { event.preventDefault(); onOpenSource(url); } }}>{label}</a>;
  }
  return <div className="runtimeSources">
    {sources.map(source => {
      const key = runtimeSourceUiKey(section.id, source.explicit ? source.id : undefined);
      const versions: string[] = Array.isArray(source.versions) ? source.versions : [];
      const requested = ui.installVersion[key] || ui.installVersion[section.id] || source.recommendedVersion;
      const version = versions.includes(requested) ? requested : versions.includes(source.recommendedVersion) ? source.recommendedVersion : versions[0] || "";
      const sourceSection = { ...section, versionLabels: source.versionLabels || section.versionLabels, catalog: source };
      const presentation = runtimeCatalogPresentation(source, version, selectedVariant);
      const requirements = source.versionRequirements?.[version];
      const variantRequirements = requirements?.variants?.[selectedVariant];
      const canInstall = source.installable !== false && requirements?.installable !== false && variantRequirements?.installable !== false &&
        (!Array.isArray(source.installableVersions) || source.installableVersions.includes(version));
      const isInstalled = isRuntimeVersionInstalled(readyInstalled, version, selectedVariant, hasVariants);
      const needsRepair = !isInstalled && isRuntimeVersionInstalled(installed, version, selectedVariant, hasVariants);
      const included = presentation.included || installed.some((item: any) => item.version === version && isRuntimeIncluded(item) &&
        (!hasVariants || item.variant === selectedVariant));
      const downloading = downloads.some(task => task.version === version && (!hasVariants || task.variant === selectedVariant));
      const url = runtimeSourceUrl(source.source || source.url);
      const sourceLinks = sources.length === 1 && Array.isArray(section.catalog?.sourceLinks)
        ? section.catalog.sourceLinks.flatMap((item: any) => {
          const href = runtimeSourceUrl(item?.url);
          return href ? [{ href, label: item.label || "upstream code" }] : [];
        }) : [];
      const label = source.label || source.sourceLabel || (url ? "Upstream" : "Versions");
      const pending = ui.pendingActions?.[key];
      const refreshing = pending === "refreshCatalog" || source.status === "loading";
      const sourceBusy = busy || Boolean(pending) || refreshing;
      const refreshLabel = source.explicit ? refreshing ? `Refreshing ${label} versions` : `Reload ${label} versions`
        : refreshing ? "Refreshing versions" : source.refreshLabel || "Reload versions";
      const message = ui.messages?.[key];
      const refreshMessage = source.explicit || message?.startsWith("Versions updated") ? message : null;
      const error = ui.sourceErrors?.[key] || (source.status === "error" ? source.error : null);
      const reload = (latestOnly?: boolean) => onRefresh({ ...(source.explicit ? { sourceId: source.id } : {}),
        ...(latestOnly === undefined ? {} : { latestOnly }) });
      const fieldId = `runtime-version-${encodeURIComponent(managerId)}-${encodeURIComponent(section.id)}-${encodeURIComponent(source.id)}`;
      const reason = !canInstall && version && !isInstalled && !included ? presentation.installReason || "No compatible macOS download is available." : "";
      return <div className="runtimeSource" data-runtime-source={source.id} key={source.id}>
        <div className="runtimeSourceHeader">
          <div className="runtimeSourceHeading">
            <span className="runtimeSourceName">{label}</span>
            {url && <span>{link(url, source.explicit ? "Releases" : presentation.sourceLabel || "Source")}</span>}
            {sourceLinks.map((item: any) => <span key={item.href} className="runtimeUpstreamCode">({link(item.href, item.label)})</span>)}
          </div>
          <div className="runtimeSourceRefreshActions">
            <button type="button" className={`btn iconOnly runtimeRefresh${refreshing ? " refreshing" : ""}`}
              disabled={sourceBusy} aria-busy={refreshing} title={refreshLabel} aria-label={refreshLabel}
              onClick={() => reload(source.supportsLatestOnly ? true : undefined)}>
              <RefreshIcon />
            </button>
            {source.supportsLatestOnly && <button type="button" className="btn" disabled={sourceBusy}
              title={`Reload all ${label} versions`} aria-label={`Reload all ${label} versions`}
              onClick={() => reload(false)}>All versions</button>}
          </div>
        </div>
        <div className="runtimeRemote">
          <div className="runtimeRemoteField">
            <label className="fieldLabel" htmlFor={fieldId}>Version</label>
            <select id={fieldId} className="input" aria-label={source.explicit ? `${label} version` : "Version"}
              value={version} disabled={versions.length === 0}
              onChange={event => onSelect(key, "installVersion", event.target.value)}>
              {versions.length ? versions.map(value => {
                const ready = isRuntimeVersionInstalled(readyInstalled, value, selectedVariant, hasVariants);
                const damaged = !ready && isRuntimeVersionInstalled(installed, value, selectedVariant, hasVariants);
                const includedVersion = ready && installed.some((item: any) => item.version === value && isRuntimeIncluded(item) &&
                  (!hasVariants || item.variant === selectedVariant));
                return <option key={value} value={value}>
                  {formatRuntimeVersionTag(value, sourceSection)}{ready ? includedVersion ? " [Included]" : " [Installed]" : damaged ? " [Needs repair]" : ""}
                </option>;
              }) : <option value="">No versions loaded</option>}
            </select>
          </div>
          {versions.length > 0 && variants.length > 1 && <div className="runtimeRemoteField">
            <label className="fieldLabel" htmlFor={`${fieldId}-variant`}>Variant</label>
            <select id={`${fieldId}-variant`} className="input" aria-label={`${source.explicit ? label + " " : ""}variant`}
              value={selectedVariant} onChange={event => onSelect(section.id, "installVariant", event.target.value)}>
              {variants.map((item: any) => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}
            </select>
          </div>}
          {versions.length > 0 && !included && <button className="btn primary"
            disabled={!canInstall || !version || sourceBusy || isInstalled || downloading}
            title={reason || (isInstalled ? "This version is installed." : undefined)}
            aria-describedby={reason ? `${fieldId}-reason` : undefined}
            onClick={() => onInstall(version, selectedVariant || undefined)}>
            {downloading ? "Installing…" : isInstalled ? "Installed" : needsRepair ? "Reinstall" : presentation.installLabel}
          </button>}
        </div>
        {reason && <div className="dim runtimeAvailability" id={`${fieldId}-reason`}>{reason}</div>}
        {refreshing && <div className="dim runtimeActionStatus" role="status">Refreshing versions…</div>}
        {refreshMessage && !refreshing && <div className="dim runtimeActionStatus" role="status">{refreshMessage.startsWith("Versions updated at ") ? "Versions updated." : refreshMessage}</div>}
        {error && !refreshing && <div className="error runtimeAvailability" role="alert">{formatUserError(error)}</div>}
      </div>;
    })}
  </div>;
}

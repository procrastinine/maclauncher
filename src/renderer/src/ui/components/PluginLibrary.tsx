import React, { useRef, useState } from "react";
import type { DownloadTask, LauncherState, RuntimeManagerState, RuntimeSettingField, RuntimeUiState } from "../types";
import { formatDownloadPercent, formatUserError } from "../ui-helpers";
import { RuntimeSettingsWindow, type RuntimeSettingsApi } from "./RuntimeSettingsWindow";
import type { RuntimeTabSection } from "./runtime-tabs-model";
import { runtimeSourceUrl } from "./runtime-tabs-model";
import { ErrorText } from "./ErrorText";

type Props = {
  manager: RuntimeManagerState;
  sections: RuntimeTabSection[];
  state?: LauncherState;
  api?: RuntimeSettingsApi;
  ui: RuntimeUiState[string];
  downloads: DownloadTask[];
  onInstall: (managerId: string, sectionId: string, version: string) => unknown;
  onUninstall: (managerId: string, sectionId: string, install: Record<string, any>) => unknown;
  onOpenSource?: (url: string) => void;
};

export function PluginLibrary({ manager, sections, state, api, ui, downloads, onInstall, onUninstall, onOpenSource }: Props) {
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [source, setSource] = useState("");
  const [scriptPath, setScriptPath] = useState("");
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [changingPlugin, setChangingPlugin] = useState<string | null>(null);
  const updatingRequests = useRef(new Set<string>());
  const [updatingPlugins, setUpdatingPlugins] = useState<Record<string, boolean>>({});
  const [updateResults, setUpdateResults] = useState<Record<string, string>>({});
  const context = manager.ui?.settingsContext;
  const pluginActions = manager.ui?.pluginActions;
  const performPluginAction = async (action: string, payload: Record<string, unknown>) => {
    if (!context || !api?.moduleSettingsAction) return false;
    setActionError(null);
    try { return await api.moduleSettingsAction(context.moduleId, action, payload); }
    catch (error) { setActionError(formatUserError(error));return false; }
  };
  const addPlugin = async (local = false) => {
    if (!pluginActions) return;
    setAdding(true);
    try {
      const result = await performPluginAction(pluginActions.install, { ...(local ? {} : { source: source.trim() }), ...(scriptPath.trim() ? { scriptPath: scriptPath.trim() } : {}) });
      if (result && !(result as any).canceled) { setSource("");setScriptPath(""); }
    } finally { setAdding(false); }
  };
  const updatePlugin = async (id: string) => {
    if (!pluginActions?.update || updatingRequests.current.has(id)) return;
    updatingRequests.current.add(id);
    setUpdatingPlugins(current => ({ ...current, [id]: true }));
    setUpdateResults(current => ({ ...current, [id]: "" }));
    try {
      const result = await performPluginAction(pluginActions.update, { id });
      if (result && !(result as any).canceled)
        setUpdateResults(current => ({ ...current, [id]: (result as any).updated === false ? "Up to date" : "Updated" }));
    } finally {
      updatingRequests.current.delete(id);
      setUpdatingPlugins(current => ({ ...current, [id]: false }));
    }
  };
  const configurationKeys = manager.ui?.configurationFieldKeys || [];
  const pluginKeys = sections.map(choice => choice.section.plugin?.settingKey).filter((key): key is string => typeof key === "string");
  const renderCard = (choice: RuntimeTabSection, control?: React.ReactNode, setField?: (key: string, value: unknown) => Promise<boolean>) => {
    const section = choice.section, plugin = section.plugin || {};
    const version = typeof plugin.version === "string" ? plugin.version : "";
    const installed = (section.installed || []).find((item: Record<string, any>) => item.version === version);
    const otherInstall = installed?.suppliedBy && (section.installed || []).find((item: Record<string, any>) => item.source === "managed" && item.removable !== false);
    const ready = installed && installed.ready !== false;
    const pending = ui.pendingActions?.[choice.sectionId];
    const download = downloads.find(task => task.managerId === manager.id && task.sectionId === choice.sectionId);
    const updating = updatingPlugins[choice.sectionId] === true;
    const busy = Boolean(pending || download || changingPlugin === choice.sectionId || updating);
    const percent = download ? formatDownloadPercent(download) : null;
    const status = pending === "uninstall" ? "Removing…" : updating ? "Updating…" : busy ? percent === null ? "Installing…" : `Installing ${percent}%` : ready ? installed.suppliedBy ? `Provided by ${installed.suppliedBy}` : "Installed" : installed ? "Repair needed" : "Missing";
    const displayVersion = installed?.providedVersion || version;
    const versionLabel = installed?.providedVersionLabel || plugin.versionLabel || (/^[a-f0-9]{40,64}$/i.test(displayVersion) ? displayVersion.slice(0, 12) : displayVersion);
    const source = runtimeSourceUrl(plugin.sourceUrl || section.catalog?.sourceUrl);
    const performAction = async () => {
      const result = await (ready || plugin.custom ? onUninstall(manager.id, choice.sectionId, installed) : onInstall(manager.id, choice.sectionId, version));
      if (result !== false && result !== undefined && typeof plugin.settingKey === "string" && setField) await setField(plugin.settingKey, !ready);
    };
    return <article className="pluginCard" key={choice.id} aria-label={section.label || choice.label}>
      <div className="pluginCardControl">{control || <div className="settingsRow"><div className="pluginCardTitle">{section.label || choice.label}</div>
        {plugin.custom && pluginActions && <label className="inlineCheck settingsToggle"><input type="checkbox" aria-label={`Enable ${section.label || choice.label}`}
          checked={Boolean(ready && plugin.enabled !== false)} disabled={!ready || busy || !api?.moduleSettingsAction}
          onChange={event => { const enabled = event.target.checked;setChangingPlugin(choice.sectionId);
            void performPluginAction(pluginActions.setEnabled, { id: choice.sectionId, enabled }).finally(() => setChangingPlugin(null)); }} /></label>}
      </div>}</div>
      {plugin.description && <p className="pluginCardDescription">{plugin.description}</p>}
      <div className="pluginCardFooter">
        <div className="pluginCardIdentity"><span className={`pluginStatus${ready ? " installed" : installed ? " repair" : ""}`} role="status">{status}</span>
          {versionLabel && <span className="pluginVersion" title={displayVersion}>{versionLabel}</span>}
          {plugin.updateAvailable && plugin.latestVersionLabel && <span className="pluginVersion">Available: {plugin.latestVersionLabel}</span>}
          {source && <a className="runtimeSourceLink" href={source} onClick={event => { if (onOpenSource) { event.preventDefault(); onOpenSource(source); } }}>Source</a>}
        </div>
        <div className="pluginCardActions">
          {ready && plugin.updatable === true && pluginActions?.update && <button type="button" className="btn"
            disabled={busy || !context || !api?.moduleSettingsAction} aria-label={`Update ${section.label || choice.label}`}
            onClick={() => void updatePlugin(choice.sectionId)}>{updating ? "Updating…" : "Update"}</button>}
          {otherInstall && <button type="button" className="btn" disabled={busy}
            aria-label={`Remove unused ${section.label || choice.label} copy`} onClick={() => void onUninstall(manager.id, choice.sectionId, otherInstall)}>Remove unused copy</button>}
          {(!ready || installed?.removable !== false) && <button type="button" className={`btn${ready || plugin.custom ? "" : " primary"}`} disabled={busy || !version}
            onClick={() => void performAction()}
            aria-label={`${ready || plugin.custom ? "Remove" : installed ? "Repair" : "Install"} ${section.label || choice.label}`}>
            {ready || plugin.custom ? "Remove" : installed ? "Repair" : "Install"}
          </button>}
        </div>
      </div>
      {installed && !ready && installed.reason && <p className="pluginCardIssue">{installed.reason}</p>}
      {updateResults[choice.sectionId] && <p className="detailMeta" role="status">{updateResults[choice.sectionId]}</p>}
    </article>;
  };
  const renderField = (field: RuntimeSettingField, control: React.ReactNode, setField: (key: string, value: unknown) => Promise<boolean>) => {
    const plugin = sections.find(choice => choice.section.plugin?.settingKey === field.key);
    if (plugin) return renderCard(plugin, control, setField);
    if (!configurationKeys.includes(field.key)) return control;
    if (field.key === configurationKeys[0]) return <details className="pluginConfiguration" open={configurationOpen}
      onToggle={event => setConfigurationOpen(event.currentTarget.open)}>
      <summary>Configuration and scripts</summary>
      <p className="pluginConfigurationDescription">Add local plugins, configuration files and keyboard bindings.</p>
      <div className="pluginConfigurationField">{control}</div>
    </details>;
    return configurationOpen ? <div className="pluginConfigurationField">{control}</div> : null;
  };
  return <section className="pluginLibrary" aria-label="Plugins">
    {manager.ui?.description && <p className="pluginLibraryIntroduction">{manager.ui.description}</p>}
    <ErrorText error={ui.error} inline />
    <ErrorText error={actionError} inline />
    {context && state ? <RuntimeSettingsWindow api={api} state={state} error={null} inline
      context={{ scope: "module", ...context }} fieldKeys={[...pluginKeys, ...configurationKeys]}
      renderField={renderField} showReset={configurationOpen} showDescription={false} /> : sections.filter(choice => !choice.section.plugin?.custom).map(choice => renderCard(choice))}
    {sections.filter(choice => choice.section.plugin?.custom).map(choice => renderCard(choice))}
    {pluginActions && context && api?.moduleSettingsAction && <form className="pluginCard pluginAddForm" onSubmit={event => { event.preventDefault();void addPlugin(); }}>
      <label className="pluginCardTitle" htmlFor={`plugin-source-${manager.id}`}>Add plugin</label>
      <p className="pluginCardDescription">A GitHub repository, script or ZIP URL, or a local script, ZIP or plugin folder.</p>
      <input id={`plugin-source-${manager.id}`} className="input" aria-label="Plugin URL" placeholder="https://github.com/owner/plugin" value={source} disabled={adding}
        onChange={event => setSource(event.target.value)} />
      <details><summary>Script location</summary><label>Relative script path<input className="input" aria-label="Relative plugin script path" placeholder="Optional, detected automatically" value={scriptPath} disabled={adding}
        onChange={event => setScriptPath(event.target.value)} /></label></details>
      <div className="pluginCardActions"><button type="submit" className="btn primary" disabled={adding || !source.trim()}>{adding ? "Adding…" : "Download"}</button>
        <button type="button" className="btn" disabled={adding} onClick={() => void addPlugin(true)}>Add local…</button></div>
    </form>}
  </section>;
}

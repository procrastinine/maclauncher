import React, { useRef, useState } from "react";
import type { DownloadTask, LauncherState, RuntimeManagerState, RuntimeUiState } from "../types";
import { buildRuntimeSettingsDefaults, formatDownloadPercent, formatUserError, normalizeRuntimeSettings, resolveModuleRuntimeSettings,
  resolveRuntimeSections, resolveRuntimeSettingsSchema, runtimeSettingsEqual } from "../ui-helpers";
import type { RuntimeSettingsApi } from "./RuntimeSettingsWindow";
import type { RuntimeTabSection } from "./runtime-tabs-model";
import { runtimeSourceUrl } from "./runtime-tabs-model";
import { ErrorText } from "./ErrorText";
import { Toggle } from "./FieldRow";

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
type PluginContext = { moduleId: string; runtimeId: string };

// Installing a plugin turns its setting on and removing it turns the setting
// off, as the switch in Settings would. The value is stored like any other
// module runtime setting: nothing is stored while every value is the default.
async function setPluginSetting(state: LauncherState | undefined, api: RuntimeSettingsApi | undefined, context: PluginContext, key: string, value: boolean) {
  const moduleInfo = (state?.modules || []).find(mod => mod.id === context.moduleId) || null;
  const schema = resolveRuntimeSettingsSchema(moduleInfo, context.runtimeId);
  if (!schema || !api?.setModuleRuntimeSettings || !schema.fields.some(field => field.key === key)) return;
  const defaults = normalizeRuntimeSettings(schema, state?.runtimeDefaults?.[context.runtimeId] || null, buildRuntimeSettingsDefaults(schema));
  const current = resolveModuleRuntimeSettings(state || null, context.moduleId, moduleInfo, context.runtimeId) || defaults;
  const next = normalizeRuntimeSettings(schema, { ...current, [key]: value }, defaults);
  await api.setModuleRuntimeSettings(context.moduleId, context.runtimeId, runtimeSettingsEqual(schema, next, defaults) ? null : next);
}

// Runtimes → a plugin library: installation, updates and removal of each
// plugin, and adding a plugin from a URL or a local file. Whether a plugin is
// used, and the runtime's own configuration, are set in Settings.
export function PluginLibrary({ manager, sections, state, api, ui, downloads, onInstall, onUninstall, onOpenSource }: Props) {
  const [source, setSource] = useState("");
  const [scriptPath, setScriptPath] = useState("");
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
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
  const renderCard = (choice: RuntimeTabSection) => {
    const section = choice.section, plugin = section.plugin || {};
    const version = typeof plugin.version === "string" ? plugin.version : "";
    const installed = (section.installed || []).find((item: Record<string, any>) => item.version === version);
    const otherInstall = installed?.suppliedBy && (section.installed || []).find((item: Record<string, any>) => item.source === "managed" && item.removable !== false);
    const ready = installed && installed.ready !== false;
    const pending = ui.pendingActions?.[choice.sectionId];
    const download = downloads.find(task => task.managerId === manager.id && task.sectionId === choice.sectionId);
    const updating = updatingPlugins[choice.sectionId] === true;
    const busy = Boolean(pending || download || updating);
    const percent = download ? formatDownloadPercent(download) : null;
    const status = pending === "uninstall" ? "Removing…" : updating ? "Updating…" : busy ? percent === null ? "Installing…" : `Installing ${percent}%` : ready ? installed.suppliedBy ? `Provided by ${installed.suppliedBy}` : "Installed" : installed ? "Repair needed" : "Missing";
    const displayVersion = installed?.providedVersion || version;
    const versionLabel = installed?.providedVersionLabel || plugin.versionLabel || (/^[a-f0-9]{40,64}$/i.test(displayVersion) ? displayVersion.slice(0, 12) : displayVersion);
    const link = runtimeSourceUrl(plugin.sourceUrl || section.catalog?.sourceUrl);
    const name = section.label || choice.label;
    const performAction = async () => {
      const result = await (ready || plugin.custom ? onUninstall(manager.id, choice.sectionId, installed) : onInstall(manager.id, choice.sectionId, version));
      if (result === false || result === undefined || typeof plugin.settingKey !== "string" || !context) return;
      try { await setPluginSetting(state, api, context, plugin.settingKey, !ready); }
      catch (error) { setActionError(formatUserError(error)); }
    };
    return <article className="pluginCard" key={choice.id} aria-label={name}>
      <div className="pluginCardTitle">{name}</div>
      {plugin.description && <p className="pluginCardDescription">{plugin.description}</p>}
      <div className="pluginCardFooter">
        <div className="pluginCardIdentity"><span className={`pluginStatus${ready ? " installed" : installed ? " repair" : ""}`} role="status">{status}</span>
          {versionLabel && <span className="pluginVersion" title={displayVersion}>{versionLabel}</span>}
          {plugin.updateAvailable && plugin.latestVersionLabel && <span className="pluginVersion">Available: {plugin.latestVersionLabel}</span>}
          {link && <a className="runtimeSourceLink" href={link} onClick={event => { if (onOpenSource) { event.preventDefault(); onOpenSource(link); } }}>Source</a>}
        </div>
        <div className="pluginCardActions">
          {ready && plugin.updatable === true && pluginActions?.update && <button type="button" className="btn"
            disabled={busy || !context || !api?.moduleSettingsAction} aria-label={`Update ${name}`}
            onClick={() => void updatePlugin(choice.sectionId)}>{updating ? "Updating…" : "Update"}</button>}
          {otherInstall && <button type="button" className="btn" disabled={busy}
            aria-label={`Remove unused ${name} copy`} onClick={() => void onUninstall(manager.id, choice.sectionId, otherInstall)}>Remove unused copy</button>}
          {(!ready || installed?.removable !== false) && <button type="button" className={`btn${ready || plugin.custom ? "" : " primary"}`} disabled={busy}
            onClick={() => void performAction()}
            aria-label={`${ready || plugin.custom ? "Remove" : installed ? "Repair" : "Install"} ${name}`}>
            {ready || plugin.custom ? "Remove" : installed ? "Repair" : "Install"}
          </button>}
        </div>
      </div>
      {installed && !ready && installed.reason && <p className="pluginCardIssue">{installed.reason}</p>}
      {updateResults[choice.sectionId] && <p className="detailMeta" role="status">{updateResults[choice.sectionId]}</p>}
    </article>;
  };
  return <section className="pluginLibrary" aria-label="Plugins">
    {manager.ui?.description && <p className="pluginLibraryIntroduction">{manager.ui.description}</p>}
    <ErrorText error={ui.error} inline />
    <ErrorText error={actionError} inline />
    {sections.filter(choice => !choice.section.plugin?.custom).map(renderCard)}
    {sections.filter(choice => choice.section.plugin?.custom).map(renderCard)}
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

// Settings → a module's runtime: the switch of each plugin added from a URL or
// a local file, for every plugin library whose Runtimes metadata names this
// module and runtime as its settings context. Plugins that the runtime's
// schema names have their switches among the runtime settings.
export function PluginSettings({ state, api, moduleId, runtimeId }: {
  state: LauncherState; api?: RuntimeSettingsApi; moduleId: string; runtimeId: string;
}) {
  const [changing, setChanging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const libraries = Object.values(state.runtimeManagers || {}).filter(manager => manager.ui?.library === "plugins" &&
    manager.ui.settingsContext?.moduleId === moduleId && manager.ui.settingsContext?.runtimeId === runtimeId && manager.ui.pluginActions?.setEnabled);
  const rows = libraries.flatMap(manager => resolveRuntimeSections(manager).filter((section: Record<string, any>) => section.plugin?.custom)
    .map((section: Record<string, any>) => ({ manager, section })));
  if (!rows.length) return null;
  async function setEnabled(manager: RuntimeManagerState, id: string, enabled: boolean) {
    if (!api?.moduleSettingsAction) return;
    setChanging(id); setError(null);
    try { await api.moduleSettingsAction(moduleId, manager.ui!.pluginActions!.setEnabled, { id, enabled }); }
    catch (failure) { setError(formatUserError(failure)); }
    finally { setChanging(null); }
  }
  return <section className="settingsStack" aria-label="Added plugins">
    <div className="settingsLabel" role="heading" aria-level={3}>Added plugins</div>
    {rows.map(({ manager, section }) => {
      const id = String(section.id), plugin = section.plugin || {}, name = section.label || id;
      const ready = (section.installed || []).some((item: Record<string, any>) => item.ready !== false);
      return <div className="settingsRow" key={`${manager.id}:${id}`}>
        <div className="settingsLabel">{name}</div>
        <div className="settingsControl">
          <Toggle label={`Use ${name}`} checked={ready && plugin.enabled !== false} disabled={!ready || changing !== null || !api?.moduleSettingsAction}
            onChange={enabled => void setEnabled(manager, id, enabled)} />
        </div>
      </div>;
    })}
    <ErrorText error={error} inline />
  </section>;
}

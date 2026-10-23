import React, { useEffect, useMemo, useState } from "react";
import type { LauncherState } from "../types";
import {
  buildRuntimeSettingsDefaults,
  formatModuleLabel,
  formatRuntimeLabel,
  formatRuntimeOption,
  formatSettingLabel,
  normalizeRuntimeSettings,
  resolveModuleRuntimeSettings,
  resolveRuntimeEntry,
  resolveRuntimeSettingsSchema,
  runtimeSettingsEqual,
  sortModulesForSettings
} from "../ui-helpers";
import { RuntimeSettingsWindow, type RuntimeSettingsApi } from "./RuntimeSettingsWindow";
import { HelpTip } from "./HelpTip";
import { LauncherViewHeader } from "./LauncherViewHeader";
import { ScrollableTabStrip } from "./ScrollableTabStrip";
import { ModuleAccountsPanel } from "./ModuleAccountsPanel";
import { SearchableSidebar } from "./SearchableSidebar";
import { ReShadeFilterLibrary, type ReShadeFilterApi } from "./ReShadeFilterLibrary";
import { EffectsPresetManager, type EffectsPresetApi } from "./EffectsPresetManager";

type SettingsViewProps = {
  state: LauncherState;
  api?: RuntimeSettingsApi & Partial<ReShadeFilterApi> & Partial<EffectsPresetApi>;
  sectionId?: string | null;
  navigationKey?: number;
  showIcons: boolean;
  showNonDefaultTags: boolean;
  onSetLauncherSettings: (patch: Record<string, any>) => void;
  onSetModuleSettings: (moduleId: string, patch: Record<string, any>) => void;
};

export function SettingsView({
  state,
  api,
  sectionId,
  navigationKey,
  showIcons,
  showNonDefaultTags,
  onSetLauncherSettings,
  onSetModuleSettings
}: SettingsViewProps) {
  const modules = useMemo(() => sortModulesForSettings(state.modules || []), [state.modules]);
  const section = (id?: string | null) => id?.startsWith("graphics:") ? "graphics" : id?.replace(/^module:/, "") || "launcher";
  const [activeTab, setActiveTab] = useState(() => section(sectionId));
  const [graphicsTab, setGraphicsTab] = useState(() => sectionId?.startsWith("graphics:presets") ? "presets" : "filters");
  useEffect(() => {
    if (sectionId) setActiveTab(section(sectionId));
    if (sectionId?.startsWith("graphics:presets")) setGraphicsTab("presets");
    else if (sectionId?.startsWith("graphics:filters")) setGraphicsTab("filters");
  }, [sectionId, navigationKey]);
  const [activeRuntimes, setActiveRuntimes] = useState<Record<string, string>>({});
  const tabs = [{ id: "launcher", label: "Launcher", title: "Launcher" },
    { id: "graphics", label: "Graphics", title: "Graphics", keywords: ["ReShade", "RetroArch", "MPV", "libplacebo", "filters", "shaders", "presets", "Advanced", "chains", ".fx", ".slangp", ".slang", ".glsl", ".hook"] },
    ...modules.map(mod => ({ id: mod.id, label: mod.shortLabel || mod.label || mod.id, title: mod.label || mod.id,
      keywords: (mod.runtime?.supported || []).flatMap(id => [id, formatRuntimeLabel(id, mod)]) }))];
  const tab = tabs.some(tab => tab.id === activeTab) ? activeTab : "launcher";
  return (
    <main className="launcherView settingsView" aria-labelledby="settings-title">
        <LauncherViewHeader title="Settings" titleId="settings-title" />

        <div className="launcherSidebarLayout">
        <SearchableSidebar label="Settings sections" searchLabel="Search settings" items={tabs} selectedId={tab}
          panelId={`settings-panel-${tab}`} onSelect={setActiveTab} />
        <div className="launcherViewBody settingsViewBody" role="region" id={`settings-panel-${tab}`}
          aria-label={tabs.find(item => item.id === tab)?.title || "Settings"} tabIndex={0}>
          <div className="settingsStack">
            {tab === "launcher" && <div className="settingsSection">
              <div className="settingsTitle">Launcher</div>
              <div className="settingsRow">
                <div className="settingsLabel">Network access <HelpTip label="About default network access">Initial setting for newly imported games. Each game's inspector has its own checkbox. Changes here do not change existing games.</HelpTip></div>
                <div className="settingsControl">
                  <label className="inlineCheck settingsToggle">
                    <input type="checkbox" aria-label="Network access" checked={state.launcherSettings.networkAccess === true}
                      onChange={event => onSetLauncherSettings({ networkAccess: event.target.checked })} />
                    <span>{state.launcherSettings.networkAccess === true ? "On" : "Off"}</span>
                  </label>
                </div>
              </div>
              <div className="settingsRow">
                <div className="settingsLabel">Show game icons</div>
                <div className="settingsControl">
                  <label className="inlineCheck settingsToggle">
                    <input
                      type="checkbox"
                      aria-label="Show game icons"
                      checked={showIcons}
                      onChange={e => onSetLauncherSettings({ showIcons: e.target.checked })}
                    />
                  </label>
                </div>
              </div>
              <div className="settingsRow">
                <div className="settingsLabel">Show non-default tags</div>
                <div className="settingsControl">
                  <label className="inlineCheck settingsToggle">
                    <input
                      type="checkbox"
                      aria-label="Show non-default tags"
                      checked={showNonDefaultTags}
                      onChange={e =>
                        onSetLauncherSettings({
                          showNonDefaultTags: e.target.checked
                        })
                      }
                    />
                  </label>
                </div>
              </div>
            </div>}
            {tab === "graphics" && <>
              <ScrollableTabStrip label="Graphics settings" tabsClassName="settingsTabs" selectedTabId={`graphics-settings-tab-${graphicsTab}`}>
                {[{ id: "filters", label: "Shaders and filters" }, { id: "presets", label: "Advanced presets" }].map((item, index, items) =>
                  <button key={item.id} type="button" role="tab" id={`graphics-settings-tab-${item.id}`}
                    className={`settingsTab${graphicsTab === item.id ? " active" : ""}`} aria-selected={graphicsTab === item.id}
                    aria-controls={`graphics-settings-panel-${item.id}`} tabIndex={graphicsTab === item.id ? 0 : -1}
                    onClick={() => setGraphicsTab(item.id)} onKeyDown={event => {
                      const next = event.key === "ArrowRight" ? (index + 1) % items.length : event.key === "ArrowLeft" ? (index + items.length - 1) % items.length
                        : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
                      if (next == null) return;event.preventDefault();setGraphicsTab(items[next].id);
                      document.getElementById(`graphics-settings-tab-${items[next].id}`)?.focus({ preventScroll: true });
                    }}>{item.label}</button>)}
              </ScrollableTabStrip>
              <div role="tabpanel" id="graphics-settings-panel-filters" aria-labelledby="graphics-settings-tab-filters" hidden={graphicsTab !== "filters"}>
                <ReShadeFilterLibrary filters={state.reshade?.filters || []} filtersError={state.reshade?.filtersError} api={api} />
              </div>
              <div role="tabpanel" id="graphics-settings-panel-presets" aria-labelledby="graphics-settings-tab-presets" hidden={graphicsTab !== "presets"}>
                <EffectsPresetManager api={api} status={state.reshade} selectedId={sectionId?.split(":")[2]} navigationKey={navigationKey} />
              </div>
            </>}
            {modules.filter(mod => mod.id === tab).map(mod => {
              const moduleSettings = state.moduleSettings?.[mod.id] || {};
              const settingsDefaults =
                mod.settingsDefaults && typeof mod.settingsDefaults === "object"
                  ? mod.settingsDefaults
                  : {};
              const settingKeys = Object.keys(settingsDefaults);
              const runtimeButtons = Array.isArray(mod.runtime?.supported)
                ? mod.runtime.supported.map(runtimeId => {
                    const runtimeSchema = resolveRuntimeSettingsSchema(mod, runtimeId);
                    const hasSettings = Boolean(runtimeSchema);
                    const entry = resolveRuntimeEntry(mod, runtimeId);
                    const hasDescription = Boolean(entry && [entry.description, entry.requirements, entry.preparation, entry.dataNotice].some(Boolean));
                    const globalDefaults = runtimeSchema
                      ? normalizeRuntimeSettings(
                          runtimeSchema,
                          state?.runtimeDefaults?.[runtimeId] || null,
                          buildRuntimeSettingsDefaults(runtimeSchema)
                        )
                      : null;
                    const moduleRuntimeSettings = runtimeSchema
                      ? resolveModuleRuntimeSettings(state, mod.id, mod, runtimeId)
                      : null;
                    const modified =
                      runtimeSchema && moduleRuntimeSettings && globalDefaults
                        ? !runtimeSettingsEqual(
                            runtimeSchema,
                            moduleRuntimeSettings,
                            globalDefaults
                          )
                        : false;
                    return {
                      id: runtimeId,
                      hasSettings,
                      hasDescription,
                      modified
                    };
                  })
                : [];
              const runtimeTabs = runtimeButtons.filter(runtime => runtime.hasSettings || runtime.hasDescription);
              const selectedRuntime = runtimeTabs.find(runtime => runtime.id === activeRuntimes[mod.id])
                || runtimeTabs.find(runtime => runtime.id === moduleSettings.defaultRuntime)
                || runtimeTabs.find(runtime => runtime.id === mod.runtime?.default)
                || runtimeTabs[0];
              return (
                <div className="settingsSection" key={mod.id}>
                  <div className="settingsTitle">
                    {formatModuleLabel(mod.label, mod.shortLabel, mod.id)}
                  </div>
                  {settingKeys.length > 0 && (
                    settingKeys.map(key => {
                      const defaultValue = settingsDefaults[key];
                      const currentValue =
                        moduleSettings[key] !== undefined
                          ? moduleSettings[key]
                          : defaultValue;
                      if (key === "defaultRuntime" && mod.runtime?.supported) {
                        const runtimeValue =
                          typeof currentValue === "string" && currentValue
                            ? currentValue
                            : mod.runtime.supported[0] || "";
                        return (
                          <div className="settingsRow" key={`${mod.id}-${key}`}>
                            <div className="settingsLabel">Default runtime</div>
                            <div className="settingsControl">
                              <select
                                className="input"
                                aria-label="Default runtime"
                                value={runtimeValue}
                                onChange={e => {
                                  const runtimeId = e.target.value;
                                  setActiveRuntimes(current => ({ ...current, [mod.id]: runtimeId }));
                                  onSetModuleSettings(mod.id, { defaultRuntime: runtimeId });
                                }}
                              >
                                {mod.runtime.supported.map(rt => (
                                  <option key={rt} value={rt}>
                                    {formatRuntimeOption(rt, mod)}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                        );
                      }
                      if (typeof defaultValue === "boolean") {
                        const checked = Boolean(currentValue);
                        const label = key === "toolsButtonVisible" ? "Show Tools button" : formatSettingLabel(key);
                        return (
                          <React.Fragment key={`${mod.id}-${key}`}>
                            <div className="settingsRow">
                              <div className="settingsLabel">{label}{key === "toolsButtonVisible" && <HelpTip label="About the Tools button">Tools remain available via Cmd+Shift+T and the menu bar.</HelpTip>}</div>
                              <div className="settingsControl">
                                <label className="inlineCheck settingsToggle">
                                  <input
                                    type="checkbox"
                                    aria-label={label}
                                    checked={checked}
                                    onChange={e =>
                                      onSetModuleSettings(mod.id, {
                                        [key]: e.target.checked
                                      })
                                    }
                                  />
                                </label>
                              </div>
                            </div>
                          </React.Fragment>
                        );
                      }
                      if (typeof defaultValue === "number") {
                        const value = Number(currentValue);
                        return (
                          <div className="settingsRow" key={`${mod.id}-${key}`}>
                            <div className="settingsLabel">{formatSettingLabel(key)}</div>
                            <div className="settingsControl">
                              <input
                                className="input"
                                type="number"
                                aria-label={formatSettingLabel(key)}
                                value={Number.isFinite(value) ? value : ""}
                                onChange={e => {
                                  const next = Number(e.target.value);
                                  if (!Number.isFinite(next)) return;
                                  onSetModuleSettings(mod.id, { [key]: next });
                                }}
                              />
                            </div>
                          </div>
                        );
                      }
                      if (typeof defaultValue === "string") {
                        const value =
                          typeof currentValue === "string" ? currentValue : String(defaultValue);
                        return (
                          <div className="settingsRow" key={`${mod.id}-${key}`}>
                            <div className="settingsLabel">{formatSettingLabel(key)}</div>
                            <div className="settingsControl">
                              <input
                                className="input"
                                type="text"
                                aria-label={formatSettingLabel(key)}
                                value={value}
                                onChange={e =>
                                  onSetModuleSettings(mod.id, { [key]: e.target.value })
                                }
                              />
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div className="settingsRow" key={`${mod.id}-${key}`}>
                          <div className="settingsLabel">{formatSettingLabel(key)}</div>
                          <div className="settingsControl">
                            <span className="dim">Unsupported setting</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                  {!runtimeTabs.length && [...(mod.ui?.accounts ? [mod.ui.accounts] : []), ...(mod.ui?.accountProviders || [])].map(descriptor =>
                    <ModuleAccountsPanel key={descriptor.stateAction} moduleId={mod.id} descriptor={descriptor} action={api?.moduleSettingsAction} />)}
                  {runtimeTabs.length > 0 && <div className="settingsRuntimeSection">
                      <ScrollableTabStrip label={`${mod.label} runtime settings`} tabsClassName="settingsTabs settingsRuntimeTabs"
                        selectedTabId={selectedRuntime ? `settings-runtime-tab-${mod.id}-${selectedRuntime.id}` : null}>
                        {runtimeTabs.map((runtime, index) => <button key={runtime.id} type="button" role="tab"
                          id={`settings-runtime-tab-${mod.id}-${runtime.id}`}
                          className={["settingsTab", selectedRuntime?.id === runtime.id ? "active" : ""].filter(Boolean).join(" ")}
                          aria-selected={selectedRuntime?.id === runtime.id}
                          aria-controls={`settings-runtime-panel-${mod.id}-${runtime.id}`}
                          tabIndex={selectedRuntime?.id === runtime.id ? 0 : -1}
                          onClick={() => setActiveRuntimes(current => ({ ...current, [mod.id]: runtime.id }))}
                          onKeyDown={event => {
                            const next = event.key === "ArrowRight" ? (index + 1) % runtimeTabs.length
                              : event.key === "ArrowLeft" ? (index - 1 + runtimeTabs.length) % runtimeTabs.length
                              : event.key === "Home" ? 0 : event.key === "End" ? runtimeTabs.length - 1 : null;
                            if (next === null) return;
                            event.preventDefault();
                            setActiveRuntimes(current => ({ ...current, [mod.id]: runtimeTabs[next].id }));
                            document.getElementById(`settings-runtime-tab-${mod.id}-${runtimeTabs[next].id}`)?.focus({ preventScroll: true });
                          }}>
                          {formatRuntimeLabel(runtime.id, mod)}
                          {runtime.modified && <span className="badge badgeWarn">Modified</span>}
                        </button>)}
                      </ScrollableTabStrip>
                      {selectedRuntime && <div role="tabpanel"
                        id={`settings-runtime-panel-${mod.id}-${selectedRuntime.id}`}
                        aria-labelledby={`settings-runtime-tab-${mod.id}-${selectedRuntime.id}`}>
                        <RuntimeSettingsWindow key={`${mod.id}:${selectedRuntime.id}`}
                          api={api} state={state} error={null} inline
                          context={{ scope: "module", moduleId: mod.id, runtimeId: selectedRuntime.id }} />
                        {[...(mod.ui?.accounts ? [mod.ui.accounts] : []), ...(mod.ui?.accountProviders || [])]
                          .filter(descriptor => !descriptor.runtimeIds?.length || descriptor.runtimeIds.includes(selectedRuntime.id))
                          .map(descriptor => <ModuleAccountsPanel key={descriptor.stateAction} moduleId={mod.id}
                            descriptor={descriptor} action={api?.moduleSettingsAction} />)}
                      </div>}
                  </div>}
                </div>
              );
            })}
          </div>
        </div>
        </div>
    </main>
  );
}

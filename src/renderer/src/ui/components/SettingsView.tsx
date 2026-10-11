import React, { useMemo, useState } from "react";
import type { LauncherApi, LauncherState } from "../types";
import {
  buildRuntimeSettingsDefaults,
  formatModuleLabel,
  formatRuntimeLabel,
  formatRuntimeOption,
  formatSettingLabel,
  normalizeRuntimeSettings,
  resolveModuleRuntimeSettings,
  resolveRuntimeSettingsSchema,
  runtimeSettingsEqual,
  sortModulesForSettings
} from "../ui-helpers";
import { RuntimeSettingsWindow } from "./RuntimeSettingsWindow";
import { HelpTip } from "./HelpTip";
import { LauncherViewHeader } from "./LauncherViewHeader";
import { ScrollableTabStrip } from "./ScrollableTabStrip";

type SettingsViewProps = {
  state: LauncherState;
  api?: LauncherApi;
  showIcons: boolean;
  showNonDefaultTags: boolean;
  onSetLauncherSettings: (patch: Record<string, any>) => void;
  onSetModuleSettings: (moduleId: string, patch: Record<string, any>) => void;
};

export function SettingsView({
  state,
  api,
  showIcons,
  showNonDefaultTags,
  onSetLauncherSettings,
  onSetModuleSettings
}: SettingsViewProps) {
  const modules = useMemo(() => sortModulesForSettings(state.modules || []), [state.modules]);
  const [activeTab, setActiveTab] = useState("launcher");
  const [activeRuntimes, setActiveRuntimes] = useState<Record<string, string>>({});
  const tabs = [{ id: "launcher", label: "Launcher", title: "Launcher" },
    ...modules.map(mod => ({ id: mod.id, label: mod.shortLabel || mod.label || mod.id, title: mod.label || mod.id }))];
  const tab = tabs.some(tab => tab.id === activeTab) ? activeTab : "launcher";
  return (
    <main className="launcherView settingsView" aria-labelledby="settings-title">
        <LauncherViewHeader title="Settings" titleId="settings-title" />

        <ScrollableTabStrip label="Settings sections" tabsClassName="settingsTabs" selectedTabId={`settings-tab-${tab}`}>
          {tabs.map((item, index) => <button key={item.id} type="button" role="tab"
            className={["settingsTab", item.id === tab ? "active" : ""].filter(Boolean).join(" ")}
            id={`settings-tab-${item.id}`} aria-controls={`settings-panel-${item.id}`} aria-selected={item.id === tab}
            tabIndex={item.id === tab ? 0 : -1} title={item.title} onClick={() => setActiveTab(item.id)}
            onKeyDown={event => {
              const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
                : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length
                : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
              if (next === null) return;
              event.preventDefault(); setActiveTab(tabs[next].id);
              document.getElementById(`settings-tab-${tabs[next].id}`)?.focus({ preventScroll: true });
            }}>{item.label}</button>)}
        </ScrollableTabStrip>
        <div className="launcherViewBody settingsViewBody" role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`} tabIndex={0}>
          <div className="settingsStack">
            {tab === "launcher" && <div className="settingsSection">
              <div className="settingsTitle">Launcher</div>
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
                    <span>{showIcons ? "On" : "Off"}</span>
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
                    <span>{showNonDefaultTags ? "On" : "Off"}</span>
                  </label>
                </div>
              </div>
            </div>}
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
                      modified
                    };
                  })
                : [];
              const runtimeTabs = runtimeButtons.filter(runtime => runtime.hasSettings);
              const selectedRuntime = runtimeTabs.find(runtime => runtime.id === activeRuntimes[mod.id])
                || runtimeTabs.find(runtime => runtime.id === moduleSettings.defaultRuntime)
                || runtimeTabs.find(runtime => runtime.id === mod.runtime?.default)
                || runtimeTabs[0];
              return (
                <div className="settingsSection" key={mod.id}>
                  <div className="settingsTitle">
                    {formatModuleLabel(mod.label, mod.shortLabel, mod.id)}
                  </div>
                  {settingKeys.length === 0 ? (
                    <div className="dim settingsHint">No settings available.</div>
                  ) : (
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
                                onChange={e =>
                                  onSetModuleSettings(mod.id, {
                                    defaultRuntime: e.target.value
                                  })
                                }
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
                                  <span>{checked ? "On" : "Off"}</span>
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
                  <div className="settingsRuntimeSection">
                    <div className="settingsLabel">Runtime settings</div>
                    {runtimeTabs.length === 0 ? <span className="dim settingsHint">No configurable runtime settings.</span> : <>
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
                      </div>}
                    </>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
    </main>
  );
}

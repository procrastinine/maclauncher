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
import { CommitNumberInput, CommitTextInput } from "./CommitInput";
import { Toggle } from "./FieldRow";
import { StatusBadge } from "./StatusBadge";

type SettingsViewProps = {
  state: LauncherState;
  api?: RuntimeSettingsApi;
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
  // Shaders and presets are managed in Runtimes ▸ Graphics.
  const section = (id?: string | null) => id?.replace(/^module:/, "") || "launcher";
  const [activeTab, setActiveTab] = useState(() => section(sectionId));
  useEffect(() => {
    if (sectionId) setActiveTab(section(sectionId));
  }, [sectionId, navigationKey]);
  const [activeRuntimes, setActiveRuntimes] = useState<Record<string, string>>({});
  const tabs = [{ id: "launcher", label: "Launcher", title: "Launcher" },
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
                <label className="settingsLabel" htmlFor="launcher-appearance">Appearance</label>
                <div className="settingsControl">
                  <select id="launcher-appearance" className="input" value={state.launcherSettings.appearance || "system"}
                    onChange={event => onSetLauncherSettings({ appearance: event.target.value })}>
                    <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
                  </select>
                </div>
              </div>
              <div className="settingsRow">
                <div className="settingsLabel">Network access <HelpTip label="About default network access">Initial setting for newly imported games. Each game's inspector has its own checkbox. Changes here do not change existing games.</HelpTip></div>
                <div className="settingsControl">
                  <Toggle label="Network access" checked={state.launcherSettings.networkAccess === true}
                    onChange={checked => onSetLauncherSettings({ networkAccess: checked })} />
                </div>
              </div>
              <div className="settingsRow">
                <div className="settingsLabel">Steam client on Play <HelpTip label="About Steam client startup">Steam games that use their own macOS Steam API can start the Steam client before launch. Ask requests permission because Steam may connect to the Internet. Don't start launches the game without starting or waiting for Steam.</HelpTip></div>
                <div className="settingsControl">
                  <select className="input" aria-label="Steam client on Play" value={state.launcherSettings.startSteamClient || "ask"}
                    onChange={event => onSetLauncherSettings({ startSteamClient: event.target.value as "ask" | "automatic" | "never" })}>
                    <option value="ask">Ask</option><option value="automatic">Start automatically</option><option value="never">Don't start</option>
                  </select>
                </div>
              </div>
              <div className="settingsRow">
                <div className="settingsLabel">Show game icons</div>
                <div className="settingsControl">
                  <Toggle label="Show game icons" checked={showIcons} onChange={checked => onSetLauncherSettings({ showIcons: checked })} />
                </div>
              </div>
              <div className="settingsRow">
                <div className="settingsLabel">Show non-default tags</div>
                <div className="settingsControl">
                  <Toggle label="Show non-default tags" checked={showNonDefaultTags}
                    onChange={checked => onSetLauncherSettings({ showNonDefaultTags: checked })} />
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
              // Module-wide accounts follow the module fields; runtime-specific
              // accounts sit with their runtime's settings.
              const accountDescriptors = [...(mod.ui?.accounts ? [mod.ui.accounts] : []), ...(mod.ui?.accountProviders || [])];
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
                        // A module with one runtime has nothing to choose.
                        if (mod.runtime.supported.length < 2 && mod.runtime.supported.includes(runtimeValue)) return null;
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
                                {!mod.runtime.supported.includes(runtimeValue) && <option value={runtimeValue}>
                                  {formatRuntimeOption(runtimeValue, mod)} (saved; choose a compatible runtime)
                                </option>}
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
                        const label = key === "toolsButtonVisible" ? "Show Tools button" : formatSettingLabel(key);
                        return (
                          <div className="settingsRow" key={`${mod.id}-${key}`}>
                            <div className="settingsLabel">{label}{key === "toolsButtonVisible" && <HelpTip label="About the Tools button">Tools remain available via Cmd+Shift+T and the menu bar.</HelpTip>}</div>
                            <div className="settingsControl">
                              <Toggle label={label} checked={Boolean(currentValue)}
                                onChange={checked => onSetModuleSettings(mod.id, { [key]: checked })} />
                            </div>
                          </div>
                        );
                      }
                      if (typeof defaultValue === "number") {
                        const value = Number(currentValue);
                        return (
                          <div className="settingsRow" key={`${mod.id}-${key}`}>
                            <div className="settingsLabel">{formatSettingLabel(key)}</div>
                            <div className="settingsControl">
                              <CommitNumberInput aria-label={formatSettingLabel(key)} value={Number.isFinite(value) ? value : null}
                                onCommit={next => onSetModuleSettings(mod.id, { [key]: next })} />
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
                              <CommitTextInput aria-label={formatSettingLabel(key)} value={value}
                                onCommit={next => onSetModuleSettings(mod.id, { [key]: next })} />
                            </div>
                          </div>
                        );
                      }
                      // Values without a presentation are left to the module's own tools.
                      return null;
                    })
                  )}
                  {accountDescriptors.filter(descriptor => !runtimeTabs.length || !descriptor.runtimeIds?.length).map(descriptor =>
                    <ModuleAccountsPanel key={descriptor.stateAction} moduleId={mod.id} descriptor={descriptor} action={api?.moduleSettingsAction} />)}
                  {runtimeTabs.length > 0 && <div className="settingsRuntimeSection">
                      {/* One runtime is named by a heading rather than a lone tab. */}
                      {runtimeTabs.length === 1 && <div className="settingsRuntimeHeading" role="heading" aria-level={3}
                        id={`settings-runtime-heading-${mod.id}-${runtimeTabs[0].id}`}>
                        {formatRuntimeLabel(runtimeTabs[0].id, mod)}
                        {runtimeTabs[0].modified && <StatusBadge>Modified</StatusBadge>}
                      </div>}
                      {runtimeTabs.length > 1 && <ScrollableTabStrip label={`${mod.label} runtime settings`} tabsClassName="settingsTabs settingsRuntimeTabs"
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
                          {runtime.modified && <StatusBadge>Modified</StatusBadge>}
                        </button>)}
                      </ScrollableTabStrip>}
                      {selectedRuntime && <div role={runtimeTabs.length > 1 ? "tabpanel" : undefined}
                        id={`settings-runtime-panel-${mod.id}-${selectedRuntime.id}`}
                        aria-labelledby={`settings-runtime-${runtimeTabs.length > 1 ? "tab" : "heading"}-${mod.id}-${selectedRuntime.id}`}>
                        <RuntimeSettingsWindow key={`${mod.id}:${selectedRuntime.id}`}
                          api={api} state={state} error={null} inline
                          context={{ scope: "module", moduleId: mod.id, runtimeId: selectedRuntime.id }} />
                        {accountDescriptors
                          .filter(descriptor => descriptor.runtimeIds?.includes(selectedRuntime.id))
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

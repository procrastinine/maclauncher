import React from "react";
import type { LauncherState, RuntimeSettingsContext } from "../../types";
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
} from "../../ui-helpers";
import { XIcon } from "../../icons";

type SettingsModalProps = {
  state: LauncherState;
  showIcons: boolean;
  showNonDefaultTags: boolean;
  onSetLauncherSettings: (patch: Record<string, any>) => void;
  onSetModuleSettings: (moduleId: string, patch: Record<string, any>) => void;
  onOpenRuntimeSettings: (payload: RuntimeSettingsContext) => void;
  onClose: () => void;
};

export function SettingsModal({
  state,
  showIcons,
  showNonDefaultTags,
  onSetLauncherSettings,
  onSetModuleSettings,
  onOpenRuntimeSettings,
  onClose
}: SettingsModalProps) {
  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modalHeader">
          <div className="modalTitle">Settings</div>
          <button
            className="btn iconOnly"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <XIcon />
          </button>
        </div>

        <div className="modalBody">
          <div className="settingsStack">
            <div className="settingsSection">
              <div className="settingsTitle">Launcher</div>
              <div className="settingsRow">
                <div className="settingsLabel">Show game icons</div>
                <div className="settingsControl">
                  <label className="inlineCheck settingsToggle">
                    <input
                      type="checkbox"
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
            </div>
            {sortModulesForSettings(state.modules || []).map(mod => {
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
              return (
                <div className="settingsSection" key={mod.id}>
                  <div className="settingsTitle">
                    {formatModuleLabel(mod.label, mod.shortLabel, mod.id)}
                  </div>
                  {settingKeys.length === 0 ? (
                    <div className="dim settingsHint">No settings available yet.</div>
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
                        return (
                          <React.Fragment key={`${mod.id}-${key}`}>
                            <div className="settingsRow">
                              <div className="settingsLabel">{formatSettingLabel(key)}</div>
                              <div className="settingsControl">
                                <label className="inlineCheck settingsToggle">
                                  <input
                                    type="checkbox"
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
                            {key === "toolsButtonVisible" && (
                              <div className="dim settingsHint">
                                Tools remain available via Cmd+Shift+T and the menu bar.
                              </div>
                            )}
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
                  <div className="settingsRow">
                    <div className="settingsLabel">Runtime settings</div>
                    <div className="settingsControl settingsRuntimeButtons">
                      {runtimeButtons.length === 0 ? (
                        <span className="dim">—</span>
                      ) : (
                        runtimeButtons.map(rt => {
                          const runtimeLabel = formatRuntimeLabel(rt.id, mod);
                          return (
                            <div className="settingsRuntimeButton" key={rt.id}>
                              <button
                                className="btn small"
                                onClick={() =>
                                  onOpenRuntimeSettings({
                                    scope: "module",
                                    moduleId: mod.id,
                                    runtimeId: rt.id
                                  })
                                }
                                disabled={!rt.hasSettings}
                              >
                                {runtimeLabel}
                              </button>
                              {rt.modified && <span className="badge badgeWarn">Modified</span>}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

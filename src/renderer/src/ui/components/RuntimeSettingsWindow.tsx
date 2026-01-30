import React, { useEffect, useMemo, useRef, useState } from "react";
import type { LauncherApi, LauncherState, RuntimeSettingsContext } from "../types";
import {
  buildRuntimeSettingsDefaults,
  formatModuleLabel,
  formatProtectionStatus,
  formatRuntimeLabel,
  normalizeRuntimeSettings,
  resolveModuleRuntimeSettings,
  resolveRuntimeSettingsSchema,
  runtimeSettingsEqual
} from "../ui-helpers";
import { XIcon } from "../icons";

type RuntimeSettingsWindowProps = {
  api: LauncherApi | undefined;
  state: LauncherState | null;
  context: RuntimeSettingsContext;
  error: string | null;
};

export function RuntimeSettingsWindow({
  api,
  state,
  context,
  error
}: RuntimeSettingsWindowProps) {
  const [draft, setDraft] = useState<Record<string, any> | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const isGameScope = context.scope === "game";
  const pendingSaveRef = useRef<Record<string, any> | null>(null);
  const saveInFlightRef = useRef(false);

  const moduleInfo = useMemo(
    () => (state?.modules || []).find(mod => mod.id === context.moduleId) || null,
    [state, context.moduleId]
  );
  const runtimeLabel = formatRuntimeLabel(context.runtimeId, moduleInfo);
  const moduleLabel = formatModuleLabel(
    moduleInfo?.label,
    moduleInfo?.shortLabel,
    context.moduleId
  );
  const schema = useMemo(
    () => resolveRuntimeSettingsSchema(moduleInfo, context.runtimeId),
    [moduleInfo, context.runtimeId]
  );
  const globalDefaults = useMemo(() => {
    if (!schema) return null;
    return normalizeRuntimeSettings(
      schema,
      state?.runtimeDefaults?.[context.runtimeId] || null,
      buildRuntimeSettingsDefaults(schema)
    );
  }, [schema, state, context.runtimeId]);
  const moduleDefaults = useMemo(() => {
    if (!schema) return null;
    return resolveModuleRuntimeSettings(
      state,
      context.moduleId,
      moduleInfo,
      context.runtimeId
    );
  }, [schema, state, context.moduleId, moduleInfo, context.runtimeId]);
  const baseDefaults = useMemo(() => {
    if (!schema) return null;
    if (isGameScope) {
      return moduleDefaults || globalDefaults || buildRuntimeSettingsDefaults(schema);
    }
    return globalDefaults || buildRuntimeSettingsDefaults(schema);
  }, [schema, isGameScope, moduleDefaults, globalDefaults]);
  const gameEntry = useMemo(() => {
    if (!isGameScope) return null;
    return (state?.recents || []).find(g => g.gamePath === context.gamePath) || null;
  }, [state, isGameScope, context.gamePath]);
  const gameOverride = useMemo(() => {
    if (!isGameScope) return null;
    const raw = gameEntry?.runtimeSettings?.[context.runtimeId];
    return raw && typeof raw === "object" ? raw : null;
  }, [isGameScope, gameEntry, context.runtimeId]);
  const normalizedGameOverride = useMemo(() => {
    if (!schema || !isGameScope) return null;
    if (!gameOverride || typeof gameOverride !== "object") return null;
    const defaults = baseDefaults || buildRuntimeSettingsDefaults(schema);
    return normalizeRuntimeSettings(schema, gameOverride, defaults);
  }, [schema, isGameScope, gameOverride, baseDefaults]);
  const savedSettings = useMemo(() => {
    if (!schema) return null;
    if (isGameScope) {
      if (
        normalizedGameOverride &&
        baseDefaults &&
        !runtimeSettingsEqual(schema, normalizedGameOverride, baseDefaults)
      ) {
        return normalizedGameOverride;
      }
      return baseDefaults;
    }
    return moduleDefaults || baseDefaults;
  }, [schema, isGameScope, normalizedGameOverride, baseDefaults, moduleDefaults]);
  const savedModified = useMemo(() => {
    if (!schema || !baseDefaults) return false;
    if (isGameScope) {
      if (!normalizedGameOverride) return false;
      return !runtimeSettingsEqual(schema, normalizedGameOverride, baseDefaults);
    }
    if (!moduleDefaults) return false;
    return !runtimeSettingsEqual(schema, moduleDefaults, baseDefaults);
  }, [schema, isGameScope, normalizedGameOverride, baseDefaults, moduleDefaults]);
  const draftModified = useMemo(() => {
    if (!schema || !baseDefaults || !draft) return false;
    return !runtimeSettingsEqual(schema, draft, baseDefaults);
  }, [schema, baseDefaults, draft]);
  const modified = dirty ? draftModified : savedModified;

  useEffect(() => {
    if (!schema) {
      setDraft(null);
      return;
    }
    if (dirty) return;
    if (!savedSettings) {
      setDraft(null);
      return;
    }
    setDraft({ ...savedSettings });
  }, [schema, savedSettings, dirty]);

  useEffect(() => {
    setSaveError(null);
  }, [context.scope, context.runtimeId, context.moduleId, context.gamePath]);

  const displaySettings = draft;
  const canEdit = Boolean(api && schema && displaySettings);
  const fieldsDisabled = !canEdit;

  async function persistDraft(nextDraft: Record<string, any>) {
    if (!api || !schema) return;
    pendingSaveRef.current = nextDraft;
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaveError(null);
    try {
      let didSave = false;
      while (pendingSaveRef.current) {
        const currentDraft = pendingSaveRef.current;
        pendingSaveRef.current = null;
        const defaults = baseDefaults || buildRuntimeSettingsDefaults(schema);
        const normalizedDraft = normalizeRuntimeSettings(schema, currentDraft, defaults);
        const isModified = !runtimeSettingsEqual(schema, normalizedDraft, defaults);
        if (!isGameScope) {
          await api.setModuleRuntimeSettings(
            context.moduleId,
            context.runtimeId,
            isModified ? normalizedDraft : null
          );
        } else if (context.gamePath) {
          await api.setGameRuntimeSettings(
            context.gamePath,
            context.runtimeId,
            isModified ? normalizedDraft : null
          );
        }
        didSave = true;
      }
      if (didSave) setDirty(false);
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      saveInFlightRef.current = false;
    }
  }

  function onReset() {
    if (!schema) return;
    const defaults = baseDefaults || buildRuntimeSettingsDefaults(schema);
    setDraft({ ...defaults });
    setDirty(true);
    setSaveError(null);
    void persistDraft({ ...defaults });
  }

  function onFieldChange(key: string, value: any) {
    setDraft(prev => {
      const nextDraft = { ...(prev || {}), [key]: value };
      void persistDraft(nextDraft);
      return nextDraft;
    });
    setDirty(true);
    setSaveError(null);
  }

  const subtitleBase = isGameScope
    ? `${gameEntry?.name || "Game"} · ${moduleLabel}`
    : `${moduleLabel} · game type defaults`;
  const subtitle = modified ? `${subtitleBase} · Modified` : subtitleBase;
  const resetLabel =
    context.scope === "game"
      ? "Reset to game type defaults"
      : "Reset to global defaults";

  return (
    <div className="runtimeSettingsRoot">
      <div className="modal runtimeSettingsPanel">
        <div className="modalHeader">
          <div>
            <div className="modalTitle">{runtimeLabel} settings</div>
            <div className="modalSubtitle">{subtitle}</div>
          </div>
          <button
            className="btn iconOnly"
            onClick={() => window.close()}
            title="Close"
            aria-label="Close"
          >
            <XIcon />
          </button>
        </div>
        <div className="modalBody">
          {error && <div className="error">Error: {error}</div>}
          {saveError && <div className="error">Error: {saveError}</div>}
          {!api && (
            <div className="empty">
              Launcher bridge unavailable. Open this window from the app.
            </div>
          )}
          {api && !state && <div className="empty">Loading runtime settings…</div>}
          {api && state && schema && displaySettings && (
            <div className="settingsStack">
              {schema.fields.map(field => {
                const isProtectionToggle = field.key === "enableProtections";
                const checked = Boolean((displaySettings as any)[field.key]);
                const statusText = isProtectionToggle
                  ? formatProtectionStatus(checked)
                  : field.description || "";
                if (field.type === "boolean") {
                  return (
                    <React.Fragment key={field.key}>
                      <div className="settingsRow">
                        <div className="settingsLabel">{field.label}</div>
                        <div className="settingsControl">
                          <label className="inlineCheck settingsToggle">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={e =>
                                onFieldChange(
                                  field.key,
                                  e.target.checked
                                )
                              }
                              disabled={!canEdit || fieldsDisabled}
                            />
                            <span>{checked ? "On" : "Off"}</span>
                          </label>
                        </div>
                      </div>
                      {statusText && <div className="dim settingsHint">{statusText}</div>}
                    </React.Fragment>
                  );
                }
                if (field.type === "number") {
                  const num = (displaySettings as any)[field.key];
                  const hint = field.description || "";
                  return (
                    <React.Fragment key={field.key}>
                      <div className="settingsRow">
                        <div className="settingsLabel">{field.label}</div>
                        <div className="settingsControl">
                          <input
                            className="input"
                            type="number"
                            value={Number.isFinite(num) ? num : ""}
                            onChange={e => onFieldChange(field.key, Number(e.target.value))}
                            disabled={!canEdit || fieldsDisabled}
                          />
                        </div>
                      </div>
                      {hint && <div className="dim settingsHint">{hint}</div>}
                    </React.Fragment>
                  );
                }
                if (field.type === "select") {
                  const options = Array.isArray(field.options) ? field.options : [];
                  const selected = String((displaySettings as any)[field.key] || "");
                  const hint = field.description || "";
                  return (
                    <React.Fragment key={field.key}>
                      <div className="settingsRow">
                        <div className="settingsLabel">{field.label}</div>
                        <div className="settingsControl">
                          <select
                            className="input"
                            value={selected}
                            onChange={e => onFieldChange(field.key, e.target.value)}
                            disabled={!canEdit || fieldsDisabled}
                          >
                            {options.map(opt => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label || opt.value}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      {hint && <div className="dim settingsHint">{hint}</div>}
                    </React.Fragment>
                  );
                }
                if (field.type === "list") {
                  const raw = (displaySettings as any)[field.key];
                  const textValue = Array.isArray(raw) ? raw.join("\n") : String(raw || "");
                  const hint = field.description || "";
                  return (
                    <React.Fragment key={field.key}>
                      <div className="settingsRow">
                        <div className="settingsLabel">{field.label}</div>
                        <div className="settingsControl">
                          <textarea
                            className="input"
                            rows={4}
                            value={textValue}
                            onChange={e => onFieldChange(field.key, e.target.value)}
                            disabled={!canEdit || fieldsDisabled}
                          />
                        </div>
                      </div>
                      {hint && <div className="dim settingsHint">{hint}</div>}
                    </React.Fragment>
                  );
                }
                const hint = field.description || "";
                return (
                  <React.Fragment key={field.key}>
                    <div className="settingsRow">
                      <div className="settingsLabel">{field.label}</div>
                      <div className="settingsControl">
                        <input
                          className="input"
                          type="text"
                          value={String((displaySettings as any)[field.key] || "")}
                          onChange={e => onFieldChange(field.key, e.target.value)}
                          disabled={!canEdit || fieldsDisabled}
                        />
                      </div>
                    </div>
                    {hint && <div className="dim settingsHint">{hint}</div>}
                  </React.Fragment>
                );
              })}
              <div className="modalActions">
                <button
                  className="btn"
                  onClick={onReset}
                  disabled={!schema || !canEdit}
                >
                  {resetLabel}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

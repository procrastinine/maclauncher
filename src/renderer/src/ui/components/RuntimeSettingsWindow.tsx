import { RefreshIcon } from "../icons";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { LauncherApi, LauncherState, RuntimeSettingsContext } from "../types";
import {
  buildRuntimeSettingsDefaults,
  formatModuleLabel,
  formatProtectionStatus,
  formatRuntimeLabel,
  formatUserError,
  matchesAnyCondition,
  isRuntimeSettingVisible,
  normalizeRuntimeSettings,
  resolveModuleRuntimeSettings,
  resolveRuntimeSettingsSchema,
  runtimeSettingsEqual
} from "../ui-helpers";

import { HelpTip } from "./HelpTip";
import { RuntimeDescription } from "./RuntimeDescription";
import { createQueuedWriter, type QueuedWriter } from "./queued-write-model";
import { loadSettingChoices, settingChoiceRequest, type SettingChoices } from "./runtime-setting-choices";

export type RuntimeSettingsApi = Pick<LauncherApi, "setModuleRuntimeSettings" | "setGameRuntimeSettings"> & Partial<Pick<LauncherApi, "moduleAction" | "moduleSettingsAction">>;

type RuntimeSettingsWindowProps = {
  api: RuntimeSettingsApi | undefined;
  state: LauncherState | null;
  context: RuntimeSettingsContext;
  error: string | null;
  inline?: boolean;
};

export function RuntimeSettingsWindow({
  api,
  state,
  context,
  error,
  inline = false
}: RuntimeSettingsWindowProps) {
  const [draft, setDraft] = useState<Record<string, any> | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, SettingChoices>>({});
  const [choiceError, setChoiceError] = useState<string | null>(null);
  const [choiceLoading, setChoiceLoading] = useState<Record<string, boolean>>({});
  const choiceScope = useRef("");
  const [choiceRevision, setChoiceRevision] = useState(0);
  const isGameScope = context.scope === "game";
  const draftRef = useRef<Record<string, any> | null>(null);
  const saveCallback = useRef<(value: Record<string, any>) => Promise<void>>(async () => {});
  const writerRef = useRef<QueuedWriter<Record<string, any>> | null>(null);
  if (!writerRef.current) writerRef.current = createQueuedWriter(value => saveCallback.current(value));
  const writer = writerRef.current;

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
      draftRef.current = null;
      setDraft(null);
      return;
    }
    if (dirty) return;
    if (!savedSettings) {
      draftRef.current = null;
      setDraft(null);
      return;
    }
    const nextDraft = { ...savedSettings };
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }, [schema, savedSettings, dirty]);

  useEffect(() => {
    setSaveError(null);
  }, [context.scope, context.runtimeId, context.moduleId, context.gamePath]);

  const displaySettings = draft || savedSettings;
  const canEdit = Boolean(api && schema && displaySettings);

  const choiceActions = JSON.stringify([...new Set((schema?.fields || []).filter(field => (isGameScope || !field.gameOnly) && isRuntimeSettingVisible(field, displaySettings || {})).map(field => field.optionsAction).filter(Boolean))]);
  useEffect(() => {
    const scope = JSON.stringify([context.moduleId, context.gamePath, context.runtimeId, isGameScope, choiceActions]);
    if (choiceScope.current !== scope) { setChoices({}); choiceScope.current = scope; }
    setChoiceError(null); setChoiceLoading({});
    const actions = JSON.parse(choiceActions) as string[];
    const request = settingChoiceRequest(api, context);
    if (!actions.length || !request) return;
    setChoiceLoading(Object.fromEntries(actions.map(action => [action, true])));
    return loadSettingChoices(actions, request,
      (action, groups) => setChoices(previous => ({ ...previous, [action]: groups })),
      (_action, error) => setChoiceError(error instanceof Error ? error.message : String(error)),
      action => setChoiceLoading(previous => ({ ...previous, [action]: false })));
  }, [api?.moduleAction, api?.moduleSettingsAction, context.moduleId, context.gamePath, context.runtimeId, isGameScope, choiceActions, choiceRevision]);

  saveCallback.current = async currentDraft => {
    if (!api || !schema) return;
    const defaults = baseDefaults || buildRuntimeSettingsDefaults(schema);
    const normalizedDraft = normalizeRuntimeSettings(schema, currentDraft, defaults);
    const isModified = !runtimeSettingsEqual(schema, normalizedDraft, defaults);
    if (!isGameScope) {
      await api.setModuleRuntimeSettings(context.moduleId, context.runtimeId, isModified ? normalizedDraft : null);
    } else if (context.gamePath) {
      await api.setGameRuntimeSettings(context.gamePath, context.runtimeId, isModified ? normalizedDraft : null);
    }
  };
  async function persistDraft(nextDraft: Record<string, any>) {
    if (!api || !schema) return;
    setSaveError(null);
    try {
      const written = await writer.save(nextDraft);
      setSaveError(null);
      if (draftRef.current === written && !writer.busy) setDirty(false);
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    }
  }

  function onReset() {
    if (!schema) return;
    const defaults = baseDefaults || buildRuntimeSettingsDefaults(schema);
    const nextDraft = { ...defaults };
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setDirty(true);
    setSaveError(null);
    void persistDraft(nextDraft);
  }

  function onFieldChange(key: string, value: any) {
    const nextDraft = { ...(draftRef.current || savedSettings || {}), [key]: value };
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setDirty(true);
    setSaveError(null);
    void persistDraft(nextDraft);
  }

  const subtitleBase = isGameScope
    ? `${gameEntry?.name || "Game"} · ${moduleLabel}`
    : moduleLabel;
  const subtitle = modified ? `${subtitleBase} · Modified` : subtitleBase;
  const resetLabel =
    context.scope === "game"
      ? "Reset to game type defaults"
      : "Reset to global defaults";

  return (
    <section className={inline ? "runtimeSettingsInline" : "runtimeSettingsRoot"} aria-label={`${runtimeLabel} settings`}>
      <div className={inline ? "runtimeSettingsInlinePanel" : "runtimeSettingsPanel"}>
        {!inline && <div className="runtimeSettingsHeader">
          <div>
            <div className="modalTitle">{runtimeLabel} settings <RuntimeDescription moduleInfo={moduleInfo} runtimeId={context.runtimeId} /></div>
            <div className="modalSubtitle">{subtitle}</div>
          </div>
        </div>}
        <div className={inline ? "runtimeSettingsInlineBody" : "runtimeSettingsBody"}>
          {error && <div className="error">Error: {formatUserError(error)}</div>}
          {saveError && <div className="error">Error: {formatUserError(saveError)}</div>}
          {choiceError && <div className="error">Error: {formatUserError(choiceError)}</div>}
          {!api && (
            <div className="empty">
              Launcher bridge unavailable. Open this window from the app.
            </div>
          )}
          {api && !state && <div className="empty">Loading runtime settings…</div>}
          {api && state && schema && displaySettings && (
            <div className="settingsStack">
              {schema.fields.filter(field => field.key !== "networkIsolation" && (isGameScope || !field.gameOnly) && isRuntimeSettingVisible(field, displaySettings)).map(field => {
                const fieldsDisabled = !canEdit || matchesAnyCondition(displaySettings, field.disabledWhen);
                const isProtectionToggle = field.key === "enableProtections";
                const checked = Boolean((displaySettings as any)[field.key]) === (field.checkedValue !== false);
                const statusText = isProtectionToggle
                  ? formatProtectionStatus(checked)
                  : "";
                if (field.optionsAction) {
                  const selected = String((displaySettings as any)[field.key] || "");
                  const options = choices[field.optionsAction]?.[field.optionsKey || field.key] || field.options || [];
                  const loading = choiceLoading[field.optionsAction] === true;
                  const disabled = fieldsDisabled || (field.gameOnly === true && !isGameScope) || (loading && !choices[field.optionsAction]);
                  return <div className="settingsRow" key={field.key}>
                    <div className="settingsLabel">{field.label}{field.description && <HelpTip label={`About ${field.label}`}>{field.description}</HelpTip>}</div>
                    <div className="settingsControl">
                      <select className="input" aria-label={field.label} value={selected} disabled={disabled}
                        onChange={event => onFieldChange(field.key, event.target.value)}>
                        {!options.some(option => option.value === selected) && <option value={selected}>{selected ? (loading || !choices[field.optionsAction] ? "Loading saved selection…" : "Selected option unavailable") : "Off"}</option>}
                        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                      <button type="button" className="btn iconOnly" title={`Refresh ${field.label}`} aria-label={`Refresh ${field.label}`} disabled={disabled || loading}
                        onClick={() => setChoiceRevision(value => value + 1)}><RefreshIcon /></button>
                    </div>
                  </div>;
                }
                if (field.type === "boolean") {
                  return (
                    <React.Fragment key={field.key}>
                      <div className="settingsRow">
                        <div className="settingsLabel">{field.label}{(field.description || statusText) && <HelpTip label={`About ${field.label}`}>{field.description || statusText}</HelpTip>}</div>
                        <div className="settingsControl">
                          <label className="inlineCheck settingsToggle">
                            <input
                              type="checkbox"
                              aria-label={field.label}
                              checked={checked}
                              onChange={e =>
                                onFieldChange(
                                  field.key,
                                  field.checkedValue === false ? !e.target.checked : e.target.checked
                                )
                              }
                              disabled={!canEdit || fieldsDisabled}
                            />
                            {(checked ? field.checkedLabel : field.uncheckedLabel) && <span>{checked ? field.checkedLabel : field.uncheckedLabel}</span>}
                          </label>
                        </div>
                      </div>
                    </React.Fragment>
                  );
                }
                if (field.type === "number") {
                  const num = (displaySettings as any)[field.key];
                  return (
                    <React.Fragment key={field.key}>
                      <div className="settingsRow">
                        <div className="settingsLabel">{field.label}{field.description && <HelpTip label={`About ${field.label}`}>{field.description}</HelpTip>}</div>
                        <div className="settingsControl">
                          <input
                            className="input"
                            type="number"
                            aria-label={field.label}
                            value={Number.isFinite(num) ? num : ""}
                            onChange={e => onFieldChange(field.key, Number(e.target.value))}
                            disabled={!canEdit || fieldsDisabled}
                          />
                        </div>
                      </div>
                    </React.Fragment>
                  );
                }
                if (field.type === "select") {
                  const options = Array.isArray(field.options) ? field.options : [];
                  const selected = String((displaySettings as any)[field.key] || "");
                  return (
                    <React.Fragment key={field.key}>
                      <div className="settingsRow">
                        <div className="settingsLabel">{field.label}{field.description && <HelpTip label={`About ${field.label}`}>{field.description}</HelpTip>}</div>
                        <div className="settingsControl">
                          <select
                            className="input"
                            aria-label={field.label}
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
                    </React.Fragment>
                  );
                }
                if (field.type === "list") {
                  const raw = (displaySettings as any)[field.key];
                  const textValue = Array.isArray(raw) ? raw.join("\n") : String(raw || "");
                  return (
                    <React.Fragment key={field.key}>
                      <div className="settingsRow">
                        <div className="settingsLabel">{field.label}{field.description && <HelpTip label={`About ${field.label}`}>{field.description}</HelpTip>}</div>
                        <div className="settingsControl">
                          <textarea
                            className="input"
                            rows={4}
                            aria-label={field.label}
                            value={textValue}
                            onChange={e => onFieldChange(field.key, e.target.value)}
                            disabled={!canEdit || fieldsDisabled}
                          />
                        </div>
                      </div>
                    </React.Fragment>
                  );
                }
                return (
                  <React.Fragment key={field.key}>
                    <div className="settingsRow">
                      <div className="settingsLabel">{field.label}{field.description && <HelpTip label={`About ${field.label}`}>{field.description}</HelpTip>}</div>
                      <div className="settingsControl">
                        <input
                          className="input"
                          type="text"
                          aria-label={field.label}
                          value={String((displaySettings as any)[field.key] || "")}
                          onChange={e => onFieldChange(field.key, e.target.value)}
                          disabled={!canEdit || fieldsDisabled}
                        />
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
              {schema.fields.some(field => (isGameScope || !field.gameOnly) && isRuntimeSettingVisible(field, displaySettings) &&
                field.key !== "networkIsolation") && <div className="runtimeSettingsActions">
                <button
                  className="btn"
                  onClick={onReset}
                  disabled={!schema || !canEdit}
                  title={resetLabel}
                  aria-label={resetLabel}
                >
                  Reset
                </button>
              </div>}
            </div>
          )}
          {inline && <RuntimeDescription moduleInfo={moduleInfo} runtimeId={context.runtimeId} />}
        </div>
      </div>
    </section>
  );
}

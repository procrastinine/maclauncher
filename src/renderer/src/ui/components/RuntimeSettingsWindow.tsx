import { Select } from "./Select";
import { RefreshIcon } from "../icons";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { LauncherApi, LauncherState, RuntimeSettingsContext, RuntimeSettingField, RuntimeSettingsSchema } from "../types";
import {
  buildRuntimeSettingsDefaults,
  formatModuleLabel,
  formatProtectionStatus,
  formatRuntimeLabel,
  matchesAnyCondition,
  isRuntimeSettingVisible,
  normalizeListValue,
  normalizeRuntimeSettings,
  resolveModuleRuntimeSettings,
  resolveRuntimeSettingsSchema,
  runtimeSettingsEqual
} from "../ui-helpers";

import { HelpTip } from "./HelpTip";
import { RuntimeSettingsDisplay } from "./RuntimeSettingsDisplay";
import { RuntimeDescription } from "./RuntimeDescription";
import { CommitNumberInput, CommitTextArea, CommitTextInput } from "./CommitInput";
import { ErrorText } from "./ErrorText";
import { Toggle } from "./FieldRow";
import { createQueuedWriter, type QueuedWriter } from "./queued-write-model";
import { loadSettingChoices, settingChoiceRequest, type SettingChoices } from "./runtime-setting-choices";
import { RuntimeFileSetting } from "./RuntimeFileSetting";

export type RuntimeSettingsApi = Pick<LauncherApi, "setModuleRuntimeSettings" | "setGameRuntimeSettings"> & Partial<Pick<LauncherApi, "moduleAction" | "moduleSettingsAction">>;

type RuntimeSettingsWindowProps = {
  api: RuntimeSettingsApi | undefined;
  state: LauncherState | null;
  context: RuntimeSettingsContext;
  error: string | null;
  inline?: boolean;
  fieldKeys?: string[];
  renderField?: (field: RuntimeSettingField, control: React.ReactNode, setField: (key: string, value: unknown) => Promise<boolean>) => React.ReactNode;
  showReset?: boolean;
  showDescription?: boolean;
  controlled?: { schema: RuntimeSettingsSchema; values: Record<string, unknown>; save: (values: Record<string, unknown>) => Promise<void>; resetLabel?: string };
};

export function RuntimeSettingsWindow({
  api,
  state,
  context,
  error,
  inline = false,
  fieldKeys,
  renderField,
  showReset = true,
  showDescription = true,
  controlled
}: RuntimeSettingsWindowProps) {
  const [draft, setDraft] = useState<Record<string, any> | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, SettingChoices>>({});
  const [choiceError, setChoiceError] = useState<string | null>(null);
  const [choiceLoading, setChoiceLoading] = useState<Record<string, boolean>>({});
  const choiceScope = useRef("");
  const [choiceRevision, setChoiceRevision] = useState(0);
  const [pickingField, setPickingField] = useState<string | null>(null);
  const pickerScope = useRef("");
  pickerScope.current = JSON.stringify([context.scope, context.moduleId, context.runtimeId, context.gamePath]);
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
    () => controlled?.schema || resolveRuntimeSettingsSchema(moduleInfo, context.runtimeId),
    [moduleInfo, context.runtimeId, controlled?.schema]
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
    if (controlled) return buildRuntimeSettingsDefaults(schema);
    return resolveModuleRuntimeSettings(
      state,
      context.moduleId,
      moduleInfo,
      context.runtimeId
    );
  }, [schema, state, context.moduleId, moduleInfo, context.runtimeId, Boolean(controlled)]);
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
    if (controlled) return controlled.values;
    if (!isGameScope) return null;
    const raw = gameEntry?.runtimeSettings?.[context.runtimeId];
    return raw && typeof raw === "object" ? raw : null;
  }, [isGameScope, gameEntry, context.runtimeId, controlled?.values]);
  const normalizedGameOverride = useMemo(() => {
    if (!schema || !isGameScope) return null;
    if (!gameOverride || typeof gameOverride !== "object") return null;
    const defaults = baseDefaults || buildRuntimeSettingsDefaults(schema);
    return normalizeRuntimeSettings(schema, gameOverride, defaults);
  }, [schema, isGameScope, gameOverride, baseDefaults]);
  const savedSettings = useMemo(() => {
    if (!schema) return null;
    if (controlled) return normalizeRuntimeSettings(schema, controlled.values, baseDefaults || buildRuntimeSettingsDefaults(schema));
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
  }, [schema, isGameScope, normalizedGameOverride, baseDefaults, moduleDefaults, controlled?.values]);
  const savedModified = useMemo(() => {
    if (!schema || !baseDefaults) return false;
    if (controlled) return !runtimeSettingsEqual(schema, savedSettings, baseDefaults);
    if (isGameScope) {
      if (!normalizedGameOverride) return false;
      return !runtimeSettingsEqual(schema, normalizedGameOverride, baseDefaults);
    }
    if (!moduleDefaults) return false;
    return !runtimeSettingsEqual(schema, moduleDefaults, baseDefaults);
  }, [schema, isGameScope, normalizedGameOverride, baseDefaults, moduleDefaults, Boolean(controlled), savedSettings]);
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
    setPickingField(null);
  }, [context.scope, context.runtimeId, context.moduleId, context.gamePath]);

  const displaySettings = draft || savedSettings;
  const canEdit = Boolean(api && schema && displaySettings);
  const visibleFields = (schema?.fields || []).filter(field => field.key !== "networkIsolation" &&
    (isGameScope || !field.gameOnly) && isRuntimeSettingVisible(field, displaySettings || {}) && (!fieldKeys || fieldKeys.includes(field.key)));
  const fileRequest = useMemo(() => settingChoiceRequest(api, context),
    [api?.moduleAction, api?.moduleSettingsAction, context.scope, context.moduleId, context.runtimeId, context.gamePath]);

  async function pickSettingFile(key: string, action: string, resultKey = "filePath") {
    const request = settingChoiceRequest(api, context), scope = pickerScope.current;
    if (!request) return;
    setPickingField(key);setSaveError(null);
    try {
      const result = await request(action) as Record<string, unknown> | null;
      if (pickerScope.current !== scope || result?.[resultKey] == null) return;
      const value = result[resultKey];
      const field = schema?.fields.find(item => item.key === key);
      if (field?.type === "list") {
        if (!Array.isArray(value) || value.length > 256 || value.some(item => typeof item !== "string" || item.length > 16384 || /[\0\r\n]/.test(item)))
          throw new Error("The selected file paths are invalid.");
        if (value.length) onFieldChange(key, [...new Set([...normalizeListValue((draftRef.current || savedSettings || {})[key], field.listSeparator), ...value])]);
        return;
      }
      if (typeof value !== "string" || value.length > 16384 || value.includes("\0")) throw new Error("The selected file path is invalid.");
      onFieldChange(key, value);
    } catch (error: any) { if (pickerScope.current === scope) setSaveError(String(error?.message || error)); }
    finally { if (pickerScope.current === scope) setPickingField(null); }
  }

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
    if (controlled) { await controlled.save(normalizedDraft);return; }
    const isModified = !runtimeSettingsEqual(schema, normalizedDraft, defaults);
    if (!isGameScope) {
      await api.setModuleRuntimeSettings(context.moduleId, context.runtimeId, isModified ? normalizedDraft : null);
    } else if (context.gamePath) {
      await api.setGameRuntimeSettings(context.gamePath, context.runtimeId, isModified ? normalizedDraft : null);
    }
  };
  async function persistDraft(nextDraft: Record<string, any>) {
    if (!api || !schema) return false;
    setSaveError(null);
    try {
      const written = await writer.save(nextDraft);
      setSaveError(null);
      if (draftRef.current === written && !writer.busy) setDirty(false);
      return true;
    } catch (e: any) {
      setSaveError(String(e?.message || e));
      return false;
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
    return persistDraft(nextDraft);
  }

  function onFieldChange(key: string, value: any) {
    const nextDraft = { ...(draftRef.current || savedSettings || {}), [key]: value };
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setDirty(true);
    setSaveError(null);
    return persistDraft(nextDraft);
  }

  const subtitleBase = isGameScope
    ? `${gameEntry?.name || "Game"} · ${moduleLabel}`
    : moduleLabel;
  const subtitle = modified ? `${subtitleBase} · Modified` : subtitleBase;
  const resetLabel = controlled?.resetLabel || (context.scope === "game"
      ? "Reset to game type defaults"
      : "Reset to global defaults");

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
          <ErrorText error={error} />
          <ErrorText error={saveError} />
          <ErrorText error={choiceError} />
          {!api && (
            <div className="empty">
              Launcher bridge unavailable. Open this window from the app.
            </div>
          )}
          {api && !state && <div className="empty">Loading runtime settings…</div>}
          {api && state && schema && displaySettings && (
            <div className="settingsStack">
              <SettingFieldRows rows={visibleFields.map(field => {
                if (field.type === "display") return <RuntimeSettingsDisplay key={field.key} field={field} />;
                const requirement = field.requiresInstall;
                const missingInstall = Boolean(requirement && !state.runtimeManagers?.[requirement.managerId]?.sections?.find(section => section.id === requirement.sectionId)?.installed?.some((install: Record<string, any>) => install.ready === true));
                const fieldsDisabled = !canEdit || missingInstall || matchesAnyCondition(displaySettings, field.disabledWhen);
                const isProtectionToggle = field.key === "enableProtections";
                const checked = !missingInstall && Boolean((displaySettings as any)[field.key]) === (field.checkedValue !== false);
                const statusText = isProtectionToggle
                  ? formatProtectionStatus(checked)
                  : "";
                if (field.fileStatusAction && field.pickerAction) return <RuntimeFileSetting
                  key={field.key} field={field} value={String(displaySettings[field.key] || "")} disabled={fieldsDisabled}
                  request={fileRequest} onChange={value => onFieldChange(field.key, value)} />;
                if (field.optionsAction) {
                  const selected = String((displaySettings as any)[field.key] || "");
                  const options = choices[field.optionsAction]?.[field.optionsKey || field.key] || field.options || [];
                  const loading = choiceLoading[field.optionsAction] === true;
                  const disabled = fieldsDisabled || (field.gameOnly === true && !isGameScope) || (loading && !choices[field.optionsAction]);
                  return <div className="settingsRow" key={field.key}>
                    <div className="settingsLabel">{field.label}{field.description && <HelpTip label={`About ${field.label}`}>{field.description}</HelpTip>}</div>
                    <div className="settingsControl">
                      <Select className="input" aria-label={field.label} value={selected} disabled={disabled}
                        onChange={event => onFieldChange(field.key, event.target.value)}>
                        {!options.some(option => option.value === selected) && <option value={selected}>{selected ? (loading || !choices[field.optionsAction] ? "Loading saved selection…" : "Selected option unavailable") : "Off"}</option>}
                        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </Select>
                      <button type="button" className="btn iconOnly" title={`Refresh ${field.label}`} aria-label={`Refresh ${field.label}`} disabled={disabled || loading}
                        onClick={() => setChoiceRevision(value => value + 1)}><RefreshIcon /></button>
                    </div>
                  </div>;
                }
                if (field.type === "boolean") {
                  return (
                    <div className="settingsRow" key={field.key}>
                      <div className="settingsLabel">{field.label}{(field.description || statusText) && <HelpTip label={`About ${field.label}`}>{field.description || statusText}</HelpTip>}</div>
                      <div className="settingsControl">
                        <Toggle label={field.label} checked={checked} disabled={!canEdit || fieldsDisabled}
                          onChange={next => onFieldChange(field.key, field.checkedValue === false ? !next : next)} />
                      </div>
                    </div>
                  );
                }
                if (field.type === "number") {
                  const num = (displaySettings as any)[field.key];
                  return (
                    <div className="settingsRow" key={field.key}>
                      <div className="settingsLabel">{field.label}{field.description && <HelpTip label={`About ${field.label}`}>{field.description}</HelpTip>}</div>
                      <div className="settingsControl">
                        <CommitNumberInput aria-label={field.label} value={Number.isFinite(num) ? num : null} min={field.min} max={field.max} step={field.step}
                          onCommit={next => onFieldChange(field.key, next)} disabled={!canEdit || fieldsDisabled} />
                      </div>
                    </div>
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
                          <Select
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
                          </Select>
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
                          <CommitTextArea rows={4} aria-label={field.label} value={textValue}
                            onCommit={next => onFieldChange(field.key, next)} disabled={!canEdit || fieldsDisabled} />
                          {field.pickerAction && <button type="button" className="btn" disabled={fieldsDisabled || pickingField !== null}
                            onClick={() => void pickSettingFile(field.key, field.pickerAction!, field.pickerResultKey || "filePaths")}>
                            {pickingField === field.key ? "Choosing…" : "Add…"}
                          </button>}
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
                        <CommitTextInput aria-label={field.label} value={String((displaySettings as any)[field.key] || "")}
                          onCommit={next => onFieldChange(field.key, next)} disabled={!canEdit || fieldsDisabled} />
                        {field.pickerAction && <button type="button" className="btn" disabled={fieldsDisabled || pickingField !== null}
                          onClick={() => void pickSettingFile(field.key, field.pickerAction!, field.pickerResultKey)}>
                          {pickingField === field.key ? "Choosing…" : "Browse…"}
                        </button>}
                      </div>
                    </div>
                  </React.Fragment>
                );
              }).map((control, index) => ({ field: visibleFields[index], control }))}
              render={(field, control) => renderField ? renderField(field, control, onFieldChange) : control} />
              {showReset && visibleFields.some(field => field.type !== "display") && <div className="runtimeSettingsActions">
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
          {schema?.provider && (!schema.provider.gameOnly || isGameScope) && <RuntimeSettingsProvider
            key={JSON.stringify([context.moduleId, context.runtimeId, context.gamePath])}
            api={api} state={state} context={context} provider={schema.provider}
            revision={JSON.stringify([gameEntry?.runtimeData, gameEntry?.moduleData])} />}
          {inline && showDescription && <RuntimeDescription moduleInfo={moduleInfo} runtimeId={context.runtimeId} />}
        </div>
      </div>
    </section>
  );
}

type ProviderSettings = { schema: RuntimeSettingsSchema; values: Record<string, unknown>; message?: string };
type SettingFieldRow = { field: RuntimeSettingField; control: React.ReactNode };

// Fields marked advanced follow the others in one collapsed group. When every
// shown field is advanced, nothing is left to separate them from, so they stay flat.
function SettingFieldRows({ rows, render }: { rows: SettingFieldRow[]; render: (field: RuntimeSettingField, control: React.ReactNode) => React.ReactNode }) {
  const basic = rows.filter(row => !row.field.advanced), advanced = rows.filter(row => row.field.advanced);
  const list = (items: SettingFieldRow[]) => items.map(({ field, control }, index) => <React.Fragment key={field.key}>
    {field.section && field.section !== items[index - 1]?.field.section &&
      <div className="settingsLabel" role="heading" aria-level={3}>{field.section}</div>}
    {render(field, control)}
  </React.Fragment>);
  if (!basic.length || !advanced.length) return <>{list(rows)}</>;
  return <>
    {list(basic)}
    <details className="settingsAdvanced">
      <summary>Advanced <span className="settingsAdvancedCount">{advanced.length}</span></summary>
      <div className="settingsStack">{list(advanced)}</div>
    </details>
  </>;
}

function providerSettings(value: unknown): ProviderSettings {
  const result = value as ProviderSettings;
  if (!result || !result.schema || !Array.isArray(result.schema.fields) || result.schema.fields.length > 128 ||
      result.schema.fields.some(field => !field || typeof field.key !== "string" || typeof field.label !== "string" ||
        !["boolean", "number", "string", "select", "list", "display"].includes(field.type)) ||
      !result.values || typeof result.values !== "object" || Array.isArray(result.values)) throw new Error("Game settings are unavailable.");
  return { schema: { fields: result.schema.fields, defaults: result.schema.defaults }, values: result.values,
    message: typeof result.message === "string" ? result.message.slice(0, 512) : undefined };
}
function RuntimeSettingsProvider({ api, state, context, provider, revision }: {
  api: RuntimeSettingsApi | undefined; state: LauncherState | null; context: RuntimeSettingsContext;
  provider: NonNullable<RuntimeSettingsSchema["provider"]>; revision: string;
}) {
  const [loaded, setLoaded] = useState<ProviderSettings | null>(null), [error, setError] = useState<string | null>(null);
  const scope = useRef(0);
  useEffect(() => {
    const request = settingChoiceRequest(api, context), generation = ++scope.current;
    setLoaded(null);setError(null);
    if (request) void request(provider.readAction).then(result => {
      if (scope.current === generation) setLoaded(providerSettings(result));
    }).catch(failure => { if (scope.current === generation) setError(String(failure?.message || failure)); });
    return () => { scope.current++; };
  }, [api?.moduleAction, api?.moduleSettingsAction, context.moduleId, context.gamePath, context.runtimeId, provider.readAction, revision]);
  async function save(values: Record<string, unknown>) {
    const request = settingChoiceRequest(api, context), generation = scope.current;
    if (!request) throw new Error("Launcher bridge unavailable.");
    const result = providerSettings(await request(provider.writeAction, { values }));
    if (generation === scope.current) setLoaded(result);
  }
  return <>
    <ErrorText error={error} />
    {!loaded && !error && <div className="empty">Loading game settings…</div>}
    {loaded?.message && <div className="empty">{loaded.message}</div>}
    {loaded && loaded.schema.fields.length > 0 && <RuntimeSettingsWindow api={api} state={state} context={context}
      error={null} inline showDescription={false} controlled={{ ...loaded, save, resetLabel: "Reset to tested defaults" }} />}
  </>;
}

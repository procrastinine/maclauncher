import type { LauncherApi, RuntimeSettingField, RuntimeSettingOption, RuntimeSettingsContext } from "../types";
import { isRuntimeSettingChoiceValue } from "../../../../core/runtime-setting-values.mjs";

export type SettingChoices = Record<string, any>;

const cacheKey = (context: RuntimeSettingsContext) => "maclauncher:setting-choices:" +
  JSON.stringify([context.scope, context.moduleId, context.runtimeId, context.gamePath]);
function cachedRecords(context: RuntimeSettingsContext) {
  try {
    const records = JSON.parse(window.localStorage.getItem(cacheKey(context)) || "{}");
    return records && typeof records === "object" && !Array.isArray(records) ? records : {};
  } catch { return {}; }
}

// Before a game's choice list arrives, a saved translator choice is named from
// the runtime inventories already in the launcher state. A managed copy,
// "<manager>:<version>", takes that version's listed label. An included copy,
// "included:<component>:<name>", takes the label of the one reference to the
// game's Wine runtime whose folder or translator manager carries that name.
export function inventoryChoiceLabel(value: string, runtimeId: string, managers: Record<string, any> | undefined): string | undefined {
  if (!value || !managers || typeof managers !== "object") return undefined;
  const sections = (state: any) => [state, ...(Array.isArray(state?.sections) ? state.sections : [])].filter(item => item && typeof item === "object");
  const included = /^included:[^:]+:([^:]+)$/.exec(value);
  if (included) {
    const name = included[1], byFolder = new Set<string>(), byManager = new Set<string>();
    for (const [managerId, state] of Object.entries(managers)) for (const section of sections(state)) for (const row of section.references || []) {
      if (row?.reference?.managerId !== runtimeId || typeof row.versionLabel !== "string" || !row.versionLabel) continue;
      if (String(row.installDir || "").split("/").pop() === name) byFolder.add(row.versionLabel);
      else if (managerId === `translator-${name}`) byManager.add(row.versionLabel);
    }
    const labels = byFolder.size ? byFolder : byManager;
    return labels.size === 1 ? [...labels][0] : undefined;
  }
  const at = value.indexOf(":"), state = at > 0 ? managers[value.slice(0, at)] : undefined;
  if (!state || typeof state !== "object") return undefined;
  const version = value.slice(at + 1);
  for (const candidate of [version, version.replace(/:d3d12$/, "")]) for (const section of sections(state)) {
    const listed = section.versionLabels?.[candidate];
    if (typeof listed === "string" && listed) return listed;
    const row = (section.installed || []).find((item: any) => item?.version === candidate);
    if (row) return [state.label, typeof row.versionLabel === "string" && row.versionLabel ? row.versionLabel : candidate].filter(Boolean).join(" ");
  }
  return undefined;
}

// Persist provider results, including their labels and atomic settings patches.
// An earlier request can supply a saved label, but only matching inputs supply
// selectable choices. A failed refresh leaves the last successful result intact.
export function readSettingChoices(context: RuntimeSettingsContext, inputs?: Record<string, unknown>, fields: RuntimeSettingField[] = []): Record<string, SettingChoices> {
  try {
    return Object.fromEntries(Object.entries(cachedRecords(context)).flatMap(([action, record]: [string, any]) => {
      if (!record || inputs && record.inputs !== JSON.stringify(inputs)) return [];
      try { return [[action, settingChoiceGroups(action, record.choices, fields)]]; }
      catch { return []; }
    }));
  } catch { return {}; }
}

export function storeSettingChoices(context: RuntimeSettingsContext, inputs: Record<string, unknown>, action: string, choices: SettingChoices) {
  try {
    window.localStorage.setItem(cacheKey(context), JSON.stringify({ ...cachedRecords(context),
      [action]: { inputs: JSON.stringify(inputs), choices } }));
  } catch { /* An unavailable browser cache does not prevent editing settings. */ }
}

function settingChoiceGroups(action: string, result: unknown, fields: RuntimeSettingField[]) {
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw Object.assign(new Error("Local setting choices are unavailable."), {
      responseType: result === null ? "null" : Array.isArray(result) ? "array" : typeof result
    });
  const groups: SettingChoices = { ...result };
  for (const key of new Set(fields.filter(field => field.optionsAction === action).map(field => field.optionsKey || field.key))) {
    const options = groups[key];
    if (options === undefined) continue;
    if (!Array.isArray(options)) {
      console.warn("Skipped an invalid local setting choice list.", action, key);
      groups[key] = [];
      continue;
    }
    const usable = options.filter(option => option &&
      isRuntimeSettingChoiceValue(option.value) && typeof option.label === "string" &&
      !/[\x00-\x1f\x7f]/.test(option.value + option.label));
    if (usable.length !== options.length) {
      console.warn("Skipped invalid local setting choices.", action, key);
      groups[key] = usable;
    }
  }
  return groups;
}

export function settingChoiceScope(_choices: SettingChoices | undefined, _field: RuntimeSettingField, option?: RuntimeSettingOption) {
  return option?.heldBack === true && typeof option.notice === "string" ? option.notice : "";
}

export function settingChoiceRequest(
  api: Partial<Pick<LauncherApi, "moduleAction" | "moduleSettingsAction">> | undefined,
  context: RuntimeSettingsContext
) {
  if (context.scope === "game") {
    const request = api?.moduleAction, gamePath = context.gamePath;
    return request && gamePath ? (action: string, payload?: Record<string, unknown>) => request(gamePath, action, payload, { runtimeId: context.runtimeId }) : null;
  }
  const request = api?.moduleSettingsAction;
  return request ? (action: string, payload?: Record<string, unknown>) => request(context.moduleId, action, { ...payload, runtimeId: context.runtimeId }) : null;
}

// Local providers finish independently: a slow device scan must not delay
// saved account or installed-runtime choices from another provider.
export function loadSettingChoices(
  actions: string[],
  request: (action: string) => Promise<unknown>,
  receive: (action: string, choices: SettingChoices) => void,
  failed: (action: string, error: unknown) => void,
  settled: (action: string) => void,
  fields: RuntimeSettingField[] = []
) {
  let active = true;
  for (const action of actions) {
    void Promise.resolve().then(() => request(action)).then(result => {
      if (!active || result === false) return;
      receive(action, settingChoiceGroups(action, result, fields));
    }).catch(error => {
      if (!active) return;
      if (typeof error?.responseType === "string") console.warn("Local setting choice response is unavailable.", { action, responseType: error.responseType });
      failed(action, error);
    })
      .finally(() => { if (active) settled(action); });
  }
  return () => { active = false; };
}

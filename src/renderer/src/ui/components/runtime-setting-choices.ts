import type { LauncherApi, RuntimeSettingField, RuntimeSettingOption, RuntimeSettingsContext } from "../types";
import { isRuntimeSettingChoiceValue } from "../../../../core/runtime-setting-values.mjs";

export type SettingChoices = Record<string, any>;

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
      if (!active) return;
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error("Local setting choices are unavailable.");
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
      receive(action, groups);
    }).catch(error => { if (active) failed(action, error); })
      .finally(() => { if (active) settled(action); });
  }
  return () => { active = false; };
}

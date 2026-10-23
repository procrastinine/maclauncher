import type { LauncherApi, RuntimeSettingsContext } from "../types";

export type SettingChoices = Record<string, Array<{ value: string; label: string }>>;

export function settingChoiceRequest(
  api: Partial<Pick<LauncherApi, "moduleAction" | "moduleSettingsAction">> | undefined,
  context: RuntimeSettingsContext
) {
  if (context.scope === "game") {
    const request = api?.moduleAction, gamePath = context.gamePath;
    return request && gamePath ? (action: string) => request(gamePath, action) : null;
  }
  const request = api?.moduleSettingsAction;
  return request ? (action: string) => request(context.moduleId, action, { runtimeId: context.runtimeId }) : null;
}

// Local providers finish independently: a slow device scan must not delay
// saved account or installed-runtime choices from another provider.
export function loadSettingChoices(
  actions: string[],
  request: (action: string) => Promise<unknown>,
  receive: (action: string, choices: SettingChoices) => void,
  failed: (action: string, error: unknown) => void,
  settled: (action: string) => void
) {
  let active = true;
  for (const action of actions) {
    void Promise.resolve().then(() => request(action)).then(result => {
      if (!active) return;
      if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length > 16)
        throw new Error("Local setting choices are unavailable.");
      const groups: SettingChoices = {};
      for (const [key, options] of Object.entries(result)) {
        if (!Array.isArray(options) || options.length > 256 || options.some(option => !option ||
            typeof option.value !== "string" || option.value.length > 1024 || typeof option.label !== "string" ||
            option.label.length > 512 || /[\x00-\x1f\x7f]/.test(option.value + option.label)))
          throw new Error("Local setting choices are invalid.");
        groups[key] = options;
      }
      receive(action, groups);
    }).catch(error => { if (active) failed(action, error); })
      .finally(() => { if (active) settled(action); });
  }
  return () => { active = false; };
}

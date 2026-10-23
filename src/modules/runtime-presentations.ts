import android from "./android/manifest.json";
import shaders from "./shared/reshade/runtime/shader-library-ui.json";
import shaderPacks from "./shared/reshade/managed-shader-packs.json";
import groups from "./shared/runtime/group-ui.json";

// Current owned presentation metadata also applies to a cached backend state.
// Versions, installation records and action identities remain backend-owned.
const managerUi: Record<string, Record<string, any>> = { ...android.runtime.managerUi, [shaders.id]: shaders.ui };
const sectionUi: Record<string, Record<string, Record<string, any>>> = {
  [shaders.id]: Object.fromEntries(shaderPacks.packs.map(pack => [pack.id, { shaderFamily: pack.family }]))
};
const groupUi: Record<string, Record<string, any>> = groups;
export function presentRuntimeManagers<T extends { id: string; ui?: Record<string, any>; sections?: Array<Record<string, any>> }>(managers: T[]): T[] {
  return managers.map(manager => {
    const current = managerUi[manager.id], group = groupUi[current?.groupId || manager.ui?.groupId];
    if (!current && !group) return manager;
    const ui = { ...manager.ui, ...current, ...group };
    const sections = sectionUi[manager.id];
    return { ...manager, ui, ...(sections && manager.sections ? {
      sections: manager.sections.map(section => sections[section.id] ? { ...section, ...sections[section.id] } : section)
    } : {}) };
  });
}

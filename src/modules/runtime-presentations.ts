import android from "./android/manifest.json";
import video from "./video/manifest.json";
import shaders from "./shared/reshade/runtime/shader-library-ui.json";
import presets from "./shared/reshade/runtime/preset-library-ui.json";
import shaderPacks from "./shared/reshade/managed-shader-packs.json";
import graphicsProviders from "./shared/reshade/runtime/provider-library-ui.json";
import groups from "./shared/runtime/group-ui.json";
import categories from "./shared/runtime/category-ui.json";

// Current owned presentation metadata also applies to a cached backend state.
// Versions, installation records and action identities remain backend-owned.
const managerUi: Record<string, Record<string, any>> = { ...android.runtime.managerUi, ...video.runtime.managerUi,...graphicsProviders, [shaders.id]: shaders.ui };
const sectionUi: Record<string, Record<string, Record<string, any>>> = {
  [shaders.id]: Object.fromEntries(shaderPacks.packs.map(pack => [pack.id, { shaderFamily: pack.family }]))
};
const groupUi: Record<string, Record<string, any>> = groups;
// Ordered sidebar headings. Modules classify their runtime groups with ui.category;
// an unclassified group joins the category marked default.
export const runtimeCategories: Array<{ id: string; label: string; sort?: "label"; default?: boolean }> =
  categories.categories as Array<{ id: string; label: string; sort?: "label"; default?: boolean }>;
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

// Launcher-owned libraries hold no versions or installation records. Each joins
// the group its metadata names once a backend manager provides that group.
const launcherLibraries = [presets];
export function withLauncherLibraries<T extends { id: string; ui?: Record<string, any> }>(managers: T[]): T[] {
  const groupsPresent = new Set(managers
    .filter(manager => (managerUi[manager.id]?.hidden ?? manager.ui?.hidden) !== true)
    .map(manager => managerUi[manager.id]?.groupId || manager.ui?.groupId));
  const libraries = launcherLibraries.filter(library => groupsPresent.has(library.ui.groupId) && !managers.some(manager => manager.id === library.id));
  return libraries.length ? [...managers, ...libraries as unknown as T[]] : managers;
}

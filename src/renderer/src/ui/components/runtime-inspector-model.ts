import type { ModuleManifest, RuntimeManagerState } from "../types";
import { compareSemver, resolveRuntimeSection, resolveRuntimeSections } from "../ui-helpers";

function inspectorSections(moduleInfo: ModuleManifest | null, runtimeId: string, manager: RuntimeManagerState | null) {
  const policy = moduleInfo?.runtime?.inspectorSections?.[runtimeId];
  const excluded = typeof policy === "object" ? policy.exclude || [] : [];
  return resolveRuntimeSections(manager).filter(section => !excluded.includes(section.id));
}

function catalogChoices(catalog: Record<string, any> | null | undefined): string[] {
  if (!catalog) return [];
  if (Array.isArray(catalog.sources)) return catalog.sources.flatMap(catalogChoices);
  const available: string[] = Array.isArray(catalog.versions) ? catalog.versions : [];
  return available.filter(version => (!Array.isArray(catalog.installableVersions) || catalog.installableVersions.includes(version)) &&
    catalog.versionRequirements?.[version]?.installable !== false);
}

export function resolveInspectorRuntimeSection(moduleInfo: ModuleManifest | null, runtimeId: string,
  manager: RuntimeManagerState | null, sectionId: string | null) {
  const fallback = resolveRuntimeSection(manager, sectionId);
  if (!moduleInfo?.runtime?.inspectorSections?.[runtimeId]) return fallback;
  const sections = inspectorSections(moduleInfo, runtimeId, manager);
  if (!sections.length) return fallback;
  const installed = sections.flatMap(section => Array.isArray(section.installed) ? section.installed : []);
  const versions = [...new Set(sections.flatMap(section => catalogChoices(section.catalog)))];
  const labels = Object.assign({}, ...sections.map(section => ({ ...section.catalog?.versionLabels, ...section.versionLabels })));
  const versionRequirements = Object.assign({}, ...sections.map(section => section.catalog?.versionRequirements || {}));
  return { ...fallback, installed, versionLabels: labels,
    catalog: { ...fallback?.catalog, sources: undefined, versions, installableVersions: versions,
      versionLabels: labels, versionRequirements } };
}

export function runtimeInspectorVersions(section: Record<string, any> | null, selectedVersion = ""): string[] {
  if (!section) return selectedVersion ? [selectedVersion] : [];
  return [...new Set([...catalogChoices(section.catalog),
    ...(section.installed || []).map((item: any) => typeof item?.version === "string" ? item.version : ""), selectedVersion])]
    .filter(Boolean).sort((left, right) => compareSemver(right, left));
}

export function runtimeInspectorVersionPatch(moduleInfo: ModuleManifest | null, runtimeId: string,
  manager: RuntimeManagerState | null, version: string): Record<string, string | null> {
  const patch: Record<string, string | null> = { version: version || null };
  const key = moduleInfo?.runtime?.managerSectionOverrideKey?.[runtimeId];
  if (!version || !key || !moduleInfo?.runtime?.inspectorSections?.[runtimeId]) return patch;
  const section = inspectorSections(moduleInfo, runtimeId, manager).find(section =>
    (section.installed || []).some((item: any) => item.version === version) || catalogChoices(section.catalog).includes(version));
  const id = section?.selectionSectionId || section?.id;
  const value = Object.entries(moduleInfo.runtime?.managerSectionMap?.[runtimeId] || {}).find(([, sectionId]) => sectionId === id)?.[0];
  if (value) patch[key] = value;
  return patch;
}

import type { ModuleManifest, RecentGame, RuntimeManagerState } from "../types";
import { architectureLabel, compareSemver, resolveRuntimeSection, resolveRuntimeSections, resolveRuntimeVersionOverride, runtimeVersionTagger } from "../ui-helpers";
import { installedRuntimeAvailability } from "../../../../core/runtime-install-availability.mjs";

export function runtimeInspectorStatusAction(moduleInfo: ModuleManifest | null, runtimeId: string, game: RecentGame, sectionId: string | null) {
  return moduleInfo?.runtime?.entries?.[runtimeId]?.statusAction ||
    (resolveRuntimeVersionOverride(moduleInfo, runtimeId, game, sectionId) ? null : moduleInfo?.runtime?.preLaunch?.[runtimeId]?.statusAction) || null;
}

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
  // Each installation keeps its own section, which Repair installs into.
  const installed = sections.flatMap(section => (Array.isArray(section.installed) ? section.installed : [])
    .map((row: any) => row && typeof row === "object" && !row.sectionId ? { ...row, sectionId: section.id } : row));
  const versions = [...new Set(sections.flatMap(section => catalogChoices(section.catalog)))];
  const labels = Object.assign({}, ...sections.map(section => ({ ...section.catalog?.versionLabels, ...section.versionLabels })));
  const versionRequirements = Object.assign({}, ...sections.map(section => section.catalog?.versionRequirements || {}));
  return { ...fallback, installed, versionLabels: labels,
    catalog: { ...fallback?.catalog, sources: undefined, versions, installableVersions: versions,
      versionLabels: labels, versionRequirements } };
}

// Selectable versions are the locally installed ones plus an explicit saved
// choice; acquiring other versions happens in the Runtimes window, never from
// the inspector's per-game menu. A damaged installation stays listed so it can
// be repaired; one this Mac cannot run is listed only as the saved choice.
export function runtimeInspectorVersions(section: Record<string, any> | null, selectedVersion = ""): string[] {
  if (!section) return selectedVersion ? [selectedVersion] : [];
  const installed = (Array.isArray(section.installed) ? section.installed : [])
    .filter((item: any) => installedRuntimeAvailability(item) !== "unavailable")
    .map((item: any) => typeof item?.version === "string" ? item.version : "")
    .filter(Boolean);
  return [...new Set([...installed, selectedVersion])]
    .filter(Boolean).sort((left, right) => compareSemver(right, left));
}

function installedArchitecture(row: Record<string, any>) {
  const value = row.architecture || (typeof row.variant === "string" && row.variant.startsWith("architecture:") ? row.variant.slice(13) : "");
  return value === "x86_64" ? "x64" : value;
}

/** The menu entry for the game's saved version choice: the choice itself, or
 * the installed build Play uses for it when the choice names that build in
 * another spelling, such as Godot's "3.5.2" for 3.5.2-stable. The launcher
 * names that build with Play's own selection; the saved choice is unchanged. */
export function runtimeInspectorSelectedVersion(section: Record<string, any> | null, selectedVersion = "", playVersion = "") {
  const installed = Array.isArray(section?.installed) ? section.installed : [];
  if (!selectedVersion || !playVersion || installed.some((row: any) => row?.version === selectedVersion)) return selectedVersion;
  return installed.some((row: any) => row?.version === playVersion && installedRuntimeAvailability(row) === "installed")
    ? playVersion : selectedVersion;
}

/** Separate locally installed CPU copies without changing the stored version.
 * Version wording stays with the same tagger used by the other runtime menus. */
export function runtimeInspectorVersionOptions(section: Record<string, any> | null, selectedVersion = "",
  tag = runtimeVersionTagger(section, runtimeInspectorVersions(section, selectedVersion))) {
  return runtimeInspectorVersions(section, selectedVersion).flatMap<{ value: string; version: string; architecture?: string; label: string }>(version => {
    const present = (Array.isArray(section?.installed) ? section.installed : []).some((row: any) => row?.version === version);
    const label = tag(version) + (present ? "" : " (not installed)");
    const cpus = [...new Set<string>((Array.isArray(section?.installed) ? section.installed : [])
      .filter((row: any) => row?.version === version && installedRuntimeAvailability(row) !== "unavailable")
      .map((row: any) => installedArchitecture(row)).filter((cpu: string) => cpu === "arm64" || cpu === "x64"))];
    if (cpus.length < 2) return [{ value: version, version, architecture: undefined, label }];
    return cpus.map(architecture => ({ value: JSON.stringify([version, architecture]), version, architecture,
      label: `${label} (${architectureLabel(architecture)})` }));
  });
}

/** The installation of one version, of the given variant when one is given: a
 * usable one first, then one that needs repair, then one this Mac cannot run. */
export function runtimeInspectorInstall(section: Record<string, any> | null, version: string, variant = "", architecture = "") {
  const rows = (Array.isArray(section?.installed) ? section.installed : [])
    .filter((row: any) => version && row?.version === version && (!variant || row.variant === variant) &&
      (!architecture || installedArchitecture(row) === architecture || installedArchitecture(row) === "universal"));
  for (const availability of ["installed", "needsRepair", "unavailable"] as const) {
    const install = rows.find((row: any) => installedRuntimeAvailability(row) === availability);
    if (install) return { availability, install: install as Record<string, any> };
  }
  return { availability: null, install: null };
}

/** What Repair installs again for a damaged or incomplete installation: the
 * same version, section, variant and build. A build named by an architecture
 * variant carries its architecture in that variant. */
export function runtimeInspectorRepair(section: Record<string, any> | null, version: string, variant = "", selectedArchitecture = "") {
  const { availability, install } = runtimeInspectorInstall(section, version, variant, selectedArchitecture);
  if (availability !== "needsRepair" || !install) return null;
  const architectureVariant = typeof install.variant === "string" && install.variant.startsWith("architecture:");
  const architecture = !architectureVariant && typeof install.architecture === "string" && install.architecture !== "universal"
    ? install.architecture : undefined;
  return { sectionId: String(install.sectionId || section?.id || "default"), version: String(install.version),
    variant: typeof install.variant === "string" && install.variant ? install.variant : undefined, architecture };
}

export function runtimeInspectorVersionPatch(moduleInfo: ModuleManifest | null, runtimeId: string,
  manager: RuntimeManagerState | null, version: string, architecture?: string | null): Record<string, string | null> {
  const patch: Record<string, string | null> = { version: version || null };
  if (architecture !== undefined) patch.architecture = architecture || null;
  const key = moduleInfo?.runtime?.managerSectionOverrideKey?.[runtimeId];
  if (!version || !key || !moduleInfo?.runtime?.inspectorSections?.[runtimeId]) return patch;
  const section = inspectorSections(moduleInfo, runtimeId, manager).find(section =>
    (section.installed || []).some((item: any) => item.version === version) || catalogChoices(section.catalog).includes(version));
  const id = section?.selectionSectionId || section?.id;
  const value = Object.entries(moduleInfo.runtime?.managerSectionMap?.[runtimeId] || {}).find(([, sectionId]) => sectionId === id)?.[0];
  // A version from a section without a choice of its own clears an earlier
  // choice, so the automatic section follows that version.
  if (value) patch[key] = value;
  else if (section) patch[key] = null;
  return patch;
}

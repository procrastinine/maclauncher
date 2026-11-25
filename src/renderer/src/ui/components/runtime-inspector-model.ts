import type { ModuleManifest, RecentGame, RuntimeManagerState } from "../types";
import { architectureLabel, compareSemver, resolveRuntimeSection, resolveRuntimeSections, resolveRuntimeVersionOverride, runtimeVersionTagger } from "../ui-helpers";
import { installedRuntimeAvailability } from "../../../../core/runtime-install-availability.mjs";
import { joinHelpLabels } from "./HelpList";

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
 * Version wording stays with the same tagger used by the other runtime menus.
 * While `choicePending`, Play's answer for the saved choice has not arrived, so
 * a choice missing under its own spelling carries no marker yet. */
export function runtimeInspectorVersionOptions(section: Record<string, any> | null, selectedVersion = "",
  tag = runtimeVersionTagger(section, runtimeInspectorVersions(section, selectedVersion)), choicePending = false) {
  return runtimeInspectorVersions(section, selectedVersion).flatMap<{ value: string; version: string; architecture?: string; label: string }>(version => {
    const present = (Array.isArray(section?.installed) ? section.installed : []).some((row: any) => row?.version === version);
    // A saved choice this Mac cannot install now (its source states why) is
    // unavailable rather than merely not installed.
    const blocked = Boolean(section?.catalog?.versionRequirements?.[version]?.installReason);
    const label = tag(version) + (present || choicePending && version === selectedVersion ? "" : blocked ? " (unavailable)" : " (not installed)");
    const cpus = [...new Set<string>((Array.isArray(section?.installed) ? section.installed : [])
      .filter((row: any) => row?.version === version && installedRuntimeAvailability(row) !== "unavailable")
      .map((row: any) => installedArchitecture(row)).filter((cpu: string) => cpu === "arm64" || cpu === "x64"))];
    if (cpus.length < 2) return [{ value: version, version, architecture: undefined, label }];
    return cpus.map(architecture => ({ value: JSON.stringify([version, architecture]), version, architecture,
      label: `${label} (${architectureLabel(architecture)})` }));
  });
}

/** The installation of one version, of the given variant when one is given: a
 * usable one first, then one that needs repair, then an incompatible one, then
 * one this Mac cannot run. */
export function runtimeInspectorInstall(section: Record<string, any> | null, version: string, variant = "", architecture = "") {
  const rows = (Array.isArray(section?.installed) ? section.installed : [])
    .filter((row: any) => version && row?.version === version && (!variant || row.variant === variant) &&
      (!architecture || installedArchitecture(row) === architecture || installedArchitecture(row) === "universal"));
  for (const availability of ["installed", "needsRepair", "incompatible", "unavailable"] as const) {
    const install = rows.find((row: any) => installedRuntimeAvailability(row) === availability);
    if (install) return { availability, install: install as Record<string, any> };
  }
  return { availability: null, install: null };
}

/** The libraries that installed versions of a runtime carry, such as the
 * Live2D library of a Ren'Py SDK, as they stand for the version Play uses.
 * Each reads its own summary, or Installed or Not installed; while that
 * version is still being looked up, it reads Checking…. A runtime whose
 * installed versions carry no libraries has no rows. */
export function runtimeInspectorLibraries(section: Record<string, any> | null, version: string, pending: boolean,
  variant = "", architecture = "") {
  const declared = new Map<string, Record<string, any>>();
  for (const row of Array.isArray(section?.installed) ? section.installed : []) {
    for (const [id, library] of Object.entries(row?.libraries || {})) {
      if (!declared.has(id) && library && typeof library === "object") declared.set(id, library as Record<string, any>);
    }
  }
  const install = !pending && version ? runtimeInspectorInstall(section, version, variant, architecture).install : null;
  return [...declared].map(([id, sample]) => {
    const library = install?.libraries?.[id] as Record<string, any> | undefined;
    const value = pending ? "Checking…" : library?.summary || (library?.ready ? "Installed" : "Not installed");
    return { id, label: String(library?.label || sample.label || id), note: String(library?.note || sample.note || ""),
      value: String(value), detail: library && !library.ready ? String(library.detail || library.reason || "") : "", pending };
  });
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

/** Version wording under a row that already names the runtime: "Sikarugir
 * 1.0.24 · Wine 11.0 rev 1" reads "1.0.24 · Wine 11.0 rev 1" beside Sikarugir. */
export function runtimeVersionTagWithout(tag: (version: string) => string, runtimeName: unknown) {
  const name = typeof runtimeName === "string" ? runtimeName.trim() : "";
  return (version: string) => {
    const text = tag(version);
    return name && text.startsWith(`${name} `) && text.length > name.length + 1 ? text.slice(name.length + 1) : text;
  };
}

export type InspectorTranslatorRow = { id?: string; label: string; selected: string; used: string; reason?: string | null; reasonCode?: string | null; fallback?: boolean };

/** The inspector's translator rows: a choice that is also what runs reads once,
 * and neighbouring rows that read the same share one row naming each of them,
 * as in "Direct3D 8, 9 and 12". When every row reads the same, the one row is
 * named Translators. A row with a line of its own stays on its own. */
export function inspectorTranslatorRows(rows: InspectorTranslatorRow[]) {
  const groups: Array<{ id?: string; value: string; labels: string[]; note: string }> = [];
  for (const row of rows) {
    const value = row.selected === row.used ? row.used : `${row.selected} → ${row.used}`;
    const note = row.reasonCode === "dlss-forwarding" && row.reason ? row.reason : "";
    const last = groups[groups.length - 1];
    if (last && !note && !last.note && last.value === value) last.labels.push(row.label);
    else groups.push({ id: row.id, value, labels: [row.label], note });
  }
  return groups.map(group => {
    const joined = joinHelpLabels(group.labels);
    return { id: group.id, value: group.value, note: group.note,
      label: groups.length === 1 && group.labels.length > 2 ? "Translators" : joined, title: group.labels.length > 1 ? joined : undefined };
  });
}

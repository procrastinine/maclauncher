import type { RuntimeManagerState, RuntimeRefreshOptions } from "../types";
import { sanitizeErrorMessage } from "../../../../core/runtime-errors.mjs";
import packageInfo from "../../../../../package.json";
import { isPrereleaseVersion } from "../ui-helpers";
import { cpuId, cpuLabel } from "../../../../core/cpu-labels.mjs";

// Shared by initial UI state and the source/import controls. An explicit
// choice stays selected; automatic choices prefer stable published releases.
export function runtimeInstallVersion(section: Record<string, any> | null | undefined, requested?: string, recommended: unknown = section?.catalog?.recommendedVersion): string {
  const versions: string[] = Array.isArray(section?.catalog?.versions)
    ? section.catalog.versions.filter((value: unknown) => typeof value === "string" && value.trim()) : [];
  for (const row of section?.installed || []) if (row.version && !versions.includes(row.version)) versions.push(row.version);
  if (requested && versions.includes(requested)) return requested;
  // A version whose installed copies are all unusable is chosen only on request,
  // so a newer listed version is the offer and a damaged one is never preselected.
  // A version this Mac cannot install is not the offer either.
  const rows: any[] = Array.isArray(section?.installed) ? section.installed : [];
  const offered = versions.filter(value => rows.some(row => row?.version === value)
    ? rows.some(row => row?.version === value && row.ready !== false) : !runtimeVersionBlocked(section?.catalog, value));
  if (section?.catalog?.preferInstalled) {
    const local = rows.find(row => row.ready !== false && offered.includes(row.version));
    if (local) return local.version;
  }
  const stable = offered.find(value => !isPrereleaseVersion(value, section));
  if (typeof recommended === "string" && offered.includes(recommended) && (!stable || !isPrereleaseVersion(recommended, section))) return recommended;
  return stable || offered[0] || "";
}

// A listed version whose own requirement keeps it from installing on this Mac,
// such as a newer macOS or a package this launcher cannot use.
export function runtimeVersionBlocked(catalog: Record<string, any> | null | undefined, version: string) {
  const requirement = catalog?.versionRequirements?.[version];
  return requirement?.installable === false || Boolean(requirement?.installReason) &&
    Array.isArray(catalog?.installableVersions) && !catalog.installableVersions.includes(version);
}

export function runtimeMinimumNotice(minimum: unknown) {
  const value = typeof minimum === "string" ? minimum.trim() : "";
  // A release reads as macOS names it: 14.0.0 is macOS 14.0, while 13.5.1 keeps its patch number.
  return value && value.localeCompare(packageInfo.build.mac.minimumSystemVersion, undefined, { numeric: true }) > 0
    ? `Requires macOS ${value.replace(/^(\d+\.\d+)\.0$/, "$1")} or later.` : "";
}
/** The parts of an "Includes …" summary, each kept on one line when the line wraps. */
export function runtimeIncludedParts(summary: unknown) {
  return typeof summary === "string" ? summary.split(/\s+·\s+/).map(part => part.trim()).filter(Boolean) : [];
}
// The same requirement as one of an installed row's detail lines, which carry no sentence period.
export function runtimeMinimumDetail(minimum: unknown) {
  return runtimeMinimumNotice(minimum).replace(/\.$/, "");
}

export function runtimeRefreshFailure(catalog: Record<string, any> | null | undefined) {
  const failedAt = catalog?.failedAt;
  return typeof failedAt === "number" && failedAt > 0 && failedAt <= 8.64e15
    ? `Last refresh failed on ${new Date(failedAt).toLocaleString()}.`
    : "Last refresh failed (date unavailable).";
}

export type RuntimeTabGroup = {
  id: string; label: string; order: number; position?: "last"; managers: RuntimeManagerState[];
  /** Sidebar category id and heading, present when categories are supplied. */
  category?: string; heading?: string;
};
/** A sidebar heading. "label" sorts its groups alphabetically; otherwise by declared order. */
export type RuntimeCategory = { id: string; label: string; sort?: "label"; default?: boolean };
export type RuntimeTabSection = {
  id: string; label: string; managerId: string; sectionId: string;
  manager: RuntimeManagerState; section: Record<string, any>;
};
export type RuntimeSectionTab = { id: string; label: string; choices: RuntimeTabSection[] };
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const order = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;

export function runtimeSourceUiKey(sectionId: string, sourceId?: string) {
  return sourceId ? JSON.stringify([sectionId, sourceId]) : sectionId;
}

// A pending setup action records which setup row started it, so only that
// row's button reports progress while the section stays busy.
export function runtimePendingAction(action: string, payload: Record<string, unknown>) {
  return action === "setup" && typeof payload.setupActionId === "string" ? `setup:${payload.setupActionId}` : action;
}

export function isRuntimeSetupPending(pending: string | null | undefined, setupActionId: string) {
  return pending === `setup:${setupActionId}`;
}

export function runtimeRefreshPayload(sectionId: string, options: RuntimeRefreshOptions = {}) {
  return { sectionId, latestOnly: options.latestOnly === true,
    ...(options.sourceId ? { sourceId: options.sourceId } : {}) };
}

export function runtimeSourceUrl(value: unknown): string | null {
  const source = text(value);
  if (!source || /\s|·/.test(source) || (source.match(/https?:\/\//gi) || []).length !== 1) return null;
  try {
    const url = new URL(source);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

// The repository or page a link opens: links into one repository on a code
// host, or to the same page elsewhere, are one link.
const CODE_HOSTS = new Set(["github.com", "gitlab.com", "codeberg.org", "bitbucket.org"]);
function runtimeLinkTarget(url: string) {
  const parsed = new URL(url), host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const parts = parsed.pathname.split("/").filter(Boolean);
  return [host, ...(CODE_HOSTS.has(host) ? parts.slice(0, 2) : parts)].join("/").toLowerCase();
}
// The links shown for a source, in order, without a second link to a target
// an earlier one already opens.
export function runtimeDistinctLinks(links: Array<{ url?: string; label?: string }>): Array<{ url: string; label: string }> {
  const seen = new Set<string>();
  return links.flatMap(item => {
    const url = runtimeSourceUrl(item?.url);
    if (!url) return [];
    const target = runtimeLinkTarget(url);
    if (seen.has(target)) return [];
    seen.add(target);
    return [{ url, label: text(item.label) || new URL(url).hostname.replace(/^www\./, "") }];
  });
}

export function runtimeCatalogSources(catalog: Record<string, any> | null | undefined): Array<Record<string, any>> {
  if (!catalog) return [];
  const downloadVersions = (source: Record<string, any>) => [...new Set((Array.isArray(source.versions) ? source.versions : [])
    .filter((version: any) => typeof version === "string" && version.trim()))].filter(version => {
      const requirements = source.versionRequirements?.[version];
      // Code-only release tags are references, not downloadable Mac runtimes.
      // Keep real packages with host requirements so their limits remain visible.
      return !(requirements?.requiresDownload === false && requirements?.requiresBuild === false &&
        requirements?.included !== true && requirements?.available !== true);
    });
  if (!Array.isArray(catalog.sources)) return [{ ...catalog, id: "default", explicit: false, versions: downloadVersions(catalog) }];
  const seen = new Set<string>();
  return catalog.sources.filter((source: any) => source && typeof source === "object" && text(source.id)).flatMap((source: any) => {
    const id = text(source.id);
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ ...source, id, explicit: true,
      versions: downloadVersions(source) }];
  });
}

export function isRuntimeManageable(manager: RuntimeManagerState | null | undefined, sectionId?: string | null): boolean {
  if (!manager || manager.ui?.hidden === true || manager.ui?.management === "built-in") return false;
  return !sectionId || manager.ui?.sectionManagement?.[sectionId] !== "built-in";
}

export function managedRuntimeSections(manager: RuntimeManagerState,
  resolveSections: (manager: RuntimeManagerState) => Array<Record<string, any>>) {
  return resolveSections(manager).filter(section => isRuntimeManageable(manager, String(section.id)));
}

// Categories are ordered headings. A group takes the first category its members
// declare; an unclassified group joins the default category, or follows every
// category when none is the default.
export function groupRuntimeManagers(managers: RuntimeManagerState[], categories: RuntimeCategory[] = []): RuntimeTabGroup[] {
  const groups = new Map<string, RuntimeTabGroup>();
  for (const manager of managers) {
    if (!isRuntimeManageable(manager)) continue;
    const id = text(manager.ui?.groupId) || manager.id;
    const memberOrder = order(manager.ui?.order, 1000);
    const group = groups.get(id) || { id, label: text(manager.ui?.tabLabel) || text(manager.label) || "Runtime", order: memberOrder, managers: [] };
    group.order = Math.min(group.order, memberOrder);
    if (manager.ui?.position === "last") group.position = "last";
    group.managers.push(manager);
    groups.set(id, group);
  }
  for (const group of groups.values()) {
    group.managers.sort((a, b) => order(a.ui?.memberOrder, 0) - order(b.ui?.memberOrder, 0) ||
      (text(a.label) || "Runtime").localeCompare(text(b.label) || "Runtime"));
    const first = group.managers[0];
    group.label = text(first.ui?.tabLabel) || text(first.label) || "Runtime";
    const declared = group.managers.map(manager => text(manager.ui?.category)).find(id => categories.some(category => category.id === id));
    const category = categories.find(item => item.id === declared) || categories.find(item => item.default);
    if (category) { group.category = category.id; group.heading = category.label; }
  }
  const rank = (group: RuntimeTabGroup) => {
    const index = categories.findIndex(category => category.id === group.category);
    return index < 0 ? categories.length : index;
  };
  const alphabetical = (group: RuntimeTabGroup) => categories[rank(group)]?.sort === "label";
  return [...groups.values()].sort((a, b) => Number(a.position === "last") - Number(b.position === "last") ||
    rank(a) - rank(b) || (alphabetical(a) ? 0 : a.order - b.order) || a.label.localeCompare(b.label));
}

// The groups whose managers name one host group (Wine) become one sidebar entry
// per CPU their version rows run on, "Wine · Apple Silicon" and "Wine · Intel",
// placed where the first of them sorts in their category. Each entry has a tab
// per source holding that CPU's rows. An installed row's CPU is its measured
// slices, then its stated architecture; a listed version's CPU is the one its
// list states, then that of its installed row. A tab keeps the rows of its CPU
// and every row whose CPU is unknown, and a source with no CPU facts is a tab of
// every entry, unless it is a member of a source's group (CrossOver's graphics
// integration), which follows that source's CPUs. With no CPU facts at all, the
// sources share one entry named after the host group.
const HOST_CPUS = ["arm64", "x64"] as const;
type HostCpu = typeof HOST_CPUS[number];
function hostCpu(value: unknown): HostCpu | "" {
  const cpu = cpuId(value);
  return cpu === "arm64" || cpu === "universal" ? "arm64" : cpu === "x64" ? "x64" : "";
}
function installCpu(row: Record<string, any>): HostCpu | "" {
  const slices = Array.isArray(row?.architectures) ? row.architectures.map(hostCpu) : [];
  if (slices.length) return slices.includes("arm64") ? "arm64" : slices.includes("x64") ? "x64" : "";
  return hostCpu(row?.architecture);
}
function versionCpu(section: Record<string, any>, version: string): HostCpu | "" {
  const stated = hostCpu(section.catalog?.versionRequirements?.[version]?.architecture);
  if (stated) return stated;
  const cpus = new Set((section.installed || []).filter((row: any) => row?.version === version).map(installCpu));
  return cpus.size === 1 ? [...cpus][0] as HostCpu | "" : "";
}
function sectionCpus(section: Record<string, any>): Set<HostCpu> {
  const cpus = [...(section.installed || []).map(installCpu),
    ...(Array.isArray(section.catalog?.versions) ? section.catalog.versions.map((version: string) => versionCpu(section, version)) : [])];
  return new Set(cpus.filter(Boolean) as HostCpu[]);
}
function sectionForCpu(section: Record<string, any>, cpu: HostCpu) {
  const keeps = (found: string) => !found || found === cpu;
  const catalog = section.catalog && { ...section.catalog, ...Object.fromEntries(["versions", "installableVersions"]
    .filter(key => Array.isArray(section.catalog[key]))
    .map(key => [key, section.catalog[key].filter((version: string) => keeps(versionCpu(section, version)))])) };
  return { ...section, installed: (section.installed || []).filter((row: any) => keeps(installCpu(row))), ...(catalog ? { catalog } : {}) };
}
export function splitRuntimeGroupsByHost(groups: RuntimeTabGroup[],
  resolveSections: (manager: RuntimeManagerState) => Array<Record<string, any>>): RuntimeTabGroup[] {
  const hosts = new Map<string, { name: string; first: RuntimeTabGroup; members: RuntimeTabGroup[] }>();
  const slots: Array<RuntimeTabGroup | string> = [];
  for (const group of groups) {
    const name = text(group.managers.find(manager => text(manager.ui?.hostGroup))?.ui?.hostGroup);
    if (!name) { slots.push(group); continue; }
    const key = JSON.stringify([group.category || "", name]);
    const host = hosts.get(key);
    if (host) host.members.push(group);
    else { hosts.set(key, { name, first: group, members: [group] }); slots.push(key); }
  }
  return slots.flatMap(slot => {
    if (typeof slot !== "string") return [slot];
    const { name, first, members } = hosts.get(slot)!;
    const managers = members.flatMap(group => group.managers);
    const sections = new Map(managers.map(manager => [manager, resolveSections(manager)]));
    const ownCpus = (manager: RuntimeManagerState) => new Set(sections.get(manager)!.flatMap(section => [...sectionCpus(section)]));
    const groupOf = new Map(members.flatMap(group => group.managers.map(manager => [manager, group] as const)));
    const cpusOf = (manager: RuntimeManagerState) => {
      const own = ownCpus(manager);
      return own.size ? own : new Set(groupOf.get(manager)!.managers.flatMap(member => [...ownCpus(member)]));
    };
    const cpus = HOST_CPUS.filter(cpu => managers.some(manager => cpusOf(manager).has(cpu)));
    const id = `host:${name.toLowerCase()}`;
    const entry = (cpu: HostCpu | null): RuntimeTabGroup => ({ ...first, id: cpu ? `${id}:${cpu}` : id,
      label: cpu ? `${name} · ${cpuLabel(cpu)}` : name, order: Math.min(...members.map(group => group.order)),
      managers: managers.filter(manager => !cpu || !cpusOf(manager).size || cpusOf(manager).has(cpu)).map(manager => ({ ...manager,
        // The source is a tab of the entry, named by its own label.
        ui: { ...manager.ui, sectionLabel: text(manager.ui?.sectionLabel) || text(manager.ui?.tabLabel) || text(manager.label) },
        sections: cpu ? sections.get(manager)!.map(section => sectionForCpu(section, cpu)) : sections.get(manager)! })) });
    return cpus.length ? cpus.map(entry) : [entry(null)];
  });
}

// The first section that a sidebar search names through its tab label, source
// name or id, so a search for a source opens its entry at that tab. Terms that
// only the entry's own label holds (such as "Wine") name no particular tab.
export function runtimeChoiceForQuery(choices: RuntimeTabSection[], query: string, entryLabel = ""): RuntimeTabSection | null {
  const searchable = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  const terms = searchable(query).trim().split(/\s+/).filter(Boolean);
  const entry = searchable(entryLabel);
  return choices.find(choice => {
    const own = searchable([choice.label, choice.managerId, choice.manager.label, choice.section.label].filter(Boolean).join(" "));
    return terms.every(term => own.includes(term) || entry.includes(term)) && terms.some(term => own.includes(term) && !entry.includes(term));
  }) || null;
}

export function runtimeGroupSections(group: RuntimeTabGroup, resolveSections: (manager: RuntimeManagerState) => Array<Record<string, any>>): RuntimeTabSection[] {
  return group.managers.flatMap(manager => {
    const sections = resolveSections(manager);
    return sections.filter(section => isRuntimeManageable(manager, String(section.id))).map(section => {
      const memberLabel = text(manager.ui?.sectionLabel) || text(manager.label) || "Runtime";
      const sectionLabel = text(section.label) || "Runtime";
      // A member's section that already begins with the member name is not prefixed again.
      const label = sections.length === 1 ? text(manager.ui?.sectionLabel) || (group.managers.length > 1 ? memberLabel : sectionLabel)
        : group.managers.length > 1 && !sectionLabel.startsWith(memberLabel) ? `${memberLabel} · ${sectionLabel}` : sectionLabel;
      const sectionId = String(section.id);
      return { id: JSON.stringify([manager.id, sectionId]), label, managerId: manager.id, sectionId, manager, section };
    });
  });
}

// Libraries own their internal navigation; their collections remain distinct
// action targets without becoming sibling runtime tabs.
export function runtimeSectionTabs(sections: RuntimeTabSection[]): RuntimeSectionTab[] {
  const tabs: RuntimeSectionTab[] = [];
  for (const section of sections) {
    const library = section.manager.ui?.library;
    const sectionGroup = text(section.manager.ui?.sectionGroupId);
    const id = library ? JSON.stringify([section.managerId, "library"]) : sectionGroup ? JSON.stringify([sectionGroup,"group"]) : section.id;
    const existing = tabs.find(tab => tab.id === id);
    if (existing) existing.choices.push(section);
    else tabs.push({ id, label: sectionGroup ? text(section.manager.ui?.sectionGroupLabel) || sectionGroup : library ? text(section.manager.ui?.sectionLabel) || text(section.manager.label) : section.label,
      choices: [section] });
  }
  return tabs;
}

// A tab chosen inside an entry keeps that entry: the source of a tab in Wine ·
// Intel stays in Wine · Intel even when its automatic CPU is Apple Silicon.
/** A requested runtime of the shown entry whose sections have not resolved yet
 * stays requested: the entry's first choice shows meanwhile, and the request
 * is not replaced by it. */
export function runtimeRequestPending(group: RuntimeTabGroup | null, choices: RuntimeTabSection[], managerId: string | null) {
  return Boolean(managerId && group?.managers.some(manager => manager.id === managerId) && !choices.some(choice => choice.managerId === managerId));
}

export function runtimeTabChoice(group: RuntimeTabGroup | null, choice: RuntimeTabSection) {
  return { groupId: group?.id ?? null, managerId: choice.managerId, sectionId: choice.sectionId };
}

// A source listed under two headings is selected by the entry chosen in the sidebar.
export function resolveRuntimeTabSelection(groups: RuntimeTabGroup[], managerId: string | null, sectionId: string | null,
  resolveSections: (manager: RuntimeManagerState) => Array<Record<string, any>>, groupId: string | null = null) {
  const has = (item: RuntimeTabGroup) => item.managers.some(manager => manager.id === managerId);
  const group = groups.find(item => item.id === groupId && has(item)) || groups.find(has) || groups[0] || null;
  if (!group) return { group: null, section: null, sections: [] as RuntimeTabSection[] };
  const sections = runtimeGroupSections(group, resolveSections);
  const section = sections.find(item => item.managerId === managerId && item.sectionId === sectionId) ||
    sections.find(item => item.managerId === managerId) || sections[0] || null;
  return { group, section, sections };
}

// The Installed header's Default menu. Automatic is named with the version it
// resolves to while nothing is saved; every usable installed row is a choice of
// its own, its variant and CPU included. A saved default without a usable
// installed row stays shown as the selection, marked, and cannot be chosen again.
export type RuntimeDefaultChoice = { value: string; label: string; version: string | null; variant?: string; architecture?: string; disabled?: boolean };
export type RuntimeDefaultRow = { install: Record<string, any>; label: string; isDefault: boolean };
export function runtimeDefaultMenu(section: Record<string, any> | null | undefined, rows: RuntimeDefaultRow[],
  versionTag: (version: string) => string = version => version): { choices: RuntimeDefaultChoice[]; selected: string } {
  const saved = section?.defaultSource === "saved";
  const defaultVersion = text(section?.defaultVersion);
  const current = rows.find(row => row.isDefault);
  const usable = rows.filter(({ install }) => install.ready !== false && !install.reference && install.supportsDefault !== false);
  const value = (install: Record<string, any>) => JSON.stringify([install.version, text(install.variant), text(install.architecture)]);
  const labels = new Map<string, number>();
  for (const row of usable) labels.set(row.label, (labels.get(row.label) || 0) + 1);
  const place = (install: Record<string, any>) => {
    const folder = text(install.installDir).split("/").filter(Boolean).at(-1);
    return folder ? ` · ${folder}` : "";
  };
  const choices: RuntimeDefaultChoice[] = [{ value: "", version: null,
    label: !saved && defaultVersion ? `Automatic (${current?.label || versionTag(defaultVersion)})` : "Automatic" }];
  for (const row of usable) choices.push({ value: value(row.install), version: row.install.version,
    label: (labels.get(row.label) || 0) > 1 ? row.label + place(row.install) : row.label,
    ...(text(row.install.variant) ? { variant: text(row.install.variant) } : {}),
    ...(text(row.install.architecture) ? { architecture: text(row.install.architecture) } : {}) });
  let selected = "";
  if (saved && current && usable.includes(current)) selected = value(current.install);
  else if (saved && defaultVersion) {
    selected = "saved";
    choices.push({ value: selected, version: defaultVersion, disabled: true,
      label: current ? `${current.label} (unavailable)` : `${versionTag(defaultVersion)} (not installed)` });
  }
  return { choices, selected };
}

/** A row's Make default choice: every usable installed row that is not the
 * current default, with the variant and CPU the Default menu passes. None where
 * the runtime has no default, keeps a default per operation, or for a reference
 * or a row that is not ready. */
export function runtimeMakeDefaultChoice(row: RuntimeDefaultRow, { supportsDefault = true, perOperation = false }: { supportsDefault?: boolean; perOperation?: boolean } = {}): RuntimeDefaultChoice | null {
  const { install } = row;
  if (!supportsDefault || perOperation || row.isDefault || install.ready === false || install.reference || install.supportsDefault === false || !text(install.version)) return null;
  return { value: JSON.stringify([install.version, text(install.variant), text(install.architecture)]), version: install.version, label: row.label,
    ...(text(install.variant) ? { variant: text(install.variant) } : {}),
    ...(text(install.architecture) ? { architecture: text(install.architecture) } : {}) };
}

export function runtimeTabMovement(key: string, index: number, count: number): number | null {
  if (count < 1) return null;
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index + count - 1) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export function isRuntimeIncluded(runtime: Record<string, any> | null | undefined): boolean {
  return runtime?.included === true || runtime?.bundledExecution === "direct";
}

export function runtimeManagementPresentation(section: Record<string, any> | null | undefined) {
  const catalog = section?.catalog;
  const localFiles = catalog?.delivery === "local-files";
  const local = catalog?.delivery === "local" || localFiles;
  return {
    local, localFiles,
    title: text(section?.managementTitle) || (localFiles ? "Files" : local ? "Applications" : "Versions"),
    refreshLabel: text(catalog?.refreshLabel) || (local ? "Find installed applications" : "Reload versions"),
    refreshingLabel: localFiles ? "Reading installed files" : local ? "Finding applications" : "Refreshing versions",
    importBusyLabel: text(catalog?.importBusyLabel) || (local ? "Adding…" : "Importing…"),
    emptyLabel: text(catalog?.emptyLabel) || (localFiles ? "No files imported." : local ? "No applications registered." : "No runtime versions installed yet.")
  };
}

export function runtimeRemovalPresentation(install: Record<string, any>, section?: Record<string, any> | null) {
  const external = install.external === true || section?.catalog?.delivery === "local";
  const label = text(install.removalLabel) || (external ? "Remove" : "Uninstall");
  const name = text(install.label) || text(section?.versionLabels?.[install.version]) ||
    text(section?.catalog?.versionLabels?.[install.version]) || (install.version ? `v${install.version}` : "this runtime");
  return { label, confirm: text(install.removalConfirm) || (external
    ? `Remove ${name} from Runtimes? The application will remain installed.`
    : `${label} ${name}?`) };
}

export function runtimeSummaryPresentation(section: Record<string, any> | null | undefined, selectedVersion?: string, message?: string | null) {
  const catalog = section?.catalog;
  const localFiles = catalog?.delivery === "local-files";
  const local = catalog?.delivery === "local" || localFiles;
  const versions = [...new Set(runtimeCatalogSources(catalog).flatMap(source => source.versions))];
  const installed = [...(Array.isArray(section?.installed) ? section.installed : []),
    ...(Array.isArray(section?.references) ? section.references : [])];
  const includedCount = installed.filter(isRuntimeIncluded).length;
  const installedCount = installed.length - includedCount;
  const latestAvailable = versions.includes(catalog?.latestAvailableVersion) ? text(catalog.latestAvailableVersion) : text(versions[0]);
  const latestInstalled = text(catalog?.latestInstalledVersion);
  const selected = text(selectedVersion);
  const checkedAt = catalog?.fetchedAt;
  const messageIncludesTime = Boolean(message?.startsWith("Versions updated at "));
  return {
    versionCount: versions.length, includedCount, installedCount,
    installedTitle: text(section?.installedTitle) || (localFiles ? "Imported files" : local ? "Registered applications" : includedCount ? installedCount ? "Included & installed" : "Included" : "Installed"),
    latestAvailableVersion: !local && latestAvailable !== selected ? latestAvailable : "",
    latestInstalledVersion: !local && latestInstalled !== latestAvailable && latestInstalled !== selected ? latestInstalled : "",
    checkedAt: typeof checkedAt === "number" && checkedAt > 0 && checkedAt <= 8.64e15 ? checkedAt : null,
    actionMessage: messageIncludesTime ? "Versions updated." : message,
    actionDetail: messageIncludesTime ? message : null,
    showDefaultVersion: section?.supportsDefault !== false && Boolean(section?.defaultVersion)
  };
}

export function runtimeCatalogPresentation(catalog: Record<string, any> | null | undefined, version?: string, variant?: string) {
  const common = version ? catalog?.versionRequirements?.[version] : null;
  const requirements = variant && common?.variants?.[variant] ? { ...common, ...common.variants[variant] } : common;
  const included = requirements?.included === true;
  const installLabel = included ? "Included" : text(requirements?.installLabel) || text(catalog?.installLabel) || "Install";
  const source = text(catalog?.source);
  let sourceUrl: string | null = null;
  let sourceLabel = "";
  let installHelpUrl: string | null = null;
  sourceUrl = runtimeSourceUrl(source);
  if (sourceUrl) sourceLabel = text(catalog?.sourceLabel) || new URL(sourceUrl).hostname.replace(/^www\./, "");
  try {
    const url = new URL(text(catalog?.installHelpUrl));
    if (["https:", "http:"].includes(url.protocol)) installHelpUrl = url.href;
  } catch {}
  const minimum = text(requirements?.minimumMacOS);
  const reason = text(requirements?.installReason) || text(catalog?.installReason) ||
    (installLabel === "Build" ? "Build the selected version locally." : "");
  return { installLabel, included, sourceUrl, sourceLabel, installHelpUrl,
    installReason: sanitizeErrorMessage([reason, runtimeMinimumNotice(minimum)].filter(Boolean).join(" ")) };
}

// Translator views (group ui.cpuBuildLabels) name the CPU build of every
// version: x64, arm64 or universal. An installed version is named by the CPU
// slices of its installed file, then by the build its list declares, then by
// the CPU its installation was made for.
const cpuBuild = (value: unknown) => {
  const name = cpuId(value);
  return name === "x64" || name === "arm64" || name === "universal" ? name : "";
};
export function translatorInstallBuild(install: Record<string, any> | null | undefined, requirement?: Record<string, any> | null): string {
  const files = install?.translator?.files || install?.installationMetadata?.translator?.files;
  if (Array.isArray(files) && files.some(file => file.format === "pe") && !files.some(file => file.format === "macho")) return "";
  const slices = [...new Set((Array.isArray(install?.architectures) ? install!.architectures : []).map(cpuBuild)
    .filter((cpu: string) => cpu === "x64" || cpu === "arm64"))];
  if (slices.length) return slices.length > 1 ? "universal" : slices[0] as string;
  return cpuBuild(requirement?.architecture) || cpuBuild(install?.architecture);
}

// The list for the CPU an installation was made for, falling back to the section's own list.
export function translatorInstallRequirement(install: Record<string, any>, section: Record<string, any> | null | undefined) {
  const slot = /^architecture:(.+)$/.exec(String(install?.variant || ""))?.[1];
  const catalog = slot && section?.catalog?.architectureCatalogs?.[slot] || section?.catalog;
  return install?.custom ? null : catalog?.versionRequirements?.[install?.version] || null;
}

// A listed version is named by its installed build for the selected Build
// choice, otherwise by the build its list declares. A list that declares no
// CPU, such as a release page whose package CPU is read at installation, leaves
// the version unnamed until it is installed.
export function translatorVersionBuild(version: string, catalog: Record<string, any> | null | undefined, installed: Array<Record<string, any>> = []) {
  const requirement = catalog?.versionRequirements?.[version] || null;
  const row = installed.find(item => item?.version === version && item.ready !== false);
  return row ? translatorInstallBuild(row, requirement) : cpuBuild(requirement?.architecture);
}

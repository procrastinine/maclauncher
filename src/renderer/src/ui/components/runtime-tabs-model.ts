import type { RuntimeManagerState } from "../types";

export type RuntimeTabGroup = {
  id: string; label: string; order: number; position?: "last"; managers: RuntimeManagerState[];
};
export type RuntimeTabSection = {
  id: string; label: string; managerId: string; sectionId: string;
  manager: RuntimeManagerState; section: Record<string, any>;
};
export type RuntimeSectionTab = { id: string; label: string; choices: RuntimeTabSection[] };
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const order = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;

export function isRuntimeManageable(manager: RuntimeManagerState | null | undefined, sectionId?: string | null): boolean {
  if (!manager || manager.ui?.management === "built-in") return false;
  return !sectionId || manager.ui?.sectionManagement?.[sectionId] !== "built-in";
}

export function managedRuntimeSections(manager: RuntimeManagerState,
  resolveSections: (manager: RuntimeManagerState) => Array<Record<string, any>>) {
  return resolveSections(manager).filter(section => isRuntimeManageable(manager, String(section.id)));
}

export function groupRuntimeManagers(managers: RuntimeManagerState[]): RuntimeTabGroup[] {
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
  }
  return [...groups.values()].sort((a, b) => Number(a.position === "last") - Number(b.position === "last") || a.order - b.order || a.label.localeCompare(b.label));
}

export function runtimeGroupSections(group: RuntimeTabGroup, resolveSections: (manager: RuntimeManagerState) => Array<Record<string, any>>): RuntimeTabSection[] {
  return group.managers.flatMap(manager => {
    const sections = resolveSections(manager);
    return sections.filter(section => isRuntimeManageable(manager, String(section.id))).map(section => {
      const memberLabel = text(manager.ui?.sectionLabel) || text(manager.label) || "Runtime";
      const sectionLabel = text(section.label) || "Runtime";
      const label = sections.length === 1 ? text(manager.ui?.sectionLabel) || (group.managers.length > 1 ? memberLabel : sectionLabel)
        : group.managers.length > 1 ? `${memberLabel} · ${sectionLabel}` : sectionLabel;
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
    const id = library ? JSON.stringify([section.managerId, "library"]) : section.id;
    const existing = tabs.find(tab => tab.id === id);
    if (existing) existing.choices.push(section);
    else tabs.push({ id, label: library ? text(section.manager.ui?.sectionLabel) || text(section.manager.label) : section.label,
      choices: [section] });
  }
  return tabs;
}

export function resolveRuntimeTabSelection(groups: RuntimeTabGroup[], managerId: string | null, sectionId: string | null,
  resolveSections: (manager: RuntimeManagerState) => Array<Record<string, any>>) {
  const group = groups.find(item => item.managers.some(manager => manager.id === managerId)) || groups[0] || null;
  if (!group) return { group: null, section: null, sections: [] as RuntimeTabSection[] };
  const sections = runtimeGroupSections(group, resolveSections);
  const section = sections.find(item => item.managerId === managerId && item.sectionId === sectionId) ||
    sections.find(item => item.managerId === managerId) || sections[0] || null;
  return { group, section, sections };
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
  const versions = Array.isArray(catalog?.versions) ? catalog.versions : [];
  const installed = Array.isArray(section?.installed) ? section.installed : [];
  const includedCount = installed.filter(isRuntimeIncluded).length;
  const installedCount = installed.length - includedCount;
  const latestAvailable = text(catalog?.latestAvailableVersion) || text(versions[0]);
  const latestInstalled = text(catalog?.latestInstalledVersion);
  const selected = text(selectedVersion);
  const checkedAt = catalog?.fetchedAt;
  const messageIncludesTime = Boolean(message?.startsWith("Versions updated at "));
  return {
    versionCount: versions.length, includedCount, installedCount,
    installedTitle: localFiles ? "Imported files" : local ? "Registered applications" : includedCount ? installedCount ? "Included & installed" : "Included" : "Installed",
    latestAvailableVersion: !local && latestAvailable !== selected ? latestAvailable : "",
    latestInstalledVersion: !local && latestInstalled !== latestAvailable && latestInstalled !== selected ? latestInstalled : "",
    checkedAt: typeof checkedAt === "number" && checkedAt > 0 && checkedAt <= 8.64e15 ? checkedAt : null,
    actionMessage: messageIncludesTime ? "Versions updated." : message,
    actionDetail: messageIncludesTime ? message : null,
    showDefaultVersion: section?.supportsDefault !== false && Boolean(section?.defaultVersion) && !installed.some(item => item.ready !== false &&
      item.version === section?.defaultVersion && (!section?.defaultVariant || item.variant === section.defaultVariant))
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
  try {
    const url = new URL(source);
    if (["https:", "http:"].includes(url.protocol)) { sourceUrl = url.href; sourceLabel = url.hostname.replace(/^www\./, ""); }
  } catch {}
  try {
    const url = new URL(text(catalog?.installHelpUrl));
    if (["https:", "http:"].includes(url.protocol)) installHelpUrl = url.href;
  } catch {}
  const minimum = text(requirements?.minimumMacOS);
  const reason = text(requirements?.installReason) || text(catalog?.installReason) ||
    (installLabel === "Build" ? "Build the selected version locally." : "");
  return { installLabel, included, sourceUrl, sourceLabel, installHelpUrl,
    installReason: [reason, minimum ? `Requires macOS ${minimum} or later.` : ""].filter(Boolean).join(" ") };
}

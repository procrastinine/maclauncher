import { resolveRuntimeSettingFallback, normalizeListValue, normalizeRuntimeSettingValue } from "../../../core/runtime-setting-values.mjs";
export { resolveRuntimeSettingFallback, normalizeListValue, normalizeRuntimeSettingValue };

import type {
  LauncherState,
  ModuleId,
  ModuleManifest,
  ModuleUiCondition,
  ModuleUiField,
  RecentGame,
  RuntimeEntry,
  RuntimeId,
  RuntimeManagerState,
  RuntimeNotice,
  RuntimeSettingsContext,
  RuntimeSettingsSchema,
  RuntimeSettingField
} from "./types";

// One vocabulary for install and availability states. Option labels carry only
// the state word; the reason belongs in a title or help popover.
export type Availability = "installed" | "included" | "notInstalled" | "downloadNeeded" | "unavailable" | "needsRepair";
const AVAILABILITY_LABELS: Readonly<Record<Availability, string>> = Object.freeze({
  installed: "Installed", included: "Included", notInstalled: "Not installed",
  downloadNeeded: "Download needed", unavailable: "Unavailable", needsRepair: "Needs repair"
});
export function availabilityLabel(state: Availability): string {
  return AVAILABILITY_LABELS[state];
}
export function withAvailability(label: string, state?: Availability | null): string {
  return state ? `${label} · ${AVAILABILITY_LABELS[state]}` : label;
}

// A transport failure (no connection, a refused proxy tunnel, an unresolved or
// unreachable host) reads as the service that could not be reached. The stored
// error and the log keep the full transport detail.
const CONNECTION_FAILURE = /\b(?:Failed to establish tunnel|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|socket hang up|net::ERR_(?:INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|CONNECTION_\w+|PROXY_\w+|TUNNEL_CONNECTION_FAILED|TIMED_OUT|NETWORK_CHANGED|ADDRESS_UNREACHABLE))\b|(?:^|:\s)fetch failed\b/;
function connectionFailure(message: string) {
  if (!CONNECTION_FAILURE.test(message)) return null;
  const named = /(?:tunnel to|getaddrinfo [A-Z_]+|request to [a-z]+:\/\/)\s*([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(message)?.[1]
    || [...message.matchAll(/[a-z]+:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi)].map(match => match[1]).find(host => !/^localhost$/i.test(host));
  const host = named?.toLowerCase();
  // A refused connection to a local helper is not an internet problem.
  if (!host && /\b(?:127\.0\.0\.1|localhost|::1)\b/i.test(message)) return null;
  const service = !host ? "the server" : /(?:^|\.)(?:github\.com|githubusercontent\.com|githubassets\.com)$/.test(host) ? "GitHub" : host;
  return `Could not connect to ${service}. Check the internet connection and try again.`;
}

export function formatUserError(error: unknown): string {
  let message = error instanceof Error ? String(error)
    : error && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message : String(error);
  // A proxy or download URL in a network error can carry a user name and
  // password; the address stays and the credentials are never shown.
  message = message.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, "$1");
  const offline = connectionFailure(message);
  if (offline) return offline;
  // Only unwrap the standard Error/Electron IPC prefixes at the start.
  // Keep the original error state, classes, paths and multiline details intact.
  while (true) {
    const prefix = /^(?:Error:[ \t]+|Error invoking remote method (?:'[^'\r\n]+'|"[^"\r\n]+"):[ \t]+)/.exec(message);
    if (!prefix || prefix[0].length === message.length) return message;
    message = message.slice(prefix[0].length);
  }
}

/** Why a game's files cannot be used right now, or undefined when they can. */
export function filesUnavailableReason(game: Pick<RecentGame, "availability"> | null | undefined) {
  return game?.availability ? `Files unavailable. ${game.availability.message}` : undefined;
}

export function formatModuleBadge(
  moduleShortLabel?: string,
  moduleLabel?: string,
  moduleId?: string
) {
  return moduleShortLabel || moduleLabel || moduleId || "Unknown";
}

export function formatModuleLabel(
  moduleLabel?: string,
  moduleShortLabel?: string,
  moduleId?: string
) {
  return moduleLabel || moduleShortLabel || moduleId || "Unknown";
}

export function resolveRuntimeEntry(
  moduleInfo: ModuleManifest | null | undefined,
  runtimeId: RuntimeId
): RuntimeEntry | null {
  const entries = moduleInfo?.runtime?.entries;
  if (!entries || typeof entries !== "object") return null;
  const entry = entries[runtimeId];
  return entry && typeof entry === "object" ? entry : null;
}

export function resolveRuntimeSettingsSchema(
  moduleInfo: ModuleManifest | null | undefined,
  runtimeId: RuntimeId
) {
  const entry = resolveRuntimeEntry(moduleInfo, runtimeId);
  if (!entry?.settings || typeof entry.settings !== "object") return null;
  const fields = Array.isArray(entry.settings.fields)
    ? entry.settings.fields.filter(field => field && typeof field === "object")
    : [];
  if (!fields.length) return null;
  return { ...entry.settings, fields };
}

export function formatRuntimeLabel(runtimeId: RuntimeId, moduleInfo?: ModuleManifest | null) {
  const entryLabel = resolveRuntimeEntry(moduleInfo, runtimeId)?.label;
  if (entryLabel) return entryLabel;
  const label = moduleInfo?.runtime?.labels?.[runtimeId];
  if (label) return label;
  if (runtimeId === "native") return "Game's macOS app";
  if (typeof runtimeId === "string" && runtimeId) {
    return runtimeId.charAt(0).toUpperCase() + runtimeId.slice(1);
  }
  return "Runtime";
}

/** Runtimes a game type offers as its default. A mode that cannot play, such
 * as inspection, is offered only when it is the type's own default. */
export function defaultRuntimeChoices(moduleInfo: ModuleManifest | null | undefined): RuntimeId[] {
  const supported = Array.isArray(moduleInfo?.runtime?.supported) ? moduleInfo!.runtime!.supported as RuntimeId[] : [];
  return supported.filter(id => (resolveRuntimeEntry(moduleInfo, id) as Record<string, unknown> | null)?.launch !== false || id === moduleInfo?.runtime?.default);
}

export function formatRuntimeOption(runtimeId: RuntimeId, moduleInfo?: ModuleManifest | null) {
  return formatRuntimeLabel(runtimeId, moduleInfo);
}

export function resolveRuntimeVersionLabel(
  version: string,
  runtimeSection: Record<string, any> | null | undefined
) {
  if (!version) return "";
  const labels = runtimeSection?.versionLabels || runtimeSection?.catalog?.versionLabels;
  const mapped = labels && typeof labels === "object" ? (labels as Record<string, string | null | undefined>)[version] : null;
  const label = readableVersion(mapped ? String(mapped) : String(version));
  // A catalog pre-release whose name does not already say so is marked.
  const prerelease = runtimeSection?.catalog?.versionRequirements?.[version]?.prerelease === true;
  return prerelease && !PRERELEASE_WORD.test(label) ? `${label} (pre-release)` : label;
}

const PRERELEASE_WORD = /(?:^|[^a-z])(?:alpha|beta|rc|pre-?release|preview|dev|development|nightly)\d*(?![a-z])/i;
/** Whether a listed version is a pre-release, by its catalog flag or its name. */
export function isPrereleaseVersion(version: string, runtimeSection: Record<string, any> | null | undefined) {
  return runtimeSection?.catalog?.versionRequirements?.[version]?.prerelease === true ||
    PRERELEASE_WORD.test(version.replace(/[._-]/g, " ")) || PRERELEASE_WORD.test(resolveRuntimeVersionLabel(version, runtimeSection));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A version reads as the upstream version people know. Commit hashes,
 * MacLauncher package revisions, workflow timestamps and app-bundle suffixes
 * stay in the exact version value and its tooltip. */
function readableVersion(raw: string) {
  // A package of an upstream with only commits is named MCLvN-MMDD after the
  // upstream commit date, sometimes followed by a build number or profile
  // ("-17", "-kag3-1").
  const build = raw.match(/^MCLv\d+(?:-(\d{2})(\d{2}))?(?:-[a-z0-9][\w.-]*)?$/i);
  if (build) {
    const month = MONTHS[Number(build[1]) - 1], day = Number(build[2]);
    return month && day ? `Development build (${month} ${day})` : "Development build";
  }
  // A workflow build named by its time and commit reads as its date.
  const snapshot = raw.match(/^(\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}Z[_-][0-9a-f]{7,40}$/i);
  if (snapshot) return snapshot[1];
  const label = raw.replace(/-MCLv[\w.-]+$/i, "")
    .replace(/(?:\s*·\s*|[-._+@])?(?<![0-9A-Za-z])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}(?![0-9A-Za-z])/g, "")
    .replace(/\.app\b/g, "").replace(/\s*\(\s*\)/g, "").replace(/\s{2,}/g, " ").trim()
    .replace(/^v(?=\d)/i, "").replace(/(\d)(alpha|beta|rc)(?=\d|$)/i, "$1 $2");
  return label || "Development build";
}

// The MacLauncher package revision of a version, when it has one.
function packageRevision(version: string) {
  const match = /(?:^|-)MCLv(\d+)/i.exec(version);
  return match ? Number(match[1]) : null;
}

export function formatRuntimeVersionTag(
  version: string,
  runtimeSection: Record<string, any> | null | undefined
) {
  const label = resolveRuntimeVersionLabel(version, runtimeSection);
  return /^\d+(?:\.\d+)+/.test(label) && !/^\d+(?:\.\d+)+\s(?:alpha|beta|rc)/i.test(label) ? `v${label}` : label;
}

/** Version labels for everything one runtime section lists. When two versions
 * read the same, a MacLauncher Builds package beside the publisher's own file
 * names its source, older package revisions of one upstream version read as
 * earlier builds, and other ties are numbered in list order. The exact version
 * remains the option value and tooltip. */
export function runtimeVersionTagger(
  runtimeSection: Record<string, any> | null | undefined,
  extra: Array<string | null | undefined> = []
): (version: string) => string {
  const versions = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value.trim()) versions.add(value); };
  const addCatalog = (catalog: any) => {
    if (!catalog || typeof catalog !== "object") return;
    (Array.isArray(catalog.versions) ? catalog.versions : []).forEach(add);
    (Array.isArray(catalog.sources) ? catalog.sources : []).forEach(addCatalog);
  };
  extra.forEach(add);
  add(runtimeSection?.defaultVersion);
  (Array.isArray(runtimeSection?.installed) ? runtimeSection.installed : []).forEach((item: any) => add(item?.version));
  addCatalog(runtimeSection?.catalog);
  // Labels that differ only in separators ("1.0.0 · preview", "1.0.0-preview")
  // name the same release and share the first one's wording.
  const groups = new Map<string, { label: string; members: string[] }>();
  for (const version of versions) {
    const label = formatRuntimeVersionTag(version, runtimeSection);
    const key = label.toLowerCase().replace(/^v(?=\d)/, "").replace(/[\s·._-]+/g, " ").trim();
    const group = groups.get(key) || { label, members: [] };
    group.members.push(version);
    groups.set(key, group);
  }
  const labels = new Map<string, string>();
  for (const { label, members } of groups.values()) {
    const packaged = members.filter(version => packageRevision(version) !== null)
      .sort((a, b) => (packageRevision(b) as number) - (packageRevision(a) as number));
    const other = members.filter(version => packageRevision(version) === null);
    other.forEach((version, index) => labels.set(version, index ? `${label} (${index + 1})` : label));
    packaged.forEach((version, index) => labels.set(version, [label, other.length ? "MacLauncher Builds" : "", index ? "earlier build" : ""]
      .filter(Boolean).join(" · ") + (index > 1 ? ` (${index})` : "")));
  }
  return version => labels.get(version) ?? formatRuntimeVersionTag(version, runtimeSection);
}

/** Version choices from a runtime manager read like the inspector's Version
 * menu; a fixed choice such as Default keeps its own label. */
export function runtimeVersionOptions<T extends { value: string; label: string }>(options: T[]): T[] {
  const tag = runtimeVersionTagger(null, options.map(option => option.value));
  return options.map(option => option.value && option.label === option.value ? { ...option, label: tag(option.value) } : option);
}

/** Display name of a runtime build's CPU. */
export function architectureLabel(architecture: string | null | undefined) {
  return architecture === "x64" || architecture === "x86_64" ? "Intel" : architecture === "universal" ? "Universal" : "Apple Silicon";
}

export function formatDownloadPercent(task: { downloaded: number; total: number | null }) {
  if (!task.total || task.total <= 0) return null;
  const pct = Math.floor((task.downloaded / task.total) * 100);
  if (!Number.isFinite(pct)) return null;
  return Math.min(100, Math.max(0, pct));
}

export function formatProtectionStatus(enableProtections: boolean) {
  return enableProtections
    ? "Child processes blocked"
    : "Child processes allowed";
}

export function buildRuntimeSettingsDefaults(schema: RuntimeSettingsSchema | null) {
  if (!schema) return {};
  const base =
    schema.defaults && typeof schema.defaults === "object" ? schema.defaults : {};
  const out: Record<string, any> = {};
  for (const field of schema.fields) {
    if (!field.key || field.type === "display") continue;
    if (Object.prototype.hasOwnProperty.call(base, field.key)) {
      out[field.key] = normalizeRuntimeSettingValue(
        field,
        (base as any)[field.key],
        resolveRuntimeSettingFallback(field)
      );
    } else {
      out[field.key] = normalizeRuntimeSettingValue(
        field,
        undefined,
        resolveRuntimeSettingFallback(field)
      );
    }
  }
  return out;
}

export function normalizeRuntimeSettings(
  schema: RuntimeSettingsSchema | null,
  incoming: Record<string, any> | null | undefined,
  defaults?: Record<string, any>
) {
  if (!schema) return {};
  const base =
    defaults && typeof defaults === "object" ? defaults : buildRuntimeSettingsDefaults(schema);
  const raw = incoming && typeof incoming === "object" ? incoming : {};
  const out: Record<string, any> = {};
  for (const field of schema.fields) {
    if (!field.key || field.type === "display") continue;
    const fallback = Object.prototype.hasOwnProperty.call(base, field.key)
      ? base[field.key]
      : resolveRuntimeSettingFallback(field);
    out[field.key] = normalizeRuntimeSettingValue(field, (raw as any)[field.key], fallback);
  }
  return out;
}

export function runtimeSettingValuesEqual(a: unknown, b: unknown) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  return a === b;
}

export function runtimeSettingsEqual(
  schema: RuntimeSettingsSchema | null,
  a: Record<string, any> | null | undefined,
  b: Record<string, any> | null | undefined
) {
  if (!schema) return true;
  for (const field of schema.fields) {
    const key = field.key;
    if (!key || field.type === "display") continue;
    if (!runtimeSettingValuesEqual((a as any)?.[key], (b as any)?.[key])) return false;
  }
  return true;
}

export function resolveModuleRuntimeSettings(
  state: Pick<LauncherState, "moduleSettings" | "runtimeDefaults"> | null,
  moduleId: ModuleId,
  moduleInfo: ModuleManifest | null,
  runtimeId: RuntimeId
) {
  const schema = resolveRuntimeSettingsSchema(moduleInfo, runtimeId);
  if (!schema) return null;
  const globalDefaults = normalizeRuntimeSettings(
    schema,
    state?.runtimeDefaults?.[runtimeId] || null,
    buildRuntimeSettingsDefaults(schema)
  );
  const moduleSettings = state?.moduleSettings?.[moduleId] || {};
  const runtimeSettings =
    moduleSettings.runtimeSettings && typeof moduleSettings.runtimeSettings === "object"
      ? moduleSettings.runtimeSettings[runtimeId]
      : null;
  const resolved = normalizeRuntimeSettings(schema, runtimeSettings, globalDefaults);
  const explicitDefaults = buildRuntimeSettingsDefaults(schema);
  for (const field of schema.fields) if (field.gameOnly === true && field.type !== "display") resolved[field.key] = explicitDefaults[field.key];
  return resolved;
}

export function resolveDefaultRuntime(
  moduleInfo: ModuleManifest | null | undefined,
  moduleSettings: Record<string, any> | null | undefined
) {
  const fallback = moduleInfo?.runtime?.default || moduleInfo?.runtime?.supported?.[0] || "";
  const value =
    typeof moduleSettings?.defaultRuntime === "string" ? moduleSettings.defaultRuntime : "";
  return value || fallback;
}

export function formatWhen(ts: number | null) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatWhenMs(ts: number) {
  if (!Number.isFinite(ts)) return "—";
  return new Date(ts).toLocaleString();
}

export function parseSemver(v: string): [number, number, number] | null {
  const m = String(v || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareSemver(a: string, b: string) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  // Other versions, such as 1.12-MCLv10, compare their digit runs as numbers.
  if (!pa || !pb) return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true });
  for (let i = 0; i < 3; i++) {
    const d = pa[i] - pb[i];
    if (d !== 0) return d;
  }
  return 0;
}

export function sortInstalled(
  installed: any[],
  sort: "default" | "newest" | "oldest" | "path",
  defaultVersion?: string | null,
  defaultVariant?: string | null
) {
  const list = Array.isArray(installed) ? installed.slice() : [];
  list.sort((a, b) => {
    if (sort === "path") {
      return String(a.installDir || "").localeCompare(String(b.installDir || ""));
    }
    const byVersion =
      sort === "oldest"
        ? compareSemver(String(a.version || ""), String(b.version || ""))
        : compareSemver(String(b.version || ""), String(a.version || ""));
    if (sort === "default" && defaultVersion) {
      const aIsDefault =
        a.version === defaultVersion && (defaultVariant ? a.variant === defaultVariant : true);
      const bIsDefault =
        b.version === defaultVersion && (defaultVariant ? b.variant === defaultVariant : true);
      if (aIsDefault !== bIsDefault) return aIsDefault ? -1 : 1;
    }
    if (byVersion !== 0) return byVersion;
    return String(a.installDir || "").localeCompare(String(b.installDir || ""));
  });
  return list;
}

export function isRuntimeVersionInstalled(
  installed: any[],
  version: string,
  variant?: string | null,
  hasVariants?: boolean
) {
  if (!version) return false;
  const list = Array.isArray(installed) ? installed : [];
  return list.some(inst => {
    if (!inst || inst.version !== version) return false;
    if (hasVariants) {
      if (!variant) return true;
      return inst.variant === variant;
    }
    return true;
  });
}

export function defaultSaveDirForGame(g: Pick<RecentGame, "defaultSaveDir">) {
  return g.defaultSaveDir || "";
}

export function formatSaveDirDisplay(saveDir: string | null) {
  if (saveDir) return saveDir;
  return "—";
}

export function getByPath(obj: any, pathStr: string) {
  if (!pathStr) return undefined;
  const parts = pathStr.split(".");
  let cur = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

export function formatFieldValue(value: any, format: ModuleUiField["format"], empty = "—") {
  if (value === null || value === undefined || value === "") return empty;
  if (format === "boolean") return value ? "Yes" : "No";
  if (format === "date") {
    const ts = typeof value === "number" ? value : Date.parse(String(value));
    return Number.isFinite(ts) ? new Date(ts).toLocaleString() : empty;
  }
  if (format === "path") return String(value);
  return String(value);
}

export function formatSettingLabel(key: string) {
  if (!key) return "Setting";
  const spaced = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// A runtime provider without a game type of its own (32-bit Mac, Prosper) is
// configured in the runtime tabs of the game types it serves, not twice.
export function settingsSectionModules(modules: ModuleManifest[]) {
  const all = Array.isArray(modules) ? modules : [];
  const served = new Set(all.filter(mod => mod.detection).flatMap(mod => mod.runtime?.supported || []));
  return sortModulesForSettings(all.filter(mod => mod.detection || !(mod.runtime?.supported || []).length ||
    !(mod.runtime?.supported || []).every(id => served.has(id))));
}

export function sortModulesForSettings(modules: ModuleManifest[]) {
  const list = Array.isArray(modules) ? modules.slice() : [];
  list.sort((a, b) => {
    const priority = (module: ModuleManifest) => Number.isFinite(module?.ui?.settingsOrder) ? module.ui!.settingsOrder! : 0;
    const byPriority = priority(a) - priority(b);
    if (byPriority) return byPriority;
    const la = String(a?.label || a?.shortLabel || a?.id || "");
    const lb = String(b?.label || b?.shortLabel || b?.id || "");
    const byLabel = la.localeCompare(lb, undefined, { sensitivity: "base", numeric: true });
    if (byLabel !== 0) return byLabel;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
  return list;
}

export function formatIconFallbackText(entry: RecentGame, moduleInfo: ModuleManifest | null) {
  const raw =
    moduleInfo?.shortLabel || moduleInfo?.label || entry.moduleId || entry.name || "Game";
  const words = String(raw)
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) {
    const first = words[0] || "";
    const second = words[1] || "";
    const text = `${first.slice(0, 1)}${second.slice(0, 2)}`;
    return text || "Game";
  }
  const compact = words.join("");
  if (!compact) return "Game";
  if (compact.length <= 3) return compact.toUpperCase();
  return compact.slice(0, 3).toUpperCase();
}

export function matchesConditionOnTarget(target: any, cond: ModuleUiCondition) {
  const value = getByPath(target, cond.key);
  if (Object.prototype.hasOwnProperty.call(cond, "equals")) return value === cond.equals;
  if (Object.prototype.hasOwnProperty.call(cond, "notEquals")) return value !== cond.notEquals;
  if (cond.truthy) return Boolean(value);
  if (cond.falsy) return !value;
  if (cond.endsWith) return typeof value === "string" && value.endsWith(cond.endsWith);
  return false;
}

export function matchesAnyCondition(target: any, conditions?: ModuleUiCondition[]) {
  if (!conditions || conditions.length === 0) return false;
  return conditions.some(cond => matchesConditionOnTarget(target, cond));
}

// Visibility affects presentation only. Normalization and persistence retain
// every field so changing a parent option restores its previous settings.
export function isRuntimeSettingVisible(field: RuntimeSettingField, settings: Record<string, unknown>) {
  return (!field.visibleWhen?.length || matchesAnyCondition(settings, field.visibleWhen)) &&
    !matchesAnyCondition(settings, field.hiddenWhen);
}

export function resolveRuntimeSections(managerState: RuntimeManagerState | null) {
  if (!managerState) return [];
  if (Array.isArray(managerState.sections)) return managerState.sections;
  if (managerState.catalog || managerState.installed) {
    return [
      {
        ...managerState,
        id: "default",
        label: managerState.label || "Runtime"
      }
    ];
  }
  const sections = [];
  for (const [key, value] of Object.entries(managerState)) {
    if (!value || typeof value !== "object") continue;
    if (!value.catalog && !value.installed) continue;
    sections.push({
      ...value,
      id: key,
      label: value.label || key
    });
  }
  return sections;
}

export function resolveRuntimeSection(
  managerState: RuntimeManagerState | null,
  sectionId: string | null
) {
  const sections = resolveRuntimeSections(managerState);
  if (!sections.length) return null;
  if (!sectionId) return sections[0] || null;
  const exact = sections.find(section => section.id === sectionId) || managerState?.selectionSections?.[sectionId];
  if (exact) return exact;
  const template = managerState?.selectionSectionTemplate;
  const source = template?.versionSectionBy === "major" && /^\d+$/.test(sectionId)
    ? sections.find(section => section.id === template.sectionId) : null;
  if (source) {
    const matches = (version: string) => /^v?(\d+)(?:[.+-]|$)/i.exec(version)?.[1] === sectionId;
    const installed = (source.installed || []).filter((item: any) => matches(item.version));
    const versions = (source.catalog?.versions || []).filter(matches);
    const defaultVersion = matches(source.defaultVersion || "") ? source.defaultVersion : versions[0] || installed[0]?.version || null;
    return { ...source, id: sectionId, label: template.label.replace("{section}", sectionId), installed, defaultVersion,
      catalog: { ...source.catalog, versions, installableVersions: (source.catalog?.installableVersions || []).filter(matches) } };
  }
  return sections[0] || null;
}

export function resolveRuntimeNotice(section: Record<string, any> | null): RuntimeNotice | null {
  if (!section || typeof section !== "object") return null;
  const notice = section.notice;
  if (!notice || typeof notice !== "object") return null;
  const title = typeof notice.title === "string" ? notice.title.trim() : "";
  const lines = Array.isArray(notice.lines) ? notice.lines : [];
  const normalizedLines: Array<{ text: string; mono?: boolean }> = [];
  for (const line of lines) {
    if (typeof line === "string") {
      const text = line.trim();
      if (text) normalizedLines.push({ text });
      continue;
    }
    if (line && typeof line === "object") {
      const text = typeof line.text === "string" ? line.text.trim() : "";
      if (!text) continue;
      normalizedLines.push({ text, mono: Boolean(line.mono) });
    }
  }
  if (!title && normalizedLines.length === 0) return null;
  return {
    title: title || "Note",
    lines: normalizedLines
  };
}

export function resolveRuntimeManagerId(moduleInfo: ModuleManifest | null, runtimeId: RuntimeId) {
  return moduleInfo?.runtime?.manager?.[runtimeId] || null;
}

export function resolveRuntimeVersionForSection(
  moduleInfo: ModuleManifest | null,
  runtimeId: RuntimeId,
  value: unknown,
  sectionId: string | null
) {
  // "auto", saved by the per-game runtime settings, is the default choice, as in version-choices.js.
  const raw = typeof value === "string" ? value.trim() : "";
  const version = raw === "auto" ? "" : raw;
  if (!version || moduleInfo?.runtime?.managerVersionSectionBy?.[runtimeId] !== "major") return version;
  const major = /^v?(\d+)(?:[.+-]|$)/i.exec(version);
  const section = sectionId ? Number(sectionId) : NaN;
  return major && Number.isFinite(section) && Number(major[1]) !== section ? "" : version;
}

export function resolveRuntimeVersionOverride(
  moduleInfo: ModuleManifest | null,
  runtimeId: RuntimeId,
  entry: RecentGame,
  sectionId: string | null
) {
  return resolveRuntimeVersionForSection(moduleInfo, runtimeId,
    getByPath(entry, `runtimeData.${runtimeId}.version`), moduleInfo?.runtime?.inspectorSections?.[runtimeId] ? null : sectionId);
}

export function resolveRuntimeSectionId(
  moduleInfo: ModuleManifest | null,
  runtimeId: RuntimeId,
  entry: RecentGame,
  options: { ignoreOverride?: boolean; managerState?: RuntimeManagerState | null } = {}
) {
  const map = moduleInfo?.runtime?.managerSectionMap?.[runtimeId] || {};
  const mapToSectionId = (value: unknown) => {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    return map[raw] || raw;
  };

  const overrideKey = moduleInfo?.runtime?.managerSectionOverrideKey?.[runtimeId];
  const overrideValue = overrideKey ? getByPath(entry, `runtimeData.${runtimeId}.${overrideKey}`) : null;
  const overrideSectionId = mapToSectionId(overrideValue);
  if (overrideKey && !options.ignoreOverride) {
    if (overrideSectionId) return overrideSectionId;
  }

  // A version chosen from the combined inspector list belongs to the section
  // that lists it, before the module's status records that section again.
  const pin = getByPath(entry, `runtimeData.${runtimeId}.version`);
  if (moduleInfo?.runtime?.inspectorSections?.[runtimeId] && !overrideSectionId && typeof pin === "string" && pin) {
    const listing = resolveRuntimeSections(options.managerState || null).find(section =>
      (section?.installed || []).some((item: any) => item?.version === pin) || (section?.catalog?.versions || []).includes(pin));
    if (listing?.id) return String(listing.id);
  }

  const key = moduleInfo?.runtime?.managerSectionBy?.[runtimeId];
  if (!key) return null;
  const direct = getByPath(entry, key);
  const moduleValue = getByPath(entry, `moduleData.${key}`);
  const value = moduleValue ?? direct;
  const detected = mapToSectionId(value);
  const automatic = moduleInfo?.runtime?.managerSectionAuto?.[runtimeId];
  if (automatic && !overrideSectionId && moduleInfo?.runtime?.managerVersionSectionBy?.[runtimeId] === "major") {
    const version = getByPath(entry, `runtimeData.${runtimeId}.version`);
    const major = typeof version === "string" ? /^v?(\d+)(?:[.+-]|$)/i.exec(version.trim()) : null;
    const pinned = major && mapToSectionId(major[1]);
    // A version pin may sit below the automatic section when the module
    // records a separate compatibility minimum.
    const floor = (automatic.minimumKey && mapToSectionId(getByPath(entry, `moduleData.${automatic.minimumKey}`))) || detected;
    if (pinned && (!Object.keys(map).length || Object.hasOwn(map, major![1]) || options.managerState?.selectionSectionTemplate?.versionSectionBy === "major") &&
        (!automatic.minimum || !floor || Number(pinned) >= Number(floor))) return pinned;
  }
  // The section the game's own data recommends precedes the Runtimes default.
  if (detected || !automatic) return detected;
  return mapToSectionId(getByPath(options.managerState, automatic.defaultKey));
}

export function readSaveEditorContext(): { gamePath: string } | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const gamePath = params.get("gamePath");
    return params.get("view") === "save-editor" && gamePath && !gamePath.includes("\0") ? { gamePath } : null;
  } catch { return null; }
}

export function readRuntimeSettingsContext(): RuntimeSettingsContext | null {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") !== "runtime-settings") return null;
    const runtimeId = params.get("runtimeId") || "";
    const moduleId = params.get("moduleId") || "";
    const scope = params.get("scope") === "game" ? "game" : "module";
    const gamePath = params.get("gamePath") || "";
    if (!runtimeId || !moduleId) return null;
    if (scope === "game" && !gamePath) return null;
    return {
      scope,
      moduleId,
      runtimeId,
      ...(gamePath ? { gamePath } : {})
    };
  } catch {
    return null;
  }
}

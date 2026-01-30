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

export const SETTINGS_MODULE_ORDER = new Map<ModuleId, number>([
  ["renpy", 0],
  ["nscripter", 1],
  ["rgss", 2],
  ["mv", 3],
  ["mz", 4],
  ["tyrano", 5],
  ["construct", 6],
  ["web", 7]
]);

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
  if (runtimeId === "native") return "Native app";
  if (typeof runtimeId === "string" && runtimeId) {
    return runtimeId.charAt(0).toUpperCase() + runtimeId.slice(1);
  }
  return "Runtime";
}

export function formatRuntimeOption(runtimeId: RuntimeId, moduleInfo?: ModuleManifest | null) {
  return formatRuntimeLabel(runtimeId, moduleInfo);
}

export function resolveRuntimeVersionLabel(
  version: string,
  runtimeSection: Record<string, any> | null | undefined
) {
  if (!version) return "";
  const labels = runtimeSection?.versionLabels;
  if (labels && typeof labels === "object") {
    const mapped = (labels as Record<string, string | null | undefined>)[version];
    if (mapped) return String(mapped);
  }
  return String(version);
}

export function formatRuntimeVersionTag(
  version: string,
  runtimeSection: Record<string, any> | null | undefined
) {
  const label = resolveRuntimeVersionLabel(version, runtimeSection);
  return label ? `v${label}` : "";
}

export function formatDownloadPercent(task: { downloaded: number; total: number | null }) {
  if (!task.total || task.total <= 0) return null;
  const pct = Math.floor((task.downloaded / task.total) * 100);
  if (!Number.isFinite(pct)) return null;
  return Math.min(100, Math.max(0, pct));
}

export function formatProtectionStatus(enableProtections: boolean) {
  return enableProtections
    ? "Protections enabled · offline by default"
    : "Protections disabled · network and child_process allowed";
}

export function resolveRuntimeSettingFallback(field: RuntimeSettingField) {
  if (Object.prototype.hasOwnProperty.call(field, "default")) return field.default;
  if (field.type === "boolean") return false;
  if (field.type === "number") return 0;
  if (field.type === "list") return [];
  return "";
}

export function normalizeListValue(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map(entry => String(entry ?? "").trim())
      .filter(entry => entry.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/)
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0);
  }
  return [];
}

export function normalizeRuntimeSettingValue(
  field: RuntimeSettingField,
  value: unknown,
  fallback: unknown
) {
  if (field.type === "boolean") {
    if (value === true || value === false) return value;
    return fallback === true || fallback === false ? fallback : false;
  }
  if (field.type === "number") {
    const num = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(num)) return num;
    const fb = typeof fallback === "number" ? fallback : Number(fallback);
    return Number.isFinite(fb) ? fb : 0;
  }
  if (field.type === "list") {
    if (value === null || value === undefined) return normalizeListValue(fallback);
    return normalizeListValue(value);
  }
  if (field.type === "select") {
    const options = Array.isArray(field.options) ? field.options : [];
    const values = options
      .map(opt => opt?.value)
      .filter(val => typeof val === "string" && val.length > 0);
    const incoming = typeof value === "string" ? value : "";
    if (incoming && values.includes(incoming)) return incoming;
    const fb = typeof fallback === "string" ? fallback : "";
    if (fb && values.includes(fb)) return fb;
    return values[0] || "";
  }
  if (typeof value === "string") return value;
  return typeof fallback === "string" ? fallback : "";
}

export function buildRuntimeSettingsDefaults(schema: RuntimeSettingsSchema | null) {
  if (!schema) return {};
  const base =
    schema.defaults && typeof schema.defaults === "object" ? schema.defaults : {};
  const out: Record<string, any> = {};
  for (const field of schema.fields) {
    if (!field.key) continue;
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
    if (!field.key) continue;
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
    if (!key) continue;
    if (!runtimeSettingValuesEqual((a as any)?.[key], (b as any)?.[key])) return false;
  }
  return true;
}

export function resolveModuleRuntimeSettings(
  state: LauncherState | null,
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
  return normalizeRuntimeSettings(schema, runtimeSettings, globalDefaults);
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
  if (!pa || !pb) return String(a || "").localeCompare(String(b || ""));
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

export function sortModulesForSettings(modules: ModuleManifest[]) {
  const list = Array.isArray(modules) ? modules.slice() : [];
  list.sort((a, b) => {
    const ia = SETTINGS_MODULE_ORDER.get(a.id);
    const ib = SETTINGS_MODULE_ORDER.get(b.id);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    const la = String(a?.label || a?.id || "");
    const lb = String(b?.label || b?.id || "");
    return la.localeCompare(lb);
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
  return sections.find(section => section.id === sectionId) || sections[0] || null;
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

export function resolveRuntimeSectionId(
  moduleInfo: ModuleManifest | null,
  runtimeId: RuntimeId,
  entry: RecentGame
) {
  const key = moduleInfo?.runtime?.managerSectionBy?.[runtimeId];
  if (!key) return null;
  const direct = getByPath(entry, key);
  const moduleValue = getByPath(entry, `moduleData.${key}`);
  const value = moduleValue ?? direct;
  if (value === null || value === undefined) return null;
  const map = moduleInfo?.runtime?.managerSectionMap?.[runtimeId] || {};
  return map[String(value)] || null;
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

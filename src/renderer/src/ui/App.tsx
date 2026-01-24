import React, { useEffect, useMemo, useRef, useState } from "react";
import { filterGames } from "./search-utils.mjs";

type ModuleId = string;
type RuntimeId = string;

type ModuleUiCondition = {
  key: string;
  equals?: unknown;
  notEquals?: unknown;
  truthy?: boolean;
  falsy?: boolean;
  endsWith?: string;
};

type ActionIconId = "refresh" | "x";

type ModuleUiField = {
  key: string;
  label: string;
  format?: "boolean" | "date" | "path" | "string";
  empty?: string;
  hiddenWhen?: ModuleUiCondition[];
};

type ModuleUiAction = {
  id: string;
  label: string;
  kind?: "primary" | "secondary" | "danger";
  icon?: ActionIconId;
  iconOnly?: boolean;
  confirm?: string;
  autoRun?: boolean;
  resultFields?: ModuleUiField[];
  disabledWhen?: ModuleUiCondition[];
  hiddenWhen?: ModuleUiCondition[];
};

type ModuleUiGroup = {
  id: string;
  label: string;
  labelKey?: string;
  actions: string[];
  note?: string;
  infoFields?: ModuleUiField[];
  hideEmptyValue?: boolean;
  hiddenWhen?: ModuleUiCondition[];
};

type ModuleUiCheatsPatch = {
  id: string;
  label: string;
  statusKey: string;
  addAction: string;
  removeAction: string;
};

type ModuleUi = {
  infoFields?: ModuleUiField[];
  actions?: ModuleUiAction[];
  actionGroups?: ModuleUiGroup[];
  cheatsStatusAction?: string;
  cheatsPatches?: ModuleUiCheatsPatch[];
  cheatsMode?: "default" | "patches";
};

type RuntimeSettingField = {
  key: string;
  type: "boolean" | "number" | "string" | "select" | "list";
  label: string;
  description?: string;
  default?: unknown;
  options?: Array<{ value: string; label: string }>;
};

type RuntimeSettingsSchema = {
  defaults?: Record<string, unknown>;
  fields: RuntimeSettingField[];
};

type RuntimeEntry = {
  label?: string;
  settings?: RuntimeSettingsSchema | null;
};

type ModuleManifest = {
  id: ModuleId;
  family: string;
  label: string;
  shortLabel: string;
  gameType: string;
  runtime: {
    default: RuntimeId;
    supported: RuntimeId[];
    entries?: Record<string, RuntimeEntry>;
    labels?: Record<string, string>;
    hosted?: {
      id: RuntimeId;
      fallback?: RuntimeId;
      userAgent?: {
        suffix?: string;
        hint?: string;
      };
    };
    manager?: Record<string, string>;
    managerSectionBy?: Record<string, string>;
    managerSectionMap?: Record<string, Record<string, string>>;
    preLaunch?: Record<
      string,
      {
        statusAction?: string;
        readyWhen?: ModuleUiCondition | ModuleUiCondition[];
        fixAction?: string;
        declineAction?: string;
        prompt?: string;
      }
    >;
  };
  supports: {
    cheats: boolean;
    cheatsPatcher: boolean;
    saveEditing: boolean;
    saveLocation: boolean;
  };
  settingsDefaults: Record<string, unknown>;
  ui?: ModuleUi | null;
  acknowledgments?: Array<{ label: string; url: string }>;
};

type ModuleSupports = {
  cheats: boolean;
  cheatsPatcher: boolean;
  saveEditing: boolean;
  saveLocation: boolean;
};

const SETTINGS_MODULE_ORDER = new Map<ModuleId, number>([
  ["renpy", 0],
  ["nscripter", 1],
  ["rgss", 2],
  ["mv", 3],
  ["mz", 4],
  ["tyrano", 5],
  ["construct", 6],
  ["web", 7]
]);

type LauncherSettings = {
  showIcons: boolean;
  showNonDefaultTags: boolean;
};

type CheatsConfig = Record<string, any>;

type CheatsField = {
  key: string;
  type: "boolean" | "number";
  label: string;
  category: string;
  common?: boolean;
  min?: number;
  max?: number;
  step?: number;
};

type CheatsSchema = {
  defaults: CheatsConfig;
  fields: CheatsField[];
};

type RecentGame = {
  gameId: string;
  schemaVersion: number;
  order: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  gamePath: string;
  importPath: string | null;
  contentRootDir: string | null;
  name: string;
  moduleId: ModuleId;
  moduleFamily: string;
  moduleLabel: string;
  moduleShortLabel: string;
  moduleRuntimeSupport: RuntimeId[];
  moduleSupports: ModuleSupports;
  gameType: string | null;
  indexDir: string | null;
  indexHtml: string | null;
  defaultSaveDir: string | null;
  saveDirOverride: string | null;
  nativeAppPath: string | null;
  lastBuiltAt: number | null;
  runtimeId: RuntimeId;
  runtimeData: Record<string, any>;
  runtimeSettings: Record<string, any>;
  moduleData: Record<string, any>;
  cheats: CheatsConfig | null;
  iconPath: string | null;
  iconSource: string | null;
  iconUrl: string | null;
  lastPlayedAt: number | null;
};

type RuntimeManagerState = {
  id: string;
  label: string;
  sections?: Array<Record<string, any>>;
  [key: string]: any;
};

type RuntimeNoticeLine = {
  text: string;
  mono?: boolean;
};

type RuntimeNotice = {
  title: string;
  lines: RuntimeNoticeLine[];
};

type LauncherState = {
  recents: RecentGame[];
  modules: ModuleManifest[];
  moduleSettings: Record<string, Record<string, any>>;
  moduleStates: Record<string, Record<string, any>>;
  runtimeManagers: Record<string, RuntimeManagerState>;
  runtimeDefaults: Record<string, Record<string, any>>;
  launcherSettings: LauncherSettings;
  running: Record<string, number>;
  debug: boolean;
  logPath: string;
};

type RuntimeSettingsContext = {
  scope: "module" | "game";
  moduleId: ModuleId;
  runtimeId: RuntimeId;
  gamePath?: string;
};

type SaveInfo = {
  saveDir: string;
  moduleId: ModuleId;
  moduleLabel: string;
  moduleShortLabel: string;
  name: string;
};

type SaveFileInfo = {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
};

type CheatsPatchStatus = Record<string, any>;

type LibsPatchStatus = Record<string, any>;
declare global {
  interface Window {
    MacLauncher?: {
      launcher: {
        getState(): Promise<LauncherState>;
        openGameDialog(): Promise<string[]>;
        getPathForFile(file: File): string | null;
        addRecent(inputPath: string): Promise<unknown>;
        forgetGame(gamePath: string): Promise<boolean>;
        moveGame(gamePath: string, delta: number): Promise<boolean>;
        reorderGame(gamePath: string, toIndex: number): Promise<boolean>;
        deleteGame(gamePath: string): Promise<boolean>;
        launchGame(gamePath: string): Promise<boolean>;
        launchGameWithRuntime(gamePath: string, runtime: RuntimeId): Promise<boolean>;
        createGameCommand(gamePath: string): Promise<string | null>;
        stopGame(gamePath: string): Promise<boolean>;
        setGameRuntime(gamePath: string, runtime: RuntimeId): Promise<boolean>;
        setGameRuntimeSettings(
          gamePath: string,
          runtimeId: RuntimeId,
          settings: Record<string, any> | null
        ): Promise<boolean>;
        setModuleSettings(moduleId: ModuleId, patch: Record<string, any>): Promise<boolean>;
        setLauncherSettings(patch: Record<string, any>): Promise<boolean>;
        setModuleRuntimeSettings(
          moduleId: ModuleId,
          runtimeId: RuntimeId,
          settings: Record<string, any> | null
        ): Promise<boolean>;
        setGameModuleData(gamePath: string, patch: Record<string, any>): Promise<boolean>;
        setGameRuntimeData(
          gamePath: string,
          runtimeId: RuntimeId,
          patch: Record<string, any> | null
        ): Promise<boolean>;
        openRuntimeSettings(payload: {
          scope: "module" | "game";
          runtimeId: RuntimeId;
          moduleId?: ModuleId;
          gamePath?: string;
        }): Promise<boolean>;
        runtimeAction(
          managerId: string,
          action: string,
          payload?: Record<string, any>
        ): Promise<boolean>;
        moduleAction(
          gamePath: string,
          action: string,
          payload?: Record<string, any>
        ): Promise<boolean>;
        setGameLibVersion(
          gamePath: string,
          depId: string,
          versionId: string | null
        ): Promise<boolean>;
        getLibsPatchStatus(gamePath: string): Promise<LibsPatchStatus>;
        patchLibs(gamePath: string): Promise<LibsPatchStatus>;
        unpatchLibs(gamePath: string): Promise<LibsPatchStatus>;
        pickSaveDir(gamePath: string): Promise<string | null>;
        resetSaveDir(gamePath: string): Promise<boolean>;
        setCheats(gamePath: string, cheats: CheatsConfig): Promise<boolean>;
        getCheatsPatchStatus(gamePath: string): Promise<CheatsPatchStatus | null>;
        patchCheatsIntoGame(gamePath: string): Promise<CheatsPatchStatus | null>;
        unpatchCheatsFromGame(gamePath: string): Promise<CheatsPatchStatus | null>;
        getSaveInfo(gamePath: string): Promise<SaveInfo>;
        listSaveFiles(gamePath: string): Promise<SaveFileInfo[]>;
        importSaveDir(gamePath: string): Promise<boolean | null>;
        exportSaveDir(gamePath: string): Promise<string | null>;
        importSaveFiles(gamePath: string): Promise<boolean | null>;
        readSaveJson(gamePath: string, fileName: string): Promise<string>;
        writeSaveJson(
          gamePath: string,
          fileName: string,
          json: string
        ): Promise<boolean>;
        openSaveJsonInExternalEditor(
          gamePath: string,
          fileName: string,
          json: string
        ): Promise<string>;
        readExternalSaveJson(gamePath: string, fileName: string): Promise<string>;
        revealInFinder(targetPath: string): Promise<boolean>;
        openExternal(url: string): Promise<boolean>;
        onState(callback: (state: LauncherState) => void): () => void;
        onOpenSettings(callback: () => void): () => void;
      };
    };
  }
}

type LauncherApi = NonNullable<Window["MacLauncher"]>["launcher"];

function formatModuleBadge(moduleShortLabel?: string, moduleLabel?: string, moduleId?: string) {
  return moduleShortLabel || moduleLabel || moduleId || "Unknown";
}

function formatModuleLabel(moduleLabel?: string, moduleShortLabel?: string, moduleId?: string) {
  return moduleLabel || moduleShortLabel || moduleId || "Unknown";
}

function resolveRuntimeEntry(moduleInfo: ModuleManifest | null | undefined, runtimeId: RuntimeId) {
  const entries = moduleInfo?.runtime?.entries;
  if (!entries || typeof entries !== "object") return null;
  const entry = entries[runtimeId];
  return entry && typeof entry === "object" ? entry : null;
}

function resolveRuntimeSettingsSchema(
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

function formatRuntimeLabel(runtimeId: RuntimeId, moduleInfo?: ModuleManifest | null) {
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

function formatRuntimeOption(runtimeId: RuntimeId, moduleInfo?: ModuleManifest | null) {
  return formatRuntimeLabel(runtimeId, moduleInfo);
}

function resolveRuntimeVersionLabel(
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

function formatRuntimeVersionTag(
  version: string,
  runtimeSection: Record<string, any> | null | undefined
) {
  const label = resolveRuntimeVersionLabel(version, runtimeSection);
  return label ? `v${label}` : "";
}

function formatProtectionStatus(enableProtections: boolean) {
  return enableProtections
    ? "Protections enabled · offline by default"
    : "Protections disabled · network and child_process allowed";
}

function resolveRuntimeSettingFallback(field: RuntimeSettingField) {
  if (Object.prototype.hasOwnProperty.call(field, "default")) return field.default;
  if (field.type === "boolean") return false;
  if (field.type === "number") return 0;
  if (field.type === "list") return [];
  return "";
}

function normalizeListValue(value: unknown) {
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

function normalizeRuntimeSettingValue(
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

function buildRuntimeSettingsDefaults(schema: RuntimeSettingsSchema | null) {
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

function normalizeRuntimeSettings(
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

function runtimeSettingValuesEqual(a: unknown, b: unknown) {
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

function runtimeSettingsEqual(
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

function resolveModuleRuntimeSettings(
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

function resolveDefaultRuntime(
  moduleInfo: ModuleManifest | null | undefined,
  moduleSettings: Record<string, any> | null | undefined
) {
  const fallback = moduleInfo?.runtime?.default || moduleInfo?.runtime?.supported?.[0] || "";
  const value = typeof moduleSettings?.defaultRuntime === "string" ? moduleSettings.defaultRuntime : "";
  return value || fallback;
}

function formatWhen(ts: number | null) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

function formatBytes(bytes: number) {
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

function formatWhenMs(ts: number) {
  if (!Number.isFinite(ts)) return "—";
  return new Date(ts).toLocaleString();
}

function parseSemver(v: string): [number, number, number] | null {
  const m = String(v || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a: string, b: string) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return String(a || "").localeCompare(String(b || ""));
  for (let i = 0; i < 3; i++) {
    const d = pa[i] - pb[i];
    if (d !== 0) return d;
  }
  return 0;
}

function sortInstalled(
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

function isRuntimeVersionInstalled(
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

function defaultSaveDirForGame(g: Pick<RecentGame, "defaultSaveDir">) {
  return g.defaultSaveDir || "";
}

function formatSaveDirDisplay(saveDir: string | null) {
  if (saveDir) return saveDir;
  return "—";
}

function getByPath(obj: any, pathStr: string) {
  if (!pathStr) return undefined;
  const parts = pathStr.split(".");
  let cur = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function formatFieldValue(value: any, format: ModuleUiField["format"], empty = "—") {
  if (value === null || value === undefined || value === "") return empty;
  if (format === "boolean") return value ? "Yes" : "No";
  if (format === "date") {
    const ts = typeof value === "number" ? value : Date.parse(String(value));
    return Number.isFinite(ts) ? new Date(ts).toLocaleString() : empty;
  }
  if (format === "path") return String(value);
  return String(value);
}

function formatSettingLabel(key: string) {
  if (!key) return "Setting";
  const spaced = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function sortModulesForSettings(modules: ModuleManifest[]) {
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

function formatIconFallbackText(entry: RecentGame, moduleInfo: ModuleManifest | null) {
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

function matchesConditionOnTarget(target: any, cond: ModuleUiCondition) {
  const value = getByPath(target, cond.key);
  if (Object.prototype.hasOwnProperty.call(cond, "equals")) return value === cond.equals;
  if (Object.prototype.hasOwnProperty.call(cond, "notEquals")) return value !== cond.notEquals;
  if (cond.truthy) return Boolean(value);
  if (cond.falsy) return !value;
  if (cond.endsWith) return typeof value === "string" && value.endsWith(cond.endsWith);
  return false;
}

function matchesAnyCondition(target: any, conditions?: ModuleUiCondition[]) {
  if (!conditions || conditions.length === 0) return false;
  return conditions.some(cond => matchesConditionOnTarget(target, cond));
}

type IconSize = number | string;

function RefreshIcon({ size = "1em" }: { size?: IconSize }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-6-6c1.66 0 3.14.69 4.22 1.78L14 10h6V4l-2.35 2.35z"
      />
    </svg>
  );
}

function XIcon({ size = "1em" }: { size?: IconSize }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.29 19.7 2.88 18.3 9.17 12 2.88 5.71 4.29 4.29 10.59 10.6 16.89 4.29z"
      />
    </svg>
  );
}

function ActionIcon({ icon, size = "1em" }: { icon: ActionIconId; size?: IconSize }) {
  if (icon === "refresh") return <RefreshIcon size={size} />;
  return <XIcon size={size} />;
}

function resolveRuntimeSections(managerState: RuntimeManagerState | null) {
  if (!managerState) return [];
  if (Array.isArray(managerState.sections)) return managerState.sections;
  if (managerState.catalog || managerState.installed) {
    return [
      {
        id: "default",
        label: managerState.label || "Runtime",
        ...managerState
      }
    ];
  }
  const sections = [];
  for (const [key, value] of Object.entries(managerState)) {
    if (!value || typeof value !== "object") continue;
    if (!value.catalog && !value.installed) continue;
    sections.push({
      id: key,
      label: value.label || key,
      ...value
    });
  }
  return sections;
}

function resolveRuntimeSection(managerState: RuntimeManagerState | null, sectionId: string | null) {
  const sections = resolveRuntimeSections(managerState);
  if (!sections.length) return null;
  if (!sectionId) return sections[0] || null;
  return sections.find(section => section.id === sectionId) || sections[0] || null;
}

function resolveRuntimeNotice(section: Record<string, any> | null): RuntimeNotice | null {
  if (!section || typeof section !== "object") return null;
  const notice = section.notice;
  if (!notice || typeof notice !== "object") return null;
  const title = typeof notice.title === "string" ? notice.title.trim() : "";
  const lines = Array.isArray(notice.lines) ? notice.lines : [];
  const normalizedLines: RuntimeNoticeLine[] = [];
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

function resolveRuntimeManagerId(moduleInfo: ModuleManifest | null, runtimeId: RuntimeId) {
  return moduleInfo?.runtime?.manager?.[runtimeId] || null;
}

function resolveRuntimeSectionId(
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

function readRuntimeSettingsContext(): RuntimeSettingsContext | null {
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

type RuntimeSettingsWindowProps = {
  api: LauncherApi | undefined;
  state: LauncherState | null;
  context: RuntimeSettingsContext;
  error: string | null;
};

function RuntimeSettingsWindow({
  api,
  state,
  context,
  error
}: RuntimeSettingsWindowProps) {
  const [draft, setDraft] = useState<Record<string, any> | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const isGameScope = context.scope === "game";

  const moduleInfo = useMemo(
    () => (state?.modules || []).find(mod => mod.id === context.moduleId) || null,
    [state, context.moduleId]
  );
  const runtimeLabel = formatRuntimeLabel(context.runtimeId, moduleInfo);
  const moduleLabel = formatModuleLabel(
    moduleInfo?.label,
    moduleInfo?.shortLabel,
    context.moduleId
  );
  const schema = useMemo(
    () => resolveRuntimeSettingsSchema(moduleInfo, context.runtimeId),
    [moduleInfo, context.runtimeId]
  );
  const globalDefaults = useMemo(() => {
    if (!schema) return null;
    return normalizeRuntimeSettings(
      schema,
      state?.runtimeDefaults?.[context.runtimeId] || null,
      buildRuntimeSettingsDefaults(schema)
    );
  }, [schema, state, context.runtimeId]);
  const moduleDefaults = useMemo(() => {
    if (!schema) return null;
    return resolveModuleRuntimeSettings(
      state,
      context.moduleId,
      moduleInfo,
      context.runtimeId
    );
  }, [schema, state, context.moduleId, moduleInfo, context.runtimeId]);
  const baseDefaults = useMemo(() => {
    if (!schema) return null;
    if (isGameScope) {
      return moduleDefaults || globalDefaults || buildRuntimeSettingsDefaults(schema);
    }
    return globalDefaults || buildRuntimeSettingsDefaults(schema);
  }, [schema, isGameScope, moduleDefaults, globalDefaults]);
  const gameEntry = useMemo(() => {
    if (!isGameScope) return null;
    return (state?.recents || []).find(g => g.gamePath === context.gamePath) || null;
  }, [state, isGameScope, context.gamePath]);
  const gameOverride = useMemo(() => {
    if (!isGameScope) return null;
    const raw = gameEntry?.runtimeSettings?.[context.runtimeId];
    return raw && typeof raw === "object" ? raw : null;
  }, [isGameScope, gameEntry, context.runtimeId]);
  const normalizedGameOverride = useMemo(() => {
    if (!schema || !isGameScope) return null;
    if (!gameOverride || typeof gameOverride !== "object") return null;
    const defaults = baseDefaults || buildRuntimeSettingsDefaults(schema);
    return normalizeRuntimeSettings(schema, gameOverride, defaults);
  }, [schema, isGameScope, gameOverride, baseDefaults]);
  const savedSettings = useMemo(() => {
    if (!schema) return null;
    if (isGameScope) {
      if (
        normalizedGameOverride &&
        baseDefaults &&
        !runtimeSettingsEqual(schema, normalizedGameOverride, baseDefaults)
      ) {
        return normalizedGameOverride;
      }
      return baseDefaults;
    }
    return moduleDefaults || baseDefaults;
  }, [schema, isGameScope, normalizedGameOverride, baseDefaults, moduleDefaults]);
  const savedModified = useMemo(() => {
    if (!schema || !baseDefaults) return false;
    if (isGameScope) {
      if (!normalizedGameOverride) return false;
      return !runtimeSettingsEqual(schema, normalizedGameOverride, baseDefaults);
    }
    if (!moduleDefaults) return false;
    return !runtimeSettingsEqual(schema, moduleDefaults, baseDefaults);
  }, [schema, isGameScope, normalizedGameOverride, baseDefaults, moduleDefaults]);
  const draftModified = useMemo(() => {
    if (!schema || !baseDefaults || !draft) return false;
    return !runtimeSettingsEqual(schema, draft, baseDefaults);
  }, [schema, baseDefaults, draft]);
  const modified = dirty ? draftModified : savedModified;

  useEffect(() => {
    if (!schema) {
      setDraft(null);
      return;
    }
    if (dirty) return;
    if (!savedSettings) {
      setDraft(null);
      return;
    }
    setDraft({ ...savedSettings });
  }, [schema, savedSettings, dirty]);

  useEffect(() => {
    setSaveError(null);
  }, [context.scope, context.runtimeId, context.moduleId, context.gamePath]);

  const displaySettings = draft;
  const fieldsDisabled = saving;
  const canEdit = Boolean(api && schema && displaySettings);

  async function onSave() {
    if (!api || !schema) return;
    const defaults = baseDefaults || buildRuntimeSettingsDefaults(schema);
    const normalizedDraft = normalizeRuntimeSettings(schema, draft || {}, defaults);
    const isModified = !runtimeSettingsEqual(schema, normalizedDraft, defaults);
    setSaving(true);
    setSaveError(null);
    try {
      if (!isGameScope) {
        await api.setModuleRuntimeSettings(
          context.moduleId,
          context.runtimeId,
          isModified ? normalizedDraft : null
        );
      } else if (context.gamePath) {
        await api.setGameRuntimeSettings(
          context.gamePath,
          context.runtimeId,
          isModified ? normalizedDraft : null
        );
      }
      setDirty(false);
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  function onReset() {
    if (!schema) return;
    const defaults = baseDefaults || buildRuntimeSettingsDefaults(schema);
    setDraft({ ...defaults });
    setDirty(true);
  }

  function onFieldChange(key: string, value: any) {
    setDraft(prev => ({ ...(prev || {}), [key]: value }));
    setDirty(true);
  }

  const subtitleBase = isGameScope
    ? `${gameEntry?.name || "Game"} · ${moduleLabel}`
    : `${moduleLabel} · game type defaults`;
  const subtitle = modified ? `${subtitleBase} · Modified` : subtitleBase;
  const resetLabel =
    context.scope === "game"
      ? "Reset to game type defaults"
      : "Reset to global defaults";

  return (
    <div className="runtimeSettingsRoot">
      <div className="modal runtimeSettingsPanel">
        <div className="modalHeader">
          <div>
            <div className="modalTitle">{runtimeLabel} settings</div>
            <div className="modalSubtitle">{subtitle}</div>
          </div>
          <button
            className="btn iconOnly"
            onClick={() => window.close()}
            title="Close"
            aria-label="Close"
          >
            <XIcon />
          </button>
        </div>
        <div className="modalBody">
          {error && <div className="error">Error: {error}</div>}
          {saveError && <div className="error">Error: {saveError}</div>}
          {!api && (
            <div className="empty">
              Launcher bridge unavailable. Open this window from the app.
            </div>
          )}
          {api && !state && <div className="empty">Loading runtime settings…</div>}
          {api && state && schema && displaySettings && (
            <div className="settingsStack">
              {schema.fields.map(field => {
                const isProtectionToggle = field.key === "enableProtections";
                const checked = Boolean((displaySettings as any)[field.key]);
                const statusText = isProtectionToggle
                  ? formatProtectionStatus(checked)
                  : field.description || "";
                if (field.type === "boolean") {
                  return (
                    <React.Fragment key={field.key}>
                      <div className="settingsRow">
                        <div className="settingsLabel">{field.label}</div>
                        <div className="settingsControl">
                          <label className="inlineCheck settingsToggle">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={e =>
                                onFieldChange(
                                  field.key,
                                  e.target.checked
                                )
                              }
                              disabled={!canEdit || fieldsDisabled}
                            />
                            <span>{checked ? "On" : "Off"}</span>
                          </label>
                        </div>
                      </div>
                      {statusText && <div className="dim settingsHint">{statusText}</div>}
                    </React.Fragment>
                  );
                }
                if (field.type === "number") {
                  const num = (displaySettings as any)[field.key];
                  const hint = field.description || "";
                  return (
                    <React.Fragment key={field.key}>
                      <div className="settingsRow">
                        <div className="settingsLabel">{field.label}</div>
                        <div className="settingsControl">
                          <input
                            className="input"
                            type="number"
                            value={Number.isFinite(num) ? num : ""}
                            onChange={e => onFieldChange(field.key, Number(e.target.value))}
                            disabled={!canEdit || fieldsDisabled}
                          />
                        </div>
                      </div>
                      {hint && <div className="dim settingsHint">{hint}</div>}
                    </React.Fragment>
                  );
                }
                if (field.type === "select") {
                  const options = Array.isArray(field.options) ? field.options : [];
                  const selected = String((displaySettings as any)[field.key] || "");
                  const hint = field.description || "";
                  return (
                    <React.Fragment key={field.key}>
                      <div className="settingsRow">
                        <div className="settingsLabel">{field.label}</div>
                        <div className="settingsControl">
                          <select
                            className="input"
                            value={selected}
                            onChange={e => onFieldChange(field.key, e.target.value)}
                            disabled={!canEdit || fieldsDisabled}
                          >
                            {options.map(opt => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label || opt.value}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      {hint && <div className="dim settingsHint">{hint}</div>}
                    </React.Fragment>
                  );
                }
                if (field.type === "list") {
                  const raw = (displaySettings as any)[field.key];
                  const textValue = Array.isArray(raw) ? raw.join("\n") : String(raw || "");
                  const hint = field.description || "";
                  return (
                    <React.Fragment key={field.key}>
                      <div className="settingsRow">
                        <div className="settingsLabel">{field.label}</div>
                        <div className="settingsControl">
                          <textarea
                            className="input"
                            rows={4}
                            value={textValue}
                            onChange={e => onFieldChange(field.key, e.target.value)}
                            disabled={!canEdit || fieldsDisabled}
                          />
                        </div>
                      </div>
                      {hint && <div className="dim settingsHint">{hint}</div>}
                    </React.Fragment>
                  );
                }
                const hint = field.description || "";
                return (
                  <React.Fragment key={field.key}>
                    <div className="settingsRow">
                      <div className="settingsLabel">{field.label}</div>
                      <div className="settingsControl">
                        <input
                          className="input"
                          type="text"
                          value={String((displaySettings as any)[field.key] || "")}
                          onChange={e => onFieldChange(field.key, e.target.value)}
                          disabled={!canEdit || fieldsDisabled}
                        />
                      </div>
                    </div>
                    {hint && <div className="dim settingsHint">{hint}</div>}
                  </React.Fragment>
                );
              })}
              <div className="modalActions">
                <button
                  className="btn"
                  onClick={onReset}
                  disabled={!schema || saving}
                >
                  {resetLabel}
                </button>
                <button
                  className="btn primary"
                  onClick={onSave}
                  disabled={!schema || saving}
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const INTERNAL_GAME_DRAG_TYPE = "application/x-maclauncher-gamepath";

export default function App() {
  const api = window.MacLauncher?.launcher;
  const [state, setState] = useState<LauncherState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [gameTypeFilter, setGameTypeFilter] = useState<Record<string, boolean>>({});
  const [gameTypesOpen, setGameTypesOpen] = useState(false);
  const [runtimesOpen, setRuntimesOpen] = useState(false);
  const [runtimeManagerId, setRuntimeManagerId] = useState<string | null>(null);
  const [runtimeSectionId, setRuntimeSectionId] = useState<string | null>(null);
  const [runtimeUi, setRuntimeUi] = useState<
    Record<
      string,
      {
        remoteOpen: Record<string, boolean>;
        installVersion: Record<string, string>;
        installVariant: Record<string, string>;
        installedSort: Record<string, "default" | "newest" | "oldest" | "path">;
        busy: boolean;
        error: string | null;
      }
    >
  >({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [acknowledgmentsOpen, setAcknowledgmentsOpen] = useState(false);
  const [saveGame, setSaveGame] = useState<RecentGame | null>(null);
  const [saveInfo, setSaveInfo] = useState<SaveInfo | null>(null);
  const [saveFiles, setSaveFiles] = useState<SaveFileInfo[]>([]);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<SaveFileInfo | null>(null);
  const [editingJson, setEditingJson] = useState<string>("");
  const [cheatGame, setCheatGame] = useState<RecentGame | null>(null);
  const [cheatSchema, setCheatSchema] = useState<CheatsSchema | null>(null);
  const [cheatDraft, setCheatDraft] = useState<CheatsConfig | null>(null);
  const [toolsButtonOverride, setToolsButtonOverride] = useState<boolean | null>(null);
  const [cheatBusy, setCheatBusy] = useState(false);
  const [cheatError, setCheatError] = useState<string | null>(null);
  const [cheatAddonStatusByPath, setCheatAddonStatusByPath] = useState<
    Record<string, CheatsPatchStatus | null>
  >({});
  const [cheatAddonBusy, setCheatAddonBusy] = useState(false);
  const [cheatsPatchStatusByPath, setCheatsPatchStatusByPath] = useState<
    Record<string, CheatsPatchStatus | null>
  >({});
  const [cheatsPatchBusyPath, setCheatsPatchBusyPath] = useState<string | null>(null);
  const [libsPatchStatusByPath, setLibsPatchStatusByPath] = useState<
    Record<string, LibsPatchStatus | null>
  >({});
  const [libsPatchBusyPath, setLibsPatchBusyPath] = useState<string | null>(null);
  const [moduleActionResultsByPath, setModuleActionResultsByPath] = useState<
    Record<string, Record<string, any>>
  >({});
  const [moduleActionBusyByPath, setModuleActionBusyByPath] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const [moduleActionErrorByPath, setModuleActionErrorByPath] = useState<
    Record<string, string | null>
  >({});
  const [expandedGamePath, setExpandedGamePath] = useState<string | null>(null);
  const [draggingGamePath, setDraggingGamePath] = useState<string | null>(null);
  const [dragOrderPaths, setDragOrderPaths] = useState<string[] | null>(null);
  const [addDropActive, setAddDropActive] = useState(false);
  const addDropDepth = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const autoRunActionKeyRef = useRef<{ gamePath: string | null; key: string | null }>({
    gamePath: null,
    key: null
  });
  const runtimeSettingsContext = useMemo(() => readRuntimeSettingsContext(), []);
  const isRuntimeSettingsView = Boolean(runtimeSettingsContext);

  useEffect(() => {
    if (!api) {
      setError(
        [
          "Missing preload bridge: window.MacLauncher.launcher.",
          "Open the launcher app window. This UI does not work in a regular browser.",
          "Run `npm run dev` and use the launcher app window."
        ].join(" ")
      );
      return;
    }

    api.getState().then(setState).catch(e => setError(String(e?.message || e)));
    return api.onState(setState);
  }, [api]);

  useEffect(() => {
    if (!api?.onOpenSettings || isRuntimeSettingsView) return;
    return api.onOpenSettings(() => setSettingsOpen(true));
  }, [api, isRuntimeSettingsView]);

  useEffect(() => {
    if (!runtimesOpen) return;
    if (!state?.runtimeManagers) return;

    setRuntimeUi(prev => {
      let didChange = false;
      const next = { ...prev };
      for (const manager of Object.values(state.runtimeManagers)) {
        const sections = resolveRuntimeSections(manager);
        const existing = next[manager.id];
        const current = existing || {
          remoteOpen: {},
          installVersion: {},
          installVariant: {},
          installedSort: {},
          busy: false,
          error: null
        };
        let managerChanged = !existing;
        const installVersion = { ...current.installVersion };
        const installVariant = { ...current.installVariant };
        const installedSort = { ...current.installedSort };
        for (const section of sections) {
          const versions = Array.isArray(section.catalog?.versions) ? section.catalog.versions : [];
          const currentVersion = installVersion[section.id];
          const fallback = versions[0] || "";
          const nextVersion =
            currentVersion && versions.includes(currentVersion) ? currentVersion : fallback;
          if (installVersion[section.id] !== nextVersion) {
            installVersion[section.id] = nextVersion;
            managerChanged = true;
          }
          const variantOptions = Array.isArray(section.variants) ? section.variants : [];
          const hasMultipleVariants = variantOptions.length > 1;
          const currentVariant = installVariant[section.id];
          const fallbackVariant = hasMultipleVariants
            ? section.defaultVariant || variantOptions[0]?.id || ""
            : "";
          const nextVariant =
            hasMultipleVariants &&
            currentVariant &&
            variantOptions.some(opt => opt.id === currentVariant)
              ? currentVariant
              : fallbackVariant;
          if (installVariant[section.id] !== nextVariant) {
            installVariant[section.id] = nextVariant;
            managerChanged = true;
          }
          const nextSort = installedSort[section.id] || "default";
          if (installedSort[section.id] !== nextSort) {
            installedSort[section.id] = nextSort;
            managerChanged = true;
          }
        }
        if (managerChanged) {
          next[manager.id] = {
            ...current,
            installVersion,
            installVariant,
            installedSort
          };
          didChange = true;
        }
      }
      return didChange ? next : prev;
    });
  }, [runtimesOpen, state?.runtimeManagers]);

  useEffect(() => {
    if (!api) return;
    if (!expandedGamePath) return;
    const entry = state?.recents?.find(g => g.gamePath === expandedGamePath);
    if (!entry || !entry.moduleSupports?.cheatsPatcher) {
      setCheatsPatchStatusByPath(prev => ({ ...prev, [expandedGamePath]: null }));
      return;
    }
    api
      .getCheatsPatchStatus(expandedGamePath)
      .then(status =>
        setCheatsPatchStatusByPath(prev => ({ ...prev, [expandedGamePath]: status }))
      )
      .catch(() => {});
  }, [api, expandedGamePath, state?.recents]);

  useEffect(() => {
    if (!api) return;
    if (!expandedGamePath) return;
    const entry = state?.recents?.find(g => g.gamePath === expandedGamePath);
    if (!entry) return;
    const moduleState = state?.moduleStates?.[entry.moduleId];
    if (!moduleState?.libs?.dependencies) {
      setLibsPatchStatusByPath(prev => ({ ...prev, [expandedGamePath]: null }));
      return;
    }
    api
      .getLibsPatchStatus(expandedGamePath)
      .then(status =>
        setLibsPatchStatusByPath(prev => ({ ...prev, [expandedGamePath]: status }))
      )
      .catch(() => {});
  }, [api, expandedGamePath, state?.recents, state?.moduleStates]);

  useEffect(() => {
    if (!api) return;
    if (!expandedGamePath) {
      autoRunActionKeyRef.current = { gamePath: null, key: null };
      return;
    }
    const entry = state?.recents?.find(g => g.gamePath === expandedGamePath);
    if (!entry) return;
    const moduleInfo = state?.modules?.find(mod => mod.id === entry.moduleId);
    const actions = moduleInfo?.ui?.actions?.filter(a => a.autoRun) || [];
    if (actions.length === 0) return;
    const actionKey = actions.map(action => action.id).join("|");
    const lastActionKey = autoRunActionKeyRef.current;
    // Avoid re-running auto-run actions on every state broadcast.
    if (lastActionKey.gamePath === expandedGamePath && lastActionKey.key === actionKey) return;
    autoRunActionKeyRef.current = { gamePath: expandedGamePath, key: actionKey };
    for (const action of actions) {
      api
        .moduleAction(entry.gamePath, action.id, {})
        .then(result => {
          setModuleActionResultsByPath(prev => ({
            ...prev,
            [entry.gamePath]: {
              ...(prev[entry.gamePath] || {}),
              [action.id]: result
            }
          }));
        })
        .catch(() => {});
    }
  }, [api, expandedGamePath, state?.modules, state?.recents]);

  const sorted = useMemo(() => state?.recents ?? [], [state]);
  const orderedGames = useMemo(() => {
    if (!dragOrderPaths || dragOrderPaths.length === 0) return sorted;
    const byPath = new Map(sorted.map(g => [g.gamePath, g]));
    const ordered: RecentGame[] = [];
    for (const gamePath of dragOrderPaths) {
      const entry = byPath.get(gamePath);
      if (!entry) continue;
      ordered.push(entry);
      byPath.delete(gamePath);
    }
    if (byPath.size > 0) {
      ordered.push(...Array.from(byPath.values()));
    }
    return ordered;
  }, [dragOrderPaths, sorted]);

  const gameTypeOptions = useMemo(() => {
    const options = (state?.modules || []).map(mod => ({
      id: mod.id,
      label: mod.shortLabel || mod.label || mod.id,
      title: mod.label || mod.shortLabel || mod.id
    }));
    options.sort((a, b) => a.label.localeCompare(b.label));
    return options;
  }, [state?.modules]);

  const activeGameTypeIds = useMemo(() => {
    const ids: string[] = [];
    for (const option of gameTypeOptions) {
      if (gameTypeFilter[option.id] !== false) ids.push(option.id);
    }
    return ids;
  }, [gameTypeOptions, gameTypeFilter]);

  const allGameTypesSelected =
    gameTypeOptions.length === 0 ||
    gameTypeOptions.every(option => gameTypeFilter[option.id] !== false);

  const visibleGames = useMemo(
    () =>
      filterGames(
        orderedGames,
        searchQuery,
        gameTypeOptions.length > 0 ? activeGameTypeIds : null
      ),
    [orderedGames, searchQuery, activeGameTypeIds, gameTypeOptions.length]
  );

  const isFiltering =
    Boolean(searchQuery.trim()) ||
    (gameTypeOptions.length > 0 && !allGameTypesSelected);

  useEffect(() => {
    if (isFiltering) clearReorderState();
  }, [isFiltering]);

  useEffect(() => {
    if (gameTypeOptions.length === 0 && gameTypesOpen) {
      setGameTypesOpen(false);
    }
  }, [gameTypeOptions.length, gameTypesOpen]);

  const modulesById = useMemo(() => {
    const out = new Map<string, ModuleManifest>();
    for (const mod of state?.modules || []) out.set(mod.id, mod);
    return out;
  }, [state?.modules]);

  const acknowledgments = useMemo(() => {
    const out: Array<{ label: string; url: string }> = [];
    for (const mod of state?.modules || []) {
      for (const item of mod.acknowledgments || []) {
        if (!item?.url) continue;
        out.push({ label: item.label || item.url, url: item.url });
      }
    }
    return out;
  }, [state?.modules]);

  const runtimeManagers = useMemo(
    () => Object.values(state?.runtimeManagers || {}),
    [state?.runtimeManagers]
  );

  const activeRuntimeManager =
    (runtimeManagerId && state?.runtimeManagers?.[runtimeManagerId]) ||
    runtimeManagers[0] ||
    null;
  const activeRuntimeSections = resolveRuntimeSections(activeRuntimeManager);
  const activeRuntimeSection =
    resolveRuntimeSection(activeRuntimeManager, runtimeSectionId) ||
    activeRuntimeSections[0] ||
    null;
  const runtimeNotice = resolveRuntimeNotice(activeRuntimeSection);
  const activeRuntimeSectionId = activeRuntimeSection?.id || null;
  const activeRuntimeUi = activeRuntimeManager
    ? runtimeUi[activeRuntimeManager.id] || {
        remoteOpen: {},
        installVersion: {},
        installVariant: {},
        installedSort: {},
        busy: false,
        error: null
      }
    : {
        remoteOpen: {},
        installVersion: {},
        installVariant: {},
        installedSort: {},
        busy: false,
        error: null
      };

  useEffect(() => {
    if (!activeRuntimeManager) return;
    if (!activeRuntimeSectionId) return;
    if (runtimeSectionId === activeRuntimeSectionId) return;
    setRuntimeSectionId(activeRuntimeSectionId);
  }, [activeRuntimeManager, activeRuntimeSectionId, runtimeSectionId]);

  async function onOpenDialog() {
    if (!api) return;
    setError(null);
    try {
      const paths = await api.openGameDialog();
      for (const p of paths) await api.addRecent(p);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  function openRuntimesManager(managerId?: string) {
    const managers = Object.values(state?.runtimeManagers || {});
    const nextId = managerId || managers[0]?.id || null;
    const nextSection =
      nextId && state?.runtimeManagers?.[nextId]
        ? resolveRuntimeSection(state.runtimeManagers[nextId], null)?.id || null
        : null;
    setRuntimeManagerId(nextId);
    setRuntimeSectionId(nextSection);
    setRuntimesOpen(true);
  }

  function closeRuntimesManager() {
    setRuntimesOpen(false);
  }

  function openSettings() {
    setSettingsOpen(true);
  }

  function closeSettings() {
    setSettingsOpen(false);
  }

  function openAcknowledgments() {
    setAcknowledgmentsOpen(true);
  }

  function closeAcknowledgments() {
    setAcknowledgmentsOpen(false);
  }

  function onOpenAcknowledgmentsLink(url: string) {
    if (!api || typeof api.openExternal !== "function") return;
    api.openExternal(url).catch(() => {});
  }

  async function onSetRuntime(gamePath: string, runtime: RuntimeId) {
    if (!api) return;
    setError(null);
    try {
      await api.setGameRuntime(gamePath, runtime);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onOpenRuntimeSettings(payload: RuntimeSettingsContext) {
    if (!api) return;
    setError(null);
    try {
      await api.openRuntimeSettings(payload);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onSetModuleSettings(moduleId: string, patch: Record<string, any>) {
    if (!api) return;
    setError(null);
    try {
      await api.setModuleSettings(moduleId, patch);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onSetLauncherSettings(patch: Record<string, any>) {
    if (!api) return;
    setError(null);
    try {
      await api.setLauncherSettings(patch);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onSetRuntimeData(
    gamePath: string,
    runtimeId: RuntimeId,
    patch: Record<string, any> | null
  ) {
    if (!api) return;
    setError(null);
    try {
      await api.setGameRuntimeData(gamePath, runtimeId, patch);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onSetGameLibVersion(
    gamePath: string,
    depId: string,
    value: string
  ) {
    if (!api) return;
    setError(null);
    try {
      const next = String(value || "").trim();
      await api.setGameLibVersion(gamePath, depId, next ? next : null);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function refreshCheatsPatchStatus(gamePath: string) {
    if (!api) return;
    const entry = state?.recents?.find(g => g.gamePath === gamePath);
    if (!entry || !entry.moduleSupports?.cheatsPatcher) {
      setCheatsPatchStatusByPath(prev => ({ ...prev, [gamePath]: null }));
      return;
    }
    try {
      const status = await api.getCheatsPatchStatus(gamePath);
      setCheatsPatchStatusByPath(prev => ({ ...prev, [gamePath]: status }));
    } catch {}
  }

  async function refreshLibsPatchStatus(gamePath: string) {
    if (!api) return;
    const entry = state?.recents?.find(g => g.gamePath === gamePath);
    if (!entry) return;
    try {
      const status = await api.getLibsPatchStatus(gamePath);
      setLibsPatchStatusByPath(prev => ({ ...prev, [gamePath]: status }));
    } catch {}
  }

  async function onPatchLibs(gamePath: string) {
    if (!api) return;
    setError(null);
    const entry = state?.recents?.find(g => g.gamePath === gamePath);
    const moduleState = entry ? state?.moduleStates?.[entry.moduleId] : null;
    const deps = moduleState?.libs?.dependencies || [];
    if (!entry || deps.length === 0) {
      setError("Library patching is not available for this game.");
      return;
    }
    const hasVersions = deps.some(dep => dep.versions.length > 0);
    if (!hasVersions) {
      setError("No managed library versions are available yet.");
      return;
    }

    const warnings = libsPatchStatusByPath[gamePath]?.warnings || [];
    const warningText = warnings.length
      ? ["", "Warnings:", ...warnings.map(w => `- ${w}`)].join("\n")
      : "";

    const ok = window.confirm(
      [
        "Patch this game’s libraries?",
        "",
        "MacLauncher will back up the original files next to the originals and apply the selected bundles.",
        "Use Unpatch to restore the backups.",
        warningText
      ]
        .filter(Boolean)
        .join("\n")
    );
    if (!ok) return;

    setLibsPatchBusyPath(gamePath);
    try {
      const status = await api.patchLibs(gamePath);
      setLibsPatchStatusByPath(prev => ({ ...prev, [gamePath]: status }));
    } catch (e: any) {
      setError(String(e?.message || e));
      await refreshLibsPatchStatus(gamePath);
    } finally {
      setLibsPatchBusyPath(null);
    }
  }

  async function onUnpatchLibs(gamePath: string) {
    if (!api) return;
    setError(null);
    const entry = state?.recents?.find(g => g.gamePath === gamePath);
    const moduleState = entry ? state?.moduleStates?.[entry.moduleId] : null;
    if (!entry || !moduleState?.libs?.dependencies) {
      setError("Library patching is not available for this game.");
      return;
    }
    const ok = window.confirm(
      [
        "Unpatch library files from this game?",
        "",
        "MacLauncher will restore .maclauncher-old backups and remove any files that were added."
      ].join("\n")
    );
    if (!ok) return;

    setLibsPatchBusyPath(gamePath);
    try {
      const status = await api.unpatchLibs(gamePath);
      setLibsPatchStatusByPath(prev => ({ ...prev, [gamePath]: status }));
    } catch (e: any) {
      setError(String(e?.message || e));
      await refreshLibsPatchStatus(gamePath);
    } finally {
      setLibsPatchBusyPath(null);
    }
  }

  async function onPatchCheatsIntoGame(gamePath: string) {
    if (!api) return;
    setError(null);
    const entry = state?.recents?.find(g => g.gamePath === gamePath);
    if (!entry || !entry.moduleSupports?.cheatsPatcher) {
      setError("Tools patching is not available for this game type.");
      return;
    }
    const ok = window.confirm(
      [
        "Patch this game’s files to load Tools?",
        "",
        "This will modify the game’s main.js and add files under js/plugins/.",
        "You can undo it later with Unpatch."
      ].join("\n")
    );
    if (!ok) return;

    setCheatsPatchBusyPath(gamePath);
    try {
      const status = await api.patchCheatsIntoGame(gamePath);
      setCheatsPatchStatusByPath(prev => ({ ...prev, [gamePath]: status }));
    } catch (e: any) {
      setError(String(e?.message || e));
      await refreshCheatsPatchStatus(gamePath);
    } finally {
      setCheatsPatchBusyPath(null);
    }
  }

  async function onUnpatchCheatsFromGame(gamePath: string) {
    if (!api) return;
    setError(null);
    const entry = state?.recents?.find(g => g.gamePath === gamePath);
    if (!entry || !entry.moduleSupports?.cheatsPatcher) {
      setError("Tools patching is not available for this game type.");
      return;
    }
    const ok = window.confirm(
      [
        "Unpatch Tools from this game’s files?",
        "",
        "This will remove the MacLauncher Tools line from main.js and delete the files MacLauncher added under js/plugins/."
      ].join("\n")
    );
    if (!ok) return;

    setCheatsPatchBusyPath(gamePath);
    try {
      const status = await api.unpatchCheatsFromGame(gamePath);
      setCheatsPatchStatusByPath(prev => ({ ...prev, [gamePath]: status }));
    } catch (e: any) {
      setError(String(e?.message || e));
      await refreshCheatsPatchStatus(gamePath);
    } finally {
      setCheatsPatchBusyPath(null);
    }
  }

  function updateRuntimeUiState(
    managerId: string,
    patch: Partial<{
      remoteOpen: Record<string, boolean>;
      installVersion: Record<string, string>;
      installVariant: Record<string, string>;
      installedSort: Record<string, "default" | "newest" | "oldest" | "path">;
      busy: boolean;
      error: string | null;
    }>
  ) {
    setRuntimeUi(prev => {
      const current = prev[managerId] || {
        remoteOpen: {},
        installVersion: {},
        installVariant: {},
        installedSort: {},
        busy: false,
        error: null
      };
      return {
        ...prev,
        [managerId]: { ...current, ...patch }
      };
    });
  }

  function updateRuntimeUiSection(
    managerId: string,
    sectionId: string,
    key: "remoteOpen" | "installVersion" | "installVariant" | "installedSort",
    value: any
  ) {
    setRuntimeUi(prev => {
      const current = prev[managerId] || {
        remoteOpen: {},
        installVersion: {},
        installVariant: {},
        installedSort: {},
        busy: false,
        error: null
      };
      return {
        ...prev,
        [managerId]: {
          ...current,
          [key]: { ...current[key], [sectionId]: value }
        }
      };
    });
  }

  async function onRuntimeAction(
    managerId: string,
    action: string,
    payload: Record<string, any>
  ) {
    if (!api) return;
    updateRuntimeUiState(managerId, { busy: true, error: null });
    try {
      await api.runtimeAction(managerId, action, payload);
    } catch (e: any) {
      updateRuntimeUiState(managerId, { error: String(e?.message || e) });
    } finally {
      updateRuntimeUiState(managerId, { busy: false });
    }
  }

  async function onRuntimeRefresh(
    managerId: string,
    sectionId: string,
    options: { latestOnly?: boolean } = {}
  ) {
    const payload: Record<string, any> = { sectionId };
    if (typeof options.latestOnly === "boolean") {
      payload.latestOnly = options.latestOnly;
    }
    return onRuntimeAction(managerId, "refreshCatalog", payload);
  }

  async function onRuntimeInstall(
    managerId: string,
    sectionId: string,
    version: string,
    variant?: string
  ) {
    return onRuntimeAction(managerId, "install", { sectionId, version, variant });
  }

  async function onRuntimeSetDefault(
    managerId: string,
    sectionId: string,
    version: string | null,
    variant?: string
  ) {
    return onRuntimeAction(managerId, "setDefault", { sectionId, version, variant });
  }

  async function onRuntimeUninstall(
    managerId: string,
    sectionId: string,
    install: Record<string, any>
  ) {
    if (!api) return;
    const label = install?.version ? `v${install.version}` : "this runtime";
    const ok = window.confirm(`Uninstall ${label}?`);
    if (!ok) return;
    return onRuntimeAction(managerId, "uninstall", {
      sectionId,
      version: install.version,
      variant: install.variant,
      platformKey: install.platformKey,
      installDir: install.installDir
    });
  }

  async function onModuleAction(
    gamePath: string,
    actionId: string,
    actionMeta?: ModuleUiAction
  ) {
    if (!api) return;
    const confirmText = actionMeta?.confirm;
    if (confirmText && !window.confirm(confirmText)) return;
    setModuleActionBusyByPath(prev => ({
      ...prev,
      [gamePath]: { ...(prev[gamePath] || {}), [actionId]: true }
    }));
    setModuleActionErrorByPath(prev => ({ ...prev, [gamePath]: null }));
    try {
      const result = await api.moduleAction(gamePath, actionId, {});
      setModuleActionResultsByPath(prev => ({
        ...prev,
        [gamePath]: { ...(prev[gamePath] || {}), [actionId]: result }
      }));
    } catch (e: any) {
      setModuleActionErrorByPath(prev => ({
        ...prev,
        [gamePath]: String(e?.message || e)
      }));
    } finally {
      setModuleActionBusyByPath(prev => ({
        ...prev,
        [gamePath]: { ...(prev[gamePath] || {}), [actionId]: false }
      }));
    }
  }

  function isInternalGameDrag(ev: React.DragEvent) {
    return Array.from(ev.dataTransfer.types || []).includes(INTERNAL_GAME_DRAG_TYPE);
  }

  function onAppDragEnter(ev: React.DragEvent) {
    if (isInternalGameDrag(ev)) return;
    addDropDepth.current += 1;
    setAddDropActive(true);
  }

  function onAppDragLeave(ev: React.DragEvent) {
    if (isInternalGameDrag(ev)) return;
    addDropDepth.current = Math.max(0, addDropDepth.current - 1);
    if (addDropDepth.current === 0) setAddDropActive(false);
  }

  function onAppDragOver(ev: React.DragEvent) {
    if (isInternalGameDrag(ev)) return;
    ev.preventDefault();
  }

  async function onDropAdd(ev: React.DragEvent) {
    ev.preventDefault();
    if (isInternalGameDrag(ev)) return;
    if (!api) return;
    const launcherApi = api;
    addDropDepth.current = 0;
    setAddDropActive(false);
    setError(null);
    try {
      const paths = new Set<string>();

      async function addFilePath(f: any) {
        if (!f) return;
        if (typeof f?.path === "string" && f.path) {
          paths.add(f.path);
          return;
        }
        if (typeof launcherApi.getPathForFile === "function") {
          const maybe = launcherApi.getPathForFile(f);
          const p = await Promise.resolve(maybe as any);
          if (typeof p === "string" && p) paths.add(p);
        }
      }

      const files = Array.from(ev.dataTransfer.files || []);
      for (const f of files as any[]) {
        await addFilePath(f);
      }

      const items = Array.from(ev.dataTransfer.items || []);
      for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile() as any;
        await addFilePath(file);
      }

      function addFileUrl(url: string) {
        try {
          const u = new URL(url);
          if (u.protocol !== "file:") return;
          let p = decodeURIComponent(u.pathname);
          p = p.replace(/^\/([a-zA-Z]:\/)/, "$1");
          if (p) paths.add(p);
        } catch {}
      }

      const uriList = ev.dataTransfer.getData("text/uri-list");
      if (uriList) {
        for (const line of uriList.split(/\r?\n/g)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          if (trimmed.startsWith("file:")) addFileUrl(trimmed);
        }
      }

      const text = ev.dataTransfer.getData("text/plain");
      if (text && text.trim().startsWith("file:")) addFileUrl(text.trim());

      for (const p of paths) await api.addRecent(p);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  function toggleGameTypeFilter(typeId: string) {
    setGameTypeFilter(prev => {
      const current = prev[typeId] !== false;
      return { ...prev, [typeId]: !current };
    });
  }

  function toggleGameTypesOpen() {
    setGameTypesOpen(prev => !prev);
  }

  function clearGameFilters() {
    setSearchQuery("");
    setGameTypeFilter({});
  }

  function toggleExpanded(gamePath: string) {
    setExpandedGamePath(prev => (prev === gamePath ? null : gamePath));
  }

  function clearReorderState() {
    setDraggingGamePath(null);
    setDragOrderPaths(null);
  }

  function onGameDragStart(ev: React.DragEvent, gamePath: string) {
    if (isFiltering) {
      ev.preventDefault();
      return;
    }
    setDraggingGamePath(gamePath);
    setDragOrderPaths(sorted.map(g => g.gamePath));
    try {
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData(INTERNAL_GAME_DRAG_TYPE, gamePath);
      ev.dataTransfer.setData("text/plain", gamePath);
    } catch {}
  }

  function computeDropIndex(ev: React.DragEvent) {
    const listEl = listRef.current;
    if (!listEl) return null;
    const items = Array.from(listEl.querySelectorAll<HTMLElement>(".gameItem"));
    if (items.length === 0) return 0;
    const y = ev.clientY;
    for (let i = 0; i < items.length; i++) {
      const row = items[i].querySelector<HTMLElement>(".gameRow");
      const rect = (row || items[i]).getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      if (y < midpoint) return i;
    }
    return items.length;
  }

  function onGameListDragOver(ev: React.DragEvent) {
    if (isFiltering) return;
    if (!isInternalGameDrag(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const idx = computeDropIndex(ev);
    if (idx == null) return;
    if (!draggingGamePath) return;
    setDragOrderPaths(prev => {
      const order = prev ? prev.slice() : sorted.map(g => g.gamePath);
      const fromIndex = order.indexOf(draggingGamePath);
      if (fromIndex < 0) return prev;
      let toIndex = Math.max(0, Math.min(order.length, idx));
      if (fromIndex < toIndex) toIndex -= 1;
      if (toIndex === fromIndex) return prev;
      order.splice(fromIndex, 1);
      order.splice(toIndex, 0, draggingGamePath);
      return order;
    });
  }

  function onGameListDragLeave(ev: React.DragEvent) {
    if (isFiltering) return;
    if (!isInternalGameDrag(ev)) return;
    const listEl = listRef.current;
    if (!listEl) return;
    const next = ev.relatedTarget as Node | null;
    if (next && listEl.contains(next)) return;
    setDragOrderPaths(null);
  }

  async function onGameListDrop(ev: React.DragEvent) {
    if (isFiltering) return;
    if (!api) return;
    if (!isInternalGameDrag(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();

    const draggedPath =
      ev.dataTransfer.getData(INTERNAL_GAME_DRAG_TYPE) || draggingGamePath;
    if (!draggedPath) return;

    const fromIndex = sorted.findIndex(g => g.gamePath === draggedPath);
    if (fromIndex < 0) return;

    const order = dragOrderPaths ?? sorted.map(g => g.gamePath);
    const toIndex = order.indexOf(draggedPath);
    if (toIndex < 0) return;

    clearReorderState();
    if (fromIndex === toIndex) return;
    setError(null);
    try {
      await api.reorderGame(draggedPath, toIndex);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onPlay(gamePath: string) {
    if (!api) return;
    setError(null);
    try {
      const entry = state?.recents?.find(g => g.gamePath === gamePath);
      if (entry) {
        const moduleInfo = modulesById.get(entry.moduleId);
        const preLaunch = moduleInfo?.runtime?.preLaunch?.[entry.runtimeId];
        if (preLaunch?.statusAction) {
          let status: any = null;
          try {
            status = await api.moduleAction(entry.gamePath, preLaunch.statusAction, {});
          } catch {}
          const readyConditions = preLaunch.readyWhen
            ? Array.isArray(preLaunch.readyWhen)
              ? preLaunch.readyWhen
              : [preLaunch.readyWhen]
            : null;
          const isReady = readyConditions
            ? readyConditions.every(cond => matchesConditionOnTarget(status, cond))
            : Boolean(status);

          if (!isReady) {
            const prompt =
              preLaunch.prompt ||
              "This runtime needs preparation before launch. Run setup now?";
            const ok = window.confirm(prompt);
            if (!ok) {
              if (preLaunch.declineAction) {
                try {
                  await api.moduleAction(entry.gamePath, preLaunch.declineAction, { status });
                } catch {}
              }
              return;
            }

            if (preLaunch.fixAction) {
              await api.moduleAction(entry.gamePath, preLaunch.fixAction, {});
              if (preLaunch.statusAction) {
                const updated = await api.moduleAction(entry.gamePath, preLaunch.statusAction, {});
                const readyNow = readyConditions
                  ? readyConditions.every(cond => matchesConditionOnTarget(updated, cond))
                  : Boolean(updated);
                if (!readyNow) {
                  setError("Runtime preparation did not complete.");
                  return;
                }
              }
            }
          }
        }
      }
      await api.launchGame(gamePath);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onCreateCommand(gamePath: string) {
    if (!api) return;
    setError(null);
    try {
      const savedPath = await api.createGameCommand(gamePath);
      if (savedPath) {
        window.alert(`Shortcut saved:\n${savedPath}`);
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onStop(gamePath: string) {
    if (!api) return;
    setError(null);
    try {
      await api.stopGame(gamePath);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onForgetGame(gamePath: string) {
    if (!api) return;
    const ok = window.confirm("Remove this game from the launcher list? Files stay on disk.");
    if (!ok) return;
    setError(null);
    try {
      await api.forgetGame(gamePath);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function refreshCheatAddonStatus(
    gamePath: string,
    statusActionId: string | null
  ) {
    if (!api || !statusActionId) return;
    setCheatError(null);
    setCheatAddonBusy(true);
    try {
      const status = await api.moduleAction(gamePath, statusActionId, {});
      setCheatAddonStatusByPath(prev => ({
        ...prev,
        [gamePath]: status
      }));
    } catch (e: any) {
      setCheatError(String(e?.message || e));
    } finally {
      setCheatAddonBusy(false);
    }
  }

  async function onCheatAddonAction(
    gamePath: string,
    actionId: string,
    actionMeta?: ModuleUiAction
  ) {
    if (!api) return;
    const confirmText = actionMeta?.confirm;
    if (confirmText && !window.confirm(confirmText)) return;
    setCheatError(null);
    setCheatAddonBusy(true);
    try {
      const result = await api.moduleAction(gamePath, actionId, {});
      if (result && typeof result === "object") {
        setCheatAddonStatusByPath(prev => ({
          ...prev,
          [gamePath]: result
        }));
      } else if (cheatAddonStatusAction) {
        await refreshCheatAddonStatus(gamePath, cheatAddonStatusAction);
      }
    } catch (e: any) {
      setCheatError(String(e?.message || e));
    } finally {
      setCheatAddonBusy(false);
    }
  }

  function openCheats(g: RecentGame) {
    if (!g.moduleSupports?.cheats) {
      setError("Cheats are not available for this game type.");
      return;
    }
    const moduleState = state?.moduleStates?.[g.moduleId];
    const schema = moduleState?.cheats?.schema as CheatsSchema | undefined;
    if (!schema) {
      setError("Cheat schema is not available for this game type.");
      return;
    }
    setCheatError(null);
    setCheatBusy(false);
    setCheatAddonBusy(false);
    setCheatGame(g);
    setCheatSchema(schema);
    setCheatDraft({ ...(g.cheats || schema.defaults || {}) });
    const moduleInfo = modulesById.get(g.moduleId);
    const supportsToolsButton = Boolean(
      moduleInfo?.settingsDefaults &&
        Object.prototype.hasOwnProperty.call(moduleInfo.settingsDefaults, "toolsButtonVisible")
    );
    const override = g.moduleData?.toolsButtonVisibleOverride;
    setToolsButtonOverride(
      supportsToolsButton && typeof override === "boolean" ? override : null
    );
    if (moduleInfo?.ui?.cheatsStatusAction && Array.isArray(moduleInfo?.ui?.cheatsPatches)) {
      void refreshCheatAddonStatus(g.gamePath, moduleInfo.ui.cheatsStatusAction);
    }
  }

  function closeCheats() {
    setCheatGame(null);
    setCheatSchema(null);
    setCheatDraft(null);
    setToolsButtonOverride(null);
    setCheatBusy(false);
    setCheatError(null);
    setCheatAddonBusy(false);
  }

  async function onSaveCheats() {
    if (!api || !cheatGame || !cheatDraft) return;
    setCheatError(null);
    setCheatBusy(true);
    try {
      await api.setCheats(cheatGame.gamePath, cheatDraft);
      const moduleInfo = modulesById.get(cheatGame.moduleId);
      const supportsToolsButton = Boolean(
        moduleInfo?.settingsDefaults &&
          Object.prototype.hasOwnProperty.call(moduleInfo.settingsDefaults, "toolsButtonVisible")
      );
      const currentOverride =
        typeof cheatGame.moduleData?.toolsButtonVisibleOverride === "boolean"
          ? cheatGame.moduleData.toolsButtonVisibleOverride
          : null;
      if (supportsToolsButton && toolsButtonOverride !== currentOverride) {
        await api.setGameModuleData(cheatGame.gamePath, {
          toolsButtonVisibleOverride: toolsButtonOverride
        });
      }
      closeCheats();
    } catch (e: any) {
      setCheatError(String(e?.message || e));
    } finally {
      setCheatBusy(false);
    }
  }

  async function onPickSaveDir(gamePath: string) {
    if (!api) return;
    setError(null);
    try {
      await api.pickSaveDir(gamePath);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onResetSaveDir(gamePath: string) {
    if (!api) return;
    setError(null);
    try {
      await api.resetSaveDir(gamePath);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onReveal(targetPath: string) {
    if (!api) return;
    try {
      await api.revealInFinder(targetPath);
    } catch {}
  }

  async function refreshSaveFiles(gamePath: string) {
    if (!api) return;
    const files = await api.listSaveFiles(gamePath);
    setSaveFiles(files);
  }

  async function onOpenSaveTools(g: RecentGame) {
    if (!api) return;
    if (g.moduleSupports && !g.moduleSupports.saveEditing) {
      setError("Save tools are not available for this game type.");
      return;
    }
    setSaveError(null);
    setSaveBusy(true);
    setSaveGame(g);
    setEditingFile(null);
    setEditingJson("");
    try {
      const info = await api.getSaveInfo(g.gamePath);
      setSaveInfo(info);
      await refreshSaveFiles(g.gamePath);
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  function closeSaveTools() {
    setSaveGame(null);
    setSaveInfo(null);
    setSaveFiles([]);
    setSaveBusy(false);
    setSaveError(null);
    setEditingFile(null);
    setEditingJson("");
  }

  async function onImportSaveDir() {
    if (!api || !saveGame) return;
    setSaveError(null);
    setSaveBusy(true);
    try {
      const ok = await api.importSaveDir(saveGame.gamePath);
      if (ok) await refreshSaveFiles(saveGame.gamePath);
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function onExportSaveDir() {
    if (!api || !saveGame) return;
    setSaveError(null);
    setSaveBusy(true);
    try {
      const out = await api.exportSaveDir(saveGame.gamePath);
      if (out) await onReveal(out);
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function onImportSaveFiles() {
    if (!api || !saveGame) return;
    setSaveError(null);
    setSaveBusy(true);
    try {
      const ok = await api.importSaveFiles(saveGame.gamePath);
      if (ok) await refreshSaveFiles(saveGame.gamePath);
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function onEditSaveFile(f: SaveFileInfo) {
    if (!api || !saveGame) return;
    setSaveError(null);
    setSaveBusy(true);
    try {
      const json = await api.readSaveJson(saveGame.gamePath, f.name);
      setEditingFile(f);
      setEditingJson(json);
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function onSaveEditedJson() {
    if (!api || !saveGame || !editingFile) return;
    setSaveError(null);
    setSaveBusy(true);
    try {
      await api.writeSaveJson(saveGame.gamePath, editingFile.name, editingJson);
      await refreshSaveFiles(saveGame.gamePath);
      setEditingFile(null);
      setEditingJson("");
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function onOpenEditedJsonExternal() {
    if (!api || !saveGame || !editingFile) return;
    setSaveError(null);
    setSaveBusy(true);
    try {
      await api.openSaveJsonInExternalEditor(
        saveGame.gamePath,
        editingFile.name,
        editingJson
      );
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function onReloadEditedJsonExternal() {
    if (!api || !saveGame || !editingFile) return;
    setSaveError(null);
    setSaveBusy(true);
    try {
      const next = await api.readExternalSaveJson(saveGame.gamePath, editingFile.name);
      setEditingJson(next);
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  function onFormatJson() {
    try {
      setEditingJson(JSON.stringify(JSON.parse(editingJson), null, 2));
    } catch {}
  }


  const cheatFields = useMemo(
    () => (cheatSchema?.fields || []) as CheatsField[],
    [cheatSchema]
  );
  const cheatNumbers = useMemo(
    () => cheatFields.filter(field => field.type === "number"),
    [cheatFields]
  );
  const cheatToggles = useMemo(
    () => cheatFields.filter(field => field.type === "boolean" && field.key !== "enabled"),
    [cheatFields]
  );
  const cheatDefaults = cheatSchema?.defaults || {};

  const cheatModuleInfo = cheatGame ? modulesById.get(cheatGame.moduleId) : null;
  const cheatModuleSettings = cheatGame
    ? state?.moduleSettings?.[cheatGame.moduleId]
    : null;
  const cheatModuleUi = cheatModuleInfo?.ui || null;
  const cheatMode = cheatModuleUi?.cheatsMode === "patches" ? "patches" : "default";
  const showCheatFields = cheatMode !== "patches";
  const cheatAddonPatches = Array.isArray(cheatModuleUi?.cheatsPatches)
    ? cheatModuleUi?.cheatsPatches
    : [];
  const cheatAddonStatusAction =
    typeof cheatModuleUi?.cheatsStatusAction === "string"
      ? cheatModuleUi.cheatsStatusAction
      : null;
  const cheatAddonStatus =
    cheatGame && cheatAddonStatusByPath[cheatGame.gamePath]
      ? cheatAddonStatusByPath[cheatGame.gamePath]
      : null;
  const cheatModuleActionsById = useMemo(() => {
    const actions = cheatModuleInfo?.ui?.actions || [];
    return new Map(actions.map(action => [action.id, action]));
  }, [cheatModuleInfo]);
  const toolsButtonSettingAvailable = Boolean(
    cheatModuleInfo?.settingsDefaults &&
      Object.prototype.hasOwnProperty.call(cheatModuleInfo.settingsDefaults, "toolsButtonVisible")
  );
  const toolsButtonVisible = toolsButtonSettingAvailable
    ? cheatModuleSettings?.toolsButtonVisible !== false
    : true;
  const toolsButtonUsesDefault = toolsButtonOverride == null;
  const toolsButtonEffective =
    toolsButtonOverride == null ? toolsButtonVisible : toolsButtonOverride;
  const canOpenExternal = Boolean(api?.openExternal);
  const showIcons = state?.launcherSettings?.showIcons !== false;
  const showNonDefaultTags = state?.launcherSettings?.showNonDefaultTags !== false;

  const activeRuntimeRemoteOpen =
    activeRuntimeManager && activeRuntimeSectionId
      ? Boolean(activeRuntimeUi.remoteOpen[activeRuntimeSectionId])
      : false;
  const activeRuntimeInstallVersion =
    activeRuntimeManager && activeRuntimeSectionId
      ? activeRuntimeUi.installVersion[activeRuntimeSectionId] || ""
      : "";
  const activeRuntimeInstallVariant =
    activeRuntimeManager && activeRuntimeSectionId
      ? activeRuntimeUi.installVariant[activeRuntimeSectionId] || ""
      : "";
  const activeRuntimeInstalledSort =
    activeRuntimeManager && activeRuntimeSectionId
      ? activeRuntimeUi.installedSort[activeRuntimeSectionId] || "default"
      : "default";
  const activeRuntimeSupportsLatestOnly = Boolean(
    activeRuntimeSection?.catalog?.supportsLatestOnly
  );
  const activeRuntimeRefreshLabel =
    activeRuntimeSection?.catalog?.status === "loading"
      ? activeRuntimeSupportsLatestOnly
        ? "Refreshing latest version"
        : "Refreshing remote versions"
      : activeRuntimeSupportsLatestOnly
        ? "Refresh latest version"
        : "Refresh remote versions";
  const activeRuntimeRefreshAllLabel =
    activeRuntimeSection?.catalog?.status === "loading"
      ? "Refreshing all remote versions"
      : "Load all remote versions";
  const activeRuntimeInstalled = Array.isArray(activeRuntimeSection?.installed)
    ? activeRuntimeSection.installed
    : [];
  const activeRuntimeVariants = Array.isArray(activeRuntimeSection?.variants)
    ? activeRuntimeSection.variants
    : [];
  const activeRuntimeHasVariants = activeRuntimeVariants.length > 0;
  const activeRuntimeHasMultipleVariants = activeRuntimeVariants.length > 1;
  const activeRuntimeResolvedInstallVariant = activeRuntimeHasVariants
    ? activeRuntimeInstallVariant ||
      activeRuntimeSection?.defaultVariant ||
      activeRuntimeVariants[0]?.id ||
      ""
    : "";
  const activeRuntimeInstalledSorted = sortInstalled(
    activeRuntimeInstalled,
    activeRuntimeInstalledSort,
    activeRuntimeSection?.defaultVersion || null,
    activeRuntimeHasVariants ? activeRuntimeSection?.defaultVariant || null : null
  );
  const activeRuntimeSelectedInstalled = isRuntimeVersionInstalled(
    activeRuntimeInstalled,
    activeRuntimeInstallVersion,
    activeRuntimeResolvedInstallVariant,
    activeRuntimeHasVariants
  );
  const activeRuntimeInstalling =
    activeRuntimeSection?.installing?.status === "downloading";
  const activeRuntimeDefaultVariantLabel = activeRuntimeHasMultipleVariants
    ? activeRuntimeVariants.find(
        (variant: any) => variant.id === activeRuntimeSection?.defaultVariant
      )?.label || activeRuntimeSection?.defaultVariant || ""
    : "";
  const activeRuntimeSubtitleParts = [];
  if (activeRuntimeSections.length > 1 && activeRuntimeSection?.label) {
    activeRuntimeSubtitleParts.push(activeRuntimeSection.label);
  }
  if (activeRuntimeSection?.defaultVersion) {
    activeRuntimeSubtitleParts.push(
      `Default ${formatRuntimeVersionTag(
        activeRuntimeSection.defaultVersion,
        activeRuntimeSection
      )}`
    );
  } else {
    activeRuntimeSubtitleParts.push("Default version not set");
  }
  if (activeRuntimeDefaultVariantLabel) {
    activeRuntimeSubtitleParts.push(activeRuntimeDefaultVariantLabel);
  }
  activeRuntimeSubtitleParts.push(`${activeRuntimeInstalled.length} installed`);
  const activeRuntimeSubtitle = activeRuntimeSubtitleParts.join(" · ");
  const totalGameCount = sorted.length;
  const filteredGameCount = visibleGames.length;
  const hasGameTypes = gameTypeOptions.length > 0;
  const gameTypesToggleLabel = gameTypesOpen ? "Hide game types" : "Show game types";
  const gameListSubtitle = isFiltering
    ? "Search to filter · Click a game for details"
    : "Drag to reorder · Click a game for details";

  if (runtimeSettingsContext) {
    return (
      <RuntimeSettingsWindow
        api={api}
        state={state}
        context={runtimeSettingsContext}
        error={error}
      />
    );
  }

  return (
    <div
      className="app"
      onDragEnter={onAppDragEnter}
      onDragLeave={onAppDragLeave}
      onDragOver={onAppDragOver}
      onDrop={onDropAdd}
    >
      {addDropActive && (
        <div className="dropOverlay">
          Drop a game folder / <span className="mono">Game.app</span> /{" "}
          <span className="mono">Game.exe</span> to add
        </div>
      )}
      <header className="header">
        <div className="headerLeft">
          <div className="title">macOS Game Launcher</div>
        </div>
        <div className="headerActions">
          {state && (
            <>
              <span className="chip">
                {state.debug ? "Debug enabled" : "Debug disabled"}
              </span>
              <button
                className="btn iconOnly"
                onClick={openSettings}
                title="Settings"
                aria-label="Settings"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path
                    fill="currentColor"
                    d="M19.14 12.94a7.3 7.3 0 0 0 .06-.94 7.3 7.3 0 0 0-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.2 7.2 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.2 7.2 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.3 7.3 0 0 0-.06.94c0 .32.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.4 1.04.72 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.22 1.12-.54 1.62-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
                  />
                </svg>
              </button>
              <button className="btn" onClick={() => openRuntimesManager()}>
                Runtimes
              </button>
              <button className="btn" onClick={() => onReveal(state.logPath)}>
                Logs
              </button>
              <button className="btn" onClick={openAcknowledgments}>
                Acknowledgments
              </button>
            </>
          )}
          <button className="btn primary" onClick={onOpenDialog}>
            Add game…
          </button>
        </div>
      </header>

      {error && <div className="error">Error: {error}</div>}

      <main className="content">
        <section className="card">
          <div className="cardHeader">
            <div>
              <div className="cardTitle">Games</div>
              <div className="cardSubtitle">{gameListSubtitle}</div>
            </div>
            <div className="cardHeaderRight">
              {isFiltering && totalGameCount > 0 ? (
                <>
                  <span className="chip">{filteredGameCount} shown</span>
                  <span className="chip">{totalGameCount} total</span>
                </>
              ) : (
                <span className="chip">{totalGameCount} total</span>
              )}
            </div>
          </div>
          <div className="gameSearch">
            <div className="gameSearchMain">
              <label className="gameSearchLabel" htmlFor="game-search-input">
                Search
              </label>
              <div className="gameSearchFieldWrap">
                <input
                  id="game-search-input"
                  className="input gameSearchField"
                  type="text"
                  placeholder="Search by title or path"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  aria-label="Search games"
                />
                <button
                  className="gameSearchToggleIcon"
                  type="button"
                  onClick={toggleGameTypesOpen}
                  disabled={!hasGameTypes}
                  title={gameTypesToggleLabel}
                  aria-label={gameTypesToggleLabel}
                  aria-expanded={gameTypesOpen}
                  aria-controls="game-types-dropdown"
                >
                  {gameTypesOpen ? (
                    <svg
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path
                        fill="currentColor"
                        d="M7 15l5-5 5 5H7z"
                      />
                    </svg>
                  ) : (
                    <svg
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path
                        fill="currentColor"
                        d="M7 9l5 5 5-5H7z"
                      />
                    </svg>
                  )}
                </button>
              </div>
            </div>
            {gameTypesOpen && (
              <div className="gameSearchDropdown" id="game-types-dropdown">
                <div className="gameSearchDropdownHeader">
                  <div className="gameSearchDropdownTitle">Game types</div>
                  <button
                    className="link"
                    type="button"
                    onClick={clearGameFilters}
                    disabled={!isFiltering}
                  >
                    Clear filters
                  </button>
                </div>
                <div className="gameSearchOptions">
                  {!hasGameTypes ? (
                    <span className="dim">None</span>
                  ) : (
                    gameTypeOptions.map(option => (
                      <label
                        className="gameTypeCheck"
                        key={option.id}
                        title={option.title}
                      >
                        <input
                          type="checkbox"
                          checked={gameTypeFilter[option.id] !== false}
                          onChange={() => toggleGameTypeFilter(option.id)}
                        />
                        <span>{option.label}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
          {totalGameCount === 0 ? (
            <div className="empty">
              Drop a game folder / <span className="mono">Game.app</span> /{" "}
              <span className="mono">Game.exe</span> /{" "}
              <span className="mono">Game.sh</span>, or click Add game...
            </div>
          ) : filteredGameCount === 0 ? (
            <div className="empty">No games match your search and filters.</div>
          ) : (
            <div
              className="gameList"
              ref={listRef}
              onDragOver={onGameListDragOver}
              onDragLeave={onGameListDragLeave}
              onDrop={onGameListDrop}
            >
              {visibleGames.map(g => {
                const expanded = expandedGamePath === g.gamePath;
                const dragging = draggingGamePath === g.gamePath;
                const dragDisabled = isFiltering;
                const moduleInfo = modulesById.get(g.moduleId) || null;
                const moduleState = state?.moduleStates?.[g.moduleId] || null;
                const moduleUi = moduleInfo?.ui || null;
                const moduleActionsById = new Map(
                  (moduleUi?.actions || []).map(action => [action.id, action])
                );
                const moduleActionGroups =
                  moduleUi?.actionGroups && moduleUi.actionGroups.length > 0
                    ? moduleUi.actionGroups
                    : (moduleUi?.actions || []).map(action => ({
                        id: action.id,
                        label: action.label,
                        actions: [action.id]
                      }));
                const visibleModuleActionGroups = moduleActionGroups.filter(
                  group => !matchesAnyCondition(g, group.hiddenWhen)
                );
                const hasSaveLocation = g.moduleSupports?.saveLocation === true;
                const saveDir = hasSaveLocation
                  ? g.saveDirOverride || defaultSaveDirForGame(g)
                  : "";
                const hasSaveDir = Boolean(saveDir);
                const canLaunchNative = Boolean(
                  (g.nativeAppPath && g.nativeAppPath.toLowerCase().endsWith(".app")) ||
                    g.gamePath.toLowerCase().endsWith(".app")
                );
                const canEditSaves = g.moduleSupports?.saveEditing !== false;
                const canUseCheats = g.moduleSupports?.cheats === true;
                const canPatchCheats = g.moduleSupports?.cheatsPatcher === true;
                const runtimeSupport =
                  Array.isArray(g.moduleRuntimeSupport) && g.moduleRuntimeSupport.length > 0
                    ? g.moduleRuntimeSupport
                    : moduleInfo?.runtime?.supported || [];
                const runtimeOptions = runtimeSupport.filter(rt => {
                  if (rt === "native" && !canLaunchNative) return false;
                  return true;
                });
                const runtimeManagerId = moduleInfo
                  ? resolveRuntimeManagerId(moduleInfo, g.runtimeId)
                  : null;
                const runtimeManagerState = runtimeManagerId
                  ? state?.runtimeManagers?.[runtimeManagerId]
                  : null;
                const runtimeSectionId = runtimeManagerId
                  ? resolveRuntimeSectionId(moduleInfo, g.runtimeId, g)
                  : null;
                const runtimeSection = resolveRuntimeSection(
                  runtimeManagerState,
                  runtimeSectionId
                );
                const runtimeVersionOverride = g.runtimeData?.[g.runtimeId]?.version || "";
                const runtimeVariantOverride = g.runtimeData?.[g.runtimeId]?.variant || "";
                const runtimeInstalledVersions = runtimeSection
                  ? Array.from(
                      new Set(
                        (runtimeSection.installed || [])
                          .map((inst: any) => inst?.version)
                          .filter(Boolean)
                      )
                    ).sort((a, b) => compareSemver(String(b || ""), String(a || "")))
                  : [];
                const runtimeDefaultVersion = runtimeSection?.defaultVersion || "";
                const runtimeLabel = formatRuntimeLabel(g.runtimeId, moduleInfo);
                const runtimeVersionLabelText = runtimeLabel
                  ? `${runtimeLabel} version`
                  : "Runtime version";
                const runtimeOverrideLabel = runtimeVersionOverride
                  ? formatRuntimeVersionTag(runtimeVersionOverride, runtimeSection)
                  : "";
                const runtimeDefaultLabel = runtimeDefaultVersion
                  ? formatRuntimeVersionTag(runtimeDefaultVersion, runtimeSection)
                  : "";
                const runtimeVersionLabel = runtimeOverrideLabel
                  ? runtimeOverrideLabel
                  : runtimeDefaultLabel
                    ? `Default (${runtimeDefaultLabel})`
                    : "Default";
                const runtimeVariantOptions = Array.isArray(runtimeSection?.variants)
                  ? runtimeSection.variants
                  : [];
                const runtimeHasMultipleVariants = runtimeVariantOptions.length > 1;
                const runtimeVariantValue =
                  runtimeVariantOverride || runtimeSection?.defaultVariant || "";
                const runtimeVariantLabel = runtimeHasMultipleVariants
                  ? runtimeVariantOptions.find(opt => opt.id === runtimeVariantValue)?.label ||
                    runtimeVariantValue ||
                    "Default"
                  : "";
                const runtimeDefaultVariantLabel = runtimeHasMultipleVariants
                  ? runtimeVariantOptions.find(opt => opt.id === runtimeSection?.defaultVariant)
                      ?.label ||
                    runtimeSection?.defaultVariant ||
                    "Default"
                  : "";
                const libsDependencies = moduleState?.libs?.dependencies || [];
                const libsAvailable = libsDependencies.some(dep => dep.versions.length > 0);
                const libsStatus = libsPatchStatusByPath[g.gamePath] || null;
                const libOverrides =
                  g.moduleData && typeof g.moduleData === "object"
                    ? g.moduleData.libVersions || {}
                    : {};
                const moduleActionResults = moduleActionResultsByPath[g.gamePath] || {};
                const moduleActionBusy = moduleActionBusyByPath[g.gamePath] || {};
                const moduleActionError = moduleActionErrorByPath[g.gamePath] || null;
                const runningCount = state?.running?.[g.gamePath] ?? 0;
                const isRunning = runningCount > 0;
                const moduleSettings = state?.moduleSettings?.[g.moduleId] || {};
                const defaultRuntime = resolveDefaultRuntime(moduleInfo, moduleSettings);
                const runtimeIsCustom = Boolean(defaultRuntime && g.runtimeId !== defaultRuntime);
                const runtimeSchema = resolveRuntimeSettingsSchema(moduleInfo, g.runtimeId);
                const moduleRuntimeSettings = runtimeSchema
                  ? resolveModuleRuntimeSettings(state, g.moduleId, moduleInfo, g.runtimeId)
                  : null;
                const gameRuntimeOverrides =
                  g.runtimeSettings && typeof g.runtimeSettings === "object"
                    ? g.runtimeSettings[g.runtimeId]
                    : null;
                const normalizedGameOverride =
                  runtimeSchema && gameRuntimeOverrides && typeof gameRuntimeOverrides === "object"
                    ? normalizeRuntimeSettings(
                        runtimeSchema,
                        gameRuntimeOverrides,
                        moduleRuntimeSettings || {}
                      )
                    : null;
                const runtimeSettingsModified =
                  runtimeSchema && moduleRuntimeSettings && normalizedGameOverride
                    ? !runtimeSettingsEqual(
                        runtimeSchema,
                        normalizedGameOverride,
                        moduleRuntimeSettings
                      )
                    : false;
                const runtimeSettingsBadge =
                  runtimeIsCustom && runtimeSettingsModified ? "Modified" : null;

                return (
                  <div
                    className={[
                      "gameItem",
                      expanded ? "expanded" : "",
                      dragging ? "dragging" : ""
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    key={g.gamePath}
                    onClick={() => toggleExpanded(g.gamePath)}
                  >
                    <div
                      className={["gameRow", showIcons ? "withIcon" : ""]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <button
                        className={[
                          "dragHandle",
                          dragDisabled ? "disabled" : ""
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        draggable={!dragDisabled}
                        onDragStart={ev => onGameDragStart(ev, g.gamePath)}
                        onDragEnd={clearReorderState}
                        onClick={e => e.stopPropagation()}
                        title={
                          dragDisabled
                            ? "Reordering is disabled while filtering"
                            : "Drag to reorder"
                        }
                        aria-disabled={dragDisabled}
                      >
                        ⋮⋮
                      </button>

                      {showIcons && (
                        <div className="gameIcon" aria-hidden="true">
                          {g.iconUrl ? (
                            <img
                              src={g.iconUrl}
                              alt=""
                              loading="lazy"
                              className="gameIconImage"
                            />
                          ) : (
                            <span className="gameIconText">
                              {formatIconFallbackText(g, moduleInfo)}
                            </span>
                          )}
                        </div>
                      )}

                      <div className="gameMain">
                        <div className="gameTopLine">
                          <span className="gameName">{g.name}</span>
                          <span className="badge">
                            {formatModuleBadge(g.moduleShortLabel, g.moduleLabel, g.moduleId)}
                          </span>
                          {showNonDefaultTags && runtimeIsCustom && (
                            <span className="badge badgeWarn">
                              {formatRuntimeLabel(g.runtimeId, moduleInfo)}
                            </span>
                          )}
                          {showNonDefaultTags && runtimeSettingsBadge && (
                            <span className="badge badgeWarn">{runtimeSettingsBadge}</span>
                          )}
                          {showNonDefaultTags && g.saveDirOverride && (
                            <span className="badge badgeAccent">Custom saves</span>
                          )}
                        </div>
                        <div className="gameBottomLine">
                          <span className="dim">
                            Last played {formatWhen(g.lastPlayedAt)}
                          </span>
                          <span className="dot">·</span>
                          <span className="mono ellipsis">{g.gamePath}</span>
                        </div>
                      </div>

                      <div
                        className="gameActions"
                        onClick={e => e.stopPropagation()}
                      >
                        <button
                          className={[
                            "btn",
                            "iconOnly",
                            isRunning ? "danger" : "primary"
                          ].join(" ")}
                          onClick={() =>
                            isRunning ? onStop(g.gamePath) : onPlay(g.gamePath)
                          }
                          title={isRunning ? "Stop" : "Play"}
                          aria-label={isRunning ? "Stop" : "Play"}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            width="18"
                            height="18"
                            aria-hidden="true"
                            focusable="false"
                          >
                            {isRunning ? (
                              <path
                                fill="currentColor"
                                d="M6 6h12v12H6z"
                              />
                            ) : (
                              <path
                                fill="currentColor"
                                d="M8 5v14l11-7z"
                              />
                            )}
                          </svg>
                        </button>
                        <button
                          className="btn small"
                          title={
                            canEditSaves
                              ? "Save tools"
                              : "Save tools not available for this game type"
                          }
                          onClick={() => onOpenSaveTools(g)}
                          disabled={!canEditSaves}
                        >
                          Saves
                        </button>
                        <button
                          className="btn small"
                          title={
                            canUseCheats
                              ? "Cheats"
                              : "Cheats not available for this game type"
                          }
                          onClick={() => openCheats(g)}
                          disabled={!canUseCheats}
                        >
                          Cheats
                        </button>
                        <button
                          className="btn small"
                          title="Create a .command shortcut"
                          onClick={() => onCreateCommand(g.gamePath)}
                        >
                          Shortcut
                        </button>
                        <button
                          className="btn iconOnly danger"
                          title="Forget game"
                          aria-label="Forget game"
                          onClick={() => onForgetGame(g.gamePath)}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            width="18"
                            height="18"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <path
                              fill="currentColor"
                              d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v9h-2V9zm4 0h2v9h-2V9zM6 7h12l-1 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7z"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {expanded && (
                      <div
                        className="gameDetails"
                        onClick={e => e.stopPropagation()}
                      >
                        <div className="detailGrid">
                          <div className="detailRow">
                            <div className="detailLabel">Game</div>
                            <div className="detailValue mono ellipsis">
                              {g.gamePath}
                            </div>
                            <div className="detailActions">
                              <button
                                className="btn small"
                                onClick={() => onReveal(g.gamePath)}
                              >
                                Reveal
                              </button>
                            </div>
                          </div>

                          {hasSaveLocation && (
                            <div className="detailRow">
                              <div className="detailLabel">Saves</div>
                              <div className="detailValue mono ellipsis">
                                {formatSaveDirDisplay(saveDir)}
                              </div>
                              <div className="detailActions">
                                <button
                                  className="btn small"
                                  onClick={() => onReveal(saveDir)}
                                  disabled={!hasSaveDir}
                                >
                                  Reveal
                                </button>
                                <button
                                  className="btn small"
                                  onClick={() => onPickSaveDir(g.gamePath)}
                                  disabled={!canEditSaves}
                                >
                                  Change…
                                </button>
                                {g.saveDirOverride && (
                                  <button
                                    className="btn small"
                                    onClick={() => onResetSaveDir(g.gamePath)}
                                    disabled={!canEditSaves}
                                  >
                                    Reset
                                  </button>
                                )}
                              </div>
                            </div>
                          )}

                          <div className="detailRow">
                            <div className="detailLabel">Runtime</div>
                            <div className="detailValue">
                              {formatRuntimeLabel(g.runtimeId, moduleInfo)}
                            </div>
                            <div className="detailActions">
                              <select
                                className="input"
                                value={g.runtimeId}
                                onChange={e =>
                                  onSetRuntime(g.gamePath, e.target.value as RuntimeId)
                                }
                              >
                                {runtimeOptions.map(rt => (
                                  <option key={rt} value={rt}>
                                    {formatRuntimeOption(rt, moduleInfo)}
                                  </option>
                                ))}
                              </select>
                              <button
                                className="btn small"
                                onClick={() =>
                                  onOpenRuntimeSettings({
                                    scope: "game",
                                    moduleId: g.moduleId,
                                    runtimeId: g.runtimeId,
                                    gamePath: g.gamePath
                                  })
                                }
                                disabled={!runtimeSchema}
                              >
                                Settings…
                              </button>
                            </div>
                          </div>

                          {runtimeManagerState && runtimeSection && (
                            <div className="detailRow">
                              <div className="detailLabel">{runtimeVersionLabelText}</div>
                              <div className="detailValue">
                                {runtimeVersionLabel}
                                {runtimeHasMultipleVariants && runtimeVariantLabel ? (
                                  <span className="dim"> · {runtimeVariantLabel}</span>
                                ) : null}
                              </div>
                              <div className="detailActions">
                                <select
                                  className="input"
                                  value={runtimeVersionOverride}
                                  onChange={e =>
                                    onSetRuntimeData(g.gamePath, g.runtimeId, {
                                      version: e.target.value || null
                                    })
                                  }
                                >
                                  <option value="">Default</option>
                                  {runtimeInstalledVersions.map(v => (
                                    <option key={v} value={v}>
                                      {formatRuntimeVersionTag(v, runtimeSection)}
                                    </option>
                                  ))}
                                </select>
                                {runtimeHasMultipleVariants && (
                                  <select
                                    className="input"
                                    value={runtimeVariantOverride || ""}
                                    onChange={e =>
                                      onSetRuntimeData(g.gamePath, g.runtimeId, {
                                        variant: e.target.value || null
                                      })
                                    }
                                  >
                                    <option value="">
                                      Default: {runtimeDefaultVariantLabel}
                                    </option>
                                    {runtimeVariantOptions.map(variant => (
                                      <option key={variant.id} value={variant.id}>
                                        {variant.label || variant.id}
                                      </option>
                                    ))}
                                  </select>
                                )}
                                <button
                                  className="btn small"
                                  onClick={() => openRuntimesManager(runtimeManagerId || undefined)}
                                >
                                  Runtimes…
                                </button>
                              </div>
                            </div>
                          )}

                          {(moduleUi?.infoFields || [])
                            .filter(field => !matchesAnyCondition(g, field.hiddenWhen))
                            .map(field => {
                              const rawValue = getByPath(g, field.key);
                              const pathValue =
                                typeof rawValue === "string" ? rawValue : "";
                              const isPath = field.format === "path" && Boolean(pathValue);
                              const formatted = formatFieldValue(
                                rawValue,
                                field.format,
                                field.empty
                              );
                              return (
                                <div className="detailRow" key={`info-${field.key}`}>
                                  <div className="detailLabel">{field.label}</div>
                                  <div className="detailValue">
                                    {isPath ? (
                                      <span className="mono ellipsis">{formatted}</span>
                                    ) : (
                                      formatted
                                    )}
                                  </div>
                                  <div className="detailActions">
                                    {isPath && (
                                      <button
                                        className="btn small"
                                        onClick={() => onReveal(pathValue)}
                                      >
                                        Reveal
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}

                          {libsDependencies.length > 0 && (
                            <div className="detailRow">
                              <div className="detailLabel">Libraries</div>
                              <div className="detailValue">
                                {(() => {
                                  if (!libsAvailable) {
                                    return <span className="dim">No managed versions</span>;
                                  }
                                  if (!libsStatus) return <span className="dim">—</span>;
                                  if (libsStatus.patched) {
                                    return <span className="badge badgeAccent">Patched</span>;
                                  }
                                  if (libsStatus.partial) {
                                    return <span className="badge badgeWarn">Partial</span>;
                                  }
                                  return <span className="badge">Not patched</span>;
                                })()}
                                {libsStatus?.warnings?.length ? (
                                  <>
                                    {" "}
                                    <span
                                      className="badge badgeWarn"
                                      title={libsStatus.warnings.join("\n")}
                                    >
                                      Warning
                                    </span>
                                  </>
                                ) : null}
                              </div>
                              <div className="detailActions">
                                <button
                                  className="btn small iconOnly"
                                  disabled={libsPatchBusyPath === g.gamePath}
                                  onClick={() => refreshLibsPatchStatus(g.gamePath)}
                                  title="Refresh"
                                  aria-label="Refresh"
                                >
                                  <RefreshIcon />
                                </button>
                                <button
                                  className="btn small"
                                  disabled={
                                    libsPatchBusyPath === g.gamePath || !libsAvailable
                                  }
                                  onClick={() => onPatchLibs(g.gamePath)}
                                >
                                  Patch…
                                </button>
                                <button
                                  className="btn small"
                                  disabled={libsPatchBusyPath === g.gamePath}
                                  onClick={() => onUnpatchLibs(g.gamePath)}
                                >
                                  Unpatch…
                                </button>
                              </div>
                            </div>
                          )}

                          {libsDependencies
                            .filter(dep => dep.versions.length > 1)
                            .map(dep => {
                              const override = dep.versions.some(
                                v => v.id === libOverrides?.[dep.id]
                              )
                                ? libOverrides[dep.id]
                                : "";
                              const defaultVersion =
                                dep.versions.find(v => v.id === dep.defaultVersion) || null;
                              const defaultLabel = defaultVersion
                                ? defaultVersion.label
                                : "No default";
                              const overrideLabel = dep.versions.find(v => v.id === override)?.label;
                              return (
                                <div className="detailRow" key={dep.id}>
                                  <div className="detailLabel">{dep.label}</div>
                                  <div className="detailValue">
                                    {override && overrideLabel ? (
                                      overrideLabel
                                    ) : (
                                      <span className="dim">Default: {defaultLabel}</span>
                                    )}
                                  </div>
                                  <div className="detailActions">
                                    <select
                                      className="input"
                                      value={override}
                                      onChange={e =>
                                        onSetGameLibVersion(
                                          g.gamePath,
                                          dep.id,
                                          e.target.value
                                        )
                                      }
                                    >
                                      <option value="">Default: {defaultLabel}</option>
                                      {dep.versions.map(version => (
                                        <option key={version.id} value={version.id}>
                                          {version.label}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                </div>
                              );
                            })}

                          {canPatchCheats && (
                            <div className="detailRow">
                              <div className="detailLabel">Tools patch</div>
                              <div className="detailValue">
                                {(() => {
                                  const status = cheatsPatchStatusByPath[g.gamePath];
                                  if (!status) return <span className="dim">—</span>;
                                  if (status.patched)
                                    return (
                                      <span className={["badge", "badgeAccent"].join(" ")}>
                                        Patched
                                      </span>
                                    );
                                  if (status.partial)
                                    return (
                                      <span className={["badge", "badgeWarn"].join(" ")}>
                                        Partial
                                      </span>
                                    );
                                  return <span className="badge">Not patched</span>;
                                })()}
                              </div>
                              <div className="detailActions">
                                <button
                                  className="btn small iconOnly"
                                  disabled={cheatsPatchBusyPath === g.gamePath}
                                  onClick={() => refreshCheatsPatchStatus(g.gamePath)}
                                  title="Refresh"
                                  aria-label="Refresh"
                                >
                                  <RefreshIcon />
                                </button>
                                <button
                                  className="btn small"
                                  disabled={cheatsPatchBusyPath === g.gamePath}
                                  onClick={() => onPatchCheatsIntoGame(g.gamePath)}
                                >
                                  Patch…
                                </button>
                                <button
                                  className="btn small"
                                  disabled={cheatsPatchBusyPath === g.gamePath}
                                  onClick={() => onUnpatchCheatsFromGame(g.gamePath)}
                                >
                                  Unpatch…
                                </button>
                              </div>
                            </div>
                          )}

                          {visibleModuleActionGroups.map(group => {
                            const actions = group.actions
                              .map(id => moduleActionsById.get(id))
                              .filter(Boolean) as ModuleUiAction[];
                            if (actions.length === 0) return null;
                            const groupLabelValue = group.labelKey
                              ? getByPath(g, group.labelKey)
                              : null;
                            const groupLabel =
                              typeof groupLabelValue === "string" && groupLabelValue.trim()
                                ? groupLabelValue.trim()
                                : group.label;
                            const visibleActions = actions.filter(
                              action => !matchesAnyCondition(g, action.hiddenWhen)
                            );
                            const groupInfoItems: Array<{
                              key: string;
                              label: string;
                              value: string;
                            }> = [];
                            for (const field of group.infoFields || []) {
                              if (matchesAnyCondition(g, field.hiddenWhen)) continue;
                              const value = formatFieldValue(
                                getByPath(g, field.key),
                                field.format,
                                field.empty
                              );
                              groupInfoItems.push({
                                key: `group:${group.id}:${field.key}`,
                                label: field.label || "",
                                value
                              });
                            }
                            const actionsWithResults = visibleActions.filter(
                              action =>
                                Array.isArray(action.resultFields) &&
                                moduleActionResults[action.id]
                            );
                            const needsPrefix = actionsWithResults.length > 1;
                            const resultItems: Array<{
                              key: string;
                              label: string;
                              value: string;
                            }> = [];
                            for (const action of actionsWithResults) {
                              const result = moduleActionResults[action.id];
                              for (const field of action.resultFields || []) {
                                const value = formatFieldValue(
                                  getByPath(result, field.key),
                                  field.format,
                                  field.empty
                                );
                                const labelParts = needsPrefix
                                  ? [action.label, field.label]
                                  : [field.label];
                                const label = labelParts.filter(Boolean).join(" ");
                                resultItems.push({
                                  key: `${action.id}:${field.key}`,
                                  label,
                                  value
                                });
                              }
                            }
                            const valueItems = groupInfoItems.concat(resultItems);
                            const showRow =
                              visibleActions.length > 0 ||
                              valueItems.length > 0 ||
                              Boolean(group.note);
                            if (!showRow) return null;
                            return (
                              <div className="detailRow" key={`action-group-${group.id}`}>
                                <div className="detailLabel">{groupLabel}</div>
                                <div className="detailValue">
                                  {group.note && <div className="dim">{group.note}</div>}
                                  {valueItems.length > 0 ? (
                                    <div className="detailMeta">
                                      {valueItems.map((item, idx) => (
                                        <span key={item.key}>
                                          {item.label ? (
                                            <>
                                              <span className="dim">{item.label}:</span>{" "}
                                            </>
                                          ) : null}
                                          {item.value}
                                          {idx < valueItems.length - 1 && (
                                            <span className="sep">·</span>
                                          )}
                                        </span>
                                      ))}
                                    </div>
                                  ) : !group.note && !group.hideEmptyValue ? (
                                    <span className="dim">—</span>
                                  ) : null}
                                </div>
                                <div className="detailActions">
                                  {visibleActions.map(action => {
                                    const actionDisabled =
                                      Boolean(moduleActionBusy[action.id]) ||
                                      matchesAnyCondition(g, action.disabledWhen);
                                    const iconOnly = Boolean(action.icon && action.iconOnly);
                                    const actionClass = [
                                      "btn",
                                      "small",
                                      action.kind === "primary" ? "primary" : "",
                                      action.kind === "danger" ? "danger" : "",
                                      iconOnly ? "iconOnly" : ""
                                    ]
                                      .filter(Boolean)
                                      .join(" ");
                                    return (
                                      <button
                                        key={action.id}
                                        className={actionClass}
                                        disabled={actionDisabled}
                                        title={action.label}
                                        aria-label={action.label}
                                        onClick={() =>
                                          onModuleAction(g.gamePath, action.id, action)
                                        }
                                      >
                                        {action.icon ? (
                                          <>
                                            <ActionIcon icon={action.icon} />
                                            {!iconOnly && <span>{action.label}</span>}
                                          </>
                                        ) : (
                                          action.label
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}

                          {moduleActionError && (
                            <div className="detailRow">
                              <div className="detailLabel">Actions</div>
                              <div className="detailValue">
                                <span className="badge badgeDanger">
                                  Error: {moduleActionError}
                                </span>
                              </div>
                              <div className="detailActions" />
                            </div>
                          )}

                        </div>

                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>

      {saveGame && (
        <div className="modalBackdrop" onClick={closeSaveTools}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <div className="modalTitle">Save tools</div>
                <div className="modalSubtitle">
                  {saveInfo?.name || saveGame.name} ·{" "}
                  {formatModuleLabel(
                    saveInfo?.moduleLabel || saveGame.moduleLabel,
                    saveInfo?.moduleShortLabel || saveGame.moduleShortLabel,
                    saveInfo?.moduleId || saveGame.moduleId
                  )}
                </div>
              </div>
              <button className="btn" onClick={closeSaveTools}>
                Close
              </button>
            </div>

            <div className="modalBody">
              {saveError && <div className="error">Error: {saveError}</div>}

              <div className="modalRow">
                <div className="dim">
                  Save dir: <span className="mono">{saveInfo?.saveDir || "—"}</span>
                </div>
                {saveInfo?.saveDir && (
                  <button className="link" onClick={() => onReveal(saveInfo.saveDir)}>
                    Reveal
                  </button>
                )}
              </div>

              <div className="modalActions">
                <button className="btn" disabled={saveBusy} onClick={onImportSaveDir}>
                  Import folder…
                </button>
                <button className="btn" disabled={saveBusy} onClick={onExportSaveDir}>
                  Export folder…
                </button>
                <button className="btn" disabled={saveBusy} onClick={onImportSaveFiles}>
                  Import files…
                </button>
              </div>

              <div className="saveSection">
                <div className="saveSectionTitle">Files in save dir</div>
                {saveFiles.length === 0 ? (
                  <div className="empty">No save files found yet.</div>
                ) : (
                  <div className="saveList">
                    {saveFiles.map(f => (
                      <div className="saveRow" key={f.path}>
                        <div className="saveRowMain">
                          <div className="saveName">{f.name}</div>
                          <div className="dim">
                            {formatBytes(f.size)} · modified {formatWhenMs(f.mtimeMs)}
                          </div>
                        </div>
                        <div className="saveRowActions">
                          <button
                            className="link"
                            disabled={saveBusy}
                            onClick={() => onReveal(f.path)}
                          >
                            Reveal
                          </button>
                          <span className="sep">·</span>
                          <button
                            className="link"
                            disabled={saveBusy}
                            onClick={() => onEditSaveFile(f)}
                          >
                            Edit JSON
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

	              {editingFile && (
	                <div className="editor">
	                  <div className="editorHeader">
	                    <div className="editorTitle">Editing: {editingFile.name}</div>
	                    <div className="editorActions">
	                      <button className="btn" disabled={saveBusy} onClick={onFormatJson}>
	                        Format
	                      </button>
	                      <button
	                        className="btn"
	                        disabled={saveBusy}
	                        onClick={onOpenEditedJsonExternal}
	                      >
	                        Open in editor
	                      </button>
	                      <button
	                        className="btn"
	                        disabled={saveBusy}
	                        onClick={onReloadEditedJsonExternal}
	                      >
	                        Reload from editor
	                      </button>
	                      <button
	                        className="btn primary"
	                        disabled={saveBusy}
	                        onClick={onSaveEditedJson}
	                      >
                        Save
                      </button>
                      <button
                        className="btn"
                        disabled={saveBusy}
                        onClick={() => {
                          setEditingFile(null);
                          setEditingJson("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                  <textarea
                    className="codeArea"
                    spellCheck={false}
                    value={editingJson}
                    onChange={e => setEditingJson(e.target.value)}
	                  />
	                  <div className="dim editorHint">
	                    External file:{" "}
	                    <span className="mono">{editingFile.path}.maclauncher.json</span> ·
	                    Writes a backup to <span className="mono">{editingFile.path}.maclauncher.bak</span>
	                  </div>
	                </div>
	              )}
            </div>
          </div>
        </div>
      )}

      {cheatGame && cheatDraft && (
        <div className="modalBackdrop" onClick={closeCheats}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <div className="modalTitle">Cheats</div>
                <div className="modalSubtitle">
                  {cheatGame.name} ·{" "}
                  {formatModuleLabel(
                    cheatGame.moduleLabel,
                    cheatGame.moduleShortLabel,
                    cheatGame.moduleId
                  )}
                </div>
              </div>
              <div className="modalHeaderActions">
                {cheatAddonStatusAction && (
                  <button
                    className="btn iconOnly"
                    disabled={cheatBusy || cheatAddonBusy}
                    onClick={() =>
                      refreshCheatAddonStatus(cheatGame.gamePath, cheatAddonStatusAction)
                    }
                    title="Refresh"
                    aria-label="Refresh"
                  >
                    <RefreshIcon />
                  </button>
                )}
                <button
                  className="btn iconOnly"
                  onClick={closeCheats}
                  title="Close"
                  aria-label="Close"
                >
                  <XIcon />
                </button>
              </div>
            </div>

            <div className="modalBody">
              {cheatError && <div className="error">Error: {cheatError}</div>}
              {showCheatFields && (
                <>
                  <div className="dim">
                    Changes apply immediately if the game is running. Otherwise on next launch.
                  </div>

                  <div className="formGrid">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={cheatDraft.enabled}
                        disabled={cheatBusy}
                        onChange={e =>
                          setCheatDraft(d => (d ? { ...d, enabled: e.target.checked } : d))
                        }
                      />
                      <span>Enable cheats</span>
                    </label>

                    {toolsButtonSettingAvailable && (
                      <div className="field">
                        <div className="fieldLabel">Tools button</div>
                        <label className="inlineCheck">
                          <input
                            type="checkbox"
                            checked={toolsButtonEffective}
                            disabled={cheatBusy}
                            onChange={e => setToolsButtonOverride(e.target.checked)}
                          />
                          <span>Show in game overlay</span>
                        </label>
                        <div className="fieldInlineActions">
                          <button
                            className="btn small"
                            disabled={cheatBusy || toolsButtonUsesDefault}
                            onClick={() => setToolsButtonOverride(null)}
                          >
                            Use default
                          </button>
                          <span className="dim">
                            Default: {toolsButtonVisible ? "Shown" : "Hidden"}
                          </span>
                        </div>
                      </div>
                    )}

                    {cheatNumbers.map(field => (
                      <label className="field" key={String(field.key)}>
                        <div className="fieldLabel">{field.label}</div>
                        <input
                          className="input"
                          type="number"
                          min={field.min}
                          max={field.max}
                          step={field.step ?? 1}
                          value={(cheatDraft as any)[field.key]}
                          disabled={cheatBusy}
                          onChange={e =>
                            setCheatDraft(d => {
                              if (!d) return d;
                              const v = Number(e.target.value);
                              if (!Number.isFinite(v)) return d;
                              const min = typeof field.min === "number" ? field.min : -Infinity;
                              const max = typeof field.max === "number" ? field.max : Infinity;
                              return { ...d, [field.key]: Math.min(max, Math.max(min, v)) } as any;
                            })
                          }
                        />
                      </label>
                    ))}

                    {cheatToggles.map(field => (
                      <label className="check" key={String(field.key)}>
                        <input
                          type="checkbox"
                          checked={Boolean((cheatDraft as any)[field.key])}
                          disabled={cheatBusy}
                          onChange={e =>
                            setCheatDraft(d =>
                              d ? ({ ...d, [field.key]: e.target.checked } as any) : d
                            )
                          }
                        />
                        <span>{field.label}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}

              {cheatAddonPatches.length > 0 && cheatGame && (
                <div className="detailGrid cheatAddonGrid">
                  {cheatAddonPatches.map(patch => {
                    const addAction = cheatModuleActionsById.get(patch.addAction) || null;
                    const removeAction = cheatModuleActionsById.get(patch.removeAction) || null;
                    if (!addAction || !removeAction) return null;
                    const canRemove = Boolean(
                      cheatAddonStatus && cheatAddonStatus[patch.statusKey]
                    );
                    const addClass = [
                      "btn",
                      "small",
                      addAction.kind === "primary" ? "primary" : "",
                      addAction.kind === "danger" ? "danger" : ""
                    ]
                      .filter(Boolean)
                      .join(" ");
                    const removeClass = [
                      "btn",
                      "small",
                      removeAction.kind === "primary" ? "primary" : "",
                      removeAction.kind === "danger" ? "danger" : ""
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <div className="detailRow cheatPatchRow" key={`cheat-addon-${patch.id}`}>
                        <div className="detailValue">{patch.label}</div>
                        <div className="detailActions">
                          <button
                            className={addClass}
                            disabled={cheatBusy || cheatAddonBusy}
                            onClick={() =>
                              onCheatAddonAction(cheatGame.gamePath, addAction.id, addAction)
                            }
                          >
                            Patch
                          </button>
                          <button
                            className={[removeClass, "iconOnly"].filter(Boolean).join(" ")}
                            disabled={cheatBusy || cheatAddonBusy || !canRemove}
                            onClick={() =>
                              onCheatAddonAction(cheatGame.gamePath, removeAction.id, removeAction)
                            }
                            title={removeAction.label}
                            aria-label={removeAction.label}
                          >
                            <ActionIcon icon="x" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {showCheatFields && (
                <div className="modalActions">
                  <button
                    className="btn"
                    disabled={cheatBusy}
                    onClick={() => setCheatDraft({ ...cheatDefaults })}
                  >
                    Reset to defaults
                  </button>
                  <button
                    className="btn primary"
                    disabled={cheatBusy}
                    onClick={onSaveCheats}
                  >
                    Save
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {settingsOpen && state && (
        <div className="modalBackdrop" onClick={closeSettings}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modalHeader">
              <div className="modalTitle">Settings</div>
              <button
                className="btn iconOnly"
                onClick={closeSettings}
                title="Close"
                aria-label="Close"
              >
                <XIcon />
              </button>
            </div>

            <div className="modalBody">
              <div className="settingsStack">
                <div className="settingsSection">
                  <div className="settingsTitle">Launcher</div>
                  <div className="settingsRow">
                    <div className="settingsLabel">Show game icons</div>
                    <div className="settingsControl">
                      <label className="inlineCheck settingsToggle">
                        <input
                          type="checkbox"
                          checked={showIcons}
                          onChange={e =>
                            onSetLauncherSettings({ showIcons: e.target.checked })
                          }
                        />
                        <span>{showIcons ? "On" : "Off"}</span>
                      </label>
                    </div>
                  </div>
                  <div className="settingsRow">
                    <div className="settingsLabel">Show non-default tags</div>
                    <div className="settingsControl">
                      <label className="inlineCheck settingsToggle">
                        <input
                          type="checkbox"
                          checked={showNonDefaultTags}
                          onChange={e =>
                            onSetLauncherSettings({
                              showNonDefaultTags: e.target.checked
                            })
                          }
                        />
                        <span>{showNonDefaultTags ? "On" : "Off"}</span>
                      </label>
                    </div>
                  </div>
                </div>
                {sortModulesForSettings(state.modules || []).map(mod => {
                  const moduleSettings = state.moduleSettings?.[mod.id] || {};
                  const settingsDefaults =
                    mod.settingsDefaults && typeof mod.settingsDefaults === "object"
                      ? mod.settingsDefaults
                      : {};
                  const settingKeys = Object.keys(settingsDefaults);
                  const runtimeButtons = Array.isArray(mod.runtime?.supported)
                    ? mod.runtime.supported.map(runtimeId => {
                        const runtimeSchema = resolveRuntimeSettingsSchema(mod, runtimeId);
                        const hasSettings = Boolean(runtimeSchema);
                        const globalDefaults = runtimeSchema
                          ? normalizeRuntimeSettings(
                              runtimeSchema,
                              state?.runtimeDefaults?.[runtimeId] || null,
                              buildRuntimeSettingsDefaults(runtimeSchema)
                            )
                          : null;
                        const moduleRuntimeSettings = runtimeSchema
                          ? resolveModuleRuntimeSettings(state, mod.id, mod, runtimeId)
                          : null;
                        const modified =
                          runtimeSchema && moduleRuntimeSettings && globalDefaults
                            ? !runtimeSettingsEqual(
                                runtimeSchema,
                                moduleRuntimeSettings,
                                globalDefaults
                              )
                            : false;
                        return {
                          id: runtimeId,
                          hasSettings,
                          modified
                        };
                      })
                    : [];
                  return (
                    <div className="settingsSection" key={mod.id}>
                      <div className="settingsTitle">
                        {formatModuleLabel(mod.label, mod.shortLabel, mod.id)}
                      </div>
                      {settingKeys.length === 0 ? (
                        <div className="dim settingsHint">No settings available yet.</div>
                      ) : (
                        settingKeys.map(key => {
                          const defaultValue = settingsDefaults[key];
                          const currentValue =
                            moduleSettings[key] !== undefined
                              ? moduleSettings[key]
                              : defaultValue;
                          if (key === "defaultRuntime" && mod.runtime?.supported) {
                            const runtimeValue =
                              typeof currentValue === "string" && currentValue
                                ? currentValue
                                : mod.runtime.supported[0] || "";
                            return (
                              <div className="settingsRow" key={`${mod.id}-${key}`}>
                                <div className="settingsLabel">Default runtime</div>
                                <div className="settingsControl">
                                  <select
                                    className="input"
                                    value={runtimeValue}
                                    onChange={e =>
                                      onSetModuleSettings(mod.id, {
                                        defaultRuntime: e.target.value
                                      })
                                    }
                                  >
                                    {mod.runtime.supported.map(rt => (
                                      <option key={rt} value={rt}>
                                        {formatRuntimeOption(rt, mod)}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              </div>
                            );
                          }
                          if (typeof defaultValue === "boolean") {
                            const checked = Boolean(currentValue);
                            return (
                              <React.Fragment key={`${mod.id}-${key}`}>
                                <div className="settingsRow">
                                  <div className="settingsLabel">
                                    {formatSettingLabel(key)}
                                  </div>
                                  <div className="settingsControl">
                                    <label className="inlineCheck settingsToggle">
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={e =>
                                          onSetModuleSettings(mod.id, {
                                            [key]: e.target.checked
                                          })
                                        }
                                      />
                                      <span>{checked ? "On" : "Off"}</span>
                                    </label>
                                  </div>
                                </div>
                                {key === "toolsButtonVisible" && (
                                  <div className="dim settingsHint">
                                    Tools remain available via Cmd+Shift+T and the menu bar.
                                  </div>
                                )}
                              </React.Fragment>
                            );
                          }
                          if (typeof defaultValue === "number") {
                            const value = Number(currentValue);
                            return (
                              <div className="settingsRow" key={`${mod.id}-${key}`}>
                                <div className="settingsLabel">
                                  {formatSettingLabel(key)}
                                </div>
                                <div className="settingsControl">
                                  <input
                                    className="input"
                                    type="number"
                                    value={Number.isFinite(value) ? value : ""}
                                    onChange={e => {
                                      const next = Number(e.target.value);
                                      if (!Number.isFinite(next)) return;
                                      onSetModuleSettings(mod.id, { [key]: next });
                                    }}
                                  />
                                </div>
                              </div>
                            );
                          }
                          if (typeof defaultValue === "string") {
                            const value =
                              typeof currentValue === "string" ? currentValue : String(defaultValue);
                            return (
                              <div className="settingsRow" key={`${mod.id}-${key}`}>
                                <div className="settingsLabel">
                                  {formatSettingLabel(key)}
                                </div>
                                <div className="settingsControl">
                                  <input
                                    className="input"
                                    type="text"
                                    value={value}
                                    onChange={e =>
                                      onSetModuleSettings(mod.id, { [key]: e.target.value })
                                    }
                                  />
                                </div>
                              </div>
                            );
                          }
                          return (
                            <div className="settingsRow" key={`${mod.id}-${key}`}>
                              <div className="settingsLabel">
                                {formatSettingLabel(key)}
                              </div>
                              <div className="settingsControl">
                                <span className="dim">Unsupported setting</span>
                              </div>
                            </div>
                          );
                        })
                      )}
                      <div className="settingsRow">
                        <div className="settingsLabel">Runtime settings</div>
                        <div className="settingsControl settingsRuntimeButtons">
                          {runtimeButtons.length === 0 ? (
                            <span className="dim">—</span>
                          ) : (
                            runtimeButtons.map(rt => (
                              <div className="settingsRuntimeButton" key={rt.id}>
                                <button
                                  className="btn small"
                                  onClick={() =>
                                    onOpenRuntimeSettings({
                                      scope: "module",
                                      moduleId: mod.id,
                                      runtimeId: rt.id
                                    })
                                  }
                                  disabled={!rt.hasSettings}
                                >
                                  {formatRuntimeLabel(rt.id, mod)}…
                                </button>
                                {rt.modified && (
                                  <span className="badge badgeWarn">Modified</span>
                                )}
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {acknowledgmentsOpen && (
        <div className="modalBackdrop" onClick={closeAcknowledgments}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <div className="modalTitle">Acknowledgments</div>
                <div className="modalSubtitle">
                  Thanks to the projects that make MacLauncher possible.
                </div>
              </div>
              <button className="btn" onClick={closeAcknowledgments}>
                Close
              </button>
            </div>

            <div className="modalBody">
              {acknowledgments.length === 0 ? (
                <div className="empty">No acknowledgments listed yet.</div>
              ) : (
                <div className="saveList">
                  {acknowledgments.map(item => (
                    <div className="modalRow" key={`${item.label}-${item.url}`}>
                      <div className="saveRowMain">
                        <div className="saveName">{item.label}</div>
                        <div className="dim mono ellipsis">{item.url}</div>
                      </div>
                      <button
                        className="btn"
                        disabled={!canOpenExternal}
                        onClick={() => onOpenAcknowledgmentsLink(item.url)}
                      >
                        Open
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {runtimesOpen && state && (
        <div className="modalBackdrop" onClick={closeRuntimesManager}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modalHeader runtimeModalHeader">
              <div className="runtimeHeaderTop">
                <div className="modalTitle">Runtimes</div>
                <button
                  className="btn iconOnly"
                  onClick={closeRuntimesManager}
                  title="Close"
                  aria-label="Close"
                >
                  <XIcon />
                </button>
              </div>
              {runtimeManagers.length > 1 && (
                <div className="runtimeTabs" role="tablist" aria-label="Runtime manager tabs">
                  {runtimeManagers.map(manager => {
                    const active = activeRuntimeManager?.id === manager.id;
                    return (
                      <div
                        key={manager.id}
                        id={`runtime-manager-tab-${manager.id}`}
                        role="tab"
                        aria-selected={active}
                        aria-controls={`runtime-panel-${manager.id}`}
                        tabIndex={active ? 0 : -1}
                        className={["runtimeTab", active ? "active" : ""]
                          .filter(Boolean)
                          .join(" ")}
                        onClick={() => {
                          setRuntimeManagerId(manager.id);
                          const nextSection =
                            resolveRuntimeSection(manager, null)?.id || null;
                          setRuntimeSectionId(nextSection);
                        }}
                        onKeyDown={e => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setRuntimeManagerId(manager.id);
                            const nextSection =
                              resolveRuntimeSection(manager, null)?.id || null;
                            setRuntimeSectionId(nextSection);
                          }
                        }}
                      >
                        <span>{manager.label || manager.id}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {activeRuntimeSections.length > 1 && (
                <div className="runtimeTabs" role="tablist" aria-label="Runtime line tabs">
                  {activeRuntimeSections.map(section => {
                    const active = activeRuntimeSection?.id === section.id;
                    return (
                      <div
                        key={section.id}
                        id={`runtime-section-tab-${section.id}`}
                        role="tab"
                        aria-selected={active}
                        aria-controls={`runtime-panel-${activeRuntimeManager?.id}-${section.id}`}
                        tabIndex={active ? 0 : -1}
                        className={["runtimeTab", active ? "active" : ""]
                          .filter(Boolean)
                          .join(" ")}
                        onClick={() => setRuntimeSectionId(section.id)}
                        onKeyDown={e => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setRuntimeSectionId(section.id);
                          }
                        }}
                      >
                        <span>{section.label || section.id}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="modalBody runtimeModalBody">
              {activeRuntimeManager && activeRuntimeSection ? (
                <div
                  className="runtimeTabPanel"
                  role="tabpanel"
                  id={`runtime-panel-${activeRuntimeManager.id}-${activeRuntimeSection.id}`}
                  aria-labelledby={`runtime-manager-tab-${activeRuntimeManager.id}`}
                >
                  <div className="runtimePanel">
                      <div className="runtimePanelHeader">
                        <div>
                          <div className="runtimePanelTitle">
                            {activeRuntimeManager.label || activeRuntimeManager.id}
                          </div>
                          <div className="runtimePanelSubtitle">
                            {activeRuntimeSubtitle}
                          </div>
                        </div>
                        <div className="runtimePanelHeaderActions">
                          {activeRuntimeInstalling && activeRuntimeSection.installing && (
                            <div className="chip">
                              Installing{" "}
                              {formatRuntimeVersionTag(
                                activeRuntimeSection.installing.version,
                                activeRuntimeSection
                              )}
                              {activeRuntimeSection.installing.total
                                ? ` · ${Math.floor(
                                    (activeRuntimeSection.installing.downloaded /
                                      activeRuntimeSection.installing.total) *
                                      100
                                  )}%`
                                : ""}
                            </div>
                          )}
                        </div>
                      </div>

                      {activeRuntimeUi.error && (
                        <div className="error runtimeError">
                          Error: {activeRuntimeUi.error}
                        </div>
                      )}

                      {runtimeNotice && (
                        <div className="runtimeNotice">
                          <div className="runtimeNoticeTitle">{runtimeNotice.title}</div>
                          {runtimeNotice.lines.map((line, index) => (
                            <div
                              key={`${runtimeNotice.title}-${index}`}
                              className={[
                                "runtimeNoticeLine",
                                line.mono ? "mono" : ""
                              ]
                                .filter(Boolean)
                                .join(" ")}
                            >
                              {line.text}
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="runtimeSectionCard">
                        <div className="runtimeSectionHeader">
                          <div>
                            <div className="runtimeSectionTitle">Remote versions</div>
                            <div className="runtimeSectionHint">
                              {activeRuntimeSection.catalog?.source ? (
                                <>
                                  Source:{" "}
                                  <span className="mono">
                                    {activeRuntimeSection.catalog.source}
                                  </span>
                                  . Installing may require network access.
                                </>
                              ) : (
                                "Installing may require network access."
                              )}
                            </div>
                          </div>
                          <div className="runtimePanelHeaderActions">
                            <button
                              className="btn iconOnly"
                              disabled={
                                activeRuntimeUi.busy ||
                                activeRuntimeSection.catalog?.status === "loading"
                              }
                              onClick={() => {
                                updateRuntimeUiSection(
                                  activeRuntimeManager.id,
                                  activeRuntimeSection.id,
                                  "remoteOpen",
                                  true
                                );
                                onRuntimeRefresh(
                                  activeRuntimeManager.id,
                                  activeRuntimeSection.id,
                                  activeRuntimeSupportsLatestOnly
                                    ? { latestOnly: true }
                                    : {}
                                );
                              }}
                              title={activeRuntimeRefreshLabel}
                              aria-label={activeRuntimeRefreshLabel}
                            >
                              <RefreshIcon />
                            </button>
                            {activeRuntimeSupportsLatestOnly && (
                              <button
                                className="btn"
                                disabled={
                                  activeRuntimeUi.busy ||
                                  activeRuntimeSection.catalog?.status === "loading"
                                }
                                onClick={() => {
                                  updateRuntimeUiSection(
                                    activeRuntimeManager.id,
                                    activeRuntimeSection.id,
                                    "remoteOpen",
                                    true
                                  );
                                  onRuntimeRefresh(
                                    activeRuntimeManager.id,
                                    activeRuntimeSection.id,
                                    { latestOnly: false }
                                  );
                                }}
                                title={activeRuntimeRefreshAllLabel}
                                aria-label={activeRuntimeRefreshAllLabel}
                              >
                                All versions...
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="runtimeSectionBody">
                          <div className="runtimeMeta">
                            {activeRuntimeSection.catalog?.status === "loading" ? (
                              <span className="dim">Fetching remote versions</span>
                            ) : activeRuntimeSection.catalog?.latestAvailableVersion ? (
                              <span className="dim">
                                Latest remote{" "}
                                {formatRuntimeVersionTag(
                                  activeRuntimeSection.catalog.latestAvailableVersion,
                                  activeRuntimeSection
                                )}
                              </span>
                            ) : (
                              <span className="dim">Remote versions not loaded</span>
                            )}
                            {activeRuntimeSection.catalog?.latestInstalledVersion && (
                              <span className="dim">
                                Latest installed{" "}
                                {formatRuntimeVersionTag(
                                  activeRuntimeSection.catalog.latestInstalledVersion,
                                  activeRuntimeSection
                                )}
                              </span>
                            )}
                          </div>

                          {activeRuntimeSection.catalog?.status === "error" &&
                            activeRuntimeSection.catalog?.error && (
                              <div className="dim">
                                Remote fetch failed: {activeRuntimeSection.catalog.error}
                              </div>
                            )}

                          {activeRuntimeRemoteOpen && (
                            <div className="runtimeRemote">
                              <div className="runtimeRemoteField">
                                <div className="fieldLabel">Version</div>
                                <select
                                  className="input"
                                  value={activeRuntimeInstallVersion}
                                  disabled={
                                    !activeRuntimeSection.catalog?.versions ||
                                    activeRuntimeSection.catalog.versions.length === 0
                                  }
                                  onChange={e =>
                                    updateRuntimeUiSection(
                                      activeRuntimeManager.id,
                                      activeRuntimeSection.id,
                                      "installVersion",
                                      e.target.value
                                    )
                                  }
                                >
                              {activeRuntimeSection.catalog?.versions &&
                              activeRuntimeSection.catalog.versions.length > 0 ? (
                                activeRuntimeSection.catalog.versions.map((v: string) => {
                                  const installed = isRuntimeVersionInstalled(
                                    activeRuntimeInstalled,
                                    v,
                                    activeRuntimeResolvedInstallVariant,
                                    activeRuntimeHasVariants
                                  );
                                  return (
                                    <option key={v} value={v}>
                                      {formatRuntimeVersionTag(v, activeRuntimeSection)}
                                      {installed ? " [Installed]" : ""}
                                    </option>
                                  );
                                })
                                  ) : (
                                    <option value="">No remote versions loaded</option>
                                  )}
                                </select>
                              </div>
                              {activeRuntimeHasMultipleVariants && (
                                  <div className="runtimeRemoteField">
                                    <div className="fieldLabel">Variant</div>
                                    <select
                                      className="input"
                                      value={activeRuntimeInstallVariant}
                                      onChange={e =>
                                        updateRuntimeUiSection(
                                          activeRuntimeManager.id,
                                          activeRuntimeSection.id,
                                          "installVariant",
                                          e.target.value
                                        )
                                      }
                                    >
                                      {activeRuntimeVariants.map((variant: any) => (
                                        <option key={variant.id} value={variant.id}>
                                          {variant.label || variant.id}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                              <button
                                className="btn primary"
                                disabled={
                                  activeRuntimeUi.busy ||
                                  activeRuntimeInstalling ||
                                  !activeRuntimeInstallVersion ||
                                  activeRuntimeSelectedInstalled
                                }
                                onClick={() => {
                                  onRuntimeInstall(
                                    activeRuntimeManager.id,
                                    activeRuntimeSection.id,
                                    activeRuntimeInstallVersion,
                                    activeRuntimeResolvedInstallVariant || undefined
                                  );
                                }}
                              >
                                Install
                              </button>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="saveSection runtimeSection">
                        <div className="saveSectionTitle runtimeInstalledHeader">
                          <span>Installed versions</span>
                          <span className="runtimeInstalledHeaderRight">
                            <span className="dim">Sort</span>
                            <select
                              className="input inputSmall"
                              value={activeRuntimeInstalledSort}
                              onChange={e =>
                                updateRuntimeUiSection(
                                  activeRuntimeManager.id,
                                  activeRuntimeSection.id,
                                  "installedSort",
                                  e.target.value
                                )
                              }
                            >
                              <option value="default">Default first</option>
                              <option value="newest">Newest first</option>
                              <option value="oldest">Oldest first</option>
                              <option value="path">Path</option>
                            </select>
                          </span>
                        </div>
                        {activeRuntimeInstalledSorted.length === 0 ? (
                          <div className="empty">No runtime versions installed yet.</div>
                        ) : (
                          <div className="saveList">
                            {activeRuntimeInstalledSorted.map(inst => {
                              const isDefault =
                                inst.version === activeRuntimeSection.defaultVersion &&
                                (activeRuntimeSection.defaultVariant
                                  ? inst.variant === activeRuntimeSection.defaultVariant
                                  : true);
                              const variantLabel = activeRuntimeHasMultipleVariants
                                ? activeRuntimeVariants.find(
                                    (variant: any) => variant.id === inst.variant
                                  )?.label || inst.variant
                                : "";
                              return (
                                <div
                                  className="saveRow"
                                  key={`${inst.version}-${inst.platformKey}-${inst.variant}`}
                                >
                                  <div className="saveRowMain">
                                    <div className="saveName">
                                      {formatRuntimeVersionTag(inst.version, activeRuntimeSection)}
                                      {isDefault && (
                                        <span className="badge badgeAccent">Default</span>
                                      )}
                                      {activeRuntimeHasMultipleVariants && inst.variant && (
                                        <span className="badge">{variantLabel}</span>
                                      )}
                                      {inst.platformKey && (
                                        <span className="dim">· {inst.platformKey}</span>
                                      )}
                                    </div>
                                    <div className="dim mono ellipsis runtimePath">
                                      {inst.installDir}
                                    </div>
                                  </div>
                                  <div className="saveRowActions">
                                    {!isDefault && (
                                      <>
                                        <button
                                          className="link"
                                          disabled={activeRuntimeUi.busy}
                                          onClick={() =>
                                            onRuntimeSetDefault(
                                              activeRuntimeManager.id,
                                              activeRuntimeSection.id,
                                              inst.version,
                                              inst.variant
                                            )
                                          }
                                        >
                                          Set default
                                        </button>
                                        <span className="sep">·</span>
                                      </>
                                    )}
                                    <button
                                      className="btn iconOnly danger"
                                      title="Uninstall"
                                      aria-label="Uninstall"
                                      disabled={
                                        activeRuntimeUi.busy ||
                                        activeRuntimeInstalling
                                      }
                                      onClick={() =>
                                        onRuntimeUninstall(
                                          activeRuntimeManager.id,
                                          activeRuntimeSection.id,
                                          inst
                                        )
                                      }
                                    >
                                      <svg
                                        viewBox="0 0 24 24"
                                        width="18"
                                        height="18"
                                        aria-hidden="true"
                                        focusable="false"
                                      >
                                        <path
                                          fill="currentColor"
                                          d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v9h-2V9zm4 0h2v9h-2V9zM6 7h12l-1 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7z"
                                        />
                                      </svg>
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                  </div>
                </div>
              ) : (
                <div className="empty">No runtime managers available.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

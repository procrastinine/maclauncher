export type ModuleId = string;
export type RuntimeId = string;

export type ModuleUiCondition = {
  key: string;
  equals?: unknown;
  notEquals?: unknown;
  truthy?: boolean;
  falsy?: boolean;
  endsWith?: string;
};

export type ActionIconId = "refresh" | "x" | "folder" | "download";

export type ModuleUiField = {
  key: string;
  label: string;
  format?: "boolean" | "date" | "path" | "string";
  empty?: string;
  hiddenWhen?: ModuleUiCondition[];
};

export type ModuleUiAction = {
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

export type ModuleUiGroup = {
  id: string;
  label: string;
  labelKey?: string;
  actions: string[];
  note?: string;
  infoFields?: ModuleUiField[];
  hideEmptyValue?: boolean;
  hiddenWhen?: ModuleUiCondition[];
};

export type ModuleUiCheatsPatch = {
  id: string;
  label: string;
  statusKey: string;
  addAction: string;
  removeAction: string;
};

export type ModuleUi = {
  infoFields?: ModuleUiField[];
  actions?: ModuleUiAction[];
  actionGroups?: ModuleUiGroup[];
  cheatsStatusAction?: string;
  cheatsPatches?: ModuleUiCheatsPatch[];
  cheatsMode?: "default" | "patches";
};

export type RuntimeSettingField = {
  key: string;
  type: "boolean" | "number" | "string" | "select" | "list";
  label: string;
  description?: string;
  default?: unknown;
  options?: Array<{ value: string; label: string }>;
};

export type RuntimeSettingsSchema = {
  defaults?: Record<string, unknown>;
  fields: RuntimeSettingField[];
};

export type RuntimeEntry = {
  label?: string;
  settings?: RuntimeSettingsSchema | null;
};

export type ModuleManifest = {
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
    managerSectionOverrideKey?: Record<string, string>;
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

export type ModuleSupports = {
  cheats: boolean;
  cheatsPatcher: boolean;
  saveEditing: boolean;
  saveLocation: boolean;
};

export type LauncherSettings = {
  showIcons: boolean;
  showNonDefaultTags: boolean;
};

export type CheatsConfig = Record<string, any>;

export type CheatsField = {
  key: string;
  type: "boolean" | "number";
  label: string;
  category: string;
  common?: boolean;
  min?: number;
  max?: number;
  step?: number;
};

export type CheatsSchema = {
  defaults: CheatsConfig;
  fields: CheatsField[];
};

export type RecentGame = {
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

export type RuntimeManagerState = {
  id: string;
  label: string;
  sections?: Array<Record<string, any>>;
  [key: string]: any;
};

export type DownloadTask = {
  id: string;
  label: string;
  detail: string | null;
  kind: string;
  managerId: string | null;
  sectionId: string | null;
  version: string | null;
  variant: string | null;
  downloaded: number;
  total: number | null;
  status: string;
  startedAt: number | null;
  error: string | null;
};

export type RuntimeStatusEntry = {
  runtimeId: RuntimeId;
  status: any;
};

export type RuntimeNoticeLine = {
  text: string;
  mono?: boolean;
};

export type RuntimeNotice = {
  title: string;
  lines: RuntimeNoticeLine[];
};

export type LauncherState = {
  recents: RecentGame[];
  modules: ModuleManifest[];
  moduleSettings: Record<string, Record<string, any>>;
  moduleStates: Record<string, Record<string, any>>;
  runtimeManagers: Record<string, RuntimeManagerState>;
  runtimeDefaults: Record<string, Record<string, any>>;
  launcherSettings: LauncherSettings;
  running: Record<string, number>;
  downloads: DownloadTask[];
  debug: boolean;
  logPath: string;
};

export type RuntimeSettingsContext = {
  scope: "module" | "game";
  moduleId: ModuleId;
  runtimeId: RuntimeId;
  gamePath?: string;
};

export type SaveInfo = {
  saveDir: string;
  moduleId: ModuleId;
  moduleLabel: string;
  moduleShortLabel: string;
  name: string;
};

export type SaveFileInfo = {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
};

export type CheatsPatchStatus = Record<string, any>;

export type LibsPatchStatus = Record<string, any>;

export type IconSize = number | string;

export type RuntimeUiState = Record<
  string,
  {
    remoteOpen: Record<string, boolean>;
    installVersion: Record<string, string>;
    installVariant: Record<string, string>;
    installedSort: Record<string, "default" | "newest" | "oldest" | "path">;
    error: string | null;
  }
>;

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
        cancelDownload(downloadId: string): Promise<boolean>;
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
        ): Promise<any>;
        moduleAction(
          gamePath: string,
          action: string,
          payload?: Record<string, any>
        ): Promise<any>;
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

export type LauncherApi = NonNullable<Window["MacLauncher"]>["launcher"];

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
  cancellable?: boolean;
  inspector?: boolean;
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
  collapsed?: boolean;
  inlineActions?: boolean;
  hiddenWhen?: ModuleUiCondition[];
};

export type ModuleUiCheatsPatch = {
  id: string;
  label: string;
  statusKey: string;
  addAction: string;
  removeAction: string;
};

export type ModuleAccountProvider = { label: string; stateAction: string; signInAction: string; signInLabel?: string; signInPayload?: Record<string, unknown>; removeAction: string; runtimeIds?: RuntimeId[] };

export type ModuleUi = {
  settingsOrder?: number;
  accounts?: ModuleAccountProvider;
  accountProviders?: ModuleAccountProvider[];
  detection?: { showVersion?: boolean };
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
  optionsAction?: string;
  optionsKey?: string;
  gameOnly?: boolean;
  visibleWhen?: ModuleUiCondition[];
  hiddenWhen?: ModuleUiCondition[];
  disabledWhen?: ModuleUiCondition[];
  checkedValue?: boolean;
  checkedLabel?: string;
  uncheckedLabel?: string;
  legacyValues?: Array<{ value: string | number | boolean; replacement: string }>;
  listSeparator?: "newline";
};

export type RuntimeSettingsSchema = {
  defaults?: Record<string, unknown>;
  fields: RuntimeSettingField[];
};

export type RuntimeEntry = {
  label?: string;
  description?: string;
  requirements?: string;
  preparation?: string;
  dataNotice?: string;
  networkAccess?: boolean;
  graphicsHost?: "window" | "remote" | "explicit" | "catalyst";
  graphicsArchitecture?: "arm64" | "x86_64";
  settings?: RuntimeSettingsSchema | null;
};

export type ModuleManifest = {
  id: ModuleId;
  detection?: {
    inputKinds?: string[];
    binaryFormats?: string[];
    extensions?: Array<{ extension: string; exclusive?: boolean }>;
  };
  icon?: { path: string; kind?: "logo" | "symbol" };
  family: string;
  label: string;
  shortLabel: string;
  gameType: string;
  runtime: {
    default: RuntimeId;
    supported: RuntimeId[];
    providers?: RuntimeId[];
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
    managerSectionAuto?: Record<string, { defaultKey: string; minimum?: boolean }>;
    managerVersionSectionBy?: Record<string, "major">;
    inspectorSections?: Record<string, "all" | { exclude?: string[] }>;
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
    launch?: boolean;
    cheats: boolean;
    cheatsPatcher: boolean;
    saveEditing: boolean;
    structuredSaveEditing?: boolean;
    saveLocation: boolean;
    saveLocationOverride?: boolean;
  };
  settingsDefaults: Record<string, unknown>;
  ui?: ModuleUi | null;
  acknowledgments?: Array<{ label: string; url: string }>;
};

export type ModuleSupports = {
  launch?: boolean;
  cheats: boolean;
  cheatsPatcher: boolean;
  saveEditing: boolean;
  structuredSaveEditing?: boolean;
  saveLocation: boolean;
  saveLocationOverride?: boolean;
};

export type LauncherSettings = {
  showIcons: boolean;
  showNonDefaultTags: boolean;
  networkAccess?: boolean;
  library?: {
    version: number;
    order: string[];
    sort: import("../../../core/library-view.mjs").LibrarySort;
    favorites: string[];
  };
};

export type LibraryBulkResult = { removedPaths: string[]; failures: Array<{ gamePath: string; error: string }> };

export type CheatsConfig = Record<string, any>;

export type GameReShadeSettings = { enabled: boolean; preset: string; effectPath?: string | null; effects?: string[] | null; parameters?: Record<string, number[]> | null };
export type ShaderFormat = "fx" | "slangp" | "slang" | "libplacebo";
export type ShaderTraits = { category?: "upscaling" | "downscaling" | "scaling" | "restoration" | "chroma" | "crt" | "color" | "effects"; neural?: boolean; geometryKnown?: boolean; outputScale?: { x: number; y: number }; conditionalGeometry?: boolean; displayDependentGeometry?: boolean;
  unresolvedGeometry?: boolean; requiresVideoPlanes?: boolean; rgbCompatible?: boolean };
export type ReShadeFilter = { id: string; name: string; path: string; format?: ShaderFormat | null; available: boolean; reason?: string };
export type ShaderParameter = { name: string; label: string; type: "float" | "int" | "bool"; default: number[]; min?: number; max?: number; step?: number; description?: string;
  mode?: string; constant?: boolean; options?: Array<{ value: number; label: string }> };
export type GameGraphicsSettings = { spatialShader?: GameReShadeSettings | null; spatialMethod: "off" | "bilinear" | "metalfx" | "fsr1" | "mako" | "ls1" | "nearest" | "bicubic" | `libplacebo:${string}`;
  neuralMethod: "off" | "mlx-dlss"; neuralModelPath: string | null; neuralInputScale: number | null; neuralInputHeight: number | null; neuralIntensity: number; neuralTemporal: boolean;
  temporalMethod: "off" | "metalfx" | "fsr2" | "fsr3" | "fsr4"; temporalSharpness: number;
  effectPlacement: "before" | "after";
  spatialMultiplier: number | null; spatialSharpness: number; ls1Mode: "quality" | "performance"; frameGeneration: "off" | "lsfg"; frameMultiplier: number;
  framePacing: "fixed" | "adaptive"; targetFps: number; smoothCadence: boolean;
  lsfgMode: "quality" | "performance"; lsfgFp16: boolean; lsfgFlowScale: number; modelVersion: string | null };
export type GraphicsInputs = { cameraProjection: boolean; source: string; methods: string[]; requiresDownload?: boolean;
  nativeVideo?: boolean; shaderBindingsNextLaunch?: boolean;
  nativeSpatialMethods?: string[]; nativeSpatialMethodLabels?: Record<string, string>;
  sourceResolution?: false | { heights: boolean; multipliers: number[]; control?: string; live?: boolean; methods?: string[]; methodLabels?: Record<string, string> }; spatialBindingsNextLaunch?: boolean;
  depth?: boolean; motionVectors?: boolean; architecture?: "arm64" | "x86_64";
  temporalSource?: string; temporalOutput?: string; commandBuffer?: string };
export type GraphicsCapabilities = { spatial: boolean; temporal?: boolean; temporalMethods?: string[]; cameraTemporalMethods?: string[]; effectPlacement?: boolean; frameGeneration: boolean; adaptive?: boolean; liveSwitching?: boolean; virtualWindow?: boolean | {activationAPI: 1}; spatialMethods: string[]; spatialMethodLabels?: Record<string, string>; frameGenerationMethods: string[]; resolutionMultipliers?: number[]; resolutionScope?: "metal" };
export type VideoEffectNode =
  | { id: string; kind: "shader"; enabled: boolean; shader: GameReShadeSettings }
  | { id: string; kind: "spatial" | "temporal" | "frame-generation"; enabled: boolean; method: string; settings?: Partial<GameGraphicsSettings>; outputSize?: { width?: number; height?: number }; presentationScale?: number }
  | { id: string; kind: "neural"; enabled: boolean; method: "mlx-dlss"; settings: {modelPath: string | null; temporal: boolean; intensity: number} };
export type GameEffectsPlan = { schema: 1; mode: "advanced"; video: VideoEffectNode[]; renderResolution?: {height: number; maximum?: true; method?: string} | {multiplier: number; method?: string} | null };
type VideoEffectTemplate<Node = VideoEffectNode> = Node extends VideoEffectNode ? Omit<Node, "id"> : never;
export type EffectCatalogRow = { id: string; kind: VideoEffectNode["kind"]; label: string; group: string; category?: string;
  template: VideoEffectTemplate;
  available: boolean; availableWithoutModel?: boolean; reason?: string; requirements?: string[] };
export type GameEffectsInfo = { mode: "simple" | "advanced"; live?: boolean; plan: GameEffectsPlan; catalog: EffectCatalogRow[];
  sourceResolution?: { heights: boolean; multipliers: number[]; live?: boolean; methods?: string[]; methodLabels?: Record<string, string> }; shaderBindingsNextLaunch?: boolean;
  selectedShaderTraits?: ShaderTraits; templates?: EffectsChainTemplate[] };
export type GraphicsProcessingPhase = "unknown" | "prepared" | "encoded" | "completed" | "presented" | "bypassed" | "failed" | "stopped";
export type GraphicsStageStatus = {id: string; requestedMethod: string; activeMethod: string; reason: string; phase: GraphicsProcessingPhase;
  input: {width: number; height: number}; output: {width: number; height: number}; frameId: number; encoded: number; completed: number; presented: number; observedAt: number};
export type GraphicsContextStatus = {pid: number; id: string; phase: GraphicsProcessingPhase; frameId: number; encoded: number; completed: number;
  presentedReal: number; presentedGenerated: number; sourceTime: number; presentedTime: number; input: {width: number; height: number}; output: {width: number; height: number};
  requestedBytes: number; admittedBytes: number; planRevision: string; controlsDigest: string; reason: string; observedAt: number; matchesPrepared: boolean; identityState: "matching" | "previous" | "unverified"; historical: boolean;
  processStart: {seconds: number; microseconds: number}; stages: GraphicsStageStatus[];
  admission?: {reason: string; observedAt: number; counts: Record<string, number>; queue: string; generation: number; format: number; width: number; height: number}};
export type GameGraphicsStatus = {state: "off" | "stopped" | "unbound" | "unavailable" | "prepared" | "observed" | "historical" | "unverified"; reason?: string; launchId?: string; launchPid?: number;
  prepared?: {mode: "simple" | "advanced"; planRevision: string; controlsDigest: string} | null;
  preparation?: {requested?: Array<{id: string; kind: string; method: string}>; applied?: Array<{id: string; kind: string; method: string}>;
    skipped?: Array<{id: string; reason: string}>; pending?: Array<{id: string; kind: string; method: string; reason: string; retained: boolean}>} | null;
  contexts: GraphicsContextStatus[]};
export type EffectsChainTemplate = { id: string; name: string; plan: GameEffectsPlan; available: boolean; reason?: string };
export type EffectsPreset = { id: string; name: string; updatedAt: number; plan: GameEffectsPlan };
export type EffectsPresetInput = { id?: string; name: string; updatedAt?: number; plan: GameEffectsPlan };
export type ReShadeState = { available: boolean; neuralAvailable?: boolean; reason?: string; shaderParameters?: boolean; shaderLiveSwitching?: boolean; presets: Array<{ id: string; label: string; available?: boolean; reason?: string; installed?: boolean; group?: string; depthHosts?: string[];
  format?: ShaderFormat; nativeVideo?: boolean; nativeVideoAvailable?: boolean; traits?: ShaderTraits }>; version?: string;
  filters?: ReShadeFilter[]; filtersError?: string;
  graphics?: GraphicsCapabilities & { hosts?: Partial<Record<"window" | "remote" | "explicit" | "catalyst", GraphicsCapabilities>> };
  models?: Array<{ version: string; label: string; capabilities: string[] }>; defaultModelVersion?: string | null;
  neuralModels?: Array<{ version: string; versionLabel?: string; modelPath: string }> };

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
  notes?: string;
  networkAccess?: boolean | null;
  reshade?: GameReShadeSettings;
  graphics?: GameGraphicsSettings;
  graphicsWarnings?: string[];
  effects?: GameEffectsPlan | null;
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
  saveLocations?: Array<{ directory: string; role?: string; label?: string; source?: string; confidence?: string }>;
  saveDirOverride: string | null;
  nativeAppPath: string | null;
  lastBuiltAt: number | null;
  runtimeId: RuntimeId;
  runtimeData: Record<string, any>;
  runtimeSettings: Record<string, any>;
  launchArguments?: string;
  moduleData: Record<string, any>;
  cheats: CheatsConfig | null;
  iconPath: string | null;
  iconSource: string | null;
  iconUrl: string | null;
  lastPlayedAt: number | null;
};

export type RuntimeRefreshOptions = { sourceId?: string; latestOnly?: boolean };

export type RuntimeManagerState = {
  id: string;
  label: string;
  ui?: { groupId?: string; tabLabel?: string; order?: number; sectionLabel?: string; memberOrder?: number;
    management?: "managed" | "built-in"; sectionManagement?: Record<string, "managed" | "built-in">; library?: "shaders"; position?: "last" };
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

export type GamePreparation = {
  phase: string;
  label: string;
  managerId?: string;
  version?: string;
  percent?: number;
  downloaded?: number;
  total?: number | null;
};

export type GameFailure = { gamePath: string; message: string };
export type ImportProgress = { inputPath: string; phase: string; completed?: number; total?: number; cached?: boolean };

export type UtilityWindowRequest = { view: "settings" | "runtimes" | "credits" | "external"; managerId?: string; sectionId?: string };
export type UtilityWindowContext = UtilityWindowRequest & { revision?: number };

export type LauncherState = {
  reshade?: ReShadeState;
  utilityWindow?: UtilityWindowContext;
  recents: RecentGame[];
  modules: ModuleManifest[];
  moduleSettings: Record<string, Record<string, any>>;
  moduleStates: Record<string, Record<string, any>>;
  runtimeManagers: Record<string, RuntimeManagerState>;
  runtimeDefaults: Record<string, Record<string, any>>;
  launcherSettings: LauncherSettings;
  running: Record<string, number>;
  preparing?: Record<string, GamePreparation>;
  importing?: ImportProgress[];
  downloads: DownloadTask[];
  debug: boolean;
  logPath: string;
};

export type LauncherActivity = Partial<Pick<LauncherState, "running" | "preparing" | "importing" | "downloads">>;

export type RuntimeSettingsContext = {
  scope: "module" | "game";
  moduleId: ModuleId;
  runtimeId: RuntimeId;
  gamePath?: string;
};

export type SaveInfo = {
  saveDir: string;
  directoryChoices?: Array<{ directory: string; role?: string; label?: string }>;
  moduleId: ModuleId;
  moduleLabel: string;
  moduleShortLabel: string;
  name: string;
  canEditJson: boolean;
  structuredActions: { inspectAction: string; editAction: string } | null;
};

export type SaveScalar = string | number | boolean | null;
export type StructuredSaveRow = {
  id: number; name: string; value: SaveScalar; editable: boolean; reason?: string; valueType?: string;
};
export type StructuredActorField = {
  key: "hp" | "mp" | "tp" | "level"; label: string; value: SaveScalar; editable: boolean; reason?: string;
};
export type StructuredSaveInspection = {
  engineId: string; fileName: string; sourceHash: string; warnings: string[];
  sections: {
    switches: StructuredSaveRow[]; variables: StructuredSaveRow[];
    gold: { value: SaveScalar; editable: boolean; reason?: string } | null;
    inventory: Record<"items" | "weapons" | "armors", StructuredSaveRow[]>;
    actors: Array<{ id: number; name: string; fields: StructuredActorField[] }>;
  };
  changed?: number; backupPath?: string | null; snapshotId?: string;
};
export type StructuredSaveChange =
  | { kind: "switch" | "variable"; id: number; value: SaveScalar }
  | { kind: "gold"; value: number }
  | { kind: "inventory"; category: "items" | "weapons" | "armors"; id: number; value: number }
  | { kind: "actor"; id: number; field: StructuredActorField["key"]; value: number };
export type SaveSnapshot = {
  id: string; createdAt: number; reason: string; totalBytes: number;
  files: Array<{ name: string; size: number; sha256: string }>;
};
export type SaveSnapshotPreview = {
  snapshotId: string; createdAt: number; expectedStateHash: string;
  changes: Array<{ name: string; operation: "replace" | "create"; size: number }>;
  keptFiles: string[];
};
export type SaveActionRunner = (action: string, payload?: Record<string, unknown>) => Promise<any>;

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
    sourceErrors?: Record<string, string | null>;
    pendingActions?: Record<string, string | null>;
    messages?: Record<string, string | null>;
  }
>;

declare global {
  interface Window {
    MacLauncher?: {
      launcher: {
        getState(): Promise<LauncherState>;
        openUtilityWindow(request: UtilityWindowRequest): Promise<boolean>;
        steamState: import("./components/SteamView").SteamApi["steamState"];
        steamScan: import("./components/SteamView").SteamApi["steamScan"];
        steamImport: import("./components/SteamView").SteamApi["steamImport"];
        steamImportDownload: import("./components/SteamView").SteamApi["steamImportDownload"];
        steamConnect: import("./components/SteamView").SteamApi["steamConnect"];
        steamSelectAccount: import("./components/SteamView").SteamApi["steamSelectAccount"];
        steamRemoveAccount: import("./components/SteamView").SteamApi["steamRemoveAccount"];
        externalState: import("./components/ExternalStoreView").ExternalStoreApi["externalState"];
        externalDownloaded: import("./components/SteamView").SteamApi["externalDownloaded"];
        externalImportCopies: import("./components/SteamView").SteamApi["externalImportCopies"];
        externalOpenDownloads: import("./components/ExternalStoreView").ExternalStoreApi["externalOpenDownloads"];
        externalConnect: import("./components/ExternalStoreView").ExternalStoreApi["externalConnect"];
        externalDisconnect: import("./components/ExternalStoreView").ExternalStoreApi["externalDisconnect"];
        externalForget: import("./components/ExternalStoreView").ExternalStoreApi["externalForget"];
        externalAuth: import("./components/ExternalStoreView").ExternalStoreApi["externalAuth"];
        externalOpenLogin: import("./components/ExternalStoreView").ExternalStoreApi["externalOpenLogin"];
        externalLibrary: import("./components/ExternalStoreView").ExternalStoreApi["externalLibrary"];
        externalSearch: import("./components/ExternalStoreView").ExternalStoreApi["externalSearch"];
        externalAddToLibrary: import("./components/ExternalStoreView").ExternalStoreApi["externalAddToLibrary"];
        externalAccounts: import("./components/ExternalStoreView").ExternalStoreApi["externalAccounts"];
        externalOpenAccounts: import("./components/ExternalStoreView").ExternalStoreApi["externalOpenAccounts"];
        externalAddGame: import("./components/ExternalStoreView").ExternalStoreApi["externalAddGame"];
        externalVersions: import("./components/ExternalStoreView").ExternalStoreApi["externalVersions"];
        externalDownload: import("./components/ExternalStoreView").ExternalStoreApi["externalDownload"];
        externalCancel: import("./components/ExternalStoreView").ExternalStoreApi["externalCancel"];
        externalImportDownload: import("./components/ExternalStoreView").ExternalStoreApi["externalImportDownload"];
        onExternalState: import("./components/ExternalStoreView").ExternalStoreApi["onExternalState"];
        steamAuth: import("./components/SteamView").SteamApi["steamAuth"];
        steamDisconnect: import("./components/SteamView").SteamApi["steamDisconnect"];
        steamLibrary: import("./components/SteamView").SteamApi["steamLibrary"];
        steamVersions: import("./components/SteamView").SteamApi["steamVersions"];
        steamPreviousVersions: import("./components/SteamView").SteamApi["steamPreviousVersions"];
        steamOpenHistory: import("./components/SteamView").SteamApi["steamOpenHistory"];
        steamDownload: import("./components/SteamView").SteamApi["steamDownload"];
        steamCancel: import("./components/SteamView").SteamApi["steamCancel"];
        steamChooseDirectory: import("./components/SteamView").SteamApi["steamChooseDirectory"];
        onSteamState: import("./components/SteamView").SteamApi["onSteamState"];
        openGameDialog(): Promise<string[]>;
        getPathForFile(file: File): string | null;
        addRecent(inputPath: string): Promise<unknown>;
        cancelImport(inputPath: string): Promise<boolean>;
        forgetGame(gamePath: string): Promise<boolean>;
        findMissingGames(gamePaths: string[]): Promise<string[]>;
        forgetGames(gamePaths: string[]): Promise<LibraryBulkResult>;
        deleteGames(gamePaths: string[]): Promise<LibraryBulkResult>;
        setGameFavorite(gamePath: string, favorite: boolean): Promise<boolean>;
        setGameNotes(gamePath: string, notes: string): Promise<boolean>;
        setGameNetworkAccess(gamePath: string, enabled: boolean): Promise<boolean>;
        setGameLaunchArguments(gamePath: string, value: string): Promise<boolean>;
        setLibrarySort(sort: import("../../../core/library-view.mjs").LibrarySort): Promise<boolean>;
        moveGame(gamePath: string, delta: number): Promise<boolean>;
        reorderGame(gamePath: string, toIndex: number): Promise<boolean>;
        deleteGame(gamePath: string): Promise<boolean>;
        launchGame(gamePath: string): Promise<boolean>;
        openSaveEditor?(gamePath: string): Promise<boolean>;
        launchGameWithRuntime(gamePath: string, runtime: RuntimeId): Promise<boolean>;
        createGameCommand(gamePath: string): Promise<string | null>;
        stopGame(gamePath: string): Promise<boolean>;
        setGameRuntime(gamePath: string, runtime: RuntimeId): Promise<boolean>;
        setGameReShade(gamePath: string, patch: Partial<GameReShadeSettings>, expectedSelection?: Pick<GameReShadeSettings, "preset" | "effectPath" | "effects">): Promise<boolean>;
        getGameShaderParameters(gamePath: string): Promise<{ key: string; parameters: ShaderParameter[] }>;
        setGameGraphics(gamePath: string, patch: Partial<GameGraphicsSettings>, expectedSpatialShader?: Pick<GameReShadeSettings, "preset" | "effectPath" | "effects">): Promise<boolean>;
        listEffectsPresets(): Promise<EffectsPreset[]>;
        saveEffectsPreset(value: EffectsPresetInput): Promise<EffectsPreset>;
        deleteEffectsPreset(id: string, updatedAt: number): Promise<EffectsPreset[]>;
        getEffectsPresetEditor(plan?: GameEffectsPlan): Promise<GameEffectsInfo>;
        getEffectsPresetParameters(nodeId: string, plan: GameEffectsPlan): Promise<{ key: string; parameters: ShaderParameter[] }>;
        pickEffectsPresetFile(kind?: "neural-model"): Promise<string | null>;
        getGameEffects(gamePath: string): Promise<GameEffectsInfo>;
        getGameGraphicsStatus(gamePath: string): Promise<GameGraphicsStatus>;
        setGameEffects(gamePath: string, plan: GameEffectsPlan): Promise<boolean>;
        resetGameEffects(gamePath: string): Promise<boolean>;
        getGameEffectParameters(gamePath: string, nodeId: string, draftPlan?: GameEffectsPlan): Promise<{ key: string; parameters: ShaderParameter[] }>;
        pickGameEffectFile(gamePath: string, kind?: "neural-model"): Promise<string | null>;
        ensureGameGraphicsModel(gamePath: string, kind: "neural" | "lossless", patch?: Partial<GameGraphicsSettings>): Promise<{modelPath?: string; modelVersion?: string} | null>;
        pickGameReShadeEffect(gamePath: string): Promise<string | null>;
        importReShadeFilters(family?: "reshade" | "libretro" | "mpv"): Promise<ReShadeFilter[] | null>;
        updateReShadeFilter(id: string, patch: { name?: string; path?: string }): Promise<boolean>;
        removeReShadeFilter(id: string): Promise<boolean>;
        pickReShadeFilterPath(id: string): Promise<string | null>;
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
          payload?: Record<string, any>,
          options?: { requestId: string }
        ): Promise<any>;
        cancelModuleAction(requestId: string): Promise<boolean>;
        moduleSettingsAction(moduleId: string, action: string, payload?: Record<string, any>): Promise<any>;
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
        selectSaveLocation(gamePath: string, directory: string): Promise<boolean>;
        listSaveFiles(gamePath: string): Promise<SaveFileInfo[]>;
        importSaveDir(gamePath: string): Promise<boolean | null>;
        exportSaveDir(gamePath: string): Promise<string | null>;
        importSaveFiles(gamePath: string): Promise<boolean | null>;
        readSaveJson(gamePath: string, fileName: string): Promise<string>;
        writeSaveJson(
          gamePath: string,
          fileName: string,
          json: string,
          expectedHash?: string
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
        onActivity(callback: (activity: LauncherActivity) => void): () => void;
        onGameImported(callback: (gamePath: string) => void): () => void;
        onGameFailed?(callback: (failure: GameFailure) => void): () => void;
      };
    };
  }
}

export type LauncherApi = NonNullable<Window["MacLauncher"]>["launcher"];

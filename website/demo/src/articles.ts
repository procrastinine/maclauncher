// What the article panel shows for each demo action. Paths are relative to
// the site root; the website build checks that every page and anchor exists.
// Each topic kind resolves through one table or rule below, most specific
// section first.
import type { DemoTopic } from "./mock/store";

export type Article = { title: string; path: string };

const page = (title: string, path: string): Article => ({ title, path });
const launcher = (title: string, anchor: string) => page(title, `launcher/#${anchor}`);
const versions = (title: string, anchor: string) => page(title, `tools/versions-and-settings/#${anchor}`);
const upscaling = (title: string, anchor: string) => page(title, `graphics/upscaling/#${anchor}`);
const frames = (title: string, anchor: string) => page(title, `graphics/frame-generation/#${anchor}`);
const neural = (title: string, anchor: string) => page(title, `graphics/neural-restoration/#${anchor}`);
const color = (title: string, anchor: string) => page(title, `graphics/color-and-light/#${anchor}`);
const crt = (title: string, anchor: string) => page(title, `graphics/crt-and-retro/#${anchor}`);
const composing = (title: string, anchor: string) => page(title, `graphics/composing-effects/#${anchor}`);

export const ARTICLES = {
  intro: page("What is MacLauncher?", "introduction/"),
  start: page("Getting started", "getting-started/"),
  play: page("Pressing Play", "getting-started/#5-press-play"),
  howGamesRun: page("How games run on a Mac", "background/how-games-run/"),
  nativeRuntimes: page("Native runtimes", "background/how-games-run/#native-runtimes-use-the-engine-that-already-runs-on-macos"),
  choosing: page("Choosing a runtime", "background/choosing-a-runtime/"),
  windowsChoice: page("Windows games: native, Sikarugir or CrossOver", "background/choosing-a-runtime/#windows-games"),
  androidChoice: page("Choosing an Android runtime", "background/choosing-a-runtime/#android-games"),
  versions: page("How a version is chosen", "background/choosing-a-runtime/#versions"),

  library: launcher("The library", "the-library"),
  addGame: launcher("Adding games", "adding-games"),
  search: launcher("Search, filters and sorting", "search-filters-and-sorting"),
  favorites: launcher("Favorites and order", "favorites-and-order"),
  selecting: launcher("Selecting several games", "selecting-several-games"),
  rows: launcher("Each row", "each-row"),
  inspector: launcher("The inspector", "the-inspector"),
  files: launcher("Files", "files"),
  launch: launcher("Launch", "launch"),
  patches: launcher("Patches", "patches"),
  gameTools: launcher("Tools", "tools"),
  notes: launcher("Notes", "notes"),
  windows: launcher("Windows and menus", "windows-and-menus"),

  runtimesWindow: versions("Runtimes: one place for every version", "runtimes-one-place-for-every-version"),
  refresh: versions("Refreshing the version list", "refresh"),
  install: versions("Installing a version", "install"),
  remove: versions("Removing a version", "remove"),
  runtimeDefault: versions("The default version", "the-default"),
  ownCopies: versions("Your own copies", "your-own-copies"),
  downloadsList: versions("Downloads", "downloads"),
  perGame: versions("Per-game choices", "per-game-choices"),
  runtimeAndVersion: versions("Runtime and version", "runtime-and-version"),
  runtimeSettings: versions("Runtime settings", "runtime-settings"),
  launchArguments: versions("Launch arguments", "launch-arguments"),
  networkAccess: versions("Network access", "network-access"),
  steamClient: versions("Steam client on Play", "steam-client-on-play"),
  saveLocation: versions("Save location", "save-location"),
  settings: versions("Settings", "settings"),
  shortcuts: versions("Shortcuts", "shortcuts"),

  external: page("Stores and downloads", "tools/stores-and-downloads/"),
  installedGames: page("Games you already have", "tools/stores-and-downloads/#games-you-already-have"),
  downloads: page("Downloading what you own", "tools/stores-and-downloads/#downloading-what-you-own"),
  accounts: page("Store accounts", "tools/stores-and-downloads/#accounts"),
  saves: page("Save tools", "tools/saves-and-cheats/#save-tools"),
  snapshots: page("Save snapshots", "tools/saves-and-cheats/#snapshots"),
  movingSaves: page("Moving saves around", "tools/saves-and-cheats/#moving-saves-around"),
  saveEditor: page("Editing RPG Maker MV/MZ saves", "tools/saves-and-cheats/#editing-rpg-maker-mvmz-saves"),
  cheats: page("Cheats", "tools/saves-and-cheats/#cheats"),
  rpgMakerCheats: page("RPG Maker cheats", "tools/saves-and-cheats/#rpg-maker"),
  renpyCheats: page("The Ren'Py console", "tools/saves-and-cheats/#renpy"),
  decompilers: page("Decompilers and extractors", "tools/decompilers-and-extractors/"),
  credits: page("Credits and licenses", "about/credits/"),
  windowsGames: page("Windows games through WINE", "games/windows/"),
  games: page("Games and runtimes", "games/"),

  graphics: page("Graphics and effects", "graphics/"),
  simpleAdvanced: page("Simple and Advanced", "graphics/#simple-and-advanced"),
  graphicsHeading: page("The Graphics heading", "graphics/#the-graphics-heading"),
  chain: page("Building a chain", "graphics/composing-effects/"),
  order: composing("Top to bottom", "top-to-bottom"),
  rowsEditing: composing("Editing rows", "editing-rows"),
  sizes: composing("Render and output sizes", "sizes"),
  adaptiveQuality: composing("Adaptive quality", "adaptive-quality"),
  presets: composing("Presets", "presets"),
  compare: composing("Seeing what changed", "seeing-what-changed"),
  videoExport: composing("Videos too", "videos-too"),
  spatial: upscaling("Spatial upscalers", "spatial-upscalers"),
  temporal: upscaling("Temporal upscalers", "temporal-upscalers"),
  shaderUpscalers: upscaling("Shader upscalers", "shader-upscalers"),
  renderSize: upscaling("Render size versus window size", "render-size-versus-window-size"),
  gameResolution: upscaling("Game resolution", "game-resolution"),
  downsample: upscaling("Downsample", "downsample"),
  frameGeneration: page("Frame generation", "graphics/frame-generation/"),
  imagePair: frames("Image-pair and scene generators", "two-kinds-of-generators"),
  pacing: frames("Pacing", "pacing"),
  losslessFiles: frames("Getting Lossless Scaling files", "getting-lossless-scaling-files"),
  neural: page("Neural upscaling and restoration", "graphics/neural-restoration/"),
  neuralModels: neural("The models", "the-models"),
  gettingModels: neural("Getting models", "getting-models"),
  crt: page("CRT and retro", "graphics/crt-and-retro/"),
  builtInCrt: crt("The built-in CRT effect", "the-built-in-crt-effect"),
  moreCrt: crt("More CRT shaders", "more-crt-shaders"),
  palette: crt("Palette and other retro looks", "palette-and-other-retro-looks"),
  motionClarity: crt("Motion clarity", "motion-clarity"),
  color: page("Color, light and sharpening", "graphics/color-and-light/"),
  builtInEffects: color("The built-in effects", "the-built-in-effects"),
  depthEffects: color("Effects that use the game's depth", "effects-that-use-the-games-depth"),
  estimatedDepth: color("Depth without a depth buffer", "depth-without-a-depth-buffer"),
  luts: color("LUTs", "luts"),
  output: color("Final output", "final-output"),
  shaders: page("Shader collections and imports", "graphics/shaders/"),
  shaderLibrary: page("The shader library", "graphics/shaders/#the-shader-library"),
  shaderFormats: page("Shader formats", "graphics/shaders/#formats")
} satisfies Record<string, Article>;

const desktop = (title: string, anchor: string) => page(title, `games/desktop-engines/#${anchor}`);
const webGames = desktop("Web games: RPG Maker MV/MZ, Construct and friends", "web-games-rpg-maker-mvmz-construct-tyranobuilder-and-friends");
const novels = page("Visual novel engines", "games/visual-novels/#the-engines");
const mobile = (title: string, anchor: string) => page(title, `games/mobile-and-consoles/#${anchor}`);
const more = (title: string, anchor: string) => page(title, `games/more/#${anchor}`);
const otherEngines = more("Infinity Engine, MUGEN and HashLink", "infinity-engine-mugen-and-hashlink");

// Each registered game type's page. A type missing here falls back to the
// overview, and the website build reports it.
export const MODULE_ARTICLES: Record<string, Article> = {
  mv: webGames, mz: webGames, construct: webGames, tyrano: webGames, "gamemaker-html5": webGames, web: webGames,
  rgss: desktop("RPG Maker XP, VX and VX Ace", "rpg-maker-xp-vx-and-vx-ace"),
  easyrpg: desktop("RPG Maker 2000/2003 and WOLF RPG Editor", "rpg-maker-20002003-and-wolf-rpg-editor"),
  wolfrpg: desktop("RPG Maker 2000/2003 and WOLF RPG Editor", "rpg-maker-20002003-and-wolf-rpg-editor"),
  renpy: desktop("Ren'Py", "renpy"), godot: desktop("Godot", "godot"), gamemaker: desktop("GameMaker", "gamemaker"),
  unity: desktop("Unity", "unity"), fna: desktop("XNA and FNA", "xna-and-fna"), love: desktop("LÖVE", "löve"),
  java: desktop("Java", "java"), flash: desktop("Flash", "flash"),
  kirikiri: novels, siglus: novels, nscripter: novels, alicesoft: novels, mages: novels, nitroplus: novels,
  minori: novels, fvp: novels, ai5: novels, vnds: novels, bgi: novels, catsystem2: novels,
  crossover: ARTICLES.windowsGames,
  android: mobile("Android", "android"), ios: mobile("iOS and iPadOS", "ios-and-ipados"),
  anyps5: mobile("PlayStation 5", "playstation-5"), prosper: mobile("PlayStation 5", "playstation-5"),
  nxnative: mobile("Nintendo Switch", "nintendo-switch"),
  "generic-app": more("Mac apps and scripts", "mac-apps-and-scripts"), mac32: more("32-bit Mac apps", "32-bit-mac-apps"),
  dosbox: more("DOS games", "dos-games"), scummvm: more("Classic adventure games", "classic-adventure-games"),
  gemrb: otherEngines, ikemen: otherEngines, hashlink: otherEngines, haxe: otherEngines,
  video: more("Videos", "videos")
};

// Runtimes with their own anchor (`runtime-<id>`) on their game type's page.
export const RUNTIME_ANCHORS: Record<string, string[]> = {
  "games/desktop-engines/": ["electron", "nwjs", "nwjs-patched", "sdk", "butterscotch", "official-studio", "opengmk", "projector", "ruffle"],
  "games/visual-novels/": ["krkrsdl2", "siglus", "rlvm", "onsyuri_mac", "onscripter_en", "system3", "xsystem35", "xsystem4", "impacto",
    "npengine", "reminori", "rfvp", "ai5", "vnds_love", "bgi-tools", "catsystem2-tools"],
  "games/mobile-and-consoles/": ["prosper"],
  "games/more/": ["native"]
};
const choice = (title: string, anchor: string) => page(title, `background/choosing-a-runtime/#${anchor}`);
// Runtimes shared by many game types, with a section of their own.
const SHARED_RUNTIMES: Record<string, Article[]> = {
  crossover: [choice("CrossOver", "3-crossover-if-you-have-it"), page("CrossOver: bring your own", "games/windows/#crossover-bring-your-own")],
  sikarugir: [choice("Sikarugir (WINE)", "2-sikarugir-wine-managed-for-you"), page("Sikarugir: free, and managed for you", "games/windows/#sikarugir-free-and-managed-for-you")],
  native: [desktop("When a game ships its own Mac build", "when-a-game-ships-its-own-mac-build")],
  mac32: [more("32-bit Mac apps", "32-bit-mac-apps")],
  klepton: [choice("MacLauncher Android", "maclauncher-android-the-default")],
  macapk: [choice("Mac.apk", "macapk")],
  aim: [choice("AIM", "aim")]
};
// Runtimes that inspect a game rather than play it.
const INSPECTION_RUNTIMES = new Set(["inspection"]);

function engine(moduleId?: string) {
  return moduleId ? MODULE_ARTICLES[moduleId] || ARTICLES.games : ARTICLES.games;
}

/** The section for one runtime of one game type: its own anchor, a shared runtime's section, or the game type's page. */
export function runtimeArticles(runtimeId: string, moduleId?: string, label?: string): Article[] {
  const home = engine(moduleId), base = home.path.split("#")[0];
  if (RUNTIME_ANCHORS[base]?.includes(runtimeId)) return [page(label || home.title, `${base}#runtime-${runtimeId}`), home];
  if (SHARED_RUNTIMES[runtimeId]) return [...SHARED_RUNTIMES[runtimeId], home];
  if (INSPECTION_RUNTIMES.has(runtimeId)) return [home, ARTICLES.decompilers];
  return [home];
}

// Methods by "kind:method" prefix; the longest matching prefix wins.
const METHOD_ARTICLES: Record<string, Article[]> = {
  "upscale:nearest": [upscaling("Nearest, bilinear and bicubic", "classic-filters")],
  "upscale:bilinear": [upscaling("Nearest, bilinear and bicubic", "classic-filters")],
  "upscale:bicubic": [upscaling("Nearest, bilinear and bicubic", "classic-filters")],
  "upscale:libplacebo": [upscaling("libplacebo filters", "libplacebo-filters")],
  "upscale:metalfx": [upscaling("MetalFX Spatial", "metalfx-spatial")],
  "upscale:fsr1": [upscaling("AMD FSR 1", "fsr-1")],
  "upscale:mako": [upscaling("MAKO", "mako")],
  "upscale:ls1": [upscaling("Lossless Scaling LS1", "lossless-scaling-ls1"), ARTICLES.losslessFiles],
  "upscale:realesrgan": [neural("Real-ESRGAN", "real-esrgan"), ARTICLES.gettingModels],
  "upscale:realcugan": [neural("Real-CUGAN", "real-cugan"), ARTICLES.gettingModels],
  "upscale:mlx-vsr": [neural("RTX Video Super Resolution", "rtx-video-super-resolution"), ARTICLES.gettingModels],
  "upscale:mlx-sr-image": [neural("DLSS SR (image)", "dlss-sr-image"), ARTICLES.gettingModels],
  "downsample": [ARTICLES.downsample, ARTICLES.sizes],
  "temporal:metalfx": [upscaling("MetalFX Temporal", "metalfx-temporal")],
  "temporal:fsr2": [upscaling("FSR 2, 3 and 4", "fsr-temporal")],
  "temporal:fsr3": [upscaling("FSR 2, 3 and 4", "fsr-temporal")],
  "temporal:fsr4": [upscaling("FSR 2, 3 and 4", "fsr-temporal")],
  "temporal:asr": [upscaling("Arm ASR and Snapdragon GSR 2", "arm-asr-and-snapdragon-gsr-2")],
  "temporal:sgsr2": [upscaling("Arm ASR and Snapdragon GSR 2", "arm-asr-and-snapdragon-gsr-2")],
  "temporal:xess": [upscaling("Intel XeSS", "xess")],
  "temporal:mlx-sr-scene": [upscaling("DLSS SR", "dlss-sr"), ARTICLES.gettingModels],
  "frame-generation:lsfg": [frames("Lossless Scaling (LSFG)", "lsfg"), ARTICLES.losslessFiles],
  "frame-generation:rife": [frames("RIFE", "rife"), ARTICLES.gettingModels],
  "frame-generation:mlx-interpolation": [frames("MLX interpolation", "mlx-interpolation"), ARTICLES.gettingModels],
  "frame-generation:metalfx": [frames("MetalFX frame interpolation", "metalfx-frame-interpolation")],
  "frame-generation:fsr3": [frames("FSR 3 frame interpolation", "fsr-3-frame-interpolation")],
  "frame-generation:xess": [frames("XeSS frame generation", "xess-frame-generation")],
  "neural:mlx-dlss": [neural("DLSS neural rendering", "dlss-neural-rendering"), ARTICLES.gettingModels],
  "neural:nafnet": [neural("NAFNet", "nafnet"), neural("Cleaning up an image", "cleaning-up-an-image")]
};
// Shaders by key prefix ("crt", "shader:retroarch:lottes"); the longest matching prefix wins.
const SHADER_ARTICLES: Record<string, Article[]> = {
  crt: [ARTICLES.builtInCrt],
  grayscale: [color("Grayscale", "grayscale")], vibrance: [color("Colour", "colour")],
  sharpen: [color("Sharpen and CAS Sharpen", "sharpen")], cas: [color("Sharpen and CAS Sharpen", "sharpen")],
  chain: [color("Combine effects", "combine-effects")],
  "shader:crt-royale": [crt("CRT Royale", "crt-royale")],
  "shader:retroarch": [crt("CRT Lottes, Easymode, GTU and zfast", "retroarch-crt-shaders")],
  "shader:image:palette": [ARTICLES.palette],
  "shader:sweetfx:smaa": [color("Clean-up", "clean-up")], "shader:image:deband": [color("Clean-up", "clean-up")],
  "shader:image:libplacebo-deband": [color("Clean-up", "clean-up")], "shader:native:cmaa2": [color("Clean-up", "clean-up")],
  "shader:sweetfx": [color("Color and tone", "color-and-tone")], "shader:image:color-balance": [color("Color and tone", "color-and-tone")],
  "shader:native:histogram-exposure": [color("Color and tone", "color-and-tone")], "shader:native:local-laplacian": [color("Color and tone", "color-and-tone")],
  "shader:image:soft-bloom": [color("Light and lens", "light-and-lens")], "shader:native:ffx-lens": [color("Light and lens", "light-and-lens")],
  "shader:native:ffx-blur": [color("Light and lens", "light-and-lens")],
  "shader:kuwahara": [color("Artistic", "artistic")], "shader:accessibility": [color("Accessibility", "accessibility")],
  "shader:ssim-superres": [ARTICLES.shaderUpscalers],
  "shader:native:estimated-depth-fog": [ARTICLES.estimatedDepth],
  "shader:native": [ARTICLES.depthEffects],
  custom: [ARTICLES.shaderFormats, ARTICLES.shaderLibrary]
};
// Output settings by key.
const OUTPUT_ARTICLES: Record<string, Article[]> = {
  toneMapping: [ARTICLES.output], comparison: [ARTICLES.compare], adaptiveQuality: [ARTICLES.adaptiveQuality, ARTICLES.sizes],
  motionClarity: [ARTICLES.motionClarity], subframes: [ARTICLES.motionClarity], duty: [ARTICLES.motionClarity], brightness: [ARTICLES.motionClarity],
  framePacing: [ARTICLES.pacing], targetFps: [ARTICLES.pacing], smoothCadence: [ARTICLES.pacing]
};
// Chain edits that are not about one method.
const CHAIN_ARTICLES: Record<string, Article[]> = {
  master: [ARTICLES.graphicsHeading], clear: [ARTICLES.graphicsHeading, ARTICLES.presets],
  "game-resolution": [ARTICLES.gameResolution, ARTICLES.renderSize],
  "row-toggle": [ARTICLES.rowsEditing], "row-remove": [ARTICLES.rowsEditing], "row-order": [ARTICLES.order, ARTICLES.rowsEditing],
  chain: [ARTICLES.rowsEditing, ARTICLES.chain]
};
const KIND_ARTICLES: Record<string, Article[]> = {
  upscale: [ARTICLES.spatial, ARTICLES.sizes], downsample: [ARTICLES.downsample, ARTICLES.sizes],
  temporal: [ARTICLES.temporal, ARTICLES.sizes], "frame-generation": [ARTICLES.frameGeneration, ARTICLES.imagePair],
  neural: [ARTICLES.neural, ARTICLES.neuralModels], shader: [ARTICLES.shaders, ARTICLES.color]
};

function longestPrefix(table: Record<string, Article[]>, key: string) {
  const match = Object.keys(table).filter(prefix => key === prefix || key.startsWith(prefix + ":") || key.startsWith(prefix + "-"))
    .sort((a, b) => b.length - a.length)[0];
  return match ? table[match] : undefined;
}

function effectArticles(id: string, detail: unknown): Article[] {
  const value = typeof detail === "string" ? detail : "";
  if (CHAIN_ARTICLES[id]) return CHAIN_ARTICLES[id];
  if (id === "output") return [...(OUTPUT_ARTICLES[value] || [ARTICLES.output]), ARTICLES.output];
  const specific = id === "shader"
    ? longestPrefix(SHADER_ARTICLES, value) || (/\.cube$/i.test(value) ? [ARTICLES.luts] : /\.(fx|slangp?|glsl|hook|fs|isf)$/i.test(value) ? [ARTICLES.shaderFormats, ARTICLES.shaderLibrary] : undefined)
    : longestPrefix(METHOD_ARTICLES, `${id}:${value}`) || longestPrefix(METHOD_ARTICLES, id);
  return [...(specific || []), ...(KIND_ARTICLES[id] || [ARTICLES.graphics, ARTICLES.chain])];
}

// Bridge methods the demo answers with a topic of their own name.
export const ACTION_ARTICLES: Record<string, Article[]> = {
  createGameCommand: [ARTICLES.shortcuts], revealInFinder: [ARTICLES.files],
  cancelImport: [ARTICLES.addGame], setLibrarySort: [ARTICLES.search], moveGame: [ARTICLES.favorites], reorderGame: [ARTICLES.favorites],
  forgetGames: [ARTICLES.selecting], deleteGames: [ARTICLES.selecting], deleteGame: [ARTICLES.selecting],
  setGameSteamClientStart: [ARTICLES.steamClient],
  saveEffectsPreset: [ARTICLES.presets], deleteEffectsPreset: [ARTICLES.presets], pickEffectsPresetFile: [ARTICLES.presets],
  pickGameEffectFile: [ARTICLES.shaderFormats, ARTICLES.shaderLibrary],
  importReShadeFilters: [ARTICLES.shaderLibrary], updateReShadeFilter: [ARTICLES.shaderLibrary],
  renameReShadeShader: [ARTICLES.shaderLibrary], removeReShadeFilter: [ARTICLES.shaderLibrary], pickReShadeFilterPath: [ARTICLES.shaderLibrary],
  setGameLibVersion: [ARTICLES.patches], patchLibs: [ARTICLES.patches], unpatchLibs: [ARTICLES.patches],
  patchCheatsIntoGame: [ARTICLES.patches, ARTICLES.cheats], unpatchCheatsFromGame: [ARTICLES.patches, ARTICLES.cheats],
  openSaveEditor: [ARTICLES.saves, ARTICLES.saveEditor], pickSaveDir: [ARTICLES.saveLocation, ARTICLES.movingSaves],
  resetSaveDir: [ARTICLES.saveLocation, ARTICLES.movingSaves], selectSaveLocation: [ARTICLES.movingSaves],
  importSaveDir: [ARTICLES.movingSaves], exportSaveDir: [ARTICLES.movingSaves], importSaveFiles: [ARTICLES.movingSaves],
  writeSaveJson: [ARTICLES.saveEditor, ARTICLES.movingSaves], openSaveJsonInExternalEditor: [ARTICLES.saveEditor, ARTICLES.movingSaves],
  steamOpenHistory: [ARTICLES.downloads], steamChooseDirectory: [ARTICLES.downloads], cancelDownload: [ARTICLES.downloadsList],
  cancelModuleAction: [ARTICLES.gameTools]
};
// Launcher settings by key.
const SETTINGS_ARTICLES: Record<string, Article[]> = {
  networkAccess: [ARTICLES.networkAccess], startSteamClient: [ARTICLES.steamClient],
  library: [ARTICLES.search, ARTICLES.favorites]
};
// Runtime manager actions.
const RUNTIME_ACTION_ARTICLES: Record<string, Article[]> = {
  refreshCatalog: [ARTICLES.refresh], install: [ARTICLES.install], setup: [ARTICLES.install], uninstall: [ARTICLES.remove],
  setDefault: [ARTICLES.runtimeDefault, ARTICLES.versions], registerCustom: [ARTICLES.ownCopies], import: [ARTICLES.ownCopies]
};
// Module tool actions by name pattern; anything else is a game tool.
const TOOL_RULES: Array<[RegExp, Article[]]> = [
  [/snapshot/i, [ARTICLES.snapshots]],
  [/cheat|console/i, [ARTICLES.cheats]],
  [/save/i, [ARTICLES.saves]],
  [/video|export.*effect|preview/i, [ARTICLES.videoExport]],
  [/quarantine/i, [ARTICLES.files]],
  [/patch/i, [ARTICLES.patches]]
];
const CHEAT_MODULES: Record<string, Article> = { mv: ARTICLES.rpgMakerCheats, mz: ARTICLES.rpgMakerCheats, rgss: ARTICLES.rpgMakerCheats, renpy: ARTICLES.renpyCheats };

function windowArticles(view: string, managerId: unknown): Article[] {
  const manager = typeof managerId === "string" ? managerId : "";
  if (view === "runtimes") {
    if (manager.startsWith("graphics-presets")) return [ARTICLES.presets];
    if (manager.startsWith("graphics-shader")) return [ARTICLES.shaderLibrary, ARTICLES.shaders];
    if (manager.startsWith("graphics")) return [ARTICLES.runtimesWindow, ARTICLES.graphics];
    return [ARTICLES.runtimesWindow, ARTICLES.versions];
  }
  if (view === "settings") return [ARTICLES.settings, ARTICLES.perGame];
  if (view === "external") return [ARTICLES.external, ARTICLES.installedGames, ARTICLES.downloads];
  if (view === "credits") return [ARTICLES.credits];
  return [ARTICLES.windows];
}

/** The articles for one demo action, most relevant first. */
export function articlesFor(topic: DemoTopic): Article[] {
  const detail = typeof topic.detail === "string" ? topic.detail : undefined;
  const list = (() => {
    switch (topic.kind) {
      case "game": return [engine(topic.moduleId), ARTICLES.inspector, ARTICLES.choosing];
      case "runtime": {
        const runtime = runtimeArticles(topic.id, topic.moduleId, detail);
        if (SHARED_RUNTIMES[topic.id] && ["crossover", "sikarugir"].includes(topic.id)) return [...runtime, ARTICLES.windowsChoice];
        if (SHARED_RUNTIMES[topic.id] && topic.moduleId === "android") return [...runtime, ARTICLES.androidChoice];
        return [...runtime, ARTICLES.runtimeAndVersion, ARTICLES.choosing];
      }
      case "version": return [ARTICLES.runtimeAndVersion, ARTICLES.versions, ARTICLES.runtimesWindow];
      case "runtime-settings":
        if (topic.id === "arguments") return [ARTICLES.launchArguments];
        if (topic.id === "network") return [ARTICLES.networkAccess];
        if (topic.id === "module") return [ARTICLES.settings];
        return [ARTICLES.runtimeSettings, ...runtimeArticles(topic.id, topic.moduleId)];
      case "play": return [ARTICLES.play, ARTICLES.launch, engine(topic.moduleId)];
      case "add": return [ARTICLES.addGame, ARTICLES.games];
      case "effect": return effectArticles(topic.id, topic.detail);
      case "window": return windowArticles(topic.id, topic.detail);
      case "settings": return [...topic.id.split(",").flatMap(key => SETTINGS_ARTICLES[key] || []), ARTICLES.settings];
      case "runtime-action": return [...(RUNTIME_ACTION_ARTICLES[topic.id] || []), ARTICLES.runtimesWindow];
      case "store":
        if (topic.id === "scan" || topic.id === "import") return [ARTICLES.installedGames, ARTICLES.external];
        if (topic.id === "account") return [ARTICLES.accounts, ARTICLES.external];
        return [ARTICLES.downloads, ARTICLES.external];
      case "saves": return [ARTICLES.saves, ARTICLES.movingSaves];
      case "cheats": return [...(topic.moduleId && CHEAT_MODULES[topic.moduleId] ? [CHEAT_MODULES[topic.moduleId]] : []), ARTICLES.cheats];
      case "tool": {
        const rule = TOOL_RULES.find(([pattern]) => pattern.test(topic.id));
        return [...(rule ? rule[1] : [ARTICLES.decompilers]), ARTICLES.gameTools, engine(topic.moduleId)];
      }
      case "entry": return [ARTICLES.files, engine(topic.moduleId)];
      case "action": return ACTION_ARTICLES[topic.id] || [ARTICLES.windows, ARTICLES.start];
      default: return [ARTICLES.intro, ARTICLES.start];
    }
  })();
  return list.filter((item, index) => list.findIndex(other => other.path === item.path) === index);
}

/** Every article a topic can resolve to, for the website build's link check. */
export function allArticles(modules: Array<{ id: string; runtimes: string[] }>): Article[] {
  const tables = [METHOD_ARTICLES, SHADER_ARTICLES, OUTPUT_ARTICLES, CHAIN_ARTICLES, KIND_ARTICLES, ACTION_ARTICLES,
    SETTINGS_ARTICLES, RUNTIME_ACTION_ARTICLES, SHARED_RUNTIMES];
  return [...Object.values(ARTICLES), ...Object.values(MODULE_ARTICLES), ...Object.values(CHEAT_MODULES),
    ...tables.flatMap(table => Object.values(table).flat()), ...TOOL_RULES.flatMap(([, list]) => list),
    ...modules.flatMap(info => info.runtimes.flatMap(runtime => runtimeArticles(runtime, info.id)))];
}

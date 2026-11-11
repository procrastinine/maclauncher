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
const translators = (title: string, anchor: string) => page(title, `windows/graphics-translators/#${anchor}`);
const choosingTranslator = (title: string, anchor: string) => page(title, `windows/choosing-a-translator/#${anchor}`);
const wineSettings = (title: string, anchor: string) => page(title, `windows/settings/#${anchor}`);
const windowGraphics = (title: string, anchor: string) => page(title, `graphics/window-graphics/#${anchor}`);
const patching = (title: string, anchor: string) => page(title, `tools/patching-games/#${anchor}`);
const bridge = (title: string, anchor: string) => page(title, `windows/steam-client-bridge/#${anchor}`);
const krisp = (title: string, anchor: string) => page(title, `windows/kosmickrisp/#${anchor}`);
const macs = (title: string, anchor: string) => page(title, `macs-and-macos/#${anchor}`);
const runtimePatching = (title: string, anchor: string) => page(title, `tools/runtime-patching/#${anchor}`);
const network = (title: string, anchor: string) => page(title, `tools/network-and-privacy/#${anchor}`);

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
  externalDrive: launcher("Games on an external drive", "games-on-an-external-drive"),
  inspector: launcher("The inspector", "the-inspector"),
  files: launcher("Files", "files"),
  launch: launcher("Launch", "launch"),
  patches: launcher("Patches", "patches"),
  gameTools: launcher("Tools", "tools"),
  notes: launcher("Notes", "notes"),
  windows: launcher("Windows and menus", "windows-and-menus"),

  runtimesWindow: versions("The Runtimes window", "the-runtimes-window"),
  processorBuilds: versions("Processor builds", "processor-builds"),
  pickingBuilds: macs("How MacLauncher picks a build", "how-maclauncher-picks-a-build"),
  processorRuntimes: macs("Runtimes that care about the processor", "runtimes-that-care-about-the-processor"),
  macOSFeatures: macs("Graphics features by macOS version", "graphics-features-by-macos-version"),
  refresh: versions("Refreshing the version list", "refresh"),
  install: versions("Installing a version", "install"),
  remove: versions("Removing a version", "remove"),
  runtimeDefault: versions("The default version", "the-default"),
  ownCopies: versions("Your own copies", "your-own-copies"),
  downloadsList: versions("Downloads", "downloads"),
  downloadedFiles: versions("Downloaded files", "downloaded-files"),
  environmentVariables: versions("Environment variables", "environment-variables"),
  gameEnvironment: page("Environment variables in WINE games", "windows/settings/#environment-variables"),
  perGame: versions("Per-game choices", "per-game-choices"),
  runtimeAndVersion: versions("Runtime and version", "runtime-and-version"),
  runtimeSettings: versions("Runtime settings", "runtime-settings"),
  launchArguments: versions("Launch arguments", "launch-arguments"),
  networkAccess: versions("Network access", "network-access"),
  goingOnline: network("When MacLauncher goes online", "when-maclauncher-goes-online"),
  offline: network("Working offline", "working-offline"),
  gameNetwork: network("Network access for each game", "network-access-for-each-game"),
  filesAndAccounts: network("Your files and accounts", "your-files-and-accounts"),
  patchingRuntimes: runtimePatching("How MacLauncher patches runtimes", "how-maclauncher-does-it"),
  patchInstall: runtimePatching("Installing a translator version", "1-install-a-translator-version"),
  patchChoose: runtimePatching("Choosing a translator for one game", "2-choose-it-for-the-game"),
  patchOptions: runtimePatching("Setting a translator's options", "3-set-its-options"),
  patchEnvironment: runtimePatching("Adding a translator's environment variables", "4-add-environment-variables"),
  patchCheck: runtimePatching("Checking the result in the inspector", "5-play-and-check-the-inspector"),
  patchBack: runtimePatching("Going back to the automatic choice", "going-back"),
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
  installers: page("Installers and packed games", "tools/decompilers-and-extractors/#installers-and-packed-games"),
  credits: page("Credits and licenses", "about/credits/"),
  updates: page("How MacLauncher is updated", "help/faq/#how-is-maclauncher-updated"),
  windowsGames: page("Windows games through WINE", "games/windows/"),
  windowsGraphics: page("Graphics effects in WINE games", "windows/effects-and-upscaling/#effects"),
  wineTemporal: page("Temporal upscaling in WINE games", "windows/effects-and-upscaling/#temporal-upscaling"),
  cameraData: page("When an upscaler needs camera data", "windows/effects-and-upscaling/#when-an-upscaler-needs-camera-data"),
  xessGames: page("XeSS games", "windows/effects-and-upscaling/#xess-games"),
  dlssGames: page("DLSS games and the selected upscaler", "windows/effects-and-upscaling/#dlss-games-and-the-selected-upscaler"),
  fidelityFx: page("FidelityFX games", "windows/effects-and-upscaling/#fidelityfx-games"),
  translatorVersions: page("Translator versions", "windows/translator-versions/"),
  translatorsOutside: page("Translators kept outside the WINE runtimes", "windows/translator-versions/#translators-kept-outside-the-wine-runtimes"),
  patchingCrossOver: page("Patching CrossOver", "windows/translator-versions/#patching-crossover"),
  kosmicKrisp: page("KosmicKrisp", "windows/kosmickrisp/"),
  maclauncherKrisp: krisp("MacLauncher KosmicKrisp", "maclauncher-kosmickrisp"),
  krispBuilds: krisp("Which build a game loads", "which-build-a-game-loads"),
  steamBridge: page("Steam client bridge", "windows/steam-client-bridge/"),
  bridgeOffered: bridge("When Play offers the bridge", "when-play-offers-it"),
  bridgePlaying: bridge("Playing with the bridge", "playing-with-the-bridge"),
  bridgeRuntimes: bridge("The bridge in Runtimes", "the-bridge-in-runtimes"),
  steamApi: page("Steam API without Steam", "tools/stores-and-downloads/#steam-api-without-steam"),
  wineIntro: page("Windows games on a Mac", "windows/"),
  rosetta: page("Rosetta", "windows/crossover-and-sikarugir/#rosetta"),
  whichWine: page("CrossOver, Sikarugir or WineCX", "windows/crossover-and-sikarugir/#which-one-to-use"),
  existingBottle: page("Choosing a bottle or wrapper", "windows/existing-bottles/#choosing-a-bottle-or-wrapper"),
  bottleUse: page("What MacLauncher does with a bottle", "windows/existing-bottles/#what-maclauncher-does-with-it"),
  choosingTranslator: page("Choosing a translator", "windows/choosing-a-translator/"),
  translatorForMac: choosingTranslator("Start with your Mac", "start-with-your-mac"),
  changingTranslator: choosingTranslator("Changing a translator", "changing-a-translator"),
  translatorOptions: choosingTranslator("Options for each translator", "options-for-each-translator"),
  androidTranslator: choosingTranslator("Translators for Android games", "android-games"),
  ps5Translator: choosingTranslator("Translators for PlayStation 5 games", "playstation-5-games"),
  translatorsChosen: translators("How MacLauncher chooses a translator", "how-maclauncher-chooses"),
  translatorsYourself: translators("Choosing a translator yourself", "choosing-one-yourself"),
  translatorCantLoad: translators("When a translator can't load", "when-a-translator-cant-load"),
  vulkanDrivers: translators("MoltenVK or KosmicKrisp", "moltenvk-or-kosmickrisp"),
  bringYourOwn: page("Bringing your own games", "games/mobile-and-consoles/#bringing-your-own-games"),
  patchingGames: page("Patching games", "tools/patching-games/"),
  videos: page("Videos", "games/more/#videos"),
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
  performanceOverlay: composing("Performance overlay", "performance-overlay"),
  frameRateCap: composing("Frame-rate cap", "frame-rate-cap"),
  displaySync: composing("Display sync and drawables", "display-sync-and-drawables"),
  graphicsShortcuts: composing("Shortcuts and screenshots", "shortcuts-and-screenshots"),
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
  shaderFormats: page("Shader formats", "graphics/shaders/#formats"),
  windowStarting: windowGraphics("Applying graphics to a window", "starting"),
  windowSession: windowGraphics("Several windows and displays", "while-it-runs"),
  windowOutput: windowGraphics("In place, enlarged or fit to the screen", "in-place-enlarged-or-fit-screen"),
  windowEffects: windowGraphics("Effects on a window", "effects-on-a-window"),
  windowChains: windowGraphics("Remembered chains", "remembered-chains"),
  keepStatic: frames("Keep static content", "keep-static-content"),
  recipes: composing("Recipes", "recipes"),
  presentation: composing("Performance and presentation", "performance-and-presentation")
} satisfies Record<string, Article>;

const desktop = (title: string, anchor: string) => page(title, `games/desktop-engines/#${anchor}`);
const webGames = desktop("Web games", "web-games");
const novels = page("Visual novel engines", "games/visual-novels/#game-types-and-runtimes");
const mobile = (title: string, anchor: string) => page(title, `games/mobile-and-consoles/#${anchor}`);
const more = (title: string, anchor: string) => page(title, `games/more/#${anchor}`);

// Each registered game type's page. A type missing here falls back to the
// overview, and the website build reports it.
export const MODULE_ARTICLES: Record<string, Article> = {
  mv: webGames, mz: webGames, construct: webGames, tyrano: webGames, "gamemaker-html5": webGames, web: webGames,
  rgss: desktop("RPG Maker XP, VX and VX Ace", "rpg-maker-xp-vx-and-vx-ace"),
  easyrpg: desktop("RPG Maker 2000/2003", "rpg-maker-20002003"), wolfrpg: desktop("WOLF RPG Editor", "wolf-rpg-editor"),
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
  uzdoom: more("Doom-engine and Build-engine games", "doom-engine-and-build-engine-games"), raze: more("Doom-engine and Build-engine games", "doom-engine-and-build-engine-games"),
  dreamm: more("LucasArts games on DREAMM", "lucasarts-games-on-dreamm"),
  gemrb: more("Infinity Engine", "infinity-engine"), xash3d: more("Half-Life", "half-life"),
  ikemen: more("MUGEN and Ikemen GO", "mugen-and-ikemen-go"),
  hashlink: more("HashLink and Haxe", "hashlink-and-haxe"), haxe: more("HashLink and Haxe", "hashlink-and-haxe"),
  video: more("Videos", "videos"), window: page("Any window or display", "graphics/window-graphics/")
};

// Runtimes with their own anchor (`runtime-<id>`) on their game type's page.
export const RUNTIME_ANCHORS: Record<string, string[]> = {
  "games/desktop-engines/": ["electron", "nwjs", "nwjs-patched", "sdk", "patched", "butterscotch", "official-studio", "opengmk", "projector", "ruffle"],
  "games/visual-novels/": ["krkrsdl2", "siglus", "rlvm", "onsyuri_mac", "onscripter_en", "system3", "xsystem35", "xsystem4", "impacto",
    "npengine", "reminori", "rfvp", "ai5", "vnds_love", "bgi-tools", "catsystem2-tools"],
  "games/mobile-and-consoles/": ["prosper"],
  "games/more/": ["native"]
};
const choice = (title: string, anchor: string) => page(title, `background/choosing-a-runtime/#${anchor}`);
// Runtimes shared by many game types, with a section of their own.
const SHARED_RUNTIMES: Record<string, Article[]> = {
  crossover: [choice("When to use CrossOver", "crossover"), page("CrossOver", "windows/crossover-and-sikarugir/#crossover")],
  sikarugir: [choice("When to use Sikarugir", "sikarugir"), page("Sikarugir (WINE)", "windows/crossover-and-sikarugir/#sikarugir")],
  native: [desktop("When a game ships its own Mac build", "when-a-game-ships-its-own-mac-build")],
  mac32: [more("32-bit Mac apps", "32-bit-mac-apps")],
  klepton: [choice("MacLauncher Android", "maclauncher-android")],
  macapk: [choice("Mac.apk", "macapk")],
  aim: [choice("AIM", "aim")]
};
// Runtimes that inspect a game rather than play it.
const INSPECTION_RUNTIMES = new Set(["inspection"]);

// Sections a selected game of some types opens after its own page.
const GAME_ARTICLES: Record<string, Article[]> = {
  window: [ARTICLES.windowSession, ARTICLES.windowEffects], crossover: [ARTICLES.wineIntro, ARTICLES.whichWine],
  nxnative: [ARTICLES.bringYourOwn, ARTICLES.processorRuntimes], anyps5: [ARTICLES.bringYourOwn],
  ios: [ARTICLES.bringYourOwn, ARTICLES.processorRuntimes], android: [ARTICLES.androidChoice, ARTICLES.processorRuntimes],
  mac32: [ARTICLES.processorRuntimes], hashlink: [ARTICLES.processorRuntimes]
};

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
  "temporal:xess": [upscaling("Intel XeSS", "xess"), ARTICLES.xessGames],
  "temporal:mlx-sr-scene": [upscaling("DLSS SR", "dlss-sr"), ARTICLES.gettingModels],
  "frame-generation:lsfg": [frames("Lossless Scaling (LSFG)", "lsfg"), ARTICLES.losslessFiles],
  "frame-generation:rife": [frames("RIFE", "rife"), ARTICLES.gettingModels],
  "frame-generation:mlx-interpolation": [frames("MLX interpolation", "mlx-interpolation"), ARTICLES.gettingModels],
  "frame-generation:metalfx": [frames("MetalFX frame interpolation", "metalfx-frame-interpolation")],
  "frame-generation:fsr3": [frames("FSR 3 frame interpolation", "fsr-3-frame-interpolation")],
  "frame-generation:xess": [frames("XeSS frame generation", "xess-frame-generation")],
  "frame-generation:vt-interpolation": [frames("VideoToolbox interpolation", "videotoolbox-interpolation")],
  "frame-generation:metalfx-image": [frames("MetalFX image interpolation", "metalfx-image-interpolation")],
  "frame-generation:vision-flow": [frames("Vision optical flow", "vision-optical-flow")],
  "frame-generation:auto": [frames("Automatic", "automatic")],
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
  "shader:sweetfx:smaa": [color("Clean-up", "clean-up")], "shader:sweetfx:fxaa": [color("Clean-up", "clean-up")],
  "shader:image:deband": [color("Clean-up", "clean-up")],
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
  framePacing: [ARTICLES.pacing], targetFps: [ARTICLES.pacing], smoothCadence: [ARTICLES.pacing],
  hud: [ARTICLES.performanceOverlay, ARTICLES.presentation], frameRateCap: [ARTICLES.frameRateCap, ARTICLES.pacing],
  displaySync: [ARTICLES.displaySync], drawableCount: [ARTICLES.displaySync]
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

// Effect edits on a window graphics entry or a Windows game also open the
// section about effects there.
function effectContext(id: string, moduleId?: string): Article[] {
  if (moduleId === "window") return [ARTICLES.windowEffects];
  if (moduleId !== "crossover") return [];
  if (id === "temporal") return [ARTICLES.wineTemporal, ARTICLES.cameraData];
  return CHAIN_ARTICLES[id] || id === "output" ? [] : [ARTICLES.windowsGraphics];
}

function effectArticles(id: string, detail: unknown, moduleId?: string): Article[] {
  return [...effectContext(id, moduleId), ...chainArticles(id, detail)];
}
function chainArticles(id: string, detail: unknown): Article[] {
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
  createGameCommand: [ARTICLES.shortcuts], revealInFinder: [ARTICLES.files], locateGame: [ARTICLES.externalDrive, ARTICLES.files],
  findMissingGames: [ARTICLES.externalDrive, ARTICLES.selecting], appUpdate: [ARTICLES.updates, ARTICLES.goingOnline, ARTICLES.settings],
  cancelImport: [ARTICLES.addGame], setLibrarySort: [ARTICLES.search], moveGame: [ARTICLES.favorites], reorderGame: [ARTICLES.favorites],
  forgetGames: [ARTICLES.selecting], deleteGames: [ARTICLES.selecting], deleteGame: [ARTICLES.selecting],
  setGameSteamClientStart: [ARTICLES.steamClient, ARTICLES.bridgePlaying],
  saveEffectsPreset: [ARTICLES.presets], deleteEffectsPreset: [ARTICLES.presets], pickEffectsPresetFile: [ARTICLES.presets],
  pickGameEffectFile: [ARTICLES.shaderFormats, ARTICLES.shaderLibrary],
  importReShadeFilters: [ARTICLES.shaderLibrary], updateReShadeFilter: [ARTICLES.shaderLibrary],
  renameReShadeShader: [ARTICLES.shaderLibrary], removeReShadeFilter: [ARTICLES.shaderLibrary], pickReShadeFilterPath: [ARTICLES.shaderLibrary],
  setGameLibVersion: [patching("RPG Maker MV: newer graphics libraries", "rpg-maker-mv-newer-graphics-libraries"), ARTICLES.patches],
  patchLibs: [patching("RPG Maker MV: newer graphics libraries", "rpg-maker-mv-newer-graphics-libraries"), ARTICLES.patches],
  unpatchLibs: [patching("RPG Maker MV: newer graphics libraries", "rpg-maker-mv-newer-graphics-libraries"), ARTICLES.patches],
  patchCheatsIntoGame: [patching("RPG Maker MV and MZ: the tools overlay on NW.js", "rpg-maker-mv-and-mz-the-tools-overlay-on-nwjs"), ARTICLES.cheats],
  unpatchCheatsFromGame: [patching("RPG Maker MV and MZ: the tools overlay on NW.js", "rpg-maker-mv-and-mz-the-tools-overlay-on-nwjs"), ARTICLES.cheats],
  openSaveEditor: [ARTICLES.saves, ARTICLES.saveEditor], pickSaveDir: [ARTICLES.saveLocation, ARTICLES.movingSaves],
  resetSaveDir: [ARTICLES.saveLocation, ARTICLES.movingSaves], selectSaveLocation: [ARTICLES.movingSaves],
  importSaveDir: [ARTICLES.movingSaves], exportSaveDir: [ARTICLES.movingSaves], importSaveFiles: [ARTICLES.movingSaves],
  writeSaveJson: [ARTICLES.saveEditor, ARTICLES.movingSaves], openSaveJsonInExternalEditor: [ARTICLES.saveEditor, ARTICLES.movingSaves],
  steamOpenHistory: [ARTICLES.downloads], steamChooseDirectory: [ARTICLES.downloads], cancelDownload: [ARTICLES.downloadsList],
  cancelModuleAction: [ARTICLES.gameTools], chooseScreenshotFolder: [ARTICLES.graphicsShortcuts],
  appActionPickerState: [ARTICLES.windowStarting], chooseAppActionTarget: [ARTICLES.windowStarting, ARTICLES.windowChains],
  openAppActionPickerLink: [ARTICLES.windowStarting], removeSessionTarget: [ARTICLES.windowSession], stopSession: [ARTICLES.windowSession, ARTICLES.windowChains],
  stopGame: [ARTICLES.launch], installRenpyConsole: [patching("The Ren'Py console and community add-ons", "renpy-the-console-and-community-add-ons")]
};
// Launcher settings by key.
const SETTINGS_ARTICLES: Record<string, Article[]> = {
  networkAccess: [ARTICLES.networkAccess, ARTICLES.gameNetwork], startSteamClient: [ARTICLES.steamClient, ARTICLES.goingOnline],
  library: [ARTICLES.search, ARTICLES.favorites], checkForUpdatesAtLaunch: [ARTICLES.updates, ARTICLES.goingOnline],
  graphicsShortcuts: [ARTICLES.graphicsShortcuts], graphicsScreenshotFolder: [ARTICLES.graphicsShortcuts],
  translatorEnvironment: [ARTICLES.environmentVariables, ARTICLES.patchEnvironment, ARTICLES.gameEnvironment]
};
// Runtime settings by runtime and key, then by the field's section in a
// WINE runtime; the translator lists also open the chosen translator's section.
const TRANSLATOR_KEYS: Record<string, Article> = {
  translatorRenderer: choosingTranslator("Direct3D 10 and 11 games", "direct3d-10-and-11"),
  translatorD3D8: choosingTranslator("Direct3D 8 and 9 games", "direct3d-8-and-9"), translatorD3D9: choosingTranslator("Direct3D 8 and 9 games", "direct3d-8-and-9"),
  translatorD3D10: choosingTranslator("Direct3D 10 and 11 games", "direct3d-10-and-11"), translatorD3D11: choosingTranslator("Direct3D 10 and 11 games", "direct3d-10-and-11"),
  translatorD3D12: choosingTranslator("Direct3D 12 games", "direct3d-12"), translatorVulkan: choosingTranslator("Vulkan games", "vulkan-games"),
  translatorVideo: ARTICLES.translatorOptions
};
// Translator choices by the engine in their value, most specific first.
const TRANSLATOR_ENGINES: Array<[RegExp, Article[]]> = [
  [/vkd3d-proton/, [translators("vkd3d-proton", "vkd3d-proton"), page("Direct3D 12 games through vkd3d-proton", "windows/kosmickrisp/#direct3d-12-games-through-vkd3d-proton")]],
  [/d3dmetal/, [translators("D3DMetal", "d3dmetal")]], [/dxmt|graphics-bridge/, [translators("DXMT", "dxmt")]],
  [/dxvk/, [translators("DXVK, D9VK and the async builds", "dxvk-d9vk-and-the-async-builds")]],
  [/wined3d|vkd3d/, [translators("WineD3D and Wine's vkd3d", "wined3d-and-wines-vkd3d")]],
  [/maclauncher-kosmickrisp/, [translators("MacLauncher KosmicKrisp", "maclauncher-kosmickrisp"), ARTICLES.maclauncherKrisp]],
  [/kosmickrisp/, [translators("KosmicKrisp", "kosmickrisp"), ARTICLES.kosmicKrisp]], [/moltenvk/, [translators("MoltenVK", "moltenvk")]],
  [/gstreamer/, [ARTICLES.translatorOptions]]
];
const WINE_SECTIONS: Record<string, Article> = {
  basic: wineSettings("Basic settings", "basic"), display: wineSettings("Display settings", "display"), input: wineSettings("Input settings", "input"),
  compatibility: wineSettings("Compatibility settings", "compatibility"), diagnostics: wineSettings("Diagnostics", "diagnostics")
};
const RUNTIME_SETTING_ARTICLES: Record<string, Article[]> = {
  "*:environmentReference": [ARTICLES.existingBottle, ARTICLES.bottleUse], "*:dlss": [ARTICLES.dlssGames],
  "capture:output": [ARTICLES.windowOutput], "capture:captureCursor": [ARTICLES.windowOutput], "capture:showPointer": [ARTICLES.windowOutput],
  "nxnative:keysPath": [ARTICLES.bringYourOwn], "nxnative:buildUpstreamHost": [mobile("Nintendo Switch", "nintendo-switch")],
  "*:angleBackend": [ARTICLES.androidTranslator], "*:vulkanRuntime": [ARTICLES.androidTranslator], "*:networkIsolation": [ARTICLES.gameNetwork, ARTICLES.networkAccess]
};
const WINE_RUNTIMES = new Set(["crossover", "sikarugir"]);
// A translator's own options in the WINE runtime settings, such as DXVK HUD.
const TRANSLATOR_OPTION = /^(dxvk|dxmt|d3dMetal|moltenVk|wineD3d|graphicsBridge)/;
const PS5_RUNTIMES = new Set(["anyps5", "prosper"]);

/** The sections for one changed runtime setting: its key, its translator choice or its group of WINE settings. */
function runtimeSettingArticles(runtimeId: string, detail: unknown): Article[] {
  const { key = "", value, section = "" } = detail && typeof detail === "object" ? detail as { key?: string; value?: unknown; section?: string } : {};
  if (!key) return [];
  if (TRANSLATOR_KEYS[key]) {
    const choice = String(value || "");
    if (!choice) return [ARTICLES.patchBack, ARTICLES.translatorsChosen, TRANSLATOR_KEYS[key]];
    const engine = TRANSLATOR_ENGINES.find(([pattern]) => pattern.test(choice))?.[1] || [];
    return [...engine, TRANSLATOR_KEYS[key], ARTICLES.patchChoose, ARTICLES.changingTranslator, ARTICLES.patchCheck];
  }
  if (WINE_RUNTIMES.has(runtimeId) && TRANSLATOR_OPTION.test(key)) return [ARTICLES.patchOptions, ARTICLES.translatorOptions, WINE_SECTIONS[section.toLowerCase()] || WINE_SECTIONS.basic];
  if (key === "vulkanRuntime" && PS5_RUNTIMES.has(runtimeId)) return [ARTICLES.ps5Translator];
  const own = RUNTIME_SETTING_ARTICLES[`${runtimeId}:${key}`] || RUNTIME_SETTING_ARTICLES[`*:${key}`] || [];
  return [...own, ...(WINE_RUNTIMES.has(runtimeId) ? [WINE_SECTIONS[section.toLowerCase()] || WINE_SECTIONS.basic] : [])];
}
// Runtime manager actions.
const RUNTIME_ACTION_ARTICLES: Record<string, Article[]> = {
  refreshCatalog: [ARTICLES.refresh, ARTICLES.goingOnline], install: [ARTICLES.install, ARTICLES.offline], setup: [ARTICLES.install], uninstall: [ARTICLES.remove],
  setDefault: [ARTICLES.runtimeDefault, ARTICLES.versions], registerCustom: [ARTICLES.ownCopies], import: [ARTICLES.ownCopies],
  "downloaded-files": [ARTICLES.downloadedFiles]
};
// Module tool actions by name pattern; anything else is a game tool.
const TOOL_RULES: Array<[RegExp, Article[]]> = [
  [/snapshot/i, [ARTICLES.snapshots]],
  [/renpyconsole|walkthrough|renpymod/i, [patching("The Ren'Py console and community add-ons", "renpy-the-console-and-community-add-ons")]],
  [/plugin/i, [patching("RPG Maker MV and MZ plugins", "rpg-maker-mv-and-mz-plugins")]],
  [/cheat|console/i, [ARTICLES.cheats]],
  [/save/i, [ARTICLES.saves]],
  [/video|export.*effect|preview/i, [ARTICLES.videoExport]],
  [/quarantine/i, [ARTICLES.files]],
  [/^(un)?patch(status)?$/i, [patching("Ren'Py patch", "renpy-patch"), ARTICLES.patches]],
  [/patch/i, [ARTICLES.patches, ARTICLES.patchingGames]],
  [/steam/i, [ARTICLES.steamApi]],
  [/keys/i, [ARTICLES.bringYourOwn]],
  [/installer|innoextract/i, [ARTICLES.installers]]
];
// Without a rule of its own, a tool opens its game type's row in the
// decompilers and extractors table.
const decompilers = (title: string, anchor: string) => page(title, `tools/decompilers-and-extractors/#${anchor}`);
const NATIVE_TOOL_TYPES = new Set(["android", "ios", "anyps5", "prosper", "nxnative", "generic-app", "mac32", "crossover", "dosbox", "haxe"]);
function toolSection(moduleId?: string): Article {
  const base = moduleId ? MODULE_ARTICLES[moduleId]?.path.split("#")[0] : "";
  if (moduleId && NATIVE_TOOL_TYPES.has(moduleId)) return decompilers("Mobile, consoles and native programs", "mobile-consoles-and-native-programs");
  if (base === "games/desktop-engines/") return decompilers("Tools for desktop engines", "desktop-engines");
  if (base === "games/visual-novels/") return decompilers("Tools for visual novels", "visual-novels");
  return moduleId ? decompilers("Tools for other game types", "other-game-types") : ARTICLES.decompilers;
}
const CHEAT_MODULES: Record<string, Article> = { mv: ARTICLES.rpgMakerCheats, mz: ARTICLES.rpgMakerCheats, rgss: ARTICLES.rpgMakerCheats, renpy: ARTICLES.renpyCheats };

// Runtimes pages with a section of their own, by manager id prefix; the
// longest matching prefix wins.
const MANAGER_ARTICLES: Record<string, Article[]> = {
  "graphics-presets": [ARTICLES.presets], "graphics-shader": [ARTICLES.shaders, ARTICLES.shaderLibrary],
  "graphics-models": [ARTICLES.losslessFiles], "graphics-neural-models": [ARTICLES.gettingModels, ARTICLES.neuralModels],
  "graphics-xess": [upscaling("Intel XeSS", "xess"), ARTICLES.xessGames], innoextract: [ARTICLES.installers],
  "sikarugir-graphics-bridge": [translators("DXMT", "dxmt"), ARTICLES.translatorsOutside],
  "maclauncher-crossover-winemac": [ARTICLES.patchingCrossOver, ARTICLES.windowsGraphics],
  "dxvk-nvapi": [ARTICLES.dlssGames, ARTICLES.translatorVersions], "vkd3d-proton": [ARTICLES.dlssGames, ARTICLES.translatorVersions],
  dxvk: [translators("DXVK, D9VK and the async builds", "dxvk-d9vk-and-the-async-builds"), ARTICLES.translatorsOutside],
  "translator-dxvk": [translators("DXVK, D9VK and the async builds", "dxvk-d9vk-and-the-async-builds"), ARTICLES.translatorsOutside],
  "translator-vkd3d-proton": [translators("vkd3d-proton", "vkd3d-proton"), ARTICLES.translatorsOutside],
  "translator-vkd3d": [translators("WineD3D and Wine's vkd3d", "wined3d-and-wines-vkd3d")],
  "translator-d3dmetal": [translators("D3DMetal", "d3dmetal"), ARTICLES.translatorsOutside],
  translator: [ARTICLES.translatorVersions, ARTICLES.patchingRuntimes], "vulkan-moltenvk-scene": [ARTICLES.fidelityFx, ARTICLES.dlssGames],
  "winevulkan-scene": [ARTICLES.fidelityFx], "fidelityfx-api": [ARTICLES.fidelityFx],
  "vulkan-kosmickrisp": [translators("KosmicKrisp", "kosmickrisp"), ARTICLES.kosmicKrisp, ARTICLES.vulkanDrivers],
  "maclauncher-kosmickrisp": [ARTICLES.maclauncherKrisp, ARTICLES.krispBuilds, ARTICLES.vulkanDrivers],
  "vulkan-moltenvk": [translators("MoltenVK", "moltenvk"), ARTICLES.vulkanDrivers],
  "maclauncher-steam-bridge": [ARTICLES.bridgeRuntimes, ARTICLES.bridgeOffered], mpv: [ARTICLES.videos], "uosc-helper": [ARTICLES.videos],
  crossover: [page("CrossOver", "windows/crossover-and-sikarugir/#crossover"), ARTICLES.whichWine],
  sikarugir: [page("Sikarugir (WINE)", "windows/crossover-and-sikarugir/#sikarugir"), ARTICLES.rosetta],
  android: [choice("MacLauncher Android", "maclauncher-android"), ARTICLES.processorRuntimes], macapk: [choice("Mac.apk", "macapk")],
  "android-aim": [choice("AIM", "aim"), ARTICLES.processorRuntimes], components: [ARTICLES.downloadedFiles]
};
// Runtimes sidebar groups that gather many game types' managers.
const GROUP_ARTICLES: Record<string, Article[]> = { graphics: [ARTICLES.graphics], tools: [ARTICLES.decompilers],
  "directx-vulkan": [ARTICLES.patchInstall, ARTICLES.choosingTranslator], "directx-metal": [ARTICLES.patchInstall, ARTICLES.choosingTranslator],
  "vulkan-drivers": [ARTICLES.vulkanDrivers, ARTICLES.patchInstall],
  codecs: [ARTICLES.translatorOptions] };
// External window tabs; each store's own tab downloads with its accounts.
const EXTERNAL_TABS: Record<string, Article[]> = {
  installed: [ARTICLES.installedGames], downloaded: [ARTICLES.downloads],
  steam: [ARTICLES.downloads, ARTICLES.accounts, ARTICLES.steamBridge],
  "google-play": [ARTICLES.downloads, ARTICLES.accounts, MODULE_ARTICLES.android, ARTICLES.androidChoice]
};

/** A launcher window, or the section or tab selected in it. */
function windowArticles(topic: DemoTopic): Article[] {
  const detail = topic.detail && typeof topic.detail === "object" ? topic.detail as { managerId?: string; groupId?: string } : {};
  const value = typeof topic.detail === "string" ? topic.detail : "";
  switch (topic.id) {
    case "runtimes": {
      const manager = detail.managerId || "";
      if (!manager) return [ARTICLES.runtimesWindow, ARTICLES.versions];
      return [...(longestPrefix(MANAGER_ARTICLES, manager) || []), ...(GROUP_ARTICLES[detail.groupId || ""] || []),
        ...(topic.moduleId ? runtimeArticles(manager, topic.moduleId) : []), ARTICLES.runtimesWindow];
    }
    case "settings":
      if (topic.moduleId === "crossover") return [...(value ? runtimeArticles(value, topic.moduleId) : [engine(topic.moduleId)]),
        WINE_SECTIONS.basic, ARTICLES.choosingTranslator, ARTICLES.settings];
      if (topic.moduleId) return [...(value ? runtimeArticles(value, topic.moduleId) : [engine(topic.moduleId)]), ARTICLES.runtimeSettings, ARTICLES.settings];
      if (value === "launcher") return [ARTICLES.settings, ARTICLES.networkAccess, ARTICLES.steamClient, ARTICLES.updates, ARTICLES.goingOnline];
      if (value === "environment") return [ARTICLES.environmentVariables, ARTICLES.patchEnvironment, ARTICLES.gameEnvironment, ARTICLES.settings];
      if (value === "graphics") return [ARTICLES.shaderLibrary, ARTICLES.shaders, ARTICLES.settings];
      if (value === "presets") return [ARTICLES.presets, ARTICLES.settings];
      return [ARTICLES.settings, ARTICLES.perGame];
    case "external":
      if (value) return [...(EXTERNAL_TABS[value] || [ARTICLES.downloads, ARTICLES.accounts]), ARTICLES.external];
      return [ARTICLES.external, ARTICLES.installedGames, ARTICLES.downloads];
    case "credits": return [ARTICLES.credits];
    case "appAction": return [ARTICLES.windowStarting, ARTICLES.windowOutput, MODULE_ARTICLES.window];
    default: return [ARTICLES.windows];
  }
}

/** The articles for one demo action, most relevant first. */
export function articlesFor(topic: DemoTopic): Article[] {
  const detail = typeof topic.detail === "string" ? topic.detail : undefined;
  const list = (() => {
    switch (topic.kind) {
      case "game": return [engine(topic.moduleId), ...(GAME_ARTICLES[topic.moduleId || ""] || []), ARTICLES.inspector, ARTICLES.choosing];
      case "runtime": {
        const runtime = runtimeArticles(topic.id, topic.moduleId, detail);
        if (SHARED_RUNTIMES[topic.id] && ["crossover", "sikarugir"].includes(topic.id)) return [...runtime, ARTICLES.whichWine, ARTICLES.windowsChoice];
        if (SHARED_RUNTIMES[topic.id] && topic.moduleId === "android") return [...runtime, ARTICLES.androidChoice];
        return [...runtime, ARTICLES.runtimeAndVersion, ARTICLES.choosing];
      }
      case "version": return [ARTICLES.runtimeAndVersion, ARTICLES.versions, ARTICLES.runtimesWindow];
      case "runtime-settings":
        if (topic.id === "arguments") return [ARTICLES.launchArguments];
        if (topic.id === "network") return [ARTICLES.gameNetwork, ARTICLES.networkAccess];
        if (topic.id === "environment") return [ARTICLES.gameEnvironment, ARTICLES.patchEnvironment, ARTICLES.environmentVariables];
        if (topic.id === "module") return [ARTICLES.settings];
        return [...runtimeSettingArticles(topic.id, topic.detail), ARTICLES.runtimeSettings, ...runtimeArticles(topic.id, topic.moduleId)];
      case "play": return [ARTICLES.play, ARTICLES.launch, engine(topic.moduleId)];
      case "add": return [ARTICLES.addGame, ARTICLES.games];
      case "effect": return effectArticles(topic.id, topic.detail, topic.moduleId);
      case "window": case "section": return windowArticles(topic);
      case "settings": return [...topic.id.split(",").flatMap(key => SETTINGS_ARTICLES[key] || []), ARTICLES.settings];
      case "runtime-action": return [...(detail === "build" ? [ARTICLES.processorBuilds, ARTICLES.pickingBuilds] : []),
        ...(RUNTIME_ACTION_ARTICLES[topic.id] || []), ARTICLES.runtimesWindow];
      case "store":
        if (topic.id === "scan" || topic.id === "import") return [ARTICLES.installedGames, ARTICLES.external];
        if (topic.id === "account") return [ARTICLES.accounts, ARTICLES.filesAndAccounts, ARTICLES.external];
        return [ARTICLES.downloads, ARTICLES.external];
      case "saves": return [ARTICLES.saves, ARTICLES.movingSaves];
      case "cheats": return [...(topic.moduleId && CHEAT_MODULES[topic.moduleId] ? [CHEAT_MODULES[topic.moduleId]] : []), ARTICLES.cheats];
      case "tool": {
        const rule = TOOL_RULES.find(([pattern]) => pattern.test(topic.id));
        return [...(rule ? rule[1] : [toolSection(topic.moduleId)]), ARTICLES.gameTools, engine(topic.moduleId)];
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
  const tables: Array<Record<string, Article[]>> = [METHOD_ARTICLES, SHADER_ARTICLES, OUTPUT_ARTICLES, CHAIN_ARTICLES, KIND_ARTICLES, ACTION_ARTICLES,
    SETTINGS_ARTICLES, RUNTIME_ACTION_ARTICLES, SHARED_RUNTIMES, MANAGER_ARTICLES, GROUP_ARTICLES, EXTERNAL_TABS, RUNTIME_SETTING_ARTICLES,
    GAME_ARTICLES, Object.fromEntries(TRANSLATOR_ENGINES.map(([pattern, list]) => [String(pattern), list]))];
  return [...Object.values(ARTICLES), ...Object.values(MODULE_ARTICLES), ...Object.values(CHEAT_MODULES), ...Object.values(TRANSLATOR_KEYS),
    ...Object.values(WINE_SECTIONS), ...Object.keys(MODULE_ARTICLES).map(toolSection),
    ...tables.flatMap(table => Object.values(table).flat()), ...TOOL_RULES.flatMap(([, list]) => list),
    ...modules.flatMap(info => info.runtimes.flatMap(runtime => runtimeArticles(runtime, info.id)))];
}

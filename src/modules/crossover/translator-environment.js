// Environment variables of the Wine runtimes. Locked names are the paths,
// loaders and selections that runtime/launch.js and sikarugir/launch.js must
// set for every launch. Launcher values come from Runtime Settings
// (src/modules/shared/runtime/wine-settings.js and the launch files); a value
// set here replaces them for the games it applies to.
const paths = "The launcher sets this path for the game's Windows environment.";
const locale = "Set by Language locale in Runtime Settings.";
const shared = [
  { key: "LANG", description: "Locale of the Windows program, such as ja_JP.UTF-8.", launcher: locale },
  { key: "LC_ALL", description: "Locale that overrides every category, such as ja_JP.UTF-8.", launcher: locale },
  { key: "LC_MESSAGES", description: "Locale of program messages, such as ja_JP.UTF-8.", launcher: locale },
  { key: "WINE_D3D_CONFIG", description: "WineD3D options, such as renderer=vulkan or csmt=0x1.", launcher: "Set by WineD3D options in Runtime Settings." },
  { key: "MTL_HUD_ENABLED", description: "1 shows the Metal Performance HUD.", launcher: "Set by Metal Performance HUD in Runtime Settings." },
  { key: "ROSETTA_ADVERTISE_AVX", description: "1 reports AVX support to Intel programs under Rosetta.", launcher: "Set by Advertise AVX under Rosetta in Runtime Settings." },
  { key: "DOTNET_EnableWriteXorExecute", description: "0 turns off .NET W^X memory protection, which is slow under Rosetta.", launcher: "Set to 0 for Intel Wine under Rosetta." }
];
const locked = [
  ...["HOME", "PATH", "TMPDIR", "WINEPREFIX", "WINEARCH", "WINELOADER", "WINESERVER", "WINEDLLPATH"].map(key => ({ key, reason: paths })),
  { key: "WINEDLLOVERRIDES", reason: "The translator choices select their libraries here. The Wine DLL overrides setting in Runtime Settings adds other libraries." },
  { prefix: "MACLAUNCHER_", reason: "Used by MacLauncher's own graphics and translator libraries." }
];
const sync = "Set by Synchronization in Runtime Settings.";
module.exports = [
  { id: "crossover", label: "CrossOver", managerIds: ["crossover"],
    description: "Applies to every game that runs with CrossOver.",
    keys: [
      { key: "WINEDEBUG", description: "Wine debug channels, such as -all or +seh,+loaddll.", launcher: "Set by Wine debug channels in Runtime Settings." },
      { key: "WINEMSYNC", description: "1 turns on MSync and 0 turns it off.", launcher: sync },
      { key: "WINEESYNC", description: "1 turns on ESync and 0 turns it off.", launcher: sync },
      { key: "CX_GRAPHICS_BACKEND", description: "CrossOver's Direct3D renderer: d3dmetal, dxmt, dxvk or wined3d.", launcher: "Set by the Direct3D translator choice in Runtime Settings." },
      ...shared
    ],
    locked: [...locked,
      ...["CX_ROOT", "CX_HOME", "CX_BOTTLE", "CX_BOTTLE_PATH", "CX_MANAGED_BOTTLE_PATH", "CX_INITIALIZED", "CX_ENV", "CX_WINELOADER"]
        .map(key => ({ key, reason: "The launcher sets CrossOver's application and bottle paths." }))] },
  { id: "sikarugir", label: "Sikarugir", managerIds: ["sikarugir"],
    description: "Applies to every game that runs with Sikarugir.",
    keys: [
      { key: "WINEDEBUG", description: "Wine debug channels, such as -all or +seh,+loaddll.", launcher: "MacLauncher sets -all, or Wine debug channels from Runtime Settings." },
      ...shared
    ],
    locked: [...locked,
      { key: "WINEMSYNC", reason: sync }, { key: "WINEESYNC", reason: sync },
      ...["DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "DYLD_FALLBACK_FRAMEWORK_PATH", "DYLD_INSERT_LIBRARIES"]
        .map(key => ({ key, reason: "The launcher sets the library paths of the selected Wine and translators." })),
      ...["VK_DRIVER_FILES", "VK_ICD_FILENAMES"].map(key => ({ key, reason: "Names the selected Vulkan driver." })),
      ...["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"].map(key => ({ key, reason: "MacLauncher's own process options are not passed to games." })),
      { key: "SikarugirAppWine11", reason: "Required by Sikarugir's Wine 11 loader." },
      { prefix: "CX_", reason: "CrossOver variables are not passed to Sikarugir launches." },
      { prefix: "GST_", reason: "The launcher sets the GStreamer plugins of the selected video codecs." }] }
];

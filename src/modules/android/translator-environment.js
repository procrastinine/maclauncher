// Environment variables of the Android runtimes and ANGLE, the OpenGL ES
// implementation that they draw with. "android" is MacLauncher Android's own
// translator and applies with both execution engines. Locked names are the
// storage, sandbox, graphics and policy values of host.js, sandbox.js,
// art/layout.mjs and providers/macapk/index.js.
const folders = "The launcher sets the Android system and storage folders.";
const sandbox = [
  ...["HOME", "CFFIXED_USER_HOME", "TMPDIR", "PATH"].map(key => ({ key, reason: "The launcher sets this path inside the game's sandbox." })),
  { prefix: "ANDROID_", reason: folders },
  ...["DOWNLOAD_CACHE", "EXTERNAL_STORAGE", "OEM_ROOT", "ODM_ROOT", "VENDOR_ROOT", "PRODUCT_ROOT", "PRODUCT_SERVICES_ROOT",
    "SYSTEM_EXT_ROOT", "APEX_ROOT"].map(key => ({ key, reason: folders })),
  ...["VK_DRIVER_FILES", "VK_ICD_FILENAMES"].map(key => ({ key, reason: "Points the Vulkan loader at the selected driver." })),
  { prefix: "KL_", reason: "The launcher sets the Android runtime's process and graphics options." },
  { prefix: "KLJ_", reason: "The launcher sets the Android runtime's process and graphics options." },
  { prefix: "DYLD_", reason: "The launcher sets the runtime's library paths." },
  { prefix: "MACLAUNCHER_", reason: "Used by MacLauncher's own Android services." }
];
const art = "The ART runtime starts the game from its prepared framework with its own class paths and options.";
module.exports = [
  { id: "android", label: "MacLauncher Android", managerIds: ["android"],
    description: "Applies to every Android game that runs with MacLauncher Android, with either execution engine.",
    keys: [],
    locked: sandbox },
  { id: "android-jvm", label: "Android JVM", managerIds: ["android"],
    description: "Applies to Android games whose execution engine is JVM.",
    keys: [
      { key: "JDK_JAVA_OPTIONS", description: "Options added to the java command line, such as -Xmx4g." },
      { key: "JAVA_TOOL_OPTIONS", description: "Options that every JVM in the process reads, such as -Xss4m." }
    ],
    locked: sandbox },
  { id: "android-art", label: "Android ART", managerIds: ["android"],
    description: "Applies to Android games whose execution engine is ART.",
    keys: [],
    locked: [...sandbox,
      ...["BOOTCLASSPATH", "CLASSPATH", "DEX2OATBOOTCLASSPATH", "SYSTEMSERVERCLASSPATH", "STANDALONE_SYSTEMSERVER_JARS",
        "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "DALVIK_VM_OPTIONS", "ART_VM_OPTIONS"].map(key => ({ key, reason: art })),
      { prefix: "LD_", reason: "The ART runtime sets the game's library loading." }] },
  { id: "macapk", label: "Mac.apk", managerIds: ["macapk"],
    description: "Applies to every Android game that runs with Mac.apk.",
    keys: [],
    locked: [
      ...["HOME", "CFFIXED_USER_HOME", "TMPDIR", "PATH"].map(key => ({ key, reason: "The launcher sets this path inside the game's sandbox." })),
      { key: "JAVA_TOOL_OPTIONS", reason: "Loads MacLauncher's executable policy and launch arguments." },
      { prefix: "MACAPK_", reason: "The launcher sets Mac.apk's storage, device, network and privacy options." },
      { prefix: "DYLD_", reason: "The launcher sets the runtime's library paths." },
      { prefix: "MACLAUNCHER_", reason: "Used by MacLauncher's own Android services." }
    ] },
  { id: "angle", label: "ANGLE", managerIds: ["android", "macapk"],
    description: "Applies to Android games, which draw OpenGL ES through ANGLE.",
    keys: [
      { key: "ANGLE_FEATURE_OVERRIDES_ENABLED", description: "ANGLE features to turn on, separated by commas." },
      { key: "ANGLE_FEATURE_OVERRIDES_DISABLED", description: "ANGLE features to turn off, separated by commas." },
      { key: "MTL_HUD_ENABLED", description: "1 shows the Metal Performance HUD with the Metal backend." }
    ],
    locked: [{ key: "KL_ANGLE_BACKEND", reason: "Set by OpenGL ES backend in Runtime Settings." },
      { key: "MACAPK_ANGLE_BACKEND", reason: "Set by Graphics backend in Runtime Settings." }] }
];

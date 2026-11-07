# Translator environment variables

Every runtime that offers a translator choice passes environment variables to the translators that a game uses: the Wine runtime and its graphics translators, the Android execution engine, ANGLE and the Vulkan driver, and the PlayStation 5 runtimes with their Vulkan driver. Each translator has global values in **Runtimes**, and these global values are the defaults of every game that uses the translator. A game's **Runtime Settings** can change, add or remove variables for that game only. Values are stored and passed exactly as written. Shell expansion, quoting and variable references such as `$HOME` have no effect. A change applies on the next launch.

## Translators of each runtime

A game receives the variables of the translators that its runtime and settings choose at launch.

| Runtime | Translators whose variables apply |
| --- | --- |
| CrossOver | CrossOver, and each graphics translator that the game uses after any [fallback](TRANSLATORS.md#compatibility-and-fallback): D3DMetal, DXMT, DXVK, vkd3d-proton, MoltenVK, KosmicKrisp and GStreamer codecs. |
| Sikarugir | Sikarugir, and each graphics translator that the game uses after any fallback, as for CrossOver. |
| MacLauncher Android | MacLauncher Android, Android JVM or Android ART following the **Execution** setting, and ANGLE. When the **OpenGL ES backend** is Vulkan, the selected Vulkan driver, MoltenVK or KosmicKrisp, as well. |
| Mac.apk | Mac.apk and ANGLE. When the **Graphics backend** is Vulkan, MoltenVK as well. |
| AnyPS5 | AnyPS5 and the selected Vulkan driver. |
| Prosper | Prosper and the selected Vulkan driver. |

AIM has no translator choice and no translator environment. WineD3D and Wine vkd3d belong to the Wine runtime, so their variables, such as `WINE_D3D_CONFIG`, are set with CrossOver or Sikarugir.

## Global values

On a runtime manager's tab in **Runtimes**, the collapsed **Environment variables** section at the top of the panel holds the global values of the translators that the manager provides. Its title shows the number of values. These values apply to every game that uses the translator. KosmicKrisp has the same global values on the **KosmicKrisp** and **MacLauncher KosmicKrisp** tabs, and ANGLE's values appear on the **MacLauncher Android** and **Mac.apk** tabs.

## Values for one game

In a game's **Runtime Settings**, the **Environment variables** section shows the values of the translators that the current settings choose. The list of translators follows the settings as they are edited, such as a different Direct3D engine, Vulkan driver or execution engine. Values from Runtimes appear together with the game's own changes, additions and removals. A game's values are stored with the game and are independent of the game type defaults in **Settings**.

## Editor

Each scope has one table of rows in the form `NAME = value`, followed by one row that adds a variable. When the scope covers several translators, the rows appear under a small heading for each translator that has values, the runtime's own translator first.

- The value field saves when it loses focus or on Return, and Escape returns it to the saved value.
- The add row has a name field that suggests the variables of every translator in the table, a value field and an **Add** button. Return in either field adds the variable, and Escape clears both fields.
- A new variable joins the translator whose heading already lists it, then the translator that suggests it, and otherwise the runtime's own translator. The runtime's own translator applies to every game that the runtime launches, so on the **MacLauncher Android** tab a variable that no translator suggests reaches games with either execution engine. While a name is typed in a table with several translators, the hint under the add row names that translator, together with the variable's description when it is a suggested one.
- The remove button (×) removes a variable. In a game, removing a value from Runtimes stores a removal for that game, which the row shows as **Removed** with the inherited value struck through.
- **Restore** returns a changed or removed row to its inherited value.
- One **Reset** per scope removes every value stored there: the global values in Runtimes, or the game's own values in Runtime Settings.
- A suggested variable's name shows its description as a tooltip.

Each row has a badge for its source:

| Badge | Meaning |
| --- | --- |
| From Runtimes | In a game, a value inherited from the global values in Runtimes. |
| Default | A translator's built-in value. |
| Changed | The game replaces an inherited value. |
| This game | A variable that only this game sets. |
| Removed | The game removes an inherited value. |
| Set by MacLauncher | MacLauncher also sets this variable. In a warning color, the value in the row replaces MacLauncher's value, and the tooltip names the setting or condition behind it. In an error color, the variable is locked, the value is not used, and the next save drops it. |

A name has the form of a shell variable: a letter or underscore followed by letters, digits or underscores, at most 256 characters. A value can hold any text except line breaks and NUL characters, at most 32,768 characters, and an empty value is passed as an empty variable. One translator holds at most 256 variables at each scope. An invalid name or value is reported under the editor and is not saved.

## Locked variables

MacLauncher sets some variables itself, such as the paths of a game's Windows environment, Android sandbox or save folders and the files that select a translator or Vulkan driver. These names are locked. A locked name cannot be added, and the editor explains why when it is typed. Locked names stay locked when another translator with the same names is also in use, so a value stored for one translator cannot replace a path that another translator's runtime sets.

In a game, the locks of every translator in the table apply, because these translators run together. In Runtimes, the runtime's own translator follows the locks of every translator on the tab, since it runs with each of them, and any other translator follows its own locks. On the **MacLauncher Android** tab, `JAVA_TOOL_OPTIONS` can therefore be set for Android JVM although Android ART locks it, and `LD_PRELOAD` cannot be set for MacLauncher Android.

## Order of values

At launch, MacLauncher combines the values of the chosen translators in this order, and a later step replaces an earlier one:

1. the translators' built-in defaults;
2. the global values from Runtimes;
3. the game's own values from Runtime Settings.

Within each step, the runtime's own translator comes first, followed by the graphics translators and the Vulkan driver, so a variable that two translators set takes the later translator's value. A removal in a game takes away the inherited value, and the variable then keeps whatever value the launcher would give it without this setting. The combined values are applied before the variables that the launcher requires, so locked names always keep the launcher's value. Variables that the launcher sets from Runtime Settings, which the editor marks **Set by MacLauncher** in a warning color, take the combined value instead.

Every translator's built-in defaults are empty, so the global values start empty.

## Storage

Global values are stored in `settings.json` under `launcher.translatorEnvironment`, and a game's values in its `game.json` under `translatorEnvironment`. Both map a translator id to its variables, and a game's removal is stored as `null`. The [data model](../development/DATA_MODEL.md) describes both fields.

## Translators

Each translator lists suggested variables with their effect. The **Launcher value** column names the variables that MacLauncher also sets and the setting or condition behind them. Any other variable whose name is not locked can be added as well.

### CrossOver

Applies to every game that runs with CrossOver. Its global values are on the **CrossOver** tab of Runtimes.

| Variable | Effect | Launcher value |
| --- | --- | --- |
| `WINEDEBUG` | Wine debug channels, such as -all or +seh,+loaddll. | Set by Wine debug channels in Runtime Settings. |
| `WINEMSYNC` | 1 turns on MSync and 0 turns it off. | Set by Synchronization in Runtime Settings. |
| `WINEESYNC` | 1 turns on ESync and 0 turns it off. | Set by Synchronization in Runtime Settings. |
| `CX_GRAPHICS_BACKEND` | CrossOver's Direct3D renderer: d3dmetal, dxmt, dxvk or wined3d. | Set by the Direct3D translator choice in Runtime Settings. |
| `LANG` | Locale of the Windows program, such as ja_JP.UTF-8. | Set by Language locale in Runtime Settings. |
| `LC_ALL` | Locale that overrides every category, such as ja_JP.UTF-8. | Set by Language locale in Runtime Settings. |
| `LC_MESSAGES` | Locale of program messages, such as ja_JP.UTF-8. | Set by Language locale in Runtime Settings. |
| `WINE_D3D_CONFIG` | WineD3D options, such as renderer=vulkan or csmt=0x1. | Set by WineD3D options in Runtime Settings. |
| `MTL_HUD_ENABLED` | 1 shows the Metal Performance HUD. | Set by Metal Performance HUD in Runtime Settings. |
| `ROSETTA_ADVERTISE_AVX` | 1 reports AVX support to Intel programs under Rosetta. | Set by Advertise AVX under Rosetta in Runtime Settings. |
| `DOTNET_EnableWriteXorExecute` | 0 turns off .NET W^X memory protection, which is slow under Rosetta. | Set to 0 for Intel Wine under Rosetta. |

| Locked | Reason |
| --- | --- |
| `HOME`, `PATH`, `TMPDIR`, `WINEPREFIX`, `WINEARCH`, `WINELOADER`, `WINESERVER`, `WINEDLLPATH` | The launcher sets this path for the game's Windows environment. |
| `WINEDLLOVERRIDES` | The translator choices select their libraries here. The Wine DLL overrides setting in Runtime Settings adds other libraries. |
| `MACLAUNCHER_`… | Used by MacLauncher's own graphics and translator libraries. |
| `CX_ROOT`, `CX_HOME`, `CX_BOTTLE`, `CX_BOTTLE_PATH`, `CX_MANAGED_BOTTLE_PATH`, `CX_INITIALIZED`, `CX_ENV`, `CX_WINELOADER` | The launcher sets CrossOver's application and bottle paths. |

### Sikarugir

Applies to every game that runs with Sikarugir. Its global values are on the **Sikarugir Wine** tab of Runtimes.

| Variable | Effect | Launcher value |
| --- | --- | --- |
| `WINEDEBUG` | Wine debug channels, such as -all or +seh,+loaddll. | MacLauncher sets -all, or Wine debug channels from Runtime Settings. |
| `LANG` | Locale of the Windows program, such as ja_JP.UTF-8. | Set by Language locale in Runtime Settings. |
| `LC_ALL` | Locale that overrides every category, such as ja_JP.UTF-8. | Set by Language locale in Runtime Settings. |
| `LC_MESSAGES` | Locale of program messages, such as ja_JP.UTF-8. | Set by Language locale in Runtime Settings. |
| `WINE_D3D_CONFIG` | WineD3D options, such as renderer=vulkan or csmt=0x1. | Set by WineD3D options in Runtime Settings. |
| `MTL_HUD_ENABLED` | 1 shows the Metal Performance HUD. | Set by Metal Performance HUD in Runtime Settings. |
| `ROSETTA_ADVERTISE_AVX` | 1 reports AVX support to Intel programs under Rosetta. | Set by Advertise AVX under Rosetta in Runtime Settings. |
| `DOTNET_EnableWriteXorExecute` | 0 turns off .NET W^X memory protection, which is slow under Rosetta. | Set to 0 for Intel Wine under Rosetta. |

| Locked | Reason |
| --- | --- |
| `HOME`, `PATH`, `TMPDIR`, `WINEPREFIX`, `WINEARCH`, `WINELOADER`, `WINESERVER`, `WINEDLLPATH` | The launcher sets this path for the game's Windows environment. |
| `WINEDLLOVERRIDES` | The translator choices select their libraries here. The Wine DLL overrides setting in Runtime Settings adds other libraries. |
| `MACLAUNCHER_`… | Used by MacLauncher's own graphics and translator libraries. |
| `WINEMSYNC`, `WINEESYNC` | Set by Synchronization in Runtime Settings. |
| `DYLD_LIBRARY_PATH`, `DYLD_FALLBACK_LIBRARY_PATH`, `DYLD_FRAMEWORK_PATH`, `DYLD_FALLBACK_FRAMEWORK_PATH`, `DYLD_INSERT_LIBRARIES` | The launcher sets the library paths of the selected Wine and translators. |
| `VK_DRIVER_FILES`, `VK_ICD_FILENAMES` | Names the selected Vulkan driver. |
| `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE` | MacLauncher's own process options are not passed to games. |
| `SikarugirAppWine11` | Required by Sikarugir's Wine 11 loader. |
| `CX_`… | CrossOver variables are not passed to Sikarugir launches. |
| `GST_`… | The launcher sets the GStreamer plugins of the selected video codecs. |

### D3DMetal

Applies to games whose Direct3D 11 or 12 choice uses D3DMetal. Its global values are on the **D3DMetal** tab of Runtimes.

| Variable | Effect | Launcher value |
| --- | --- | --- |
| `D3DM_SUPPORT_DXR` | 1 exposes DirectX Raytracing on Macs that support it. |  |
| `D3DM_ENABLE_METALFX` | 1 translates DLSS requests to MetalFX. | Set by Game temporal integration in Runtime Settings. |
| `D3DM_MAX_FPS` | Frame rate limit. | Set by D3DMetal FPS limit in Runtime Settings. |
| `D3DM_MTL4` | 1 renders with Metal 4 where available. | Set by D3DMetal Metal 4 in Runtime Settings. |
| `D3DM_VENDOR_ID` | PCI vendor ID that the adapter reports to the game. |  |
| `D3DM_DEVICE_ID` | PCI device ID that the adapter reports to the game. |  |
| `D3DM_DEVICE_DESCRIPTION` | Adapter name that the game sees. |  |

| Locked | Reason |
| --- | --- |

### DXMT

Applies to games whose Direct3D 10 or 11 choice uses DXMT. Its global values are on the **DXMT** tab of Runtimes.

| Variable | Effect | Launcher value |
| --- | --- | --- |
| `DXMT_CONFIG` | Options separated by semicolons, such as d3d11.preferredMaxFrameRate=60. | Set by DXMT configuration in Runtime Settings. |
| `DXMT_CONFIG_FILE` | Path of a DXMT configuration file. |  |
| `DXMT_LOG_LEVEL` | Log detail: none, error, warn, info or debug. |  |
| `DXMT_LOG_PATH` | Folder for DXMT log files. |  |
| `DXMT_SHADER_CACHE` | 0 turns off DXMT's shader cache. |  |
| `DXMT_SHADER_CACHE_PATH` | Folder for DXMT's shader cache. |  |
| `DXMT_METALFX_SPATIAL_SWAPCHAIN` | 1 upscales the swap chain with MetalFX spatial scaling. | Set by MetalFX spatial in Runtime Settings. |
| `DXMT_ENABLE_NVEXT` | 1 exposes NVIDIA extensions for DLSS through MetalFX. | Set by Game temporal integration in Runtime Settings. |

| Locked | Reason |
| --- | --- |

### DXVK

Applies to games whose Direct3D 8, 9, 10 or 11 choice uses DXVK, D8VK or D9VK. Its global values are on the **DXVK** tab of Runtimes.

| Variable | Effect | Launcher value |
| --- | --- | --- |
| `DXVK_CONFIG` | dxvk.conf options separated by semicolons, such as dxvk.enableAsync = True. |  |
| `DXVK_CONFIG_FILE` | Path of a dxvk.conf file. |  |
| `DXVK_HUD` | On-screen HUD elements, such as fps, frametimes, compiler or full. | Set by DXVK HUD in Runtime Settings. |
| `DXVK_ASYNC` | 1 compiles shaders asynchronously in DXVK async builds. | Set by DXVK async in Runtime Settings. |
| `DXVK_LOG_LEVEL` | Log detail: none, error, warn, info or debug. |  |
| `DXVK_LOG_PATH` | Folder for DXVK log files, or none to write no log files. |  |
| `DXVK_SHADER_CACHE` | 0 turns off DXVK's internal shader cache. |  |
| `DXVK_SHADER_CACHE_PATH` | Folder for DXVK's internal shader cache. |  |
| `DXVK_STATE_CACHE_PATH` | Folder for the pipeline state cache of DXVK 2.6 and earlier. |  |
| `DXVK_FILTER_DEVICE_NAME` | Uses the Vulkan device whose name contains this text. |  |
| `DXVK_ENABLE_NVAPI` | 1 reports an NVIDIA GPU so that NVAPI can load. |  |
| `DXVK_DEBUG` | Debugging mode, such as markers or validation. |  |

| Locked | Reason |
| --- | --- |

### vkd3d-proton

Applies to games whose Direct3D 12 choice uses vkd3d-proton. Its global values are on the **vkd3d-proton** tab of Runtimes.

| Variable | Effect | Launcher value |
| --- | --- | --- |
| `VKD3D_CONFIG` | Options separated by commas, such as nodxr or single_queue. |  |
| `VKD3D_DEBUG` | Log detail: none, err, info, fixme, warn or trace. |  |
| `VKD3D_SHADER_DEBUG` | Log detail of the shader compilers, with the VKD3D_DEBUG values. |  |
| `VKD3D_LOG_FILE` | File that receives the log instead of the standard error output. |  |
| `VKD3D_SHADER_CACHE_PATH` | Folder for vkd3d-proton.cache, or 0 to turn the cache off. |  |
| `VKD3D_FRAME_RATE` | Frame rate limit; 0 removes the limit. |  |
| `VKD3D_SWAPCHAIN_PRESENT_MODE` | Present mode: IMMEDIATE, MAILBOX, FIFO or FIFO_RELAXED. |  |
| `VKD3D_FILTER_DEVICE_NAME` | Uses a Vulkan device whose name contains this text. |  |
| `VKD3D_DISABLE_EXTENSIONS` | Vulkan extensions that vkd3d-proton does not use. |  |

| Locked | Reason |
| --- | --- |

### GStreamer codecs

Applies to games whose video codec choice is a registered GStreamer folder. Its global values are on the **GStreamer codecs** tab of Runtimes.

| Variable | Effect | Launcher value |
| --- | --- | --- |
| `GST_DEBUG` | Log detail by category, such as 2 or *:3. |  |
| `GST_DEBUG_FILE` | File that receives the GStreamer log. |  |
| `GST_DEBUG_NO_COLOR` | 1 writes the log without color codes. |  |

| Locked | Reason |
| --- | --- |
| `GST_PLUGIN_`… | The codec choice sets the plugin folders. |
| `GST_REGISTRY`… | The launcher keeps the plugin registry with the codec folder. |

### MoltenVK

Applies to games whose Vulkan driver is MoltenVK. Its global values are on the **MoltenVK** tab of Runtimes.

| Variable | Effect | Launcher value |
| --- | --- | --- |
| `MVK_CONFIG_LOG_LEVEL` | Log detail: 0 none, 1 errors, 2 warnings, 3 information, 4 debug. |  |
| `MVK_CONFIG_FAST_MATH_ENABLED` | Metal fast math: 0 never, 1 always, 2 when a shader requests it. | Set by MoltenVK fast math in the Runtime Settings of Wine games. |
| `MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS` | 1 places descriptors in Metal argument buffers. | Set by MoltenVK argument buffers in the Runtime Settings of Wine games. |
| `MVK_CONFIG_UE4_HACK_ENABLED` | 1 turns on MoltenVK's workarounds for Unreal Engine 4 games. | Set by MoltenVK UE4 compatibility in the Runtime Settings of Wine games. |
| `MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS` | 1 processes queue submissions on the calling thread. |  |
| `MVK_CONFIG_PREFILL_METAL_COMMAND_BUFFERS` | Metal command buffer filling: 0 at submission, 1 deferred, 2 immediate, 3 immediate without autorelease pools. |  |
| `MVK_CONFIG_MAX_ACTIVE_METAL_COMMAND_BUFFERS_PER_QUEUE` | Number of Metal command buffers a queue may have in flight. |  |
| `MVK_CONFIG_USE_MTLHEAP` | Resource heaps: 0 never, 1 where safe, 2 always. |  |
| `MVK_CONFIG_RESUME_LOST_DEVICE` | 1 keeps the device usable after a GPU error. |  |
| `MVK_CONFIG_SHADER_COMPRESSION_ALGORITHM` | Compression of cached shader source: 0 none, 1 LZFSE, 2 ZLIB, 3 LZ4, 4 LZMA. |  |
| `MVK_CONFIG_SWAPCHAIN_MIN_MAG_FILTER_USE_NEAREST` | 1 scales the swap chain with nearest-neighbor sampling. |  |
| `MVK_CONFIG_SPECIALIZED_QUEUE_FAMILIES` | 1 offers separate queue families for graphics, compute and transfer. |  |
| `MVK_CONFIG_PERFORMANCE_TRACKING` | 1 collects performance statistics. |  |
| `MVK_CONFIG_ACTIVITY_PERFORMANCE_LOGGING_STYLE` | When performance statistics are logged: 0 by frame count, 1 immediately, 2 when the device ends. |  |
| `MVK_CONFIG_DEBUG` | 1 adds debugging information to converted shaders and logs. |  |
| `VK_LOADER_DEBUG` | Vulkan loader messages: error, warn, info, debug, driver or all. |  |

| Locked | Reason |
| --- | --- |
| `VK_DRIVER_FILES`, `VK_ICD_FILENAMES` | Points the Vulkan loader at the selected driver. |
| `KL_MVK_DYLIB` | Names the selected Vulkan library for Android. |
| `CX_LIBVULKAN` | Names the selected Vulkan library for CrossOver. |

### KosmicKrisp

Applies to games whose Vulkan driver is a KosmicKrisp build. Its global values are on the **KosmicKrisp** and **MacLauncher KosmicKrisp** tabs of Runtimes.

| Variable | Effect | Launcher value |
| --- | --- | --- |
| `MESA_KK_DEBUG` | Driver debugging flags: msl, force_robustness or force_per_vertex_buffer. |  |
| `KK_EMULATION` | Comma-separated emulation selection: optional initial `performance` or `conformance`, `+name`/`-name`, `-VK_extension_name` to hide an extension, and `apple7` through `apple11` or `mode=7` through `mode=11` chip presets. See [Performance and conformance](KOSMICKRISP.md#performance-and-conformance). |  |
| `MESA_KK_EXPERIMENTAL` | Experimental features: custom_border, image_view_min_lod, optimize_e5b9g9r9 or all. The driver's default is custom_border,image_view_min_lod. |  |
| `MESA_KK_DISABLE_WORKAROUNDS` | Workaround numbers to turn off, separated by commas, or all. |  |
| `MESA_KK_GPU_CAPTURE` | true records a Metal GPU capture. |  |
| `MESA_KK_GPU_CAPTURE_DIRECTORY` | Folder that receives Metal GPU captures. |  |
| `MESA_SHADER_CACHE_DIR` | Folder for Mesa's shader cache. |  |
| `MESA_SHADER_CACHE_DISABLE` | true turns off Mesa's shader cache. |  |
| `MESA_SHADER_CACHE_MAX_SIZE` | Largest shader cache size, such as 1G or 512M. |  |
| `MESA_VK_WSI_PRESENT_MODE` | Present mode: immediate, mailbox, fifo or relaxed. |  |
| `MESA_VK_ABORT_ON_DEVICE_LOSS` | true stops the process when the GPU device is lost. |  |
| `MESA_VK_ENABLE_SUBMIT_THREAD` | true submits queue work on a separate thread. |  |
| `VK_LOADER_DEBUG` | Vulkan loader messages: error, warn, info, debug, driver or all. |  |

| Locked | Reason |
| --- | --- |
| `VK_DRIVER_FILES`, `VK_ICD_FILENAMES` | Points the Vulkan loader at the selected driver. |
| `KL_MVK_DYLIB` | Names the selected Vulkan library for Android. |
| `CX_LIBVULKAN` | Names the selected Vulkan library for CrossOver. |

### MacLauncher Android

Applies to every Android game that runs with MacLauncher Android, with either execution engine. Its global values are on the **MacLauncher Android** tab of Runtimes.

No variables are suggested. Any variable that is not locked can be added.

| Locked | Reason |
| --- | --- |
| `HOME`, `CFFIXED_USER_HOME`, `TMPDIR`, `PATH` | The launcher sets this path inside the game's sandbox. |
| `ANDROID_`…, `DOWNLOAD_CACHE`, `EXTERNAL_STORAGE`, `OEM_ROOT`, `ODM_ROOT`, `VENDOR_ROOT`, `PRODUCT_ROOT`, `PRODUCT_SERVICES_ROOT`, `SYSTEM_EXT_ROOT`, `APEX_ROOT` | The launcher sets the Android system and storage folders. |
| `VK_DRIVER_FILES`, `VK_ICD_FILENAMES` | Points the Vulkan loader at the selected driver. |
| `KL_`…, `KLJ_`… | The launcher sets the Android runtime's process and graphics options. |
| `DYLD_`… | The launcher sets the runtime's library paths. |
| `MACLAUNCHER_`… | Used by MacLauncher's own Android services. |

### Android JVM

Applies to Android games whose execution engine is JVM. Its global values are on the **MacLauncher Android** tab of Runtimes.

| Variable | Effect | Launcher value |
| --- | --- | --- |
| `JDK_JAVA_OPTIONS` | Options added to the java command line, such as -Xmx4g. |  |
| `JAVA_TOOL_OPTIONS` | Options that every JVM in the process reads, such as -Xss4m. |  |

| Locked | Reason |
| --- | --- |
| `HOME`, `CFFIXED_USER_HOME`, `TMPDIR`, `PATH` | The launcher sets this path inside the game's sandbox. |
| `ANDROID_`…, `DOWNLOAD_CACHE`, `EXTERNAL_STORAGE`, `OEM_ROOT`, `ODM_ROOT`, `VENDOR_ROOT`, `PRODUCT_ROOT`, `PRODUCT_SERVICES_ROOT`, `SYSTEM_EXT_ROOT`, `APEX_ROOT` | The launcher sets the Android system and storage folders. |
| `VK_DRIVER_FILES`, `VK_ICD_FILENAMES` | Points the Vulkan loader at the selected driver. |
| `KL_`…, `KLJ_`… | The launcher sets the Android runtime's process and graphics options. |
| `DYLD_`… | The launcher sets the runtime's library paths. |
| `MACLAUNCHER_`… | Used by MacLauncher's own Android services. |

### Android ART

Applies to Android games whose execution engine is ART. Its global values are on the **MacLauncher Android** tab of Runtimes.

No variables are suggested. Any variable that is not locked can be added.

| Locked | Reason |
| --- | --- |
| `HOME`, `CFFIXED_USER_HOME`, `TMPDIR`, `PATH` | The launcher sets this path inside the game's sandbox. |
| `ANDROID_`…, `DOWNLOAD_CACHE`, `EXTERNAL_STORAGE`, `OEM_ROOT`, `ODM_ROOT`, `VENDOR_ROOT`, `PRODUCT_ROOT`, `PRODUCT_SERVICES_ROOT`, `SYSTEM_EXT_ROOT`, `APEX_ROOT` | The launcher sets the Android system and storage folders. |
| `VK_DRIVER_FILES`, `VK_ICD_FILENAMES` | Points the Vulkan loader at the selected driver. |
| `KL_`…, `KLJ_`… | The launcher sets the Android runtime's process and graphics options. |
| `DYLD_`… | The launcher sets the runtime's library paths. |
| `MACLAUNCHER_`… | Used by MacLauncher's own Android services. |
| `BOOTCLASSPATH`, `CLASSPATH`, `DEX2OATBOOTCLASSPATH`, `SYSTEMSERVERCLASSPATH`, `STANDALONE_SYSTEMSERVER_JARS`, `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS`, `_JAVA_OPTIONS`, `DALVIK_VM_OPTIONS`, `ART_VM_OPTIONS` | The ART runtime starts the game from its prepared framework with its own class paths and options. |
| `LD_`… | The ART runtime sets the game's library loading. |

### Mac.apk

Applies to every Android game that runs with Mac.apk. Its global values are on the **Mac.apk** tab of Runtimes.

No variables are suggested. Any variable that is not locked can be added.

| Locked | Reason |
| --- | --- |
| `HOME`, `CFFIXED_USER_HOME`, `TMPDIR`, `PATH` | The launcher sets this path inside the game's sandbox. |
| `JAVA_TOOL_OPTIONS` | Loads MacLauncher's executable policy and launch arguments. |
| `MACAPK_`… | The launcher sets Mac.apk's storage, device, network and privacy options. |
| `DYLD_`… | The launcher sets the runtime's library paths. |
| `MACLAUNCHER_`… | Used by MacLauncher's own Android services. |

### ANGLE

Applies to Android games, which draw OpenGL ES through ANGLE. Its global values are on the **MacLauncher Android** and **Mac.apk** tabs of Runtimes.

| Variable | Effect | Launcher value |
| --- | --- | --- |
| `ANGLE_FEATURE_OVERRIDES_ENABLED` | ANGLE features to turn on, separated by commas. |  |
| `ANGLE_FEATURE_OVERRIDES_DISABLED` | ANGLE features to turn off, separated by commas. |  |
| `MTL_HUD_ENABLED` | 1 shows the Metal Performance HUD with the Metal backend. |  |

| Locked | Reason |
| --- | --- |
| `KL_ANGLE_BACKEND` | Set by OpenGL ES backend in Runtime Settings. |
| `MACAPK_ANGLE_BACKEND` | Set by Graphics backend in Runtime Settings. |

### AnyPS5

Applies to every PlayStation 5 game that runs with AnyPS5. Its global values are on the **AnyPS5** tab of Runtimes.

| Variable | Effect | Launcher value |
| --- | --- | --- |
| `APS5_PLAYGO_UNLISTED_CHUNKS` | PlayGo state of chunks that the package does not list. | MacLauncher sets installed. |

| Locked | Reason |
| --- | --- |
| `ANYPS5_VULKAN_LIBRARY` | Names the selected Vulkan library. |
| `ANYPS5_INPUT_CONFIG` | The launcher writes the controller bindings from Runtime Settings. |
| `ANYPS5_MOUSE_ROUTING` | Set by Mouse input in Runtime Settings. |
| `DYLD_`… | The launcher sets the runtime's library paths. |

### Prosper

Applies to every PlayStation 5 game that runs with Prosper. Its global values are on the **Prosper** tab of Runtimes.

No variables are suggested. Any variable that is not locked can be added.

| Locked | Reason |
| --- | --- |
| `PROSPER_SAVE0`, `PROSPER_SAVEDATA_DIR`, `HOME`, `XDG_DATA_HOME` | Decides where Prosper keeps saves, which the launcher tracks. |
| `PROSPER_GUEST_FS` | The launcher serves the game's files through Prosper's guest file system. |
| `PROSPER_APP_CONFIG` | Set by Configuration file in Runtime Settings. |
| `PROSPER_VULKAN_LIB` | Names the selected Vulkan library. |
| `DYLD_`… | The launcher sets the runtime's library paths. |

# Translator environment variables

Every runtime that offers a translator choice passes environment variables to the translators a game uses. These are the Wine runtime and its graphics translators, the Android execution engine together with ANGLE and the Vulkan driver, and the PlayStation 5 runtimes with their Vulkan driver. Each translator has global values in **Settings → Environment variables**, which serve as the defaults for every game that uses it, and a game's **Runtime Settings** can change, add or remove variables for that game alone. Values are stored and passed exactly as written, so shell expansion, quoting and variable references such as `$HOME` have no effect. A change applies at the next launch.

## Translators of each runtime

At launch, a game receives the variables of the translators that its runtime and settings choose:

| Runtime | Translators whose variables apply |
| --- | --- |
| CrossOver | CrossOver, and each graphics translator that the game uses after any [fallback](TRANSLATORS.md#compatibility-and-fallback): D3DMetal, DXMT, DXVK, vkd3d-proton, MoltenVK, KosmicKrisp and GStreamer codecs. |
| Sikarugir | Sikarugir, and each graphics translator that the game uses after any fallback, as for CrossOver. |
| WineCX | WineCX, and each graphics translator that the game uses after any fallback, as for CrossOver. |
| MacLauncher Android | MacLauncher Android, Android JVM or Android ART depending on the **Execution** setting, and ANGLE. When the **OpenGL ES backend** is Vulkan, the selected Vulkan driver (MoltenVK or KosmicKrisp) is added. |
| Mac.apk | Mac.apk and ANGLE, plus MoltenVK when the **Graphics backend** is Vulkan. |
| AnyPS5 | AnyPS5 and the selected Vulkan driver. |
| Prosper | Prosper and the selected Vulkan driver. |

AIM offers no translator choice and has no translator variables. WineD3D and Wine vkd3d are part of the Wine runtime, so their variables, such as `WINE_D3D_CONFIG`, are set among those of CrossOver, Sikarugir or WineCX.

## Global values

**Settings → Environment variables** holds the global values of every translator, with each translator listed once. The page is divided into collapsed blocks, one per runtime or translator, and each block's title shows how many values it holds:

| Block | Translators |
| --- | --- |
| MacLauncher Android | MacLauncher Android, Android JVM, Android ART and ANGLE |
| Mac.apk | Mac.apk |
| AnyPS5, Prosper, CrossOver, Sikarugir, WineCX | The runtime's own translator |
| DXVK, vkd3d-proton, DXMT, D3DMetal, GStreamer codecs, MoltenVK, KosmicKrisp | The graphics translator or Vulkan driver |

A global value applies to every game that uses its translator. ANGLE's values are set in the **MacLauncher Android** block but also reach Mac.apk games. A change made in one Settings window appears in every open launcher window at once.

## Values for one game

In a game's **Runtime Settings**, the **Environment variables** section shows the values of the translators that the current settings choose. The list of translators updates while the settings are edited, for example when a different Direct3D engine, Vulkan driver or execution engine is chosen. Values inherited from Settings are shown together with the game's own changes, additions and removals. The game's values are stored with the game and do not depend on the game type defaults in **Settings**.

## Editor

The same editor is used for a block in Settings and for the section in a game's Runtime Settings. Each of these has one table of rows in the form `NAME = value`, followed by a row for adding a variable. When the table covers several translators, the rows are grouped under a small heading for each translator that has values, with the runtime's own translator first.

- A value field saves when it loses focus or when Return is pressed, and Escape restores the saved value.
- The add row has a name field that suggests the variables of every translator in the table, a value field and an **Add** button. Return in either field adds the variable, and Escape clears both fields.
- A new variable is filed under the translator whose heading already lists it. Failing that, it goes to the translator that suggests it, and otherwise to the runtime's own translator. Because the runtime's own translator applies to every game that the runtime launches, a variable that no translator suggests, added in the **MacLauncher Android** block, reaches games with either execution engine. While a name is being typed in a table with several translators, the hint under the add row names the translator it will join, together with the variable's description when it is a suggested one.
- The remove button (×) removes a variable. In a game, removing a value inherited from Settings stores a removal for that game, which the row shows as **Removed** with the inherited value struck through.
- **Restore** returns a changed or removed row to its inherited value.
- Each table has one **Reset**, which removes every value stored at that level: the global values of a block in Settings, or the game's own values in Runtime Settings.
- A suggested variable's name shows its description as a tooltip.

A badge on each row shows where its value comes from:

| Badge | Meaning |
| --- | --- |
| From Settings | In a game, a value inherited from the global values in Settings. |
| Default | A translator's built-in value. |
| Changed | The game replaces an inherited value. |
| This game | A variable that only this game sets. |
| Removed | The game removes an inherited value. |
| Set by MacLauncher | MacLauncher also sets this variable. In a warning color, the badge means that the value in the row replaces MacLauncher's value, and its tooltip names the setting or condition behind MacLauncher's value. In an error color, it means that the variable is locked: the value is not used, and the next save drops it. |

A name has the form of a shell variable, a letter or underscore followed by letters, digits or underscores, and is at most 256 characters long. A value can hold any text except line breaks and NUL characters, up to 32,768 characters, and an empty value is passed as an empty variable. Each translator can hold at most 256 variables in Settings, and at most 256 in each game. An invalid name or value is reported under the editor and is not saved.

## Locked variables

Some variables are set by MacLauncher itself, such as the paths of a game's Windows environment, Android sandbox or save folders, and the files that select a translator or Vulkan driver. Their names are locked: a locked name cannot be added, and the editor explains why as soon as it is typed. A lock still holds when another translator in use has a variable of the same name, so a value stored for one translator cannot replace a path that another translator's runtime sets.

In a game, the translators in the table run together, so the locks of all of them apply. In Settings, the runtime's own translator follows the locks of every translator that runs with it, including one whose values sit in another block, such as ANGLE for Mac.apk, while every other translator follows only its own locks. For this reason, in the **MacLauncher Android** block, `JAVA_TOOL_OPTIONS` can be set for Android JVM even though Android ART locks it, and `LD_PRELOAD` cannot be set for MacLauncher Android.

## Order of values

At launch, MacLauncher combines the values of the chosen translators in this order, and a later step replaces an earlier one:

1. the translators' built-in defaults;
2. the global values from Settings;
3. the game's own values from Runtime Settings.

Within each step, the runtime's own translator comes first, followed by the graphics translators and the Vulkan driver, so when two translators set the same variable, the later translator's value is used. A removal in a game takes away the inherited value, and the variable then gets whatever value the launcher would give it without this feature. The combined values are applied before the variables that the launcher requires, which means locked names always keep the launcher's value. Variables that the launcher sets from Runtime Settings behave the other way: the editor marks them **Set by MacLauncher** in a warning color, and the combined value replaces the launcher's.

Every translator's built-in defaults are empty, so the global values start out empty.

## Storage

Global values are stored in `settings.json` under `launcher.translatorEnvironment`, and a game's values in its `game.json` under `translatorEnvironment`. Both fields map a translator id to its variables, and a game's removal is stored as `null`. The [data model](../development/DATA_MODEL.md) describes both fields.

## Translators

Each translator suggests a set of variables, listed here with their effect. When MacLauncher also sets one of them, the Launcher value column names the setting or condition behind it. Any other variable can be added as well, provided its name is not locked.

### CrossOver

These variables apply to every game that runs with CrossOver, and their global values are in the **CrossOver** block of Settings → Environment variables.

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

Every game that runs with Sikarugir receives these variables. Their global values are in the **Sikarugir** block in Settings.

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

These variables apply to games whose Direct3D 11 or 12 choice uses D3DMetal, with global values in the **D3DMetal** block in Settings.

| Variable | Effect | Launcher value |
| --- | --- | --- |
| `D3DM_SUPPORT_DXR` | 1 exposes DirectX Raytracing on Macs that support it. |  |
| `D3DM_ENABLE_METALFX` | 1 translates DLSS requests to MetalFX. | Set by Game temporal integration in Runtime Settings. |
| `D3DM_MAX_FPS` | Frame rate limit. | Set by D3DMetal FPS limit in Runtime Settings. |
| `D3DM_MTL4` | 1 renders with Metal 4 where available. | Set by D3DMetal Metal 4 in Runtime Settings. |
| `D3DM_VENDOR_ID` | PCI vendor ID that the adapter reports to the game. | `0x10de` while D3DMetal performs a game's DLSS through game temporal integration in a Wine whose `win32u.so` reads it; a value set here replaces it. |
| `D3DM_DEVICE_ID` | PCI device ID that the adapter reports to the game. | `0x2684` while D3DMetal performs a game's DLSS through game temporal integration in a Wine whose `win32u.so` reads it; a value set here replaces it. |
| `D3DM_DEVICE_DESCRIPTION` | Adapter name that the game sees. | `NVIDIA GeForce RTX 4090` while D3DMetal performs a game's DLSS through game temporal integration in a Wine whose `win32u.so` reads it; a value set here replaces it. |

| Locked | Reason |
| --- | --- |

### DXMT

Games whose Direct3D 10 or 11 choice uses DXMT receive these variables. Their global values are in the **DXMT** block in Settings.

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

These variables apply when a game's Direct3D 8, 9, 10 or 11 choice uses DXVK, D8VK or D9VK. Their global values are in the **DXVK** block in Settings.

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
| `DXVK_ENABLE_NVAPI` | 1 exposes NVIDIA adapters to NVAPI. |  |
| `DXVK_DEBUG` | Debugging mode, such as markers or validation. |  |

| Locked | Reason |
| --- | --- |

When a CrossOver, Sikarugir or WineCX launch uses DXVK's DXGI with an NVIDIA vendor override (`dxgi.customVendorId = 10de`), MacLauncher adds `dxgi.customDeviceDesc = "<GPU name> (DXVK)"` to `DXVK_CONFIG`. This happens with both DXVK and vkd3d-proton. The GPU name comes from cached graphics hardware metadata, and no description is added when that name is unavailable or several adapter names are present. Every existing `DXVK_CONFIG` entry is kept, and an explicit `dxgi.customDeviceDesc` takes precedence, even with an empty value. The suffix tells the adapter that DXGI presents apart from Wine's display driver description without changing the GPU model. NVAPI still reports its own device name.

### vkd3d-proton

Games whose Direct3D 12 choice uses vkd3d-proton receive these variables, with global values in the **vkd3d-proton** block in Settings.

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

These variables apply when a game's video codec choice is a registered GStreamer folder. Their global values are in the **GStreamer codecs** block in Settings.

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

Games whose Vulkan driver is MoltenVK receive these variables. Their global values are in the **MoltenVK** block in Settings.

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

These variables apply to games whose Vulkan driver is a KosmicKrisp build. One set of global values in the **KosmicKrisp** block in Settings covers every KosmicKrisp build.

| Variable | Effect | Launcher value |
| --- | --- | --- |
| `MESA_KK_DEBUG` | Driver debugging flags: msl, force_robustness or force_per_vertex_buffer. |  |
| `KK_EMULATION` | Emulated features, comma-separated and applied left to right. Unset or `performance`: the fast set for this Mac's Apple GPU generation, which the driver detects automatically. `conformance`: every emulated feature (Direct3D 12 feature level 12_2, shader model 6.9). `apple7` through `apple11` or `mode=7` through `mode=11`: also turn on the features that generation runs natively. `+name` or `-name`: one feature on or off. `-VK_extension_name` hides an extension. See [Performance and conformance](KOSMICKRISP.md#performance-and-conformance) and the [switch table](KOSMICKRISP.md#switch-table) for the names. |  |
| `MESA_KK_EXPERIMENTAL` | Experimental features: custom_border, image_view_min_lod, optimize_e5b9g9r9 or all. The driver's default is custom_border,image_view_min_lod. |  |
| `MESA_KK_DISABLE_WORKAROUNDS` | Workaround numbers to turn off, separated by commas, or all. |  |
| `MESA_KK_GPU_CAPTURE` | true enables Metal capture control through debug markers. |  |
| `MESA_KK_GPU_CAPTURE_IMMEDIATELY` | true starts capture at device creation when capture is enabled. |  |
| `MESA_KK_GPU_CAPTURE_DIRECTORY` | Folder that receives Metal GPU captures. Capture is refused while timestamp counter heaps exist, and creating a heap ends a capture that the driver controls, so real timestamp queries keep working. Ordinary device and heap lifetimes leave capture control inactive. |  |
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

These variables reach every Android game that runs with MacLauncher Android, whichever execution engine it uses, and their global values are in the **MacLauncher Android** block in Settings.

MacLauncher Android suggests no variables, but any variable whose name is not locked can be added.

| Locked | Reason |
| --- | --- |
| `HOME`, `CFFIXED_USER_HOME`, `TMPDIR`, `PATH` | The launcher sets this path inside the game's sandbox. |
| `ANDROID_`…, `DOWNLOAD_CACHE`, `EXTERNAL_STORAGE`, `OEM_ROOT`, `ODM_ROOT`, `VENDOR_ROOT`, `PRODUCT_ROOT`, `PRODUCT_SERVICES_ROOT`, `SYSTEM_EXT_ROOT`, `APEX_ROOT` | The launcher sets the Android system and storage folders. |
| `VK_DRIVER_FILES`, `VK_ICD_FILENAMES` | Points the Vulkan loader at the selected driver. |
| `KL_`…, `KLJ_`… | The launcher sets the Android runtime's process and graphics options. |
| `DYLD_`… | The launcher sets the runtime's library paths. |
| `MACLAUNCHER_`… | Used by MacLauncher's own Android services. |

### Android JVM

Android games whose execution engine is JVM receive these variables. Their global values are also in the **MacLauncher Android** block in Settings.

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

These variables apply to Android games whose execution engine is ART, and their global values are in the **MacLauncher Android** block in Settings as well.

Android ART suggests no variables. Any variable whose name is not locked can be added.

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

Every Android game that runs with Mac.apk receives these variables, with global values in the **Mac.apk** block in Settings.

Mac.apk suggests no variables, but any variable whose name is not locked can be added.

| Locked | Reason |
| --- | --- |
| `HOME`, `CFFIXED_USER_HOME`, `TMPDIR`, `PATH` | The launcher sets this path inside the game's sandbox. |
| `JAVA_TOOL_OPTIONS` | Loads MacLauncher's executable policy and launch arguments. |
| `MACAPK_`… | The launcher sets Mac.apk's storage, device, network and privacy options. |
| `DYLD_`… | The launcher sets the runtime's library paths. |
| `MACLAUNCHER_`… | Used by MacLauncher's own Android services. |

### ANGLE

Android games draw OpenGL ES through ANGLE, so these variables apply to them. Their global values are in the **MacLauncher Android** block in Settings and reach Mac.apk games as well.

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

These variables apply to every PlayStation 5 game that runs with AnyPS5. Their global values are in the **AnyPS5** block in Settings.

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

Every PlayStation 5 game that runs with Prosper receives these variables, with global values in the **Prosper** block in Settings.

Prosper suggests no variables. Any variable whose name is not locked can be added.

| Locked | Reason |
| --- | --- |
| `PROSPER_SAVE0`, `PROSPER_SAVEDATA_DIR`, `HOME`, `XDG_DATA_HOME` | Decides where Prosper keeps saves, which the launcher tracks. |
| `PROSPER_GUEST_FS` | The launcher serves the game's files through Prosper's guest file system. |
| `PROSPER_APP_CONFIG` | Set by Configuration file in Runtime Settings. |
| `PROSPER_VULKAN_LIB` | Names the selected Vulkan library. |
| `DYLD_`… | The launcher sets the runtime's library paths. |

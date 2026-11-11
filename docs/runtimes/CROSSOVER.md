# CrossOver

[CrossOver](https://www.codeweavers.com/crossover) is CodeWeavers' commercial distribution of Wine, the compatibility layer that runs Windows programs on macOS. MacLauncher uses a CrossOver application that is already installed on the Mac as a runtime for [Windows games](../game-types/WINDOWS.md) and for the compatible Windows executables of other game types. The application has to be licensed and has its own prerequisites. CodeWeavers handles CrossOver's downloads, licenses and application updates, so MacLauncher neither bundles nor downloads CrossOver. For a Wine runtime that MacLauncher downloads itself, [Sikarugir](SIKARUGIR.md) and [WineCX](WINECX.md) are the alternatives. All three share one [Wine layer](WINE.md).

Running Windows games through Wine is a major MacLauncher feature, and CrossOver is one of its three Wine runtimes. MacLauncher keeps CrossOver's own Wine and engines and adds to them, without modifying the CrossOver application. Compared with starting the same game in CrossOver alone, these additions change the following:

- Import and Play prepare a private bottle for each game automatically, run the game from its original files and keep that bottle when CrossOver is updated or moved. A bottle that already exists can be used instead, and MacLauncher never deletes, recreates, moves or replaces it.
- Each game can choose a default Direct3D engine, a translator for each Direct3D version, a Vulkan driver and video codecs from CrossOver's own engines and from [translator versions installed in Runtimes](TRANSLATORS.md). A version is installed once and shared by every game that selects it.
- Several CrossOver applications can be registered side by side, and each game can use a different one.
- MacLauncher's [graphics effects](../graphics/SHARED_PROCESSING.md) run on CrossOver games through private copies of CrossOver's Wine loaders. Compatible DLSS and XeSS integrations supply scene inputs for MetalFX and shared temporal methods whose required inputs are available.
- Display, input, compatibility and diagnostics controls are set per game, and a game in an existing bottle can keep that bottle's current values.

## When CrossOver is offered

Sikarugir is the default runtime for generic Windows games. CrossOver is offered for any game with a compatible x86 or x64 Windows executable while a registered application is available, and saved CrossOver selections and the usual defaults of known engines are kept. Some detected engines have no macOS runtime of their own, such as BGI / Ethornell, CatSystem2 and Windows Haxe builds; for these, a registered CrossOver application comes first. [Windows Game](../game-types/WINDOWS.md#windows-executables-in-other-game-types) describes which games offer the Windows runtimes.

The selected CrossOver version supplies the Windows API compatibility. A game's DRM, anti-cheat and Windows dependency requirements still apply.

## Applications and versions

MacLauncher finds CrossOver at `/Applications/CrossOver.app` and `~/Applications/CrossOver.app` automatically, and **Find installed applications** checks those paths again. Further applications, including previews and copies with updated libraries, are registered with **Runtimes → CrossOver → Add CrossOver**. Every application stays where it is, and **Remove** unregisters its path without deleting it. Each application's row names the translator versions that it includes, such as its DXMT, DXVK and D3DMetal releases.

Each registered application is a separate choice, even when several copies report the same version. Play chooses one in the [usual order](README.md#versions): the game's **Version** selection, then a saved default, then the newest registered application that is ready. When the first application is added and no default is saved yet, it becomes the default.

An optional CrossOver graphics integration package, matched to the application's exact release and build, adds Vulkan external memory, semaphore and fence sharing to CrossOver's Mac driver. Only the NGX scene transport uses it, on a game whose Direct3D 12 translator is a vkd3d-proton version of MacLauncher selected in **Runtimes**. Launches with CrossOver's automatic translators never offer or load it. Play offers it only when the package list names a package for that release and build. When Play downloads another component, the package is listed with its version and size in that download's dialog. Otherwise Play offers it in its own dialog, where **Play Without It** starts the game with CrossOver's supplied module. Without the package the NGX scene transport is off, the launch log records why, and the game starts. A declined or failed download is remembered for that CrossOver release and build, so Play offers the package again only for another release or after **Find installed applications** in **Runtimes → CrossOver**. An unavailable matching package also keeps CrossOver's supplied module. Its versions are listed under **CrossOver graphics integration** in the CrossOver entry of **Runtimes**, which refreshes the package list and removes versions. The package never modifies the CrossOver application.

One integration revision, the newest, is retained for each registered CrossOver release. Play preparation and Refresh remove revisions that no registered application needs, after games release them, and inspect the registered applications only while a package or a remembered choice exists. Registered applications whose location is temporarily unavailable retain their integration packages. Each launch checks the integration library's digest before linking it.

An application updated in the same location keeps its selection and its existing bottles. If the selected application is missing, however, MacLauncher does not substitute another copy. The application can be used again once it is restored to its registered location, or once its new location is added in **Runtimes** and selected.

## Bottles and private game files

Ordinary Play uses a prefix-local Windows drive letter for the game root and passes the executable and working directory through that drive, so game assets, portable saves and configuration stay at their original paths. The drive root is the imported folder when it contains the game folder, so a program can read files above its own folder. An executable in a packaged Unreal layout, `<install>/<project>/Binaries/<platform>` with `<install>/Engine` and `<project>/Content` folders inside the install folder, maps at least that install folder, also when the executable itself was imported. Otherwise the drive root is the game folder. The mapping keeps the Windows root short regardless of the Mac folder depth. Existing drive mappings are preserved and matching mappings are reused. Game files and the native working directory stay at their original locations; Play makes no copy of the game and no folder of links to it. It also neither reads nor updates the private game folders of earlier MacLauncher versions, and their files and records stay untouched.

Executable selection follows an explicit Windows executable choice, the publisher's Windows entry recorded with a Steam download, the detected engine's Windows entry, the recorded game program, then executable discovery. An explicit choice is the **Windows executable** runtime setting or an imported executable. A detected engine can also mark its entry as required, as [MAGES.](../game-types/MAGES.md#crossover-sikarugir-and-winecx) does for a publisher launcher that the game program depends on. An imported executable then identifies the game but does not choose what starts. Steam downloads retain the publisher's default Windows entry from the app metadata already used for the download. Reading that receipt is offline; missing or invalid entries fall through to the other choices. Every entry must be a Windows PE executable inside the game folder.

Those earlier private `game/` folders are recovered once into the original game folders instead, as [Earlier private game folders](../library/GAME_PREPARATION.md#earlier-private-game-folders) describes. Missing files are restored, and a version that differs from the original is kept beside it as a conflict copy. Earlier `temporal-camera` and `temporal-original` folders with proxy or asset-link records are kept for a separate recovery. The recovery does not run during Play, import or upkeep, and it removes no Wine prefixes or bottles.

By default, a game's Windows environment is a private CrossOver bottle. Each game has its own bottle for each Windows environment type, independent of the selected CrossOver installation. The bottle and its saves therefore survive moving, updating or changing the CrossOver application, and changes of renderer or synchronization keep it as well. Saves written to the bottle's Windows profile remain with the bottle. Where CrossOver would link profile folders to the macOS Documents or Desktop folders, MacLauncher replaces those links with private folders inside the bottle. Save tools use the original game folder as the primary location and list the selected bottle's Windows profile as an alternate, as they do for every Wine source. CrossOver has no universal save editor or save-location format, and engine save codecs are disabled while it is selected.

CrossOver, like Sikarugir and WineCX, stores shader caches in each game's MacLauncher runtime directory. `MESA_SHADER_CACHE_DIR` points to `cache/mesa`. DXVK uses `DXVK_SHADER_CACHE_PATH`, set to the Wine DOS path for `cache/dxvk`, which Play creates before the game starts. Cache locations are separate from the bottle and Wine home. The Mesa cache has a budget of `4G` through `MESA_SHADER_CACHE_MAX_SIZE`, unless **Settings → Environment variables**, the game's **Runtime Settings** or an external Wine environment sets another value.

Stop first asks the Windows programs in a private bottle to close and then ends any remaining Wine processes. Canceling the initial preparation removes only the incomplete private environment. Removing a game from the library removes the Windows environments that MacLauncher created for it and leaves the original game files alone. Application registrations are stored in `runtimes/crossover/registrations.json`.

After an upgrade from an earlier MacLauncher version, the game's earlier bottle is adopted once at its stable Windows environment path. MacLauncher adopts the bottle that the game last used, according to its records. Without such a record, it adopts the bottle with the newest registry or marker timestamp; when usage is unknown or tied, the bottles stay where they are for manual resolution. A bottle that is already at the stable path takes precedence. Other earlier bottles stay separate, with their locations recorded, and their files are not merged. A bottle is also not adopted automatically when its internal Wine drive mappings use absolute paths that would break after the move.

## Existing bottles

A game can also run in a CrossOver bottle that already exists. Each game's Runtime Settings has an **Environment** choice for this: **Private (MacLauncher)**, the CrossOver bottles found on the Mac, or **Choose…** for another bottle. To find bottles, MacLauncher reads the configured bottle folder from the environment, CrossOver's configuration or its preferences, and uses the standard Bottles folder otherwise. Published and stub bottles are excluded. Both the list and the bottles' current values are read offline.

Selecting a bottle stores only a reference to its path. The bottle stays in place, and MacLauncher never copies, adopts, recreates or removes it. A missing or incomplete bottle reports an error and is left as it is. Removing the game also leaves the bottle intact, and a removal whose directory would contain the bottle is refused.

CrossOver then runs with the bottle's absolute path, `--wait-children` and `--no-update`. Selected settings and translator files can change the bottle, while its profile mappings stay as supplied. Logs stay in MacLauncher's data. **Open Windows files** opens the selected bottle, whose Windows profiles are listed as alternate save locations.

Stop ends only the launched game's processes by default. **Close All Applications** asks for confirmation before it asks the bottle's other Windows programs to close and forces the remaining ones to quit. When the game exits normally, the bottle's other programs keep running. If the bottle's wineserver is running, the selector shows this, and MSync and High Resolution changes then have to wait until it stops.

## Runtime settings

Settings holds the defaults, and each game's Runtime Settings can override them. Settings that need Apple Silicon or a newer macOS than the Mac has are not listed.

| Setting | Behavior |
| --- | --- |
| Environment | A private bottle for the game, or a reference to an existing bottle. Set per game only. |
| Default Direct3D engine | The global renderer choice for every Direct3D API without a choice of its own: CrossOver's automatic choice, an engine included with the selected CrossOver, or a specific translator version installed in Runtimes. Each choice names its engine, version and source. |
| Direct3D 8, 9, 10 / 10.1 and 11 | A choice for each API among the installed implementations, with their actual versions and sources. Choices that share DLLs or helpers are linked, and an unset choice keeps the default Direct3D engine. |
| Direct3D 12 | Wine vkd3d, D3DMetal, or a vkd3d-proton or D3DMetal version installed in Runtimes. With the automatic **Vulkan driver**, vkd3d-proton pairs with [MacLauncher KosmicKrisp](KOSMICKRISP.md#direct3d-12-through-vkd3d-proton), on which it reports Direct3D feature level 12_1; with another selected driver, the launch warns that KosmicKrisp is recommended for it. |
| Vulkan driver | CrossOver's automatic choice, CrossOver's own MoltenVK, or a specific MoltenVK or KosmicKrisp version installed in Runtimes. The automatic choice keeps CrossOver's driver, except that a DXVK or vkd3d-proton version from Runtimes pairs with MacLauncher KosmicKrisp, as [Selection and loading](KOSMICKRISP.md#selection-and-loading) describes. Only versions with code for the CPU architecture of the selected Wine are listed, as [Versions and sources](TRANSLATORS.md#versions-and-sources) explains. |
| Video codecs | The runtime defaults or a registered GStreamer codec folder. |
| Game temporal integration | Exposes MetalFX Temporal through a 64-bit game's DLSS integration with CrossOver's own DXMT or D3DMetal. A DXMT or D3DMetal version from Runtimes, and DLSS forwarding with DXVK or vkd3d-proton, do not depend on it. Listed for Unity and Windows games; hidden only for WineD3D. See [Temporal upscaling](#temporal-upscaling). |
| Synchronization | Automatic, MSync, ESync or Off. ESync is listed only when the selected CrossOver is older than version 25. |
| Language locale | An optional locale identifier, such as `ja_JP.UTF-8`. |
| Windows environment | Windows 10, Windows 11, Windows 7 or Windows XP, each a 64-bit bottle type that the selected application must include. Each choice uses its own bottle. |
| Per-launch Windows version | **Bottle version**, or a Windows version that CrossOver reports for this launch within the current bottle. See [Windows versions](#windows-versions). |
| Windows executable | An optional relative path, for when automatic selection picks the wrong executable. |
| Enable BepInEx winhttp override | Opts in to `winhttp=n,b` for a game that already contains BepInEx's proxy DLL. Listed for Unity and Windows games. No mod, DLL or font is downloaded. Explicit Wine DLL overrides take precedence, including grouped entries such as `winhttp,wininet=b`. |
| Wine DLL overrides, game arguments | Apply to the game process. MacLauncher sets the application and bottle paths itself. |
| Wine debug channels | Optional Wine channel filters, such as `-all` or `+seh`. |

The graphics and synchronization choices follow the [CrossOver Mac user guide](https://www.codeweavers.com/support/docs/crossover-mac/index), and the BepInEx option follows BepInEx's [Wine instructions](https://docs.bepinex.dev/articles/advanced/proton_wine.html). [Graphics translators](TRANSLATORS.md#selection) describes the translator controls.

### Display, input, compatibility and diagnostics

Runtime Settings keeps the basic launch choices above separate from four advanced groups. **Display** holds High Resolution (Retina), DPI, fullscreen capture, vertical sync and virtual desktops, and **Input** maps Option to Alt and Command to Ctrl and configures mouse capture. **Compatibility** holds Rosetta AVX advertisement together with options for particular engines: DXVK async, DXMT frame-rate presets and MetalFX spatial, D3DMetal frame limits and Metal 4, MoltenVK fast math, argument buffers and UE4 compatibility, and WineD3D configuration. Each engine's options appear only when that engine is selected. **Diagnostics**, finally, offers the Metal and DXVK HUDs, the Wine crash dialog and Wine debug channels.

Environment variables for CrossOver and its translators have global values in **Settings → Environment variables** and a game's own values in the **Environment variables** section of its Runtime Settings, as [translator environment variables](TRANSLATOR_ENVIRONMENT.md) describes. A variable there replaces the value that one of these controls sets, such as `WINEDEBUG` or `MTL_HUD_ENABLED`. Registry settings apply to the selected Windows environment on its next launch, and High Resolution and synchronization changes can require restarting the environment's Windows programs.

| Control | Values and effect |
| --- | --- |
| High Resolution (Retina) | Runtime default, On or Off; On selects 192 DPI unless DPI is set explicitly. |
| DPI | A positive REG_DWORD integer; empty keeps the current value. |
| Option as Alt, Command as Ctrl | Map both the left and right modifier keys. |
| Mouse capture | Configures cursor confinement and DirectInput mouse warping. |
| Fullscreen display capture, Vertical sync | Runtime default, On or Off. |
| Virtual desktop | Positive WIDTHxHEIGHT dimensions, such as 1920x1080; off turns the desktop off; empty uses the runtime default. |
| DXVK async | Runtime default, On or Off; takes effect in DXVK builds that implement async. |
| DXMT configuration | Runtime default or a 30, 60 or 120 FPS preset. |
| MetalFX spatial | Runtime default, On or Off for DXMT. |
| D3DMetal FPS limit | Runtime default, 30, 60, 120, 144 or 240 FPS. |
| D3DMetal Metal 4 | Runtime default, On or Off; takes effect in builds that implement Metal 4. |
| MoltenVK fast math, argument buffers, UE4 compatibility | Runtime default, On or Off; each changes the corresponding MoltenVK option. |
| WineD3D options | Comma-separated configuration, such as csmt=0x1,renderer=gl. |
| Metal Performance HUD | Runtime default, On or Off. |
| DXVK HUD | Runtime default, Off, FPS, Performance or Full. |
| Wine crash dialog | Runtime default, On or Off. |

### Windows versions

Besides the four bottle types, the per-launch Windows version can be Windows 8.1, 8, Vista, XP 64-bit, XP, 2000, ME, 98 or 95, or Windows Server 2008 R2, 2008 or 2003. CrossOver's per-launch version changes only the version reported within the current bottle, so it creates no further bottle. When an existing bottle is selected, the game always runs in that bottle, and the bottle type applies only to private bottles.

### Settings of an existing bottle

For a game in an existing bottle, each setting defaults to **Bottle setting**, followed by its current value as read offline. **Custom setting** turns on an override for that control. Overrides stored in the registry are written into the selected bottle, and its original files and Windows environment remain in place.

## Translators

[Graphics translators](TRANSLATORS.md) describes how the translator choices are installed, loaded and checked. Runtimes groups the translators as DirectX → Vulkan, DirectX → Metal, Vulkan drivers and video codecs, and Runtime Settings arranges the Direct3D choices from Direct3D 8 to 12. Their versions, API scope and sources come from installed files. CrossOver's automatic choice remains global while it is unresolved, whereas a specific default Direct3D engine or an explicit choice for every API uses the private loader. For a game in an existing bottle, each control also offers the bottle's current setting. A runtime version is installed once, and private graphics views and Windows DLLs link to that installation. Prepared loader trees are shared between games that use the same inputs.

Translator dependency directories use fallback library and framework lookup, so macOS system libraries retain precedence. The private Wine loader keeps its own `ntdll.so` anchor.

Translator catalogs and local registrations share their runtime storage with Sikarugir. Components installed inside CrossOver are referenced in place and are used for CrossOver launches only.

Video components add only their plugin directories. Their private preparation reuses CrossOver's established native core dependencies and preserves its scanner and system-plugin defaults. Component dependency directories do not enter global library search paths; optional unusable plugins are reported separately from usable siblings.

## Graphics

Before each launch, the selected translator is checked against the actual Wine CPU, PE machine type, native macOS minimum and required Wine imports. When a file is missing or a requirement is proven missing, the same engine included with this CrossOver is used instead, or CrossOver's automatic choice when it has no such engine. Metadata that cannot be read leaves the selection active. The inspector names the selected and used engines and explains any fallback, and [System requirements](SYSTEM_REQUIREMENTS.md#windows-compatibility-runtimes) lists the related components.

Per-game ReShade effects use the shared [graphics pipeline](../graphics/SHARED_PROCESSING.md) with the selected CrossOver application, graphics backend and Windows environment, and effects can be switched while the game runs. For these effects, and for translators installed in Runtimes, the game starts through private copies of CrossOver's small Wine loaders. The copies are prepared automatically and signed again with permission to load MacLauncher's graphics adapter, while they keep the original loaders' other entitlements. Each prepared set is cached once for its source and translator inputs and reused between games. CrossOver's application, license files and installed libraries stay in place, and the game's existing bottle and saves are kept.

Prepared sets include complete linked Windows module views for every architecture supplied by the selected Wine. WoW64 resolves bootstrap modules from these loader-relative views, with selected translator, camera and scene links taking precedence.

If the graphics loader cannot be prepared, the game runs with the selected vendor renderer and its existing bottle, without shared graphics effects for that launch, and its saved graphics selections are kept. A translator from Runtimes that depends on the private loader is the exception: its launch stops with the error instead.

Graphics providers must match the architecture of the native Wine process that runs the game. When CrossOver uses a separate Unix loader, provider compatibility depends on that loader's architectures, not on the Windows executable or the launcher. An Intel Wine process therefore needs Intel-compatible graphics providers, including on Apple Silicon through Rosetta. Intel-only Wine components go through the usual [Rosetta](ROSETTA.md) check, even when the CrossOver application itself is universal.

When DXVK's DXGI presents an NVIDIA adapter through `DXVK_CONFIG`'s `dxgi.customVendorId = 10de`, MacLauncher sets the DXGI description to the actual GPU name followed by ` (DXVK)`. For example, `Apple M2 Max` becomes `"Apple M2 Max (DXVK)"`. This keeps applications from interpreting Wine's display driver version as an NVIDIA driver version. The rule also applies to vkd3d-proton using DXVK's DXGI. An existing `dxgi.customDeviceDesc` in `DXVK_CONFIG` is preserved along with every other entry. No description is added when the GPU name is unavailable or ambiguous. NVAPI's device name stays unchanged; [translator environment variables](TRANSLATOR_ENVIRONMENT.md#dxvk) describes the controls.

### Temporal upscaling

Temporal upscalers need the game's depth and motion data, which a Windows game passes to the upscaler it calls itself. **Game temporal integration** makes use of this with DXMT and D3DMetal: it exposes MetalFX Temporal through a 64-bit game's DLSS integration. It requires Apple Silicon, matching NVAPI and NGX libraries, and DXMT on macOS 14 or later or D3DMetal on macOS 26 or later. The setting applies to CrossOver's own DXMT and D3DMetal, and selecting a shared Temporal upscaling method turns the integration on at launch as well. A DXMT or D3DMetal version from Runtimes selected for Direct3D 11 or 12 turns it on by itself; where the Mac, macOS, executable or libraries cannot run it, the game starts without it.

DXVK and vkd3d-proton forward DLSS without this option. When a 64-bit game's Direct3D 11 or 12 renders through one of them, DXVK's own DXGI is placed, and the **Vulkan driver** in use is MacLauncher KosmicKrisp or MoltenVK scene support, whether the automatic pairing or a selection chose it, the game's DLSS frames always go through DXVK-NVAPI and the NGX forwarding core to that driver. Play offers the two managed packages after consent, in the same Play as a driver download; both are listed in **Runtimes → Graphics → DirectX → Vulkan**, as **DXVK-NVAPI** and **Vulkan DLSS forwarding**. On this route, DXVK presents a virtual NVIDIA adapter description to admit the forwarding core, while actual driver and provider checks still decide feature support. A route without DXVK's own DXGI, such as CrossOver's DXVK 1.10.3 on Wine's DXGI, starts without forwarding. A driver without the temporal carrier, which includes CrossOver's own MoltenVK, stock MoltenVK versions and LWJGL's KosmicKrisp, does not forward either; when such a driver is selected, its Vulkan driver row says "This Vulkan driver does not forward DLSS frames."

On every route, DLSS must also be enabled in the game. Neither route enables DLSS frame generation or ray reconstruction.

Enabled temporal rows in the Advanced graphics settings prepare the same game integration and dependencies as the Simple temporal settings, while disabled rows add no temporal requirements.

MacLauncher's FSR 2 and FSR 3 upscalers need the game's camera data as well. A game that calls DLSS through NVIDIA Streamline already passes that data to Streamline, and MacLauncher's Streamline adapter can hand it on. This FSR2/3 temporal replacement needs a supported Streamline interposer and a DXMT camera adapter that matches the selected renderer's native library and Windows thunk. CrossOver uses the adapter only when DXMT is the Direct3D engine actually in use, not when CrossOver makes its automatic choice. The camera adapter is included with MacLauncher, whereas the DXMT support libraries are separate: **Runtimes → Graphics → DirectX → Metal** installs the shared DXMT versions, and the Direct3D engine choice selects one version for both rendering and camera support. When that version does not match, the camera adapter reports the mismatch and the selected renderer stays unchanged.

The game then runs from the adapter's [launch folder](#launch-folders-for-adapters) through the private loader copies. For that launch, the private renderer selection turns off CrossOver's automatic DLL redirection and selects the matching DXMT libraries directly. Camera values are tied to the game's exact frame and viewport, and projections that the adapter does not support keep the game's original scaler.

The same DXMT conditions apply to an automatic in-game XeSS compatibility adaptation. When a game includes Intel's XeSS Direct3D 11 library, MacLauncher's XeSS adapter takes its place in the launch folder so that the game's XeSS requests can run through MetalFX. [Inputs and adapters](../graphics/INPUTS_AND_ADAPTERS.md) describes the data that both routes supply.

### FidelityFX API adapter

A game that ships AMD's FidelityFX API library, `amd_fidelityfx_vk.dll` for Vulkan or `amd_fidelityfx_dx12.dll` for Direct3D 12, can have its FidelityFX upscaling performed by MacLauncher's selected temporal upscaler. MacLauncher prepares the adapter only when the game's graphics settings use scene inputs, such as a temporal upscaler, and the library exports the five FidelityFX API functions: `ffxCreateContext`, `ffxDestroyContext`, `ffxConfigure`, `ffxQuery` and `ffxDispatch`. MacLauncher looks for the library beside the executable, at the top of the game folder and in their `plugins`, `Plugins`, `FidelityFX` and `FSR` subfolders.

The FidelityFX API adapter is a MacLauncher Builds package under **Graphics** → **Effects** in the Runtimes window, and Play offers to install it. Its proxy replaces the game's library only in the separate launch folder. The game's own library is kept beside it under another name and handles every context, configuration, query and frame-generation call. Each upscale dispatch becomes one temporal frame, `VkTemporalFrameInfoMVK`, with FidelityFX's reactive and transparency-and-composition masks in a chained `VkTemporalFrameMasksInfoMVK`:

- For Vulkan, the proxy records the frame in the dispatch's command buffer. The selected Vulkan driver has to forward temporal frames, as MacLauncher KosmicKrisp and MoltenVK scene support do, and the game's device has to provide `vkCmdPipelineBarrier2`.
- For Direct3D 12, the proxy records the frame through vkd3d-proton's MetalFX command-list interface. The selected Direct3D 12 translator has to be MacLauncher's vkd3d-proton, on a Vulkan driver that forwards temporal frames.

The selected upscaler then writes the dispatch's output. When a frame cannot be recorded, the original FidelityFX dispatch runs. The adapter is prepared the same way for CrossOver, Sikarugir and WineCX launches. With DXMT, D3DMetal or the Vulkan driver included with the Wine source, the game's FidelityFX library runs unchanged. FidelityFX Super Resolution 2 libraries have a different interface and keep their original route.

### Launch folders for adapters

A camera adapter or the in-game XeSS adaptation has to replace a DLL beside the application, so it runs the game from a separate launch folder. Only the executable and the selected DLLs are copied into that folder; other assets are referenced from the originals, and the working directory remains the original executable folder. Writes through these references reach the original files. Files that the game creates, or replaces atomically, relative to the adapted executable stay in the launch folder, because DLL redirection cannot send them elsewhere, and they are kept there.

Each adapter launch has its own folder, which is kept, so earlier private files are never removed or merged into the originals. Ordinary Play does not use these folders. If preparation fails, the original executable runs without the adaptation, and independent shared effects can still use an available loader.

## Requirements

Wine's macOS window driver needs a graphical login session, so games are played from the MacLauncher application; an SSH shell alone cannot supply that session. [Windows Steam games](WINDOWS_STEAM.md) describes the optional Steam client bridge to the Steam client for Mac, which CrossOver shares with Sikarugir. This runtime uses CrossOver's own commands and modifies neither Steam nor CrossOver.

## Implementation

CrossOver is registered as a runtime provider. Module discovery adds its runtime metadata and settings to every detected game type without changing the detected engine. The exceptions are Android games, native Mac apps and games recorded inside a Mac app bundle. Offline detection records which Windows executable a game includes, or that it has none, using the shared search that [Windows Game](../game-types/WINDOWS.md#windows-executables-in-other-game-types) describes. When MacLauncher decides whether to offer CrossOver for a game, it reads only that record, the recorded paths and the local application state, never the game's files, so the result does not change while those files are unavailable. Engine-specific preparation and runtime-download hooks do not run while this provider is selected.

On macOS 14 and later, a Wine program asks the active application to give up activation before it activates itself, by posting the distributed `WineAppWillActivateNotification` with its process ID. While a game started by MacLauncher runs, MacLauncher answers the requests that come from that game's own processes, matched against the processes descended from the launch, and only while MacLauncher is the frontmost application. It then makes one AppKit activation request for that process through the shared activation helper, so the game becomes the active application when its window opens. Requests from other Wine programs, or while another application is in front, are ignored. Answering needs no Accessibility permission and does not delay the launch.

Rosetta AVX advertisement is on by default for private bottles and can be turned off in Runtime Settings. When the Wine process runs under Rosetta, the launch also sets `DOTNET_EnableWriteXorExecute=0`. Language locale sets `LANG`, `LC_ALL` and `LC_MESSAGES`. CrossOver versions before 25 receive the earlier graphics and ESync flags, while later versions use the unified graphics selector and MSync.

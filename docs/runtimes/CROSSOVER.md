# CrossOver

[CrossOver](https://www.codeweavers.com/crossover) is CodeWeavers' commercial distribution of Wine. MacLauncher uses a CrossOver application that is already installed on the Mac as a runtime for [Windows games](../game-types/WINDOWS.md) and for the compatible Windows executables of other game types. The application has to be licensed and has its own prerequisites. Because CodeWeavers handles CrossOver's downloads, licenses and application updates, MacLauncher neither bundles nor downloads CrossOver; [Sikarugir](SIKARUGIR.md) and [WineCX](WINECX.md) are the Wine runtimes that MacLauncher downloads itself. All three share one [Wine layer](WINE.md).

MacLauncher uses CrossOver's own Wine and engines and adds features around them without modifying the CrossOver application. Compared with starting the same game in CrossOver alone, MacLauncher changes the following:

- Import and Play prepare a private bottle for each game automatically, run the game from its original files and keep that bottle when CrossOver is updated or moved. A bottle that already exists can be used instead, and MacLauncher never deletes, recreates, moves or replaces it.
- Each game can choose a default Direct3D engine, a translator for each Direct3D version, a Vulkan driver and video codecs, from CrossOver's own engines and from [translator versions installed in Runtimes](TRANSLATORS.md). A version is installed once and shared by every game that selects it.
- Several CrossOver applications can be registered side by side, and each game can use a different one.
- MacLauncher's [graphics effects](../graphics/SHARED_PROCESSING.md) run on CrossOver games through private copies of CrossOver's Wine loaders. A game's compatible DLSS or XeSS integration supplies scene inputs to MetalFX and to the shared temporal methods whose required inputs are available.
- Display, input, compatibility and diagnostics controls are set per game, and a game in an existing bottle can keep that bottle's current values.

## When CrossOver is offered

Sikarugir is the default runtime for generic Windows games. CrossOver is offered for any game with a compatible x86 or x64 Windows executable while a registered application is available, and saved CrossOver selections and the usual defaults of known engines are kept. Some detected engines, such as BGI / Ethornell, CatSystem2 and Windows Haxe builds, have no macOS runtime of their own, so a registered CrossOver application comes first for them. [Windows Game](../game-types/WINDOWS.md#windows-executables-in-other-game-types) describes which games offer the Windows runtimes.

Windows API compatibility comes from the selected CrossOver version, and a game's DRM, anti-cheat and Windows dependency requirements still apply.

## Applications and versions

MacLauncher finds CrossOver at `/Applications/CrossOver.app` and `~/Applications/CrossOver.app` automatically, and **Find installed applications** checks those paths again. Other copies, including previews and copies with updated libraries, are registered with **Runtimes → CrossOver → Add CrossOver**. Every application stays where it is, and **Remove** unregisters its path without deleting anything. Each application's row names the translator versions that it includes, such as its DXMT, DXVK and D3DMetal releases.

Each registered application is a separate choice, even when several copies report the same version. Play chooses one in the [usual order](README.md#versions): the game's **Version** selection, then a saved default, then the newest registered application that is ready. The first application added becomes the default when no default is saved yet.

An optional CrossOver graphics integration package, matched to the application's exact release and build, adds Vulkan external memory, semaphore and fence sharing to CrossOver's Mac driver. Only the transfer of NGX scene data uses it, for a game whose Direct3D 12 translator is a MacLauncher vkd3d-proton version selected in **Runtimes**, so launches with CrossOver's automatic translators never offer or load it. Play offers the package only when the package list names one for that release and build. When Play downloads another component, the package is listed with its version and size in that download's dialog. Otherwise Play offers it in a dialog of its own, where **Play Without It** starts the game with the module that CrossOver supplies. Without the package, the NGX scene data transfer is off, the launch log records why, and the game starts. Play remembers a declined or failed download for that CrossOver release and build, and offers the package again only for another release or after **Find installed applications** in **Runtimes → CrossOver**. When no matching package is available, CrossOver's own module is used as well. The package's versions are listed under **CrossOver graphics integration** in the CrossOver entry of **Runtimes**, which refreshes the package list and removes versions. The package never modifies the CrossOver application.

For each registered CrossOver release, only the newest integration revision is kept. Play preparation and Refresh remove revisions that no registered application needs once games have stopped using them, and they inspect the registered applications only while a package or a remembered choice exists. A registered application whose location is temporarily unavailable keeps its integration packages. Each launch checks the integration library's checksum before linking it.

An application updated in the same location keeps its selection and its existing bottles. If the selected application is missing, however, MacLauncher does not substitute another copy. The application can be used again once it is restored to its registered location, or once its new location is added in **Runtimes** and selected.

## Bottles and private game files

For an ordinary Play, MacLauncher maps the game root to a Windows drive letter local to the prefix and passes the executable and working directory through that drive, so game assets, portable saves and configuration stay at their original paths. The drive root is the imported folder when that folder contains the game folder, which lets a program read files above its own folder. For an executable in a packaged Unreal layout, `<install>/<project>/Binaries/<platform>` with `<install>/Engine` and `<project>/Content` folders inside the install folder, the drive maps at least that install folder, even when the executable itself was imported. In all other cases, the drive root is the game folder. However deep the folder sits on the Mac, the mapping keeps the Windows path short. Existing drive mappings are preserved, and matching ones are reused. Game files and the native working directory stay at their original locations, and Play makes no copy of the game and no folder of links to it.

Play also neither reads nor updates the private game folders of earlier MacLauncher versions, and their files and records stay untouched. Those earlier private `game/` folders are instead recovered once into the original game folders, as [Earlier private game folders](../library/GAME_PREPARATION.md#earlier-private-game-folders) describes. Missing files are restored, and a version that differs from the original is kept beside it as a conflict copy. Earlier `temporal-camera` and `temporal-original` folders with proxy or asset-link records are kept for a separate recovery. The recovery does not run during Play, import or upkeep, and it removes no Wine prefixes or bottles.

Play picks the executable from the first of these that applies: an explicit Windows executable choice, the publisher's Windows entry recorded with a Steam download, the detected engine's Windows entry, the recorded game program, and finally executable discovery. An explicit choice is either the **Windows executable** runtime setting or an imported executable. A detected engine can also mark its entry as required, as [MAGES.](../game-types/MAGES.md#crossover-sikarugir-and-winecx) does for a publisher launcher that the game program depends on; an imported executable then identifies the game without choosing what starts. A Steam download keeps the publisher's default Windows entry from the app metadata that the download already used. That record is read offline, and a missing or invalid entry passes on to the other choices. Every entry must be a Windows PE executable inside the game folder.

By default, a game's Windows environment is a private CrossOver bottle. Each game has its own bottle for each Windows environment type, independent of the selected CrossOver installation, so the bottle and its saves survive moving, updating or changing the CrossOver application. Changing the renderer or synchronization keeps the bottle as well. Saves written to the bottle's Windows profile remain with the bottle. Where CrossOver would link profile folders to the macOS Documents or Desktop folders, MacLauncher replaces those links with private folders inside the bottle. As for every Wine source, save tools use the original game folder as the primary location and list the selected bottle's Windows profile as an alternate. CrossOver has no universal save editor or save-location format, and engine save codecs are disabled while it is selected.

CrossOver, like Sikarugir and WineCX, stores shader caches in each game's MacLauncher runtime directory. `MESA_SHADER_CACHE_DIR` points to `cache/mesa`. DXVK uses `DXVK_SHADER_CACHE_PATH`, set to the Wine DOS path for `cache/dxvk`, which Play creates before the game starts. The cache locations are separate from the bottle and the Wine home. Through `MESA_SHADER_CACHE_MAX_SIZE`, the Mesa cache gets a budget of `4G`, unless **Settings → Environment variables**, the game's **Runtime Settings** or an existing Wine environment sets another value.

Stop first asks the Windows programs in a private bottle to close and then ends any remaining Wine processes. Canceling the initial preparation removes only the incomplete private environment. Removing a game from the library removes the Windows environments that MacLauncher created for it and leaves the original game files alone. Application registrations are stored in `runtimes/crossover/registrations.json`.

After an upgrade from an earlier MacLauncher version, the game's earlier bottle is moved once to its stable Windows environment path and used from there. MacLauncher takes the bottle that the game last used, according to its records. Without such a record, it takes the bottle with the newest registry or marker timestamp; when usage is unknown or tied, the bottles stay where they are and have to be sorted out by hand. A bottle that is already at the stable path takes precedence. Other earlier bottles stay separate, with their locations recorded, and their files are not merged. A bottle whose internal Wine drive mappings use absolute paths, which would break after the move, is not moved automatically either.

## Existing bottles

A game can also run in a CrossOver bottle that already exists. For this, each game's Runtime Settings has an **Environment** choice: **Private (MacLauncher)**, the CrossOver bottles found on the Mac, or **Choose…** for another bottle. To find bottles, MacLauncher reads the configured bottle folder from the environment, CrossOver's configuration or its preferences, and otherwise uses the standard Bottles folder. Published and stub bottles are excluded. Both the list and the bottles' current values are read offline.

Selecting a bottle stores only a reference to its path. The bottle stays in place, and MacLauncher never copies, takes over, recreates or removes it. A missing or incomplete bottle reports an error and is left as it is. Removing the game also leaves the bottle intact, and a removal whose directory would contain the bottle is refused.

CrossOver then runs with the bottle's absolute path, `--wait-children` and `--no-update`. Selected settings and translator files can change the bottle, while its profile mappings stay as they were. Logs stay in MacLauncher's data. **Open Windows files** opens the selected bottle, whose Windows profiles are listed as alternate save locations.

Stop ends only the launched game's processes by default. **Close All Applications** asks for confirmation, then asks the bottle's other Windows programs to close and forces the remaining ones to quit. When the game exits normally, the bottle's other programs keep running. While the bottle's wineserver is running, the selector shows it, and MSync and High Resolution changes have to wait until it stops.

## Runtime settings

Settings holds the defaults, and each game's Runtime Settings can override them. Settings that need Apple Silicon or a newer macOS than the Mac has are not listed.

| Setting | Behavior |
| --- | --- |
| Environment | A private bottle for the game, or a reference to an existing bottle. Set per game only. |
| Default Direct3D engine | The global renderer choice for every Direct3D API without a choice of its own: CrossOver's automatic choice, an engine included with the selected CrossOver, or a specific translator version installed in Runtimes. Each choice names its engine, version and source. |
| Direct3D 8, 9, 10 / 10.1 and 11 | A choice for each API among the installed implementations, with their actual versions and sources. Choices that share DLLs or helpers are linked, and an unset choice keeps the default Direct3D engine. |
| Direct3D 12 | Wine vkd3d, D3DMetal, or a vkd3d-proton or D3DMetal version installed in Runtimes. CrossOver's own D3DMetal, with an automatic, inherited or D3DMetal default Direct3D engine and no other Direct3D API choice, uses CrossOver's D3DMetal renderer, as the D3DMetal default Direct3D engine does. With the automatic **Vulkan driver**, vkd3d-proton is paired with [MacLauncher KosmicKrisp](KOSMICKRISP.md#direct3d-12-through-vkd3d-proton), on which it reports Direct3D feature level 12_1; with another selected driver, the launch warns that KosmicKrisp is recommended for it. |
| Vulkan driver | CrossOver's automatic choice, CrossOver's own MoltenVK, or a specific MoltenVK or KosmicKrisp version installed in Runtimes. The automatic choice keeps CrossOver's driver, except that a DXVK or vkd3d-proton version from Runtimes is paired with MacLauncher KosmicKrisp, as [Selection and loading](KOSMICKRISP.md#selection-and-loading) describes. Only versions with code for the CPU architecture of the selected Wine are listed, as [Versions and sources](TRANSLATORS.md#versions-and-sources) explains. |
| Video codecs | The runtime defaults or a registered GStreamer codec folder. |
| Game temporal integration | Exposes MetalFX Temporal through a 64-bit game's DLSS integration with CrossOver's own DXMT or D3DMetal. A DXMT or D3DMetal version from Runtimes, and DLSS forwarding with DXVK or vkd3d-proton, do not depend on it. Listed for Unity and Windows games, and hidden only for WineD3D. See [Temporal upscaling](#temporal-upscaling). |
| Synchronization | Automatic, MSync, ESync or Off. ESync is listed only when the selected CrossOver is older than version 25. |
| Language locale | An optional locale identifier, such as `ja_JP.UTF-8`. |
| Windows environment | Windows 10, Windows 11, Windows 7 or Windows XP, each a 64-bit bottle type that the selected application must include. Each choice uses its own bottle. |
| Per-launch Windows version | **Bottle version**, or a Windows version that CrossOver reports for this launch within the current bottle. See [Windows versions](#windows-versions). |
| Windows executable | An optional relative path, for when automatic selection picks the wrong executable. |
| Enable BepInEx winhttp override | Turns on `winhttp=n,b` for a game that already contains BepInEx's proxy DLL. Listed for Unity and Windows games. No mod, DLL or font is downloaded. Explicit Wine DLL overrides take precedence, including grouped entries such as `winhttp,wininet=b`. |
| Wine DLL overrides, game arguments | Apply to the game process. MacLauncher sets the application and bottle paths itself. |
| Wine debug channels | Optional Wine channel filters, such as `-all` or `+seh`. |

The graphics and synchronization choices follow the [CrossOver Mac user guide](https://www.codeweavers.com/support/docs/crossover-mac/index), and the BepInEx option follows BepInEx's [Wine instructions](https://docs.bepinex.dev/articles/advanced/proton_wine.html). [Graphics translators](TRANSLATORS.md#selection) describes the translator controls.

### Display, input, compatibility and diagnostics

Runtime Settings keeps the basic launch choices above separate from four advanced groups. **Display** holds High Resolution (Retina), DPI, fullscreen capture, vertical sync and virtual desktops, and **Input** maps Option to Alt and Command to Ctrl and configures mouse capture. **Compatibility** holds Rosetta AVX advertisement together with options for particular engines: DXVK async, DXMT frame-rate presets and MetalFX spatial, D3DMetal frame limits and Metal 4, MoltenVK fast math, argument buffers and UE4 compatibility, and WineD3D configuration. Each engine's options appear only when that engine is selected. **Diagnostics**, finally, offers the Metal and DXVK HUDs, the Wine crash dialog and Wine debug channels.

Environment variables for CrossOver and its translators have global values in **Settings → Environment variables** and a game's own values in the **Environment variables** section of its Runtime Settings, as [translator environment variables](TRANSLATOR_ENVIRONMENT.md) describes. A variable set there replaces the value that one of these controls sets, such as `WINEDEBUG` or `MTL_HUD_ENABLED`. Registry settings apply to the selected Windows environment on its next launch, and High Resolution and synchronization changes can require restarting the environment's Windows programs.

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

[Graphics translators](TRANSLATORS.md) describes how the translator choices are installed, loaded and checked. Runtimes groups the translators as DirectX → Vulkan, DirectX → Metal, Vulkan drivers and video codecs, and Runtime Settings arranges the Direct3D choices from Direct3D 8 to 12. Their versions, API scope and sources are read from the installed files. CrossOver's automatic choice stays global while it is unresolved, whereas a specific default Direct3D engine or an explicit choice for every API uses the private loader. For a game in an existing bottle, each control also offers the bottle's current setting. A runtime version is installed once, and private graphics views and Windows DLLs link to that installation. Prepared loader trees are shared between games that use the same files.

Translator dependency directories use fallback library and framework lookup, so macOS system libraries keep precedence. The private Wine loader still locates its files from its own `ntdll.so`.

Translator catalogs and local registrations share their runtime storage with Sikarugir. Components installed inside CrossOver are used in place, and only for CrossOver launches.

A video codec component adds only its plugin directories. When it is prepared, CrossOver's existing native core dependencies are reused, and CrossOver's scanner and system-plugin defaults are kept. The component's dependency directories stay out of global library search paths, and optional plugins that cannot be used are reported separately from the usable ones.

## Graphics

Before each launch, the selected translator is checked against the actual Wine CPU, PE machine type, native macOS minimum and required Wine imports. When a file is missing or a requirement is shown to be missing, the same engine included with this CrossOver is used instead, or CrossOver's automatic choice when it has no such engine. Metadata that cannot be read leaves the selection active. The inspector names the selected and used engines and explains any fallback, and [System requirements](SYSTEM_REQUIREMENTS.md#windows-compatibility-runtimes) lists the related components.

Per-game ReShade effects use the shared [graphics pipeline](../graphics/SHARED_PROCESSING.md) with the selected CrossOver application, graphics backend and Windows environment, and effects can be switched while the game runs. For these effects, and for translators installed in Runtimes, the game starts through private copies of CrossOver's small Wine loaders. The copies are prepared automatically and signed again with permission to load MacLauncher's graphics adapter, while keeping the original loaders' other entitlements. Each prepared set is cached once for its CrossOver application and translator files and reused between games. CrossOver's application, license files and installed libraries stay in place, and the game's existing bottle and saves are kept.

Each prepared set contains complete linked views of the Windows modules for every architecture that the selected Wine supplies. WoW64 loads its bootstrap modules from these views relative to the loader, and the links for the selected translator, camera and scene libraries take precedence there.

If the graphics loader cannot be prepared, the game runs with the selected CrossOver renderer and its existing bottle, without shared graphics effects for that launch, and its saved graphics selections are kept. A translator from Runtimes that depends on the private loader is the exception: its launch stops with the error instead.

Graphics libraries must match the architecture of the native Wine process that runs the game. When CrossOver uses a separate Unix loader, the architectures of that loader decide which libraries are compatible; the Windows executable and the launcher play no part. An Intel Wine process therefore needs Intel-compatible graphics libraries, including on Apple Silicon through Rosetta. Intel-only Wine components go through the usual [Rosetta](ROSETTA.md) check, even when the CrossOver application itself is universal.

When DXVK's DXGI presents an NVIDIA adapter through `DXVK_CONFIG`'s `dxgi.customVendorId = 10de`, MacLauncher sets the DXGI description to the actual GPU name followed by ` (DXVK)`. For example, `Apple M2 Max` becomes `"Apple M2 Max (DXVK)"`. Applications then do not mistake Wine's display driver version for an NVIDIA driver version. The rule also applies to vkd3d-proton when it uses DXVK's DXGI. An existing `dxgi.customDeviceDesc` in `DXVK_CONFIG` is preserved along with every other entry, and no description is added when the GPU name is unavailable or ambiguous. NVAPI's device name stays unchanged. [Translator environment variables](TRANSLATOR_ENVIRONMENT.md#dxvk) describes the controls.

### Temporal upscaling

Temporal upscalers need the game's depth and motion data, which a Windows game passes to the upscaler it calls itself. **Game temporal integration** takes advantage of this with DXMT and D3DMetal by exposing MetalFX Temporal through a 64-bit game's DLSS integration. It requires Apple Silicon and matching NVAPI and NGX libraries, together with DXMT on macOS 14 or later or D3DMetal on macOS 26 or later. The setting controls CrossOver's own DXMT and D3DMetal, and selecting a shared Temporal upscaling method also turns the integration on at launch. A DXMT or D3DMetal version from Runtimes selected for Direct3D 11 or 12 turns it on by itself. Where the Mac, macOS, executable or libraries cannot run the integration, the game starts without it.

DXVK and vkd3d-proton forward DLSS without this option. When a 64-bit game renders Direct3D 11 or 12 through one of them, DXVK's own DXGI is placed, and the **Vulkan driver** in use is MacLauncher KosmicKrisp or MoltenVK scene support, the game's DLSS frames always go through DXVK-NVAPI and the NGX forwarding core to that driver. It makes no difference whether the automatic pairing or a selection chose the driver. Both come as MacLauncher Builds packages, which Play downloads after consent in the same Play as a driver download, and **Runtimes → Graphics → DirectX → Vulkan** lists them as **DXVK-NVAPI** and **Vulkan DLSS forwarding**. The forwarding core is placed in the bottle's `system32`, and the bottle's registry names that folder as the NGX core location (`HKLM\Software\NVIDIA Corporation\Global\NGXCore`, `FullPath` = `C:\Windows\System32`), which is where the game's NGX library looks for its core. Play writes this value only when the stopped bottle does not already hold it, in any spelling of the key. DXVK then presents a virtual NVIDIA adapter description so that the forwarding core is accepted, while the actual driver and library checks still decide which features are supported.

Without DXVK's own DXGI, as with CrossOver's DXVK 1.10.3 on Wine's DXGI, the game starts without forwarding. A driver that cannot carry temporal frames does not forward either. CrossOver's own MoltenVK, stock MoltenVK versions and LWJGL's KosmicKrisp are such drivers, and when one of them is selected, its Vulkan driver row says "This Vulkan driver does not forward DLSS frames."

Either way, DLSS must also be enabled in the game, and neither game temporal integration nor DLSS forwarding enables DLSS frame generation or ray reconstruction.

Enabled temporal rows in the Advanced graphics settings prepare the same game integration and dependencies as the Simple temporal settings, while disabled rows add no temporal requirements.

MacLauncher's FSR 2 and FSR 3 upscalers need the game's camera data as well. A game that calls DLSS through NVIDIA Streamline passes that data to Streamline in `slSetConstants`. MacLauncher never replaces the game's Streamline interposer (`sl.interposer.dll`), because a game can verify the interposer's NVIDIA signature and then turn Streamline off. When [DLSS goes through DXVK or vkd3d-proton](../graphics/INPUTS_AND_ADAPTERS.md#dlss-through-vulkan-translators), the NGX core that MacLauncher places for it takes the camera from the game's own interposer inside the game process. FSR 2 and FSR 3 are therefore available whenever DLSS is forwarded this way and the interposer exports Streamline's application API. On DXMT and D3DMetal, DLSS through Streamline runs without a camera, so MetalFX Temporal is available through game temporal integration but FSR 2 and FSR 3 are not.

With DXMT, game temporal integration uses MacLauncher's adapted DXMT libraries, which must match the selected renderer's native library and Windows thunk. CrossOver uses them only when DXMT is the Direct3D engine actually in use, and never under CrossOver's automatic choice. The adapted libraries are included with MacLauncher, whereas the DXMT support libraries are installed separately: **Runtimes → Graphics → DirectX → Metal** installs the shared DXMT versions, and the Direct3D engine choice selects one version for both rendering and temporal integration. When that version does not match, the inspector reports the mismatch and the selected renderer stays unchanged. For that launch, the private loader copies and renderer selection turn off CrossOver's automatic DLL redirection and select the matching DXMT libraries directly.

The same DXMT conditions apply to MacLauncher's automatic adaptation of in-game XeSS. When a game includes Intel's XeSS Direct3D 11 library, MacLauncher's XeSS adapter takes its place in the launch folder so that the game's XeSS requests can run through MetalFX. [Inputs and adapters](../graphics/INPUTS_AND_ADAPTERS.md) describes the data that the DLSS and XeSS integrations supply.

### Game frame-generation inputs

Game frame-generation calls are separate from shared Frame generation rows. The vkd3d-proton NGX core reports DLSS-G unsupported, and the FidelityFX API adapter forwards the game's frame-generation calls to its original library. D3DMetal retains its native MetalFX interpolation; observing an interpolator does not turn it into a real-frame scene producer. [Windows frame-generation inputs](../graphics/INPUTS_AND_ADAPTERS.md#windows-frame-generation-inputs) describes these routes and their presentation ownership.

A game that calls MetalFX frame interpolation through its translator can supply its real color pair and scene inputs to an enabled shared Frame generation row. A compatible 2× row writes the midpoint output requested by that call; the translator keeps its existing presentation schedule. Missing producer color metadata or unsupported provider inputs retain the original interpolation. This same input path serves native MetalFX applications and does not change NGX feature advertisement.

### FidelityFX API adapter

A game that ships AMD's FidelityFX API library, `amd_fidelityfx_vk.dll` for Vulkan or `amd_fidelityfx_dx12.dll` for Direct3D 12, can have its FidelityFX upscaling performed by MacLauncher's selected temporal upscaler. MacLauncher prepares the adapter only when the game's graphics settings use scene inputs, such as a temporal upscaler, and the library exports the five FidelityFX API functions: `ffxCreateContext`, `ffxDestroyContext`, `ffxConfigure`, `ffxQuery` and `ffxDispatch`. MacLauncher looks for the library beside the executable, at the top of the game folder and in their `plugins`, `Plugins`, `FidelityFX` and `FSR` subfolders.

The FidelityFX API adapter is a MacLauncher Builds package under **Graphics** → **Effects** in the Runtimes window, and Play offers to install it. Its proxy replaces the game's library only in the separate launch folder. The game's own library is kept beside it under another name and handles every context, configuration, query and frame-generation call. The proxy turns each upscale dispatch into one temporal frame, `VkTemporalFrameInfoMVK`, with FidelityFX's reactive and transparency-and-composition masks in a chained `VkTemporalFrameMasksInfoMVK`:

- For Vulkan, the proxy records the frame in the dispatch's command buffer. The selected Vulkan driver has to forward temporal frames, as MacLauncher KosmicKrisp and MoltenVK scene support do, and the game's device has to provide `vkCmdPipelineBarrier2`.
- For Direct3D 12, the proxy records the frame through vkd3d-proton's MetalFX command-list interface. The selected Direct3D 12 translator has to be MacLauncher's vkd3d-proton, on a Vulkan driver that forwards temporal frames.

The selected upscaler then writes the dispatch's output. When a frame cannot be recorded, the original FidelityFX dispatch runs. When the dispatches are recorded, the graphics menus count depth, motion vectors, jitter, exposure and the camera as inputs that the game supplies, so temporal upscalers are not listed under **Needs scene inputs**. Effects placed before the upscaler run on the dispatch's render-resolution input. The upscaled image then continues through the remaining effects when the game presents it in its window, so each of those effects runs once for that frame. The adapter is prepared the same way for CrossOver, Sikarugir and WineCX launches. With DXMT, D3DMetal or the Vulkan driver included with the Wine source, the game's FidelityFX library runs unchanged. FidelityFX Super Resolution 2 libraries have a different interface and also run unchanged.

While the game's **Graphics** are off, the proxy passes every upscale dispatch to the game's own FidelityFX library, so the game looks as it does without MacLauncher. Turning **Graphics** on again records the next dispatch for the selected upscaler. The first dispatch after each switch carries FidelityFX's reset flag, so the implementation that takes over starts without the other's history. The proxy follows `effect-plan.active`, a one-byte file that MacLauncher writes beside the game's effect plan each time it publishes the plan: `1` while the plan has an enabled row or output options, `0` otherwise. A background thread in the game process compares the file's write time and size every 100 ms and reads the byte only when they change, so no dispatch waits for the file. Without the file, the proxy records every dispatch.

### Launch folders for adapters

The FidelityFX API adapter and the in-game XeSS adaptation have to replace a DLL beside the application, so they run the game from a separate launch folder. Only the executable and the selected DLLs are copied into that folder, and other assets are referenced from the originals. The working directory remains the original executable folder, as when CrossOver starts the game, so files that the game reads or writes relative to its working directory, such as logs, saves and configuration, use that folder. Writes through the references also reach the original files. Files that the game creates, or replaces atomically, at paths built from the adapted executable's own location stay in the launch folder, because DLL redirection cannot send them elsewhere.

Each game has one launch folder for each Windows runtime, and every adapter launch replaces it at the same path, so it uses a single Windows drive letter. Files that the game created in the previous launch folder are removed with it and are never merged into the originals. The first adapter launch also removes the per-launch folders that earlier MacLauncher versions created and frees the drive letters they used. Ordinary Play does not use these folders. If preparation fails, the original executable runs without the adaptation, and independent shared effects can still use an available loader.

## Requirements

Wine's macOS window driver needs a graphical login session, so games are played from the MacLauncher application; an SSH shell alone cannot supply that session. [Windows Steam games](WINDOWS_STEAM.md) describes the optional bridge to the Steam client for Mac, which CrossOver shares with Sikarugir. This runtime uses CrossOver's own commands and modifies neither Steam nor CrossOver.

## Implementation

CrossOver is registered as a runtime provider. Module discovery adds its runtime metadata and settings to every detected game type, except Android games, native Mac apps and games recorded inside a Mac app bundle, without changing the detected engine. Offline detection records which Windows executable a game includes, or that it has none, using the shared search that [Windows Game](../game-types/WINDOWS.md#windows-executables-in-other-game-types) describes. To decide whether to offer CrossOver for a game, MacLauncher reads only that record, the recorded paths and the local application state, never the game's files, so the result does not change while those files are unavailable. Engine-specific preparation and runtime-download hooks do not run while CrossOver is selected.

On macOS 14 and later, a Wine program asks the active application to give up activation before it activates itself, by posting the distributed `WineAppWillActivateNotification` with its process ID. While a game started by MacLauncher runs, MacLauncher answers the requests that come from that game's own processes, matched against the processes descended from the launch, and only while MacLauncher is the frontmost application. It then makes one AppKit activation request for that process through the shared activation helper, so the game becomes the active application when its window opens. Requests from other Wine programs, or while another application is in front, are ignored. Answering needs no Accessibility permission and does not delay the launch.

Rosetta AVX advertisement is on by default for private bottles and can be turned off in Runtime Settings. When the Wine process runs under Rosetta, the launch also sets `DOTNET_EnableWriteXorExecute=0`. Language locale sets `LANG`, `LC_ALL` and `LC_MESSAGES`. CrossOver versions before 25 receive the earlier graphics and ESync flags, while later versions use the unified graphics selector and MSync.

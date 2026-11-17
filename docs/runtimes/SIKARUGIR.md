# Sikarugir

[Sikarugir](https://github.com/Sikarugir-App/Sikarugir) is a free distribution of Wine for macOS. Its publisher releases [Wine engines](https://github.com/Sikarugir-App/Engines) together with Templates, packages of the support libraries that each engine needs. MacLauncher downloads these engines and runs compatible Windows games with them. Sikarugir is the default runtime for [Windows games](../game-types/WINDOWS.md), and it is also offered for [other game types](../game-types/WINDOWS.md#windows-executables-in-other-game-types) whose files include a compatible x86 or x64 Windows executable, such as Windows releases of Ren'Py, RPG Maker, Unity and Godot games. Game runtime selectors list it as **Sikarugir**. [CrossOver](CROSSOVER.md), which uses a CrossOver application installed on the Mac, and [WineCX](WINECX.md), another downloaded Wine runtime, are separate choices. All three share the [Wine layer](WINE.md) whose settings, translators and graphics this page describes.

Sikarugir is the Wine runtime that MacLauncher can always download. Setup uses the publisher's engine archives directly, without Creator, a wrapper application, Homebrew or a compiler. On top of the engine, MacLauncher adds the following:

- Play prepares a private Wine prefix for each game from the game's original files, so no wrapper application has to be built first. A Sikarugir wrapper that already exists can be used instead, and MacLauncher never deletes, recreates, moves or replaces it.
- Every installed engine stays selectable, and each game can use a different one.
- Each game can choose a default Direct3D engine, a translator for each Direct3D version, a Vulkan driver and video codecs, from the Template's components and from [translator versions installed in Runtimes](TRANSLATORS.md), without changing the installed engine or Template. A version is installed once and shared by every game that selects it.
- MacLauncher's [graphics effects](../graphics/SHARED_PROCESSING.md) run on Sikarugir games. A game's compatible DLSS or XeSS integration supplies scene inputs to MetalFX and to the shared temporal methods whose required inputs are available.
- Display, input, compatibility and diagnostics controls, a DirectDraw compatibility wrapper and per-program Windows versions are set per game.

## Requirements

Current engines require macOS 14 or later, and installation reads the minimum macOS version from the engine and its support libraries. A Wine version installed during Play comes with its matching support libraries, and Play then prepares a private Windows environment for the game. The native Wine binaries are Intel code and need Rosetta on Apple Silicon, so Play checks for Rosetta and offers to install it, as [Rosetta](ROSETTA.md) describes.

The directories of Sikarugir's support libraries and of translator dependencies use fallback library and framework lookup, so macOS system libraries keep precedence. The private Wine loader still locates its files from its own `ntdll.so`.

The Windows APIs come from the selected Wine version and graphics backend, while Windows libraries that a game itself requires remain part of that game's own environment.

[Windows Steam games](WINDOWS_STEAM.md) describes the optional bridge to the Steam client for Mac, which Sikarugir shares with CrossOver.

## Versions

**Runtimes → Wine · Intel → Sikarugir** lists the downloadable and installed versions and sets the global preferred version, which the inspector's **Version** selector can override for one game. [Release catalogs](RUNTIME_CATALOGS.md#sikarugir) describes how Refresh reads the publisher's versions.

Each version pairs a Wine engine with a Template. MacLauncher records the engine and Template versions separately, together with the exact downloaded files and their checksums, so the Wine version never comes from the publisher's rolling release tag, and each installed engine stays selectable on its own. During installation, MacLauncher finds the Wine bundle by its `bin/wine` and `bin/wineserver` files and the Template application by its `Contents/Frameworks` folder, so an archive that places them inside another folder still installs in the same layout.

Version labels name the Template release, then the Wine release and its engine revision, in the form **Sikarugir 1.0.24 · Wine 10.0 rev 8**, which matches **WineCX 4.8.1 · Wine 11.19** and **CrossOver 26.3**. An installed engine's row also names the translator versions that its Template includes. A listed version names them too when an installed engine uses the same Template release; otherwise they are known after download ([Graphics translators](TRANSLATORS.md#versions-and-sources)). A single Template component can be installed without the Wine engine from the Template card of its translator in **Runtimes → Graphics**. Archive hashes remain in Details. Each included translator row shows the component's own release followed by its host, the runtime package that contains it, such as **DXVK 3.1.1 async · Sikarugir Template 1.0.24**; a folder name appears only when it is needed to tell otherwise identical rows apart. Matching copies from different hosts add the host's Wine version, and copies whose hosts have the same formatted version are told apart by the names those hosts supply.

From version 1.0.24 on, Templates keep their renderer packages in `Contents/SharedSupport/renderer`; earlier Templates keep them in `Contents/Frameworks/renderer`. Installation looks first in the folder that matches the Template version and then in the other one. If neither exists, it searches the Template's contents and records where the renderers are. Whichever folder they came from, MacLauncher installs the renderers in the same layout and records each component's native-library requirements for the graphics capability checks.

Refresh lists every compatible engine that the publisher offers, each paired with the newest compatible Template. Automatic selection uses the newest listed engine, which also takes the place of a global preferred version that is neither listed nor installed. A version chosen for a single game is used exactly as chosen. An engine or Template counts as a separate version when its checksum differs or, if the publisher states no checksum, when its listed size or asset differs. A newer Template or a replaced archive therefore adds versions, and the installed ones stay selectable. [Runtime release catalogs](RUNTIME_CATALOGS.md#sikarugir) describes how archives are recognized and checked.

**Install** can replace an incomplete installation of the same version, and Play offers the same repair through its download prompt. The replacement is assembled in a separate folder before it takes the place of the installed runtime, and each game's private files and Windows environment are kept. Completed engine and Template archives stay in the shared artifact cache, so a retry after an extraction failure reuses the verified download.

When a version chosen for one game cannot be resolved, preparation stops with a message that names the runtime and the version setting and either gives the reason or points to the versions listed in Runtimes. Play does not substitute another version for that game's choice.

## Private game files and prefixes

Ordinary Play uses the original Windows executable and game assets, with the executable's folder as the working directory. It makes no copy of the game and no folder of links to it, and it does not read, update or remove the private game folders of earlier MacLauncher versions. Portable saves and configuration remain at their original paths.

Those earlier private `game/` folders are instead recovered once into the original game folders, as [Earlier private game folders](../library/GAME_PREPARATION.md#earlier-private-game-folders) describes. Missing files are restored, and a version that differs from the original is kept beside it as a conflict copy. Earlier `temporal-camera` and `temporal-original` folders with proxy or asset-link records are kept for a separate recovery. The recovery does not run during Play, import or upkeep, and it removes no Wine prefixes or bottles.

A game's Windows environment is a Wine prefix. Each game has private prefixes under `prefixes/`, and the Windows 10, 11, 7 and XP selections each keep their own prefix. Other Windows versions are reported through per-program registry settings in the Windows 10 prefix, so they need no prefix of their own. A prefix does not depend on the selected engine version, installation path or package checksum, so runtime updates and reinstalls keep it and its saves. When the Wine engine recorded for a prefix differs from the selected engine, Play updates the existing prefix before applying registry settings or game graphics libraries. If a completed prefix has no engine recorded, Play records the selected one without running setup. Graphics loader views, in contrast, are kept separately for each combination of runtime and renderer components.

Every launch maps the game root to a Windows drive letter local to the prefix and passes the executable and working directory as paths on that drive. The drive root is the imported folder when that folder contains the game folder, which lets a program read files above its own folder. For an executable in a packaged Unreal layout, `<install>/<project>/Binaries/<platform>` with `<install>/Engine` and `<project>/Content` folders inside the install folder, the drive maps at least that install folder, even when the executable itself was imported. In all other cases, the drive root is the game folder. However deep the folder sits on the Mac, the Windows path stays short. Matching drive mappings are reused; a conflicting mapping is left intact, and another free letter is used. The Windows working directory on the mapped drive is set explicitly, while the native working directory and game files stay at their original locations. The same rule applies to private prefixes and existing wrappers, and no game data is copied for either. Windows profile folders, the home folder and temporary files are stored inside the prefix.

After an upgrade from an earlier MacLauncher version, the game's earlier prefix is moved once to its stable Windows-version path and used from there. MacLauncher takes the prefix that the game last used, according to its records. Without such a record, it takes the prefix with the newest registry or marker timestamp; when usage is unknown or tied, the prefixes stay where they are and have to be sorted out by hand. A prefix that is already at the stable path takes precedence. Other earlier prefixes stay separate, with their locations recorded, and their files are not merged. A prefix whose internal Wine drive mappings use absolute paths, which would break after the move, is not moved automatically either.

The installed engines are shared and never changed. Instead, each game has private runtime views that select its renderer libraries: they contain copies of the engine's small Wine loader files and use the installed libraries in place. After preparation, missing renderer DLLs are linked into the prefix, and renderer changes keep the existing prefix files and the libraries that the game supplies.

Stop first asks the Windows programs in a private prefix to close and then ends any remaining Wine processes. Removing a game from the library removes the Windows environments that MacLauncher created for it and leaves the original game files alone.

### Saves

Save tools use the original game folder as the primary location and list the selected prefix's Windows profile as an alternate. There is no universal Windows save editor or cheat integration. Recognized engines keep their optional source and asset tools, but engine-specific save codecs are disabled while Sikarugir is selected.

## Existing wrappers

A game can also run in a Sikarugir wrapper that already exists. For this, each game's Runtime Settings has an **Environment** choice: **Private (MacLauncher)**, the wrappers found under `~/Applications/Sikarugir`, or **Choose…** for another wrapper. The list and each wrapper's current values are read offline from the wrapper's Info.plist and registry files.

Selecting a wrapper stores a reference and leaves the wrapper in place. MacLauncher builds the launch from the wrapper's own Wine engine, prefix and support files, but it does not run the wrapper's launcher, custom shell commands or startup and shutdown scripts. Explicit settings or translator overrides can change the prefix, whereas inherited translator settings leave its DLL files unchanged. The wrapper's profile mappings, HOME and temporary-folder behavior stay as the wrapper defines them, and logs stay in MacLauncher's data.

A missing or incomplete wrapper reports an error and is not recreated. Removing the game leaves the wrapper intact, and a removal whose directory contains the wrapper is refused. **Open Windows files** opens the selected prefix, whose Windows profiles are listed as alternate save locations.

Stop ends only the game's processes by default. **Close All Applications** asks for confirmation, then asks the other Windows programs in the prefix to close and forces the remaining ones to quit. When the game exits normally, the other programs keep running. While the prefix's wineserver is running, the selector shows it, and MSync and High Resolution changes have to wait until it stops.

## Runtime settings

Settings holds the defaults, and each game's Runtime Settings can override them. Settings that need Apple Silicon or a newer macOS than the Mac has are not listed.

| Setting | Behavior |
| --- | --- |
| Environment | A private prefix for the game, or a reference to an existing Sikarugir wrapper. Set per game only. |
| Default Direct3D engine | The renderer choice for every Direct3D API without a choice of its own: Sikarugir's automatic choice, the engines that the selected runtime supplies, or a specific translator version installed in Runtimes. Each choice names its engine, version and source. |
| Direct3D 8, 9, 10 / 10.1 and 11 | A choice for each API among the installed implementations. Choices that share DLLs or helpers are linked, and the inspector reports the selected and the used component. |
| Direct3D 12 | Wine vkd3d, D3DMetal, or a vkd3d-proton or D3DMetal version installed in Runtimes. With the automatic **Vulkan driver**, vkd3d-proton is paired with [MacLauncher KosmicKrisp](KOSMICKRISP.md#direct3d-12-through-vkd3d-proton), on which it reports Direct3D feature level 12_1; with another selected driver, the launch warns that KosmicKrisp is recommended for it. |
| Vulkan driver | Sikarugir's automatic choice, a driver that the runtime supplies, or a specific MoltenVK or KosmicKrisp version installed in Runtimes. The automatic choice keeps the Template's driver, except that a DXVK or vkd3d-proton version from Runtimes is paired with MacLauncher KosmicKrisp, as [Selection and loading](KOSMICKRISP.md#selection-and-loading) describes. |
| Video codecs | The runtime defaults or a registered GStreamer codec folder. |
| Game temporal integration | Exposes MetalFX Temporal through a compatible 64-bit game's DLSS integration with the Template's own DXMT or D3DMetal. A DXMT or D3DMetal version from Runtimes, and DLSS forwarding with DXVK or vkd3d-proton, do not depend on it. Listed for Unity and Windows games, and hidden only for WineD3D. See [Game temporal integration](#game-temporal-integration). |
| DirectDraw compatibility | The optional CNC-DDraw wrapper for 32-bit games with a software DirectDraw renderer. Off by default and independent of the Direct3D settings. |
| Synchronization | Automatic, MSync or Off. MSync requires support in the selected engine. |
| Language locale | An optional locale, such as `ja_JP.UTF-8` or `en_US.UTF-8`. |
| Windows version | The Windows version that Wine reports. See [Windows versions](#windows-versions). |
| Windows executable | An optional relative path inside the game folder. |
| Wine DLL overrides | One `library=order` entry per line, such as `winhttp=n,b`. |
| Game arguments | One argument per line. |
| Wine debug channels | Optional Wine channel filters, such as `-all` or `+seh`. |

The optional **Enable BepInEx winhttp override**, listed for Unity and Windows games, loads a `winhttp.dll` that the game already supplies before Wine's built-in library. It installs no BepInEx, mods or DLLs, and explicit DLL overrides take precedence. The [BepInEx Wine guide](https://docs.bepinex.dev/articles/advanced/proton_wine.html) describes this setting. [Graphics translators](TRANSLATORS.md#selection) describes the translator controls.

### Display, input, compatibility and diagnostics

Runtime Settings keeps the basic launch choices above separate from four advanced groups. **Display** holds High Resolution (Retina), DPI, fullscreen capture, vertical sync and virtual desktops, and **Input** maps Option to Alt and Command to Ctrl and configures mouse capture. **Compatibility** holds Rosetta AVX advertisement together with options for particular engines: DXVK async, DXMT frame-rate presets and MetalFX spatial, D3DMetal frame limits and Metal 4, MoltenVK fast math, argument buffers and UE4 compatibility, and WineD3D configuration. Each engine's options appear only when that engine is selected. **Diagnostics**, finally, offers the Metal and DXVK HUDs, the Wine crash dialog and Wine debug channels.

Environment variables for Sikarugir and its translators have global values in **Settings → Environment variables** and a game's own values in the **Environment variables** section of its Runtime Settings, as [translator environment variables](TRANSLATOR_ENVIRONMENT.md) describes. A variable set there replaces the value that one of these controls sets, such as `WINEDEBUG` or `MTL_HUD_ENABLED`. Registry settings apply to the selected Windows environment on its next launch, and High Resolution and synchronization changes can require restarting the environment's Windows programs.

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

Windows 10, 11, 7 and XP each use their own prefix. The other versions, Windows 8.1, 8, Vista, XP 64-bit, 2000, ME, 98 and 95 and Windows Server 2008 R2, 2008 and 2003, instead change the per-program Windows version within the Windows 10 prefix. When an existing wrapper is selected, every Windows version applies inside that wrapper's prefix, and no private prefix is created.

### Settings of an existing wrapper

For a game in an existing wrapper, each setting defaults to **Wrapper setting**, followed by its current value as read offline. **Custom setting** turns on an override for that control. Overrides stored in the registry are written into the selected wrapper's prefix, and its original files and Windows environment remain in place.

## Translators

[Graphics translators](TRANSLATORS.md) describes how the translator choices are installed, loaded and checked. Runtimes groups the translators as DirectX → Vulkan, DirectX → Metal, Vulkan drivers and video codecs, and Runtime Settings arranges the Direct3D choices from Direct3D 8 to 12. Their versions, API scope and sources are read from the installed files. Direct3D APIs that share DXGI or native modules use one consistent set of those files in the private graphics view. For a game in an existing wrapper, each control also offers the wrapper's current setting. A runtime version is installed once, and private graphics views and prefix DLLs link to that installation. Prepared loader trees are shared between games that use the same files.

DXMT, D3DMetal and the Template's `dxvk`, `dxvk3` and `d9vk` DXVK folders can be installed from Template component catalogs without installing another Wine engine. Registered folders stay at their original locations.

A video codec component keeps Sikarugir's scanner, system-plugin paths and existing GStreamer/GObject core. Only the selected plugin directories are added to the plugin search path, and the plugins' private dependencies are reached through the shared prepared view. Optional plugins that cannot be used are reported, while the usable ones stay available. Video settings inherited from the defaults add no further component view.

## Graphics

Per-game ReShade effects use the shared [graphics pipeline](../graphics/SHARED_PROCESSING.md) with the selected Wine version, graphics backend and Windows environment. Effects can be switched while the game runs, and the shared Wine installation stays unchanged.

Sikarugir's automatic choice depends on the Mac. Direct3D 10 and 11 use DXMT. On a Mac with a confirmed physical Apple M-series GPU and macOS 26 or later, the automatic choice also turns on KosmicKrisp, and Direct3D 8 and 9 then use the Template's `d9vk` libraries. With a virtual or unrecognized GPU, or on an older system, Direct3D 8 and 9 use WineD3D and Vulkan uses MoltenVK.

The Vulkan driver is chosen separately from the Direct3D renderer, and the choice also applies to games that use Vulkan directly. Its automatic choice prefers KosmicKrisp when the macOS, architecture and physical GPU checks pass, and uses MoltenVK otherwise. With a DXVK or vkd3d-proton version from Runtimes, the automatic choice is MacLauncher KosmicKrisp instead, as [Selection and loading](KOSMICKRISP.md#selection-and-loading) describes. A selected translator that cannot load falls back to the same engine supplied by the runtime, or to the runtime's automatic choice, and the warning and the inspector name both versions and the reason.

During installation, MacLauncher identifies the renderers that the selected Template supplies and records their component version labels and minimum macOS versions. Each renderer's minimum follows from its platform API requirements and installed native dependencies, independently of the Wine engine.

| Component | Supplied by | Requirements and role |
| --- | --- | --- |
| DXMT | The Template's DXMT libraries | macOS 14 or the libraries' higher minimum; Direct3D 10/11 to Metal. |
| DXVK / D9VK | The Template's `dxvk`, `dxvk3` and `d9vk` libraries | Direct3D to Vulkan. MoltenVK uses the older Direct3D 10/11 profile; KosmicKrisp uses the newer profile when supplied and supported. |
| MoltenVK | The Template's Vulkan libraries | Vulkan-to-Metal driver; minimum macOS read from the installed libraries. |
| KosmicKrisp | The Template's Vulkan libraries | Vulkan-to-Metal driver; Apple Silicon and macOS 26 or the libraries' higher minimum. |
| D3DMetal | The Template's D3DMetal framework and dependencies | Apple Silicon and 64-bit Windows games; minimum macOS follows the installed framework and dependencies. Direct3D 11/12 to Metal. |
| WineD3D | Selected Wine engine | Wine's built-in Direct3D translation. |
| CNC-DDraw | The Template's optional DirectDraw wrapper | Software DirectDraw compatibility for 32-bit Windows games; uses installed libraries without another download. |

### Game frame-generation inputs

Sikarugir uses the same [Windows frame-generation input routes](../graphics/INPUTS_AND_ADAPTERS.md#windows-frame-generation-inputs) as CrossOver and WineCX. A shared Frame generation row uses the scene producer's available data. It does not expose a new game DLSS-G capability or take presentation ownership from a game frame-generation plugin.

### Game temporal integration

Temporal upscalers need the game's depth and motion data, which a Windows game passes to the upscaler it calls itself. **Game temporal integration** takes advantage of this with DXMT and D3DMetal by exposing MetalFX Temporal through a compatible 64-bit game's DLSS integration. It requires Apple Silicon and the selected package's NVAPI and NGX libraries. With DXMT it requires macOS 14 or later, and with D3DMetal macOS 26 or later; native dependencies can raise either minimum. The game's own DLSS setting activates the integration, and selecting a shared Temporal upscaling method also turns it on at launch. The setting controls the Template's own DXMT and D3DMetal. A DXMT or D3DMetal version from Runtimes selected for Direct3D 11 or 12 turns the integration on by itself. Where the Mac, macOS, executable, libraries or Wine engine cannot run it, the game starts without it.

Games offer DLSS only on an NVIDIA adapter. While D3DMetal performs a game's DLSS in a Wine whose `win32u.so` reads D3DMetal's adapter variables, such as WineCX's, the game therefore sees an NVIDIA GeForce RTX 4090. The **Reported graphics adapter** row of [What each source supplies](WINE.md#what-each-source-supplies) and the [D3DMetal variables](TRANSLATOR_ENVIRONMENT.md#d3dmetal) describe the values.

The option is off by default. It uses the selected renderer's existing MetalFX integration without modifying the game's DLLs, and DXMT's vendor libraries are selected when this option, a shared temporal upscaler or a DXMT version from Runtimes turns the integration on. A shared temporal selection replaces the exposed MetalFX operation only when matching scene resources and all of the selected upscaler's required inputs are available; otherwise the game's original scaler stays active. Methods that depend on the camera require the [camera support](#fsr23-camera-support) described below, because DLSS alone supplies no camera parameters. The option does not enable DLSS frame generation or ray reconstruction, and the common ReShade effects stay available whether or not the game supports DLSS.

Enabled temporal rows in the Advanced graphics settings prepare the same game integration and dependencies as the Simple temporal settings, while disabled rows add no temporal requirements.

For DLSS, D3DMetal also needs a Wine engine with the path conversion functions that expose the NGX libraries to games. Wine 10 lacks them, so MacLauncher checks the selected engine before launch; with compatible Wine 10 packages, DXMT remains available for DLSS. Ordinary D3DMetal rendering does not need these functions.

DXVK and vkd3d-proton forward DLSS inputs without a setting. When a 64-bit game renders Direct3D 11 or 12 through one of them, DXVK's own DXGI is placed, and the **Vulkan driver** in use is MacLauncher KosmicKrisp or MoltenVK scene support, the game's DLSS frames always go through DXVK-NVAPI and the NGX forwarding core to that driver. It makes no difference whether the automatic pairing or a selection chose the driver. Play downloads the DXVK-NVAPI and NGX forwarding libraries from MacLauncher Builds after consent, in the same Play as a driver download, and places them in the private Windows environment together with DXVK's DXGI. **Runtimes → Graphics → DirectX → Vulkan** lists them as **DXVK-NVAPI** and **Vulkan DLSS forwarding**. The forwarding core goes into the prefix's `system32`, and the prefix's registry names that folder as the NGX core location (`HKLM\Software\NVIDIA Corporation\Global\NGXCore`, `FullPath` = `C:\Windows\System32`), which is where the game's NGX library looks for its core. Play writes this value only when the stopped prefix does not already hold it, in any spelling of the key. The Wine engine and the game's libraries remain unchanged. With a virtual NVIDIA adapter in place, the forwarding core is accepted, while the actual driver and graphics libraries decide which features are supported. Without DXVK's own DXGI, the game starts without forwarding. The same applies to a driver that cannot carry temporal frames, such as the Template's own drivers, a stock MoltenVK version or LWJGL's KosmicKrisp; when such a driver is selected, its Vulkan driver row says "This Vulkan driver does not forward DLSS frames."


A game that calls MetalFX frame interpolation through its translator can supply its real color pair and scene inputs to one enabled 2× shared Frame generation row. Classic Metal follows observed full copies and registered format views from those images to current drawables on the same device and queue. Both presentation endpoints must be identified before either enters shared presentation. The selected provider writes the requested midpoint, and the translator keeps its existing presentation schedule. Unknown copies, reused acquisitions and unsupported provider inputs retain the original interpolation. MetalFX preserves the native color domain; another provider that requires an explicit encoding retains the original call when that metadata is absent. This same input path serves native MetalFX applications and does not change NGX feature advertisement.

### FSR2/3 camera support

MacLauncher's FSR 2 and FSR 3 upscalers need the game's camera data as well. A game that calls DLSS through NVIDIA Streamline passes that data to Streamline in `slSetConstants`. MacLauncher never replaces the game's Streamline interposer (`sl.interposer.dll`), because a game can verify the interposer's NVIDIA signature and then turn Streamline off. When [DLSS goes through DXVK or vkd3d-proton](../graphics/INPUTS_AND_ADAPTERS.md#dlss-through-vulkan-translators), the NGX core that MacLauncher places for it takes the camera from the game's own interposer inside the game process, matched to the exact frame and viewport of each DLSS evaluation. FSR 2 and FSR 3 are therefore available whenever DLSS is forwarded this way, the interposer exports Streamline's application API and Streamline's DLSS plugin (`sl.dlss.dll`) sits beside it. A game that ships the interposer without that plugin calls NGX directly for DLSS and supplies no camera at the evaluation. In Unreal Engine's Streamline plugin folder, such a game sets each frame's camera after that frame's DLSS evaluation when started with `-slforcetagging`. The launch adds that argument when an enabled frame generation row consumes the camera, and that frame's frame generation receives the camera; FSR 2 and FSR 3 are not offered there. Projections that the core does not support keep the game's original scaler. On DXMT and D3DMetal, DLSS through Streamline runs without a camera, so MetalFX Temporal is available through game temporal integration but FSR 2 and FSR 3 are not.

When an enabled row needs additional scene inputs, the same NGX route can also carry the game's full Streamline projection, validated camera-pose transform and admitted HUD-less/UI tags. Exact frame, viewport, command and lifetime checks keep these attachments with their evaluation; missing conventions remain unknown. This optional capture keeps the game's interposer, original API results and existing scalar camera route unchanged, and it does not offer DLSS-G.

**Runtimes → Graphics → DirectX → Metal** installs DXMT versions independently of the Wine engine. The Direct3D engine choice also selects the DXMT version that MacLauncher's adapted DXMT libraries use. If that version does not match them, the inspector states that temporal integration is unavailable, and the selected DXMT continues to render.

The same DXMT conditions apply to MacLauncher's automatic adapter for in-game XeSS. When a game includes Intel's XeSS Direct3D 11 library, MacLauncher's XeSS adapter takes its place in the launch folder so that the game's XeSS requests can run through MetalFX. [Inputs and adapters](../graphics/INPUTS_AND_ADAPTERS.md) describes the data that the DLSS and XeSS integrations supply.

### Launch folders for adapters

The FidelityFX API adapter and the XeSS adapter need a DLL beside the application, so they run the game from a separate launch folder that holds copies of only the executable and the selected DLLs. Other assets are referenced from the originals. As in ordinary Play, the working directory remains the original executable folder, so files that the game reads or writes relative to its working directory, such as logs, saves and configuration, use that folder. Files that the game creates, or replaces atomically, at paths built from the executable's own location stay in the launch folder until the next adapter launch. Each game has one launch folder for each Windows runtime, and every adapter launch replaces it at the same path, so it uses a single Windows drive letter; original resources are never deleted, renamed or replaced. The first adapter launch also removes the per-launch folders that earlier MacLauncher versions created and frees the drive letters they used. Ordinary Play does not use these folders. If an adapter cannot be prepared, the original executable runs with the selected backend and the other available effects.

## Licenses

Wine is licensed under LGPL-2.1-or-later. The matching renderer and support-library notices stay with each installation, and a Template contains components under several different licenses. [Attributions](../ATTRIBUTIONS.md) and [upstream sources](UPSTREAMS.md#sikarugir) list their sources and download records.

D3DMetal is Apple's proprietary Direct3D 11/12 component for compatible Apple Silicon systems and 64-bit Windows games. Its download keeps the [Game Porting Toolkit license](https://github.com/Sikarugir-App/Sikarugir/blob/main/D3DMetal/4.0/License.pdf), which limits use to developing, testing or evaluating games on Apple products and allows redistribution only for non-commercial purposes under its terms. That license is separate from the open-source Wine and graphics component licenses.

## Implementation

On macOS 14 and later, a Wine program asks the active application to give up activation before it activates itself, by posting the distributed `WineAppWillActivateNotification` with its process ID. While a game started by MacLauncher runs, MacLauncher answers the requests that come from that game's own processes, matched against the processes descended from the launch, and only while MacLauncher is the frontmost application. It then makes one AppKit activation request for that process through the shared activation helper, so the game becomes the active application when its window opens. Requests from other Wine programs, or while another application is in front, are ignored. Answering needs no Accessibility permission and does not delay the launch.

Rosetta AVX advertisement is on by default for private prefixes and can be turned off in Runtime Settings. When the Wine process runs under Rosetta, the launch also sets `DOTNET_EnableWriteXorExecute=0`. Language locale sets `LANG`, `LC_ALL` and `LC_MESSAGES`.

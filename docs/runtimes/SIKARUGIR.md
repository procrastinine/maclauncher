# Sikarugir (Wine)

[Sikarugir](https://github.com/Sikarugir-App/Sikarugir) is a free distribution of Wine for macOS. Its publisher releases [Wine engines](https://github.com/Sikarugir-App/Engines) together with Templates, packages of the support libraries that each engine needs. MacLauncher downloads these engines and runs compatible Windows games with them. Sikarugir is the default runtime for [Windows games](../game-types/WINDOWS.md), and it is also offered for [other game types](../game-types/WINDOWS.md#windows-executables-in-other-game-types) whose files include a compatible x86 or x64 Windows executable, such as Windows releases of Ren'Py, RPG Maker, Unity and Godot games. Game runtime selectors list it as **Sikarugir (Wine)**. For locally installed CrossOver applications, [CrossOver](CROSSOVER.md) is a separate choice, and [WineCX](WINECX.md) is another downloaded Wine runtime. All three share the [Wine layer](WINE.md) that this page's settings, translators and graphics sections describe.

Running Windows games through Wine is a major MacLauncher feature, and Sikarugir is the runtime that MacLauncher can always download. Setup uses the publisher's engine archives directly, without Creator, a wrapper application, Homebrew or a compiler. On top of the engine, MacLauncher adds the following:

- Play prepares a private Wine prefix for each game from its original files, so no wrapper application has to be built first. A Sikarugir wrapper that already exists can be used instead, and MacLauncher never deletes, recreates, moves or replaces it.
- Every installed engine stays selectable, and each game can use a different one.
- Each game can choose a default Direct3D engine, a translator for each Direct3D version, a Vulkan driver and video codecs from the Template's components and from [translator versions installed in Runtimes](TRANSLATORS.md), without changing the installed engine or Template. A version is installed once and shared by every game that selects it.
- MacLauncher's [graphics effects](../graphics/SHARED_PROCESSING.md) run on Sikarugir games. Compatible DLSS and XeSS integrations supply scene inputs for MetalFX and shared temporal methods whose required inputs are available.
- Display, input, compatibility and diagnostics controls, a DirectDraw compatibility wrapper and per-program Windows versions are set per game.

## Requirements

A Wine version installed during Play comes with its matching support libraries, and Play then prepares a private Windows environment for the game. Installation reads the minimum macOS version from the engine and its support libraries; current engines require macOS 14 or later. Their native Wine binaries are Intel code, which needs Rosetta on Apple Silicon. Play checks for Rosetta and offers to install it, as [Rosetta](ROSETTA.md) describes.

Vendor support and translator dependency directories use fallback library and framework lookup, so macOS system libraries retain precedence. The private Wine loader keeps its own `ntdll.so` anchor.

The selected Wine version and graphics backend supply the Windows APIs. Windows libraries that a game itself requires remain part of that game's own environment.

[Windows Steam games](WINDOWS_STEAM.md) describes the optional Steam client bridge to the Steam client for Mac, which Sikarugir shares with CrossOver.

## Versions

**Runtimes → Sikarugir** lists the downloadable and installed versions and selects the global preferred version, and the inspector's **Version** selector can override it for one game. [Release catalogs](RUNTIME_CATALOGS.md#sikarugir) describes how Refresh reads the publisher's versions.

Each version pairs a Wine engine with a Template. Engine and Template versions are recorded separately, together with the exact downloaded files and their checksums. The publisher's rolling release tag is therefore not the Wine version, and each installed engine stays selectable on its own. During installation, MacLauncher finds the Wine bundle by its `bin/wine` and `bin/wineserver` files and the Template application by its `Contents/Frameworks` folder, so an archive that places them inside another folder still installs in the same layout.

Version labels name the Wine release, its engine revision and the Template, in the form **Wine 10.0 (rev 8) · Template 1.0.24**. An installed engine's row also names the translator versions that its Template includes, and a listed version names them when an installed engine uses the same Template release; otherwise they are known after download ([Graphics translators](TRANSLATORS.md#versions-and-sources)). A single Template component can be installed without the Wine engine from the Template card of its translator in **Runtimes → Graphics**. Archive hashes remain in Details. Included translator rows show the component's own release followed by its host, such as **DXVK 3.1.1 async · Sikarugir Template 1.0.24**; a folder name appears only when it distinguishes otherwise identical rows. Matching copies from different hosts add the host's Wine version, and copies with the same formatted host version use their supplied host names to distinguish them.

Templates keep their renderer packages in `Contents/SharedSupport/renderer` from version 1.0.24 on, and in `Contents/Frameworks/renderer` before that. Installation looks first in the folder that matches the Template version and then in the other one. If neither exists, it searches the Template's contents and records where the renderers are. Whichever folder they came from, MacLauncher installs the renderers in the same layout and records each component's native-library requirements for the graphics capability checks.

Refresh lists every compatible engine that the publisher offers, each paired with the newest compatible Template. Automatic selection uses the newest listed engine, which also replaces a global preferred version that is neither listed nor installed. An explicit per-game version remains exact. An engine or Template counts as a separate version when its checksum differs, or, if the publisher states no checksum, when its listed size or asset differs. A newer Template or a replaced archive therefore adds versions, while installed ones stay selectable. [Runtime release catalogs](RUNTIME_CATALOGS.md#sikarugir) describes how archives are recognized and checked.

**Install** can replace an incomplete installation of the same version, and Play offers the same repair through its download prompt. The replacement is assembled in a separate folder before it takes the place of the installed runtime, and each game's private files and Windows environment are kept. Completed engine and Template archives stay in the shared artifact cache, so a retry after an extraction failure reuses the verified download.

An explicit per-game version that cannot be resolved stops preparation with a message naming the runtime and version setting. The message includes the reason or directs selection to a version listed in Runtimes; Play does not substitute another version for that unresolved game choice.

## Private game files and prefixes

Ordinary Play uses the original Windows executable and game assets, with the executable's folder as the working directory. It makes no copy of the game and no folder of links to it, and it does not read, update or remove the private game folders of earlier MacLauncher versions. Portable saves and configuration remain at their original paths.

Those earlier private `game/` folders are recovered once into the original game folders instead, as [Earlier private game folders](../library/GAME_PREPARATION.md#earlier-private-game-folders) describes. Missing files are restored, and a version that differs from the original is kept beside it as a conflict copy. Earlier `temporal-camera` and `temporal-original` folders with proxy or asset-link records are kept for a separate recovery. The recovery does not run during Play, import or upkeep, and it removes no Wine prefixes or bottles.

A game's Windows environment is a Wine prefix. Each game has private prefixes under `prefixes/`, and the Windows 10, 11, 7 and XP selections each keep their own prefix. Other Windows versions are reported through per-program registry settings in the Windows 10 prefix, so they need no further prefix. A prefix does not depend on the selected engine version, installation path or package checksum, and runtime updates and reinstalls therefore keep it and its saves. When a recorded Wine engine identity differs from the selected engine, Play updates the existing prefix before applying registry settings or game graphics libraries. Play records a missing engine identity without running setup on a completed prefix. Graphics loader views, in contrast, are keyed separately to the runtime and renderer components.

Every launch maps the game root to a prefix-local Windows drive letter and uses mapped Windows paths for the executable and working directory. The drive root is the imported folder when it contains the game folder, so a program can read files above its own folder. An executable in a packaged Unreal layout, `<install>/<project>/Binaries/<platform>` with `<install>/Engine` and `<project>/Content` folders inside the install folder, maps at least that install folder, also when the executable itself was imported. Otherwise the drive root is the game folder. The Windows root stays short regardless of the Mac folder depth. Matching drive mappings are reused, and conflicting mappings remain intact while another free letter is selected. The mapped Windows working directory is set explicitly; the native working directory and game files stay at their original locations. The same rule applies to private prefixes and existing wrappers, without copying game data. Windows profile folders, the home folder and temporary files are stored inside the prefix.

After an upgrade from an earlier MacLauncher version, the game's earlier prefix is adopted once at its stable Windows-version path. MacLauncher adopts the prefix that the game last used, according to its records. Without such a record, it adopts the prefix with the newest registry or marker timestamp; when usage is unknown or tied, the prefixes stay where they are for manual resolution. A prefix that is already at the stable path takes precedence. Other earlier prefixes stay separate, with their locations recorded, and their files are not merged. A prefix is also not adopted automatically when its internal Wine drive mappings use absolute paths that would break after the move.

The shared installed engines are never changed. Instead, private runtime views select the renderer libraries for each game: they copy the engine's small Wine loader files and share the installed libraries. After preparation, missing renderer DLLs are linked into the prefix, and renderer changes keep the existing prefix files and the libraries that the game supplies.

Stop first asks the Windows programs in a private prefix to close and then ends any remaining Wine processes. Removing a game from the library removes the Windows environments that MacLauncher created for it and leaves the original game files alone.

### Saves

Save tools use the original game folder as the primary location and list the selected prefix's Windows profile as an alternate. There is no universal Windows save editor or cheat integration. Recognized engines keep their optional source and asset tools, but engine-specific save codecs are disabled while Sikarugir is selected.

## Existing wrappers

A game can also run in a Sikarugir wrapper that already exists. Each game's Runtime Settings has an **Environment** choice for this: **Private (MacLauncher)**, the wrappers found under `~/Applications/Sikarugir`, or **Choose…** for another wrapper. The list and each wrapper's current values are read offline from the wrapper's Info.plist and registry files.

Selecting a wrapper stores a reference and leaves the wrapper in place. MacLauncher builds the launch from the wrapper's own Wine engine, prefix and support files, but it does not run the wrapper's launcher, custom shell commands or startup and shutdown scripts. Explicit settings or translator overrides can change the prefix, whereas inherited translator settings leave its DLL files unchanged. The wrapper's profile mappings, HOME and temporary-folder behavior stay as supplied, and logs stay in MacLauncher's data.

A missing or incomplete wrapper reports an error and is not recreated. Removing the game leaves the wrapper intact, and a removal whose directory contains the wrapper is refused. **Open Windows files** opens the selected prefix, whose Windows profiles are listed as alternate save locations.

Stop ends only the game's processes by default. **Close All Applications** asks for confirmation before it asks the other Windows programs in the prefix to close and forces the remaining ones to quit. When the game exits normally, other programs keep running. If the prefix's wineserver is running, the selector shows this, and MSync and High Resolution changes then have to wait until it stops.

## Runtime settings

Settings holds the defaults, and each game's Runtime Settings can override them. Settings that need Apple Silicon or a newer macOS than the Mac has are not listed.

| Setting | Behavior |
| --- | --- |
| Environment | A private prefix for the game, or a reference to an existing Sikarugir wrapper. Set per game only. |
| Default Direct3D engine | The renderer choice for every Direct3D API without a choice of its own: the Template's automatic choice, the engines that the selected runtime supplies, or a specific translator version installed in Runtimes. Each choice names its engine, version and source. |
| Direct3D 8, 9, 10 / 10.1 and 11 | A choice for each API among the installed implementations. Choices that share DLLs or helpers are linked, and the inspector reports the selected and the used component. |
| Direct3D 12 | Wine vkd3d, D3DMetal, or a vkd3d-proton or D3DMetal version installed in Runtimes. With the automatic **Vulkan driver**, vkd3d-proton pairs with [MacLauncher KosmicKrisp](KOSMICKRISP.md#direct3d-12-through-vkd3d-proton), on which it reports Direct3D feature level 12_1; with another selected driver, the launch warns that KosmicKrisp is recommended for it. |
| Vulkan driver | The Template's automatic choice, a driver that the runtime supplies, or a specific MoltenVK or KosmicKrisp version installed in Runtimes. The automatic choice keeps the Template's driver, except that a DXVK or vkd3d-proton version from Runtimes pairs with MacLauncher KosmicKrisp, as [Selection and loading](KOSMICKRISP.md#selection-and-loading) describes. |
| Video codecs | The runtime defaults or a registered GStreamer codec folder. |
| Game temporal integration | Exposes MetalFX Temporal through a compatible 64-bit game's DLSS integration with the Template's own DXMT or D3DMetal. A DXMT or D3DMetal version from Runtimes, and DLSS forwarding with DXVK or vkd3d-proton, do not depend on it. Listed for Unity and Windows games; hidden only for WineD3D. See [Game temporal integration](#game-temporal-integration). |
| DirectDraw compatibility | The optional CNC-DDraw wrapper for 32-bit games with a software DirectDraw renderer. Off by default and independent of the Direct3D settings. |
| Synchronization | Automatic, MSync or Off. MSync requires support in the selected engine. |
| Language locale | An optional locale, such as `ja_JP.UTF-8` or `en_US.UTF-8`. |
| Windows version | The Windows version that Wine reports. See [Windows versions](#windows-versions). |
| Windows executable | An optional relative path inside the game folder. |
| Wine DLL overrides | One `library=order` entry per line, such as `winhttp=n,b`. |
| Game arguments | One argument per line. |
| Wine debug channels | Optional Wine channel filters, such as `-all` or `+seh`. |

The optional **Enable BepInEx winhttp override**, which is listed for Unity and Windows games, loads a `winhttp.dll` that the game already supplies before Wine's built-in library. It installs no BepInEx, mods or DLLs, and explicit DLL overrides take precedence. The [BepInEx Wine guide](https://docs.bepinex.dev/articles/advanced/proton_wine.html) describes this setting. [Graphics translators](TRANSLATORS.md#selection) describes the translator controls.

### Display, input, compatibility and diagnostics

Runtime Settings keeps the basic launch choices above separate from four advanced groups. **Display** holds High Resolution (Retina), DPI, fullscreen capture, vertical sync and virtual desktops, and **Input** maps Option to Alt and Command to Ctrl and configures mouse capture. **Compatibility** holds Rosetta AVX advertisement together with options for particular engines: DXVK async, DXMT frame-rate presets and MetalFX spatial, D3DMetal frame limits and Metal 4, MoltenVK fast math, argument buffers and UE4 compatibility, and WineD3D configuration. Each engine's options appear only when that engine is selected. **Diagnostics**, finally, offers the Metal and DXVK HUDs, the Wine crash dialog and Wine debug channels.

Environment variables for Sikarugir and its translators have global values in **Settings → Environment variables** and a game's own values in the **Environment variables** section of its Runtime Settings, as [translator environment variables](TRANSLATOR_ENVIRONMENT.md) describes. A variable there replaces the value that one of these controls sets, such as `WINEDEBUG` or `MTL_HUD_ENABLED`. Registry settings apply to the selected Windows environment on its next launch, and High Resolution and synchronization changes can require restarting the environment's Windows programs.

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

Windows 10, 11, 7 and XP each use their own prefix. The other versions, Windows 8.1, 8, Vista, XP 64-bit, 2000, ME, 98 and 95 and Windows Server 2008 R2, 2008 and 2003, change the per-program Windows version within the Windows 10 prefix instead. When an existing wrapper is selected, every Windows version applies inside that wrapper's prefix, and no private prefix is created.

### Settings of an existing wrapper

For a game in an existing wrapper, each setting defaults to **Wrapper setting**, followed by its current value as read offline. **Custom setting** turns on an override for that control. Overrides stored in the registry are written into the selected wrapper's prefix, and its original files and Windows environment remain in place.

## Translators

[Graphics translators](TRANSLATORS.md) describes how the translator choices are installed, loaded and checked. Runtimes groups the translators as DirectX → Vulkan, DirectX → Metal, Vulkan drivers and video codecs, and Runtime Settings arranges the Direct3D choices from Direct3D 8 to 12. Their versions, API scope and sources come from installed files. Direct3D APIs that share DXGI or native modules use one consistent set of those files in the private graphics view. For a game in an existing wrapper, each control also offers the wrapper's current setting. A runtime version is installed once, and private graphics views and prefix DLLs link to that installation. Prepared loader trees are shared between games that use the same inputs.

DXMT, D3DMetal and the Template's `dxvk`, `dxvk3` and `d9vk` DXVK folders can be installed from Template component catalogs without installing another Wine engine. Registered folders stay at their original locations.

Video components retain Sikarugir's scanner, system-plugin paths and established GStreamer/GObject core. Only selected plugin directories enter the plugin search path; private dependency neighborhoods use the shared prepared view. Optional unusable plugins are reported while usable siblings remain available. Inherited video settings do not add another component view.

## Graphics

Per-game ReShade effects use the shared [graphics pipeline](../graphics/SHARED_PROCESSING.md) with the selected Wine version, graphics backend and Windows environment. Effects can be switched while the game runs, and the shared Wine installation stays unchanged.

The Template's automatic choice depends on the Mac. Direct3D 10 and 11 use DXMT. On a confirmed physical Apple M-series GPU with macOS 26 or later, the automatic choice also enables KosmicKrisp, and Direct3D 8 and 9 then use the Template's `d9vk` libraries. Virtual or unrecognized GPUs and older systems use WineD3D for Direct3D 8 and 9 and MoltenVK for Vulkan.

The Vulkan driver is chosen separately from the Direct3D renderer, and it also applies to games that use Vulkan directly. Its automatic choice prefers KosmicKrisp when the macOS, architecture and physical GPU checks pass, and uses MoltenVK otherwise. With a DXVK or vkd3d-proton version from Runtimes, the automatic choice pairs with MacLauncher KosmicKrisp instead, as [Selection and loading](KOSMICKRISP.md#selection-and-loading) describes. A selected translator that cannot load falls back to the same engine supplied by the runtime, or to the runtime's automatic choice, and the warning and inspector name both versions and the reason.

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

### Game temporal integration

DXVK and vkd3d-proton forward DLSS inputs without a setting. When a 64-bit game's Direct3D 11 or 12 renders through one of them, DXVK's own DXGI is placed, and the **Vulkan driver** in use is MacLauncher KosmicKrisp or MoltenVK scene support, whether the automatic pairing or a selection chose it, the game's DLSS frames always go through DXVK-NVAPI and the NGX forwarding core to that driver. Play offers the managed DXVK-NVAPI and NGX forwarding libraries after consent, in the same Play as a driver download, and stages them in the private Windows environment with DXVK's DXGI. Both are listed in **Runtimes → Graphics → DirectX → Vulkan**, as **DXVK-NVAPI** and **Vulkan DLSS forwarding**. The source Wine engine and game libraries remain unchanged. A virtual NVIDIA adapter admits the forwarding core; the actual driver and graphics provider decide feature support. A route without DXVK's own DXGI starts without forwarding, and so does a driver without the temporal carrier, such as the Template's own drivers, a stock MoltenVK version or LWJGL's KosmicKrisp. When such a driver is selected, its Vulkan driver row says "This Vulkan driver does not forward DLSS frames."

Temporal upscalers need the game's depth and motion data, which a Windows game passes to the upscaler it calls itself. **Game temporal integration** makes use of this with DXMT and D3DMetal: it exposes MetalFX Temporal through a compatible 64-bit game's DLSS integration. It requires Apple Silicon and the selected package's NVAPI and NGX libraries. The DXMT path requires macOS 14 or later and the D3DMetal path macOS 26 or later, and native dependencies can raise either minimum. The game's own DLSS setting activates the integration, and selecting a shared Temporal upscaling method also turns it on at launch. The setting applies to the Template's own DXMT and D3DMetal. A DXMT or D3DMetal version from Runtimes selected for Direct3D 11 or 12 turns the integration on by itself; where the Mac, macOS, executable, libraries or Wine engine cannot run it, the game starts without it.

The option is off by default. It uses the selected renderer's existing MetalFX integration without modifying the game's DLLs, and DXMT's vendor libraries are selected when this option, a shared temporal upscaler or a DXMT version from Runtimes enables the integration. A shared temporal selection replaces the exposed MetalFX operation only when matching scene resources and all of the selected provider's required inputs are available; otherwise the game's original scaler stays active. Camera-dependent methods require the [camera support](#fsr23-camera-support) below; DLSS alone supplies no camera parameters. The option does not enable DLSS frame generation or ray reconstruction, and the common ReShade effects stay available whether or not the game supports DLSS.

Enabled temporal rows in the Advanced graphics settings prepare the same game integration and dependencies as the Simple temporal settings, while disabled rows add no temporal requirements.

D3DMetal also needs a Wine engine with the path conversion functions that expose the NGX libraries to games, and Wine 10 lacks them. MacLauncher checks the selected engine before launch, and DXMT remains available for DLSS with compatible Wine 10 packages. This requirement does not affect ordinary D3DMetal rendering.

### FSR2/3 camera support

MacLauncher's FSR 2 and FSR 3 upscalers need the game's camera data as well. A game that calls DLSS through NVIDIA Streamline already passes that data to Streamline, and MacLauncher's Streamline adapter can hand it on. This FSR2/3 camera support requires a compatible Streamline interposer and a camera adapter that matches the selected DXMT native library and Windows thunk. The camera adapter is included with MacLauncher. Preparation adds the matched libraries and the Streamline adapter only to the optional camera launch folder, where the original interposer stays next to its proxy for normal plugin lookup, with its complete export interface. Camera constants are matched to the exact frame, viewport and queued depth and motion textures, and projections that the adapter does not support keep the game's original scaler. Turning on game temporal integration before launch also prepares camera support for live changes of the temporal method.

**Runtimes → Graphics → DirectX → Metal** installs DXMT versions independently of the Wine engine. The Direct3D engine choice also selects the DXMT version that the camera adapter uses, and if that version does not match the adapter, the inspector states that camera support is unavailable while the selected DXMT continues to render.

The same DXMT conditions apply to an automatic in-game XeSS compatibility adapter. When a game includes Intel's XeSS Direct3D 11 library, MacLauncher's XeSS adapter takes its place in the launch folder so that the game's XeSS requests can run through MetalFX. [Inputs and adapters](../graphics/INPUTS_AND_ADAPTERS.md) describes the data that both routes supply.

### Launch folders for adapters

A camera adapter or the XeSS adapter needs a DLL beside the application, so it runs the game from a separate launch folder that contains copies of only the executable and the selected DLLs. Other assets are referenced from the originals, and the working directory remains the original executable folder. Files that the game creates, or replaces atomically, relative to the executable can stay in that launch folder, which is kept. When a launch folder is no longer used, original resources are never deleted, renamed or replaced, and earlier launch folders stay intact. Ordinary Play bypasses these folders. If an adapter cannot be prepared, the original executable runs with the selected backend and the other available effects.

## Licenses

Wine is licensed under LGPL-2.1-or-later. The matching renderer and support-library notices stay with each installation, and a Template contains components under several different licenses. [Attributions](../ATTRIBUTIONS.md) and [upstream sources](UPSTREAMS.md#sikarugir) list their sources and download records.

D3DMetal is Apple's proprietary Direct3D 11/12 component for compatible Apple Silicon systems and 64-bit Windows games. Its download keeps the [Game Porting Toolkit license](https://github.com/Sikarugir-App/Sikarugir/blob/main/D3DMetal/4.0/License.pdf), which limits use to developing, testing or evaluating games on Apple products and allows redistribution only for non-commercial purposes under its terms. That license is separate from the open-source Wine and graphics component licenses.

## Implementation

On macOS 14 and later, a Wine program asks the active application to give up activation before it activates itself, by posting the distributed `WineAppWillActivateNotification` with its process ID. While a game started by MacLauncher runs, MacLauncher answers the requests that come from that game's own processes, matched against the processes descended from the launch, and only while MacLauncher is the frontmost application. It then makes one AppKit activation request for that process through the shared activation helper, so the game becomes the active application when its window opens. Requests from other Wine programs, or while another application is in front, are ignored. Answering needs no Accessibility permission and does not delay the launch.

Rosetta AVX advertisement is on by default for private prefixes and can be turned off in Runtime Settings. When the Wine process runs under Rosetta, the launch also sets `DOTNET_EnableWriteXorExecute=0`. Language locale sets `LANG`, `LC_ALL` and `LC_MESSAGES`.

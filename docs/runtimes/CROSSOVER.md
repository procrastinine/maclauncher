# CrossOver

CrossOver is a Windows compatibility runtime supplied by a [CrossOver application](https://www.codeweavers.com/crossover) already installed on the Mac. MacLauncher uses it for [Windows games](../game-types/WINDOWS.md) and for compatible Windows executables of other game types. It requires a licensed CrossOver application with its own prerequisites; CodeWeavers handles CrossOver downloads, licenses and application updates, and MacLauncher does not bundle, copy or download any CrossOver binaries. [Sikarugir (Wine)](SIKARUGIR.md) is the alternative that MacLauncher downloads itself.

## When CrossOver is offered

Sikarugir is the default runtime for generic Windows games. CrossOver is offered for any game with a compatible x86 or x64 Windows executable when a registered application is available, and saved CrossOver selections and the usual defaults of known engines are kept. For detected engines with no macOS runtime of their own, such as BGI / Ethornell, CatSystem2 and Windows Haxe builds, a registered CrossOver application comes first. [Windows Game](../game-types/WINDOWS.md#windows-executables-in-other-game-types) describes which games offer the Windows runtimes.

The selected CrossOver version supplies the Windows API compatibility. The games' DRM, anti-cheat and Windows dependency requirements still apply.

## Applications and versions

MacLauncher finds `/Applications/CrossOver.app` and `~/Applications/CrossOver.app` automatically, and **Find installed applications** checks those paths. **Runtimes → CrossOver → Add CrossOver** registers further applications, including previews and copies with updated libraries. Applications stay where they are, and **Remove** unregisters a path without deleting the application.

Each registered application is its own choice, even when several copies report the same version. Play chooses one in the [usual order](README.md#versions): the game's **Version** selection, then a saved default, then the newest registered application that is ready. Adding the first application saves it as the default if none is saved.

An application updated in the same location keeps its selection and existing bottles. If the selected application is missing, MacLauncher does not substitute another copy. It can be used again after it is restored to its registered location, or after its new location is added in **Runtimes** and selected.

## Bottles and private game files

Ordinary Play passes the original Windows executable to CrossOver and uses its original executable folder as the working directory. Game assets, portable saves and configuration stay at their original paths. Play makes no copy of the game or folder of links to it, and it does not read or update the private game folders of earlier MacLauncher versions, whose files and records stay untouched.

Files in the private `game/` folders of earlier MacLauncher releases are recovered once into the original game folders, as [Earlier private game folders](../library/GAME_PREPARATION.md#earlier-private-game-folders) describes. Missing files are restored, and a version that differs from the original is kept beside it as a conflict copy. Earlier `temporal-camera` and `temporal-original` folders with proxy or asset-link records are kept for separate recovery. This recovery does not run during Play, import or upkeep, and it removes no Wine prefixes or bottles.

The default Windows environment is a private CrossOver bottle. Each game and Windows environment type has its own bottle, independent of the selected CrossOver installation. Moving, updating or changing the CrossOver application retains that bottle and its saves. Renderer and synchronization changes retain it too. Saves written to a bottle's Windows profile remain with the bottle. Profile aliases into macOS Documents or Desktop are replaced with private directories. CrossOver has no universal save editor or save-location format, and engine save tools are unavailable while it is selected.

Stop first asks Windows programs in a private bottle to close, then ends remaining Wine processes. Canceling initial preparation removes only the incomplete private environment. Removing a game from the library removes the Windows environments that MacLauncher created for it and leaves the original game files alone. Application registrations are stored in `runtimes/crossover/registrations.json`.

After an upgrade, the earlier bottle that the game last used, as recorded, is adopted once at the game's stable Windows environment path. Without that record, the bottle with the newest registry or marker timestamp is adopted; when usage is unknown or tied, the bottles stay where they are for manual resolution. A bottle already at the stable path takes precedence. Other earlier bottles stay separate, with their locations recorded, and their files are not merged. A bottle whose internal Wine drive mappings use absolute paths that would break after the move is not adopted automatically.

## Existing bottles

Each game's Runtime Settings offers **Environment**: **Private (MacLauncher)**, discovered CrossOver bottles, or **Choose…**. Discovery reads the configured bottle folder from the environment, CrossOver configuration or preferences, with the standard Bottles folder as the default. Published and stub bottles are excluded. Listing and current values are read offline.

A selection stores a path reference. The bottle stays in place and is not copied, adopted, recreated or removed. A missing or incomplete external bottle reports an error and is left in place. Removing a game leaves its external environment intact; a removal whose directory contains an external environment is refused.

CrossOver runs with the absolute bottle path, `--wait-children` and `--no-update`. Selected settings and translator files may change the bottle; profile mappings stay as supplied. Logs stay in MacLauncher's data. **Open Windows files** opens the selected bottle, and its Windows profiles are listed as alternate save locations.

Stop defaults to the launched game's processes. **Close All Applications** requires confirmation before asking the bottle's other Windows programs to close and forcing remaining programs to quit. Ordinary exit leaves the bottle's other programs running. A running wineserver is shown in the selector; MSync and High Resolution changes require it to stop.

## Runtime settings

Settings holds the defaults, and each game's Runtime Settings can override them. Settings and graphics choices that need Apple Silicon or a newer macOS than the Mac has are not listed.

| Setting | Behavior |
| --- | --- |
| Environment | Per-game private bottle or an existing bottle reference. |
| Graphics | Automatic, D3DMetal, DXMT, DXVK or WineD3D. Automatic keeps CrossOver's own choice. Availability depends on the application, Mac and macOS version. |
| Game temporal integration | Exposes MetalFX Temporal through a 64-bit game's DLSS integration. Listed for Unity and Windows games. See [Temporal upscaling](#temporal-upscaling). |
| DXMT support | The DXMT library version for FSR2/3 camera support. Automatic uses the default from Runtimes. |
| Synchronization | Automatic, MSync, ESync or Off. ESync is for older CrossOver versions; newer releases may not support it. |
| Language locale | An optional locale identifier, such as `ja_JP.UTF-8`. |
| Windows environment | Windows 10, Windows 11, Windows 7 or Windows XP, in a 64-bit bottle when the selected application includes one. Each choice uses its own bottle. |
| Windows executable | An optional relative path, for when automatic selection picks the wrong executable. |
| Enable BepInEx winhttp override | Opts in to `winhttp=n,b` for a game that already contains BepInEx's proxy DLL. Listed for Unity and Windows games. No mod, DLL or font is downloaded. Explicit Wine DLL overrides take precedence, including grouped entries such as `winhttp,wininet=b`. |
| Wine DLL overrides, environment variables, game arguments | Apply to the game process. MacLauncher sets the application and bottle paths itself. |
| Wine debug channels | Optional Wine channel filters, such as `-all` or `+seh`. |

The graphics and synchronization choices follow the [CrossOver Mac user guide](https://www.codeweavers.com/support/docs/crossover-mac/index). The BepInEx option follows BepInEx's [Wine instructions](https://docs.bepinex.dev/articles/advanced/proton_wine.html).

## Graphics

Each renderer has requirements of its own, separate from those of CrossOver's Wine. In CrossOver 26.3, DXMT requires macOS 14, and D3DMetal with its libraries requires Apple Silicon and macOS 15.4. MacLauncher reads the minimum macOS version that the installed renderer libraries declare, leaves renderers that cannot run on the Mac out of the **Graphics** choices, and checks the selection again before it creates the game's Windows environment. Automatic keeps CrossOver's own renderer choice, and WineD3D is offered regardless of these requirements. [System requirements](SYSTEM_REQUIREMENTS.md#windows-compatibility-runtimes) lists the related components.

Per-game ReShade effects use the shared [graphics pipeline](../graphics/SHARED_PROCESSING.md) with the selected CrossOver application, graphics backend and Windows environment. Effects switch while the game runs.

Shared graphics controls use private copies of CrossOver's small Wine loaders, prepared automatically with permission to load the graphics adapter. The copies keep the original loaders' other entitlements and are reused between launches. CrossOver's application, license files and installed libraries stay in place, and the game's existing bottle and saves are kept.

If the graphics loader cannot be prepared, the game runs with the selected vendor renderer and its existing bottle, without shared graphics effects for that launch. Saved graphics selections are kept.

Graphics providers must match the architecture of the native Wine process that runs the game. When CrossOver uses a separate Unix loader, that loader's architectures decide provider compatibility, not the Windows executable or the launcher. An Intel Wine process needs Intel-compatible graphics providers, including on Apple Silicon through Rosetta. Intel-only Wine components go through the usual [Rosetta](ROSETTA.md) check, even when the CrossOver app itself is universal.

### Temporal upscaling

**Game temporal integration** exposes MetalFX Temporal through a 64-bit game's DLSS integration. It requires Apple Silicon, matching NVAPI and NGX libraries, and either DXMT on macOS 14 or later or D3DMetal on macOS 26 or later. DLSS must be enabled in the game. Selecting a shared Temporal upscaling method also turns this integration on at launch. Renderers other than DXMT and D3DMetal do not supply these temporal inputs, and with Automatic graphics, CrossOver chooses the renderer. The option does not enable DLSS frame generation or ray reconstruction.

Enabled temporal rows in the Advanced graphics settings prepare the same game integration and dependencies as the Simple temporal settings. Disabled rows add no temporal requirements.

FSR2/3 temporal replacement also requires a supported Streamline interposer and a DXMT camera adapter matching the selected renderer's native library and Windows thunk. CrossOver uses this adapter only when DXMT is selected explicitly. The camera adapter is included with MacLauncher; the DXMT support libraries are separate. Compatible installed Wine support libraries are reused. Otherwise, Play downloads the matching Template support package and keeps only its DXMT libraries, with no additional Wine engine. **Runtimes → Graphics → Translators → DXMT** manages these libraries. CrossOver and Sikarugir share one set of installed versions and one default. Versions identify an upstream DXMT release or a Sikarugir Template component. Versions that earlier MacLauncher releases installed for CrossOver remain installed and are used from their existing folder. The version and default are independent of the selected CrossOver application, and the per-game **DXMT support** setting can override that default.

Preparation uses private copies of the game and loader. The private renderer selection turns off CrossOver's automatic DLL redirection for that launch and selects the matching DXMT libraries directly. Camera values are tied to the game's exact frame and viewport, and unsupported projections keep the game's original scaler.

A camera adapter, or the automatic in-game XeSS compatibility adaptation, that replaces a DLL beside the app uses a separate launch folder. Only the executable and selected DLLs are copied; other assets reference the originals. The working directory remains the original executable folder. Each adapter launch has its own folder, which is kept, so earlier private files are never removed or merged into the originals. Writes through the asset references reach the original files. Files that the game creates, or replaces atomically, relative to the adapted executable stay in that adapter folder, because DLL redirection cannot send them elsewhere, and they are kept there. Ordinary Play does not use that folder. If preparation fails, the original executable runs without the camera adaptation; independent shared effects can still use an available loader.

## Requirements

Wine's macOS window driver needs a graphical login session, so playback runs from the MacLauncher application; an SSH shell alone cannot supply that session. [NotProton](https://github.com/NotProtonNot/NotProton) shows a separate Steam integration. This backend uses CrossOver's own commands and modifies neither Steam nor CrossOver.

## Implementation

CrossOver is registered as a runtime provider. Module discovery adds its runtime metadata and settings to every detected game type without changing the detected engine, except for Android games, native Mac apps and games recorded inside a Mac app bundle. Offline detection records which Windows executable a game includes, or that it has none, using the shared search described in [Windows Game](../game-types/WINDOWS.md#windows-executables-in-other-game-types). The check that offers CrossOver for a game reads only that record, the recorded paths and the local application state, never the game's files, so its result does not change while they are unavailable. Engine-specific preparation and runtime-download hooks do not run for a selected provider.

Rosetta AVX advertisement is enabled by default and can be disabled in Runtime Settings. Language locale sets `LANG`, `LC_ALL` and `LC_MESSAGES`. Sikarugir launches under Rosetta also set `DOTNET_EnableWriteXorExecute=0`. CrossOver launches before version 25 receive the legacy graphics and ESync flags; later versions use the unified graphics selector and MSync.

Runtime Settings groups the basic launch choices separately from advanced Display, Input, Compatibility and Diagnostics controls. Display includes High Resolution (Retina), DPI, fullscreen capture, vertical sync and virtual desktops. Input controls map Option to Alt and Command to Ctrl and configure mouse capture. Registry settings apply to the selected Windows environment on the next launch; High Resolution and synchronization changes can require restarting its Windows programs.

Compatibility options include Rosetta AVX advertisement and per-engine controls: DXVK async, DXMT frame-rate presets and MetalFX spatial, D3DMetal frame limits and Metal 4, MoltenVK fast math, argument buffers and UE4 compatibility, and WineD3D configuration. Diagnostics offers Metal and DXVK HUDs and the Wine crash dialog. Engine options appear with the corresponding engine selection. Explicit environment entries override these controls.

Additional Windows versions include Windows 8.1, 8, Vista, XP 64-bit and Windows Server variants. CrossOver's per-launch Windows version changes the reported version within the current bottle. Existing Windows environment selections retain their separate storage locations.

For an existing environment, each setting defaults to **Bottle setting** with its current value read offline. **Custom setting** enables an override for that control. Registry-backed overrides write into the selected bottle; its original files and Windows environment remain in place.

| Control | Values and effect |
| --- | --- |
| High Resolution (Retina) | Runtime default, On or Off; On selects 192 DPI unless DPI is explicitly set. |
| DPI | A positive REG_DWORD integer; empty retains the current value. |
| Option as Alt, Command as Ctrl | Map both left and right modifier keys. |
| Mouse capture | Configure cursor confinement and DirectInput mouse warping. |
| Fullscreen display capture, Vertical sync | Runtime default, On or Off. |
| Virtual desktop | Positive WIDTHxHEIGHT dimensions, such as 1920x1080; off disables the desktop; empty uses the runtime default. |
| DXVK async | Runtime default, On or Off; takes effect in DXVK builds that implement async. |
| DXMT configuration | Runtime default or a 30, 60 or 120 FPS preset. |
| MetalFX spatial | Runtime default, On or Off for DXMT. |
| D3DMetal FPS limit | Runtime default, 30, 60, 120, 144 or 240 FPS. |
| D3DMetal Metal 4 | Runtime default, On or Off; takes effect in builds that implement Metal 4. |
| MoltenVK fast math, argument buffers, UE4 compatibility | Runtime default, On or Off; each changes its corresponding MoltenVK option. |
| WineD3D options | Comma-separated configuration, such as csmt=0x1,renderer=gl. |
| Metal Performance HUD | Runtime default, On or Off. |
| DXVK HUD | Runtime default, Off, FPS, Performance or Full. |
| Wine crash dialog | Runtime default, On or Off. |

Translator catalogs and local registration share the runtime storage used by Sikarugir. [Translator runtimes](TRANSLATORS.md) lists the publishers, component sources, notices and registration behavior. Installed CrossOver components are referenced in place and remain restricted to CrossOver launches.

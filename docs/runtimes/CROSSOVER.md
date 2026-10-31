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

Play creates a private Windows bottle and private game files in the game's launcher data directory, under `games/<gameId>/runtimes/crossover/`. Windows games can write settings or saves next to any asset, so the game folder is copied once, using filesystem copy-on-write cloning when available. Other filesystems need storage for a separate copy.

Relaunching checks source file metadata and reuses unchanged assets. An updated original replaces a private file only when the private file still matches the previous original, so saves, mod edits and private deletions stay intact. Newly added assets are copied, and files removed from the source stay in the private folder. Initial preparation records content hashes; later launches hash only files that may have changed. The CrossOver application is not modified.

Launch settings are checked before private game files or a new Windows environment are created. Each registered application and each Windows environment type gets its own bottle. Changing the selected application or Windows environment keeps the previous bottle, and selecting it again reuses that bottle.

Saves stored next to game files live in the shared private game folder, while saves stored in a bottle's Windows profile stay with that bottle. Windows profile folder aliases that point into the macOS Documents and Desktop folders are replaced with private directories. CrossOver has no universal save editor or save-location format, and engine save tools are unavailable while it is selected.

Stop ends the Wine processes in the game's private bottle. Canceling the initial preparation removes the incomplete environment so that Play can try again. Forgetting a game removes its private files and bottles. Application registrations are stored in `runtimes/crossover/registrations.json`.

## Runtime settings

Settings holds the defaults, and each game's Runtime Settings can override them. Settings and graphics choices that need Apple Silicon or a newer macOS than the Mac has are not listed.

| Setting | Behavior |
| --- | --- |
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

FSR2/3 temporal replacement also requires a supported Streamline interposer and a DXMT camera adapter matching the selected renderer's native library and Windows thunk. CrossOver uses this adapter only when DXMT is selected explicitly. The camera adapter is included with MacLauncher; the DXMT support libraries are separate. Compatible installed Wine support libraries are reused. Otherwise, Play downloads the matching Template support package and keeps only its DXMT libraries, with no additional Wine engine. **Runtimes → Graphics → DXMT support** manages these libraries. CrossOver and Sikarugir share one set of installed versions and one default. Each version is numbered after the Sikarugir Template release it comes from. Versions that earlier MacLauncher releases installed for CrossOver remain installed and are used from their existing folder. The version and default are independent of the selected CrossOver application, and the per-game **DXMT support** setting can override that default.

Preparation uses private copies of the game and loader. The private renderer selection turns off CrossOver's automatic DLL redirection for that launch and selects the matching DXMT libraries directly. Camera values are tied to the game's exact frame and viewport, and unsupported projections keep the game's original scaler.

Camera DLLs are prepared in a separate launch folder that references only the game's private files. Executables and affected files use copy-on-write clones. After Wine exits, saves, configuration and mod changes are carried back into the private game folder, including files replaced or moved during play, and conflicting files are kept separately. If preparation fails, the ordinary game folder remains available. A filesystem without the required cloning support runs the selected backend without the camera adapter. When the camera adapter is unavailable, independent shared effects can still use an available loader.

## Requirements

Wine's macOS window driver needs a graphical login session, so playback runs from the MacLauncher application; an SSH shell alone cannot supply that session. [NotProton](https://github.com/NotProtonNot/NotProton) shows a separate Steam integration. This backend uses CrossOver's own commands and modifies neither Steam nor CrossOver.

## Implementation

CrossOver is registered as a runtime provider. Module discovery adds its runtime metadata and settings to every detected game type without changing the detected engine, except for Android games, native Mac apps and games recorded inside a Mac app bundle. Offline detection records which Windows executable a game includes, or that it has none, using the shared search described in [Windows Game](../game-types/WINDOWS.md#windows-executables-in-other-game-types). The check that offers CrossOver for a game reads only that record, the recorded paths and the local application state, never the game's files, so its result does not change while they are unavailable. Engine-specific preparation and runtime-download hooks do not run for a selected provider.

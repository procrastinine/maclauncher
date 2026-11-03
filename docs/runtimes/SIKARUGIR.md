# Sikarugir (Wine)

Sikarugir runs compatible Windows games with downloaded [Sikarugir Wine engines](https://github.com/Sikarugir-App/Engines) and their matching support libraries. It is the default runtime for [Windows games](../game-types/WINDOWS.md) and is also offered for [other game types](../game-types/WINDOWS.md#windows-executables-in-other-game-types) whose files include a compatible x86 or x64 Windows executable, such as Ren'Py, RPG Maker, Unity and Godot releases for Windows. In game runtime selectors it appears as **Sikarugir (Wine)**. Setup uses the publisher's engine archives directly, without Creator, a wrapper application, Homebrew or a compiler. [CrossOver](CROSSOVER.md) is a separate choice for locally installed CrossOver applications.

## Requirements

A Wine version installed during Play comes with its matching support libraries, and Play prepares a private Windows environment for the game. Installation reads the minimum macOS version from the engine and support libraries; current engines require macOS 14 or later. Their native Wine binaries are Intel code that needs Rosetta on Apple Silicon; Play checks for it and offers to install it, as described in [Rosetta](ROSETTA.md).

The selected Wine version and graphics backend supply the Windows APIs. Windows libraries that a game requires remain part of that game's own environment.

## Versions

**Runtimes → Sikarugir** lists downloadable and installed versions and selects the global preferred version, which the inspector's **Version** selector can override for one game. [Release catalogs](RUNTIME_CATALOGS.md#sikarugir) describes how Refresh reads the publisher's versions.

Each version pairs a Wine engine with a Template, the publisher's package of support libraries. Engine and Template versions are recorded separately, with the exact downloaded files and their checksums. The publisher's rolling release tag is not the Wine version. Each installed engine stays selectable on its own. Installation finds the Wine bundle by its `bin/wine` and `bin/wineserver` files and the Template application by its `Contents/Frameworks` folder, so an archive that places them inside another folder installs in the same layout.

Templates keep their renderer packages in `Contents/SharedSupport/renderer` from version 1.0.24 on and in `Contents/Frameworks/renderer` before that. Installation looks in the folder that matches the Template version first and then in the other one; if neither exists, it searches the Template's contents and records where the renderers are. MacLauncher installs the renderers in the same layout whichever folder they came from, and records each component's native-library requirements for the graphics capability checks.

Refresh lists every compatible engine that the publisher offers, each paired with the newest compatible Template. Automatic selection uses the newest listed engine, which also takes the place of a saved choice that is neither listed nor installed. An engine or Template counts as a separate version when its checksum differs or, if the publisher states no checksum, when its listed size or asset differs. A newer Template or a replaced archive therefore adds versions, and installed ones stay selectable. [Runtime release catalogs](RUNTIME_CATALOGS.md#sikarugir) describes how archives are recognized and checked. **Install** can replace an incomplete installation of the same version, and Play offers the same repair through its download prompt. The replacement is assembled in a separate folder before it takes the place of the installed runtime, and each game's private files and Windows environment are kept.

## Private game files and prefixes

Ordinary Play uses the original Windows executable, game assets and executable folder as its working directory. It makes no copy of the game or folder of links to it, and it does not read, update or remove the private game folders of earlier MacLauncher versions. Portable saves and configuration remain at their original paths.

Files in the private `game/` folders of earlier MacLauncher releases are recovered once into the original game folders, as [Earlier private game folders](../library/GAME_PREPARATION.md#earlier-private-game-folders) describes. Missing files are restored, and a version that differs from the original is kept beside it as a conflict copy. Earlier `temporal-camera` and `temporal-original` folders with proxy or asset-link records are kept for separate recovery. This recovery does not run during Play, import or upkeep, and it removes no Wine prefixes or bottles.

The Windows environment is a Wine prefix. Each game and Windows-version setting has one private prefix under `prefixes/`, independent of the selected engine version, installation path or package checksum. Runtime updates and reinstalls keep that prefix and its saves. Graphics loader views remain keyed to the runtime and renderer components separately. Wine accepts the original Unix executable path directly. A long path uses one short Windows drive mapping to the original game folder, preserving Windows path-length compatibility without copying game data. Existing mappings are kept; a conflicting older mapping uses another free drive letter. Windows profile directories, the home folder and temporary files are stored inside the prefix.

After an upgrade, the earlier prefix that the game last used, as recorded, is adopted once at the game's stable Windows-version path. Without that record, the prefix with the newest registry or marker timestamp is adopted; when usage is unknown or tied, the prefixes stay where they are for manual resolution. A prefix already at the stable path takes precedence. Other earlier prefixes stay separate, with their locations recorded, and their files are not merged. A prefix whose internal Wine drive mappings use absolute paths that would break after the move is not adopted automatically.

The shared installed engines stay unchanged. Private runtime views select the renderer libraries for each game: they copy the engine's small Wine loader files and share the installed libraries. Missing renderer DLLs are linked into the prefix after preparation. Renderer changes retain existing prefix files and game-supplied libraries.

Stop ends the Wine processes belonging to the selected prefix. Removing a game from the library removes the Windows environments that MacLauncher created for it and leaves the original game files alone.

### Saves

Save tools use the original game folder as the primary location and list the selected prefix's Windows profile as an alternate. There is no universal Windows save editor or cheat integration. Recognized engines retain optional source and asset tools; engine-specific save codecs remain disabled while Sikarugir is selected.

## Runtime settings

Settings holds the defaults, and each game's Runtime Settings can override them. Settings and graphics choices that need Apple Silicon or a newer macOS than the Mac has are not listed.

| Setting | Behavior |
| --- | --- |
| Graphics | Automatic, DXMT, DXVK, D3DMetal or WineD3D. Availability depends on the selected engine, Mac and macOS version. |
| Game temporal integration | Exposes MetalFX Temporal through a compatible 64-bit game's DLSS integration. Listed for Unity and Windows games. See [Game temporal integration](#game-temporal-integration). |
| DXMT support | The DXMT library version for FSR2/3 camera support. Automatic uses the default from Runtimes. |
| Vulkan driver | Automatic, MoltenVK or KosmicKrisp. Applies to Vulkan graphics, separately from the Direct3D renderer. |
| DirectDraw compatibility | The optional CNC-DDraw wrapper for 32-bit games with a software DirectDraw renderer. Off by default and independent of the Direct3D settings. |
| Synchronization | Automatic, MSync or Off. MSync requires support in the selected engine. |
| Language locale | An optional locale, such as `ja_JP.UTF-8` or `en_US.UTF-8`. |
| Windows version | Windows 10, 11, 7 or XP compatibility. |
| Windows executable | An optional relative path inside the game folder. |
| Wine DLL overrides | One `library=order` entry per line, such as `winhttp=n,b`. |
| Environment variables | One `NAME=value` entry per line. MacLauncher sets the runtime and private Windows paths itself. |
| Game arguments | One argument per line. |
| Wine debug channels | Optional Wine channel filters, such as `-all` or `+seh`. |

The optional **Enable BepInEx winhttp override**, listed for Unity and Windows games, loads a `winhttp.dll` that the game already supplies before Wine's built-in library. It does not install BepInEx, mods or DLLs, and explicit DLL overrides take precedence. The [BepInEx Wine guide](https://docs.bepinex.dev/articles/advanced/proton_wine.html) describes this setting.

## Graphics

Per-game ReShade effects use the shared [graphics pipeline](../graphics/SHARED_PROCESSING.md) with the selected Wine version, graphics backend and Windows environment. Effects switch while the game runs, and the shared Wine installation stays unchanged.

With **Automatic** graphics, Direct3D 10 and 11 use DXMT. On a confirmed physical Apple M-series GPU with macOS 26 or later, Automatic enables KosmicKrisp, and Direct3D 8 and 9 use D9VK. Virtual or unrecognized GPUs, and older systems, use WineD3D for Direct3D 8 and 9 and MoltenVK for Vulkan.

The Vulkan driver is chosen separately from the Direct3D renderer and also applies to games that use Vulkan directly. Automatic prefers KosmicKrisp when its macOS, architecture and physical GPU checks pass, and uses MoltenVK otherwise. An explicit graphics choice without matching runtime components reports its requirements and is never changed silently.

Installation identifies the renderers supplied by the selected Template and records their component version labels and minimum macOS versions. Platform API requirements and the installed native dependencies determine each renderer's minimum independently of the Wine engine.

| Component | Supplied by | Requirements and role |
| --- | --- | --- |
| DXMT | The Template's DXMT libraries | macOS 14 or the libraries' higher minimum; Direct3D 10/11 to Metal. |
| DXVK / D9VK | The Template's DXVK, DXVK3 and D9VK libraries | Direct3D to Vulkan. MoltenVK uses the older Direct3D 10/11 profile; KosmicKrisp uses the newer profile when supplied and supported. |
| MoltenVK | The Template's Vulkan libraries | Vulkan-to-Metal driver; minimum macOS read from the installed libraries. |
| KosmicKrisp | The Template's Vulkan libraries | Vulkan-to-Metal driver; Apple Silicon and macOS 26 or the libraries' higher minimum. |
| D3DMetal | The Template's D3DMetal framework and dependencies | Apple Silicon and 64-bit Windows games; minimum macOS follows the installed framework and dependencies. Direct3D 11/12 to Metal. |
| WineD3D | Selected Wine engine | Wine's built-in Direct3D translation. |
| CNC-DDraw | The Template's optional DirectDraw wrapper | Software DirectDraw compatibility for 32-bit Windows games; uses installed libraries without another download. |

### Game temporal integration

**Game temporal integration** exposes MetalFX Temporal through a compatible 64-bit game's DLSS integration. It requires Apple Silicon and the selected package's NVAPI and NGX libraries. The DXMT path requires macOS 14 or later; the D3DMetal temporal path requires macOS 26 or later. Native dependencies can raise either minimum. The game's own DLSS setting activates the integration, and selecting a shared Temporal upscaling method also turns it on at launch.

The option is off by default. It uses the selected renderer's existing MetalFX integration without modifying the game's DLLs. DXMT's vendor libraries are selected when this option or a shared temporal upscaler is enabled. A shared temporal selection can replace the exposed MetalFX operation with another available Metal implementation. The option does not enable DLSS frame generation or ray reconstruction, and the common ReShade effects remain available whether or not the game supports DLSS.

Enabled temporal rows in the Advanced graphics settings prepare the same game integration and dependencies as the Simple temporal settings. Disabled rows add no temporal requirements.

D3DMetal also needs a Wine engine with the path conversion functions used to expose the NGX libraries to games, and Wine 10 lacks them. MacLauncher checks the selected engine before launch; DXMT remains available for DLSS with compatible Wine 10 packages. This requirement does not affect ordinary D3DMetal rendering.

### FSR2/3 camera support

FSR2/3 camera support also requires a compatible Streamline interposer and a camera adapter matching the selected DXMT native library and Windows thunk. The camera adapter is included with MacLauncher. Preparation adds the matched libraries and Streamline adapter only to the optional camera launch folder. The original interposer stays next to its proxy for normal plugin lookup, with its complete export interface. Camera constants are matched to the exact frame, viewport and queued depth and motion textures, and unsupported projections keep the game's original scaler. Turning on game temporal integration before launch also prepares camera support for live changes of the temporal method.

**Runtimes → Graphics → DXMT support** manages compatible library versions separately from the Wine engine. Sikarugir and CrossOver share one set of installed versions and one default. Each version is numbered after the Sikarugir Template release it comes from. Compatible installed libraries are reused, and missing support libraries are downloaded when FSR2/3 is selected. The per-game **DXMT support** setting can override the runtime default without changing the selected engine or its other support libraries.

A camera adapter, or the automatic in-game XeSS compatibility adapter, that needs a DLL beside the app uses a separate launch folder containing copies of only the executable and selected DLLs; other assets reference the originals. The working directory remains the original executable folder. Files that the game creates, or replaces atomically, relative to the executable can stay in that adapter folder, which is kept. When an adapter folder is no longer used, original resources are never deleted, renamed or replaced, and earlier adapter folders stay intact. Ordinary Play bypasses these folders. If adapter preparation fails, the original executable runs with the selected backend and other available effects.

## Licenses

Wine is licensed under LGPL-2.1-or-later. The matching renderer and support-library notices stay with each installation, and the Template contains components under several different licenses. [Attributions](../ATTRIBUTIONS.md) and [upstream sources](UPSTREAMS.md#sikarugir) list their sources and download records.

D3DMetal is Apple's proprietary Direct3D 11/12 component for compatible Apple Silicon systems and 64-bit Windows games. Its download keeps the [Game Porting Toolkit license](https://github.com/Sikarugir-App/Sikarugir/blob/main/D3DMetal/4.0/License.pdf), which limits use to developing, testing or evaluating games on Apple products and allows redistribution only for non-commercial purposes under its terms. That license is separate from the open-source Wine and graphics component licenses.

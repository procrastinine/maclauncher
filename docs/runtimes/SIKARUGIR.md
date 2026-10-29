# Sikarugir (Wine)

Sikarugir runs compatible Windows games using managed
[Sikarugir Wine engines](https://github.com/Sikarugir-App/Engines) and their matching
support libraries. Runtimes → Sikarugir lists downloadable and installed versions;
the player is labeled **Sikarugir (Wine)**. Setup uses the publisher's engine
archives directly, without Creator, a wrapper application, Homebrew or a compiler.
[CrossOver](CROSSOVER.md) remains a separate choice for local CrossOver applications.

## Import and Play

Import accepts complete Windows game folders and `.exe` files.
Generic Windows games default to Sikarugir. Recognized engines retain their usual
default and also offer Sikarugir when a valid x86/x64 Windows executable is present.
A generic folder import requires one valid top-level Windows executable;
selecting an individual executable identifies the game in folders with several. Native macOS apps and
Linux exports retain their own backends.

Play asks before a missing runtime download, installs its matching libraries and
prepares a private Windows environment automatically. Current managed engines
require macOS 14 or later. Their native Wine binaries are Intel and require
Rosetta on Apple Silicon; the launcher handles the
Rosetta check and consent. Installed versions work without another catalog request
or download. The selected Wine version and graphics backend supply the Windows APIs; required
Windows libraries remain part of the game’s runtime environment.

## Versions and storage

Runtimes → Sikarugir selects the global preferred version; the inspector's Version
selector overrides it for one game. Refresh fetches the publisher's version list
only after an explicit action. Wine engine versions and supporting Template
versions are recorded separately, with exact artifact identities and checksums.
The publisher's rolling release tag is not the Wine version. Each installed
engine remains selectable independently.

Automatic selection uses Wine 10.0 revision 8 with Template 1.0.21. Wine 11.0
revision 1 remains available for explicit version selection. Refresh can
discover newer compatible publisher archives. Different
engine or Template checksums create distinct version identities, preserving
existing installations rather than replacing their files.

Play creates a persistent writable game copy under
`games/<game-id>/runtimes/sikarugir/game/`, using filesystem cloning where available.
Other filesystems require storage for a separate copy. Source updates refresh
untouched private assets while preserving saves, mods and private deletions;
files removed from the original remain in the private copy. Original files remain
unchanged.

Each prefix maps the private game copy to a short Windows drive path (`G:`),
avoiding long macOS library paths in Windows executable and asset paths.

Each Wine engine and Windows-version setting has a separate private prefix under
`prefixes/`. Changing graphics keeps that prefix and its saves. Shared installed
engines remain unchanged; private runtime views select renderer libraries for
each game. These views copy the engine's small Wine loader files, preserving
separate loaders and their required memory layouts, and share the installed
libraries. Windows profile directories, Home and temporary files use private
storage. Stop terminates Wine processes belonging to the selected game's prefix.
Forgetting the game removes its owned environments and private game files.
Missing renderer DLLs are linked into the private Windows environment after
preparation. Changing the renderer updates these managed links while preserving
existing prefix files and game-supplied libraries.

Save tools expose the private game copy and the selected Wine environment's
private Windows profile folders. Snapshots exclude the Windows runtime-library
tree and mappings to external files. There is no
universal Windows save editor or cheat integration. Recognized engines retain
their optional source and asset tools, with engine-specific save codecs disabled
while Sikarugir is selected.

## Runtime Settings

Settings provides defaults; an inspector's Runtime Settings overrides them for
that game.

| Setting | Behavior |
| --- | --- |
| Graphics | Automatic, DXMT, DXVK, D3DMetal or WineD3D. Availability depends on the selected engine, Mac and macOS version. |
| Game temporal integration | Exposes MetalFX Temporal through a compatible 64-bit game's DLSS integration. Requires Apple Silicon and the selected package's NVAPI/NGX libraries. DXMT requires macOS 14 or later; D3DMetal requires macOS 26 or later. The game’s DLSS setting activates the integration. Selecting a shared Temporal upscaling method also enables it at launch. |
| Vulkan driver | Automatic, MoltenVK or KosmicKrisp; applies to Vulkan graphics, separately from the Direct3D renderer. |
| DirectDraw compatibility | Optional CNC-DDraw wrapper for 32-bit games with a software DirectDraw renderer. Disabled by default; independent of Direct3D settings. |
| Synchronization | Automatic, MSync or Off. MSync requires support in the selected engine. |
| Language locale | Optional locale such as `ja_JP.UTF-8` or `en_US.UTF-8`. |
| Windows version | Windows 10, 11, 7 or XP compatibility setting. |
| Windows executable | Optional relative path inside the game folder. |
| Wine DLL overrides | One `library=order` entry per line, such as `winhttp=n,b`. |
| Environment variables | One `NAME=value` entry per line; runtime and private Windows paths are managed automatically. |
| Game arguments | One argument per line. |
| Wine debug channels | Optional Wine channel filters, such as `-all` or `+seh`. |

The optional **Enable BepInEx winhttp override** loads an existing game-supplied
`winhttp.dll` before Wine's built-in library. It does not install BepInEx, mods or
DLLs. Explicit DLL overrides take precedence. The
[BepInEx Wine guide](https://docs.bepinex.dev/articles/advanced/proton_wine.html)
describes this setting.

## Graphics and licenses

Per-game ReShade effects use the shared [graphics pipeline](GRAPHICS.md) with the
selected Wine version, graphics backend and Windows environment. Effects switch
live while saves and the shared Wine installation remain unchanged.

Automatic uses DXMT for Direct3D 10/11. A confirmed physical Apple M-series GPU
with macOS 26 or later enables KosmicKrisp and D9VK for Direct3D 8/9. Virtual or
unrecognized GPUs, and older systems, select MoltenVK for Vulkan and WineD3D for
Direct3D 8/9.

Game temporal integration remains off by default. It uses the selected renderer's
existing MetalFX integration without modifying imported game DLLs. DXMT's vendor libraries
are selected when this option or a shared temporal upscaler is enabled. Shared
temporal selection can replace the exposed MetalFX operation with another available
Metal implementation. It does not enable DLSS frame generation or ray reconstruction.
Common ReShade effects remain available independently of the game's DLSS support.
Enabled temporal rows in Advanced prepare the same game integration and
dependencies as Simple temporal settings. Disabled rows add no temporal demand.

FSR2/3 camera support additionally requires a compatible Streamline interposer
and a camera adapter matching the selected DXMT native library and Windows
thunk. Preparation adds the matched closure and Streamline adapter to the game's
private files. The original interposer remains beside its proxy for normal plugin
lookup; its complete export interface is preserved. Camera constants are matched
to the exact frame, viewport and queued depth/motion textures. Unsupported
projections retain the game's original scaler. Enabling game temporal integration
before launch also prepares camera support for live temporal-method changes.
Runtimes → Sikarugir → DXMT support manages compatible library versions
separately from the Wine engine. Compatible installed libraries are reused;
missing support libraries download after consent when FSR2/3 is selected.
The camera adapter is included with MacLauncher. The per-game DXMT support setting can override the runtime default without
changing the selected engine or its other support libraries.
Camera DLLs use a separate launch folder with copy-on-write files and references
to the game's private assets. Preparation failure leaves the ordinary game
folder available and starts the selected backend without the camera bridge.
Saves, configuration and mod changes are preserved after Wine finishes;
conflicting files are retained separately. Saved graphics choices and other
effects remain available. A filesystem without the required cloning support
uses the selected backend without the camera adapter.

D3DMetal also needs a Wine engine with the path conversion functions used to
expose NGX libraries to games. Wine 10 lacks these functions. MacLauncher checks
the selected engine before launch; DXMT remains available for DLSS with compatible
Wine 10 packages. This requirement does not affect ordinary D3DMetal rendering.

| Component | Current package | Requirements and role |
| --- | --- | --- |
| DXMT | Publisher label `v0.80-244-g7c8dee1`; 64-bit D3D11 build `v0.80-250-g427228c` | macOS 14 or later; Direct3D 10/11 to Metal. |
| DXVK / D9VK | macOS variants `1.10.3`, `2.3` and `3.1.1-async` | Direct3D to Vulkan. MoltenVK uses the older Direct3D 10/11 profile; KosmicKrisp uses the newer profile. |
| MoltenVK | `1.4.1` | Vulkan-to-Metal driver; available with the macOS 14 base runtime. |
| KosmicKrisp | Mesa `26.3.0-devel`, Git `063dfaeec5` | Vulkan-to-Metal driver; Apple Silicon and macOS 26 or later. |
| D3DMetal | `4.0b2` | Apple Silicon, macOS 26.4 or later and 64-bit Windows games; Direct3D 11/12 to Metal. |
| WineD3D | Selected Wine engine | Wine's built-in Direct3D translation. |
| CNC-DDraw | `7.1.0.0` | Optional software DirectDraw compatibility for 32-bit Windows games; uses installed libraries without another download. |

The Vulkan driver is separate from the Direct3D renderer. Automatic prefers
KosmicKrisp when its macOS, architecture and physical GPU checks pass, otherwise
MoltenVK. This driver choice also applies
to games using Vulkan directly. Explicit graphics choices without matching runtime components report
their requirements instead of silently changing the selection.

D3DMetal is Apple's proprietary Direct3D 11/12 component for compatible Apple
Silicon systems and 64-bit Windows games. Its download retains the
[Game Porting Toolkit license](https://github.com/Sikarugir-App/Sikarugir/blob/main/D3DMetal/4.0/License.pdf),
which limits use to developing, testing or evaluating games on Apple products
and permits redistribution only for non-commercial purposes under its terms.
It is separate from the open-source Wine and graphics component licenses.

Wine uses LGPL-2.1-or-later. Matching renderer and support-library notices remain
with each installation; the Template contains components with different licenses.
[Attributions](../ATTRIBUTIONS.md) and [upstream identities](../UPSTREAMS.md)
describe their source and artifact records.

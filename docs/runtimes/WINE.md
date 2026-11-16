# Wine runtimes

MacLauncher runs [Windows games](../game-types/WINDOWS.md), and the compatible Windows executables of other game types, through Wine. Each Wine source is a separate choice in the game's runtime selector with its own tab in **Runtimes**:

| Source | Runtime selector | Origin | Delivery |
| --- | --- | --- | --- |
| [Sikarugir](SIKARUGIR.md) | **Sikarugir** | Sikarugir Wine engines with their Templates | Downloaded after consent; the default for Windows games |
| [CrossOver](CROSSOVER.md) | **CrossOver** | CodeWeavers' CrossOver application | Registered from an installed, licensed application; never downloaded |
| [WineCX](WINECX.md) | **WineCX** | dappermint's winecx-gptk runtime: CodeWeavers' CrossOver Wine changes on a current Wine release | Downloaded after consent |
| MetalSharp Wine | **MetalSharp Wine** | The signed arm64 MetalSharp Wine application from metalsharp/MetalSharp-Wine, with its FEX x86 translation | Downloaded after consent |
| Highball Wine | **Highball Wine** | Highball engine releases from gauthierpiarrette/highball-engine: Intel builds, and arm64 builds that run through the installed Highball application's signed Wine loader | Downloaded after consent; arm64 builds only while Highball is installed |

The sources share one Wine layer, so its settings, translator choices, graphics effects, DLSS support, Steam client bridge and private Windows environments work the same way with each of them. The page for each source covers only what differs: where its Wine tree comes from, how its versions are listed and installed, and the kind of existing environment it can use.

## Shared behavior

### .NET and XNA

Wine Mono runs .NET Framework programs and provides its FNA-based XNA assemblies. Play maps the selected Wine engine's shared data directory to a short Windows drive path, and Mono finds its files through that mapping even when the launcher data folder or the graphics loader path is longer than Windows `MAX_PATH`. The runtime files stay where they were installed.

### Settings

**Settings** holds one set of Wine defaults for each source, and each game's Runtime Settings can override them. Every source has the same controls: Direct3D engine and per-API translators, Vulkan driver, video codecs, game temporal integration, synchronization, language locale, Windows version, executable, DLL overrides, arguments, debug channels, the BepInEx `winhttp` override, and the Display, Input, Compatibility and Diagnostics groups. [Sikarugir runtime settings](SIKARUGIR.md#runtime-settings) lists each control and its values. Two sources add a control of their own. CrossOver adds its bottle type, which also selects the bottle that holds the game's saves, and Sikarugir adds DirectDraw compatibility through the CNC-DDraw wrapper in its Template.

### Translators

The translator versions installed in **Runtimes → Graphics** work with every source. The translators that a source ships itself are listed as Included rows labeled with that source's name. [Graphics translators](TRANSLATORS.md) describes how translators are selected, loaded and replaced when one cannot run.

### Private and existing environments

Play prepares a private Windows environment for each game from the game's original files, with a separate environment for each source and Windows version. An environment does not depend on the source's version, installation path or package checksum, so it survives updates and reinstalls together with its saves. Removing a game from the library removes the environments that MacLauncher created for it and leaves the game files alone.

A CrossOver bottle or a Sikarugir wrapper that already exists can be used instead of a private environment. MacLauncher never deletes, recreates, moves or replaces such an environment.

### Graphics

MacLauncher's [graphics effects](../graphics/SHARED_PROCESSING.md), MetalFX through a game's DLSS integration, the [FidelityFX API adapter](CROSSOVER.md#fidelityfx-api-adapter), and DLSS forwarding with DXVK and vkd3d-proton work with every source. None of them modifies the installed Wine tree. Instead, each game runs from a private [graphics view](TRANSLATORS.md#installed-versions-and-links) that holds the libraries selected for it.

### Game Mode and local network access

Sikarugir and WineCX games run their Wine loader from a private application bundle in the games category (`LSApplicationCategoryType` `public.app-category.games`). macOS uses that category to turn on Game Mode for a game that is in full screen and is the frontmost application. Because macOS associates a process with a bundle only when the process starts from the bundle's own `Contents/MacOS` path, the bundle contains the loader and `ntdll.so` files themselves, and the game's Windows programs start from there. The bundle keeps the loader's own application properties together with the source's identifier, and it sits beside the private Wine files in the game's graphics view. CrossOver games run from CrossOver's own loader instead, which declares no category. MacLauncher itself declares the entertainment category (`public.app-category.entertainment`), so the launcher window never turns on Game Mode.

WineCX's Wine, like CrossOver's, would start each program from a link named after the program in the user's temporary folder (`winetemp-…`), and that link belongs to no bundle. For the bundled loader, a file occupies that folder's name, so its programs stay in the bundle; each process still carries its program's name.

macOS attributes local network access by a bundled process to the bundle's identifier. MacLauncher uses one identifier per Wine source, `com.maclauncher.wine-game.sikarugir` and `com.maclauncher.wine-game.winecx`, so on macOS 15 and later the system asks once per source. Its request shows the bundle's `NSLocalNetworkUsageDescription` text, which names the source, as in "Windows games that MacLauncher starts with Sikarugir use the local network to find and join games, players and devices nearby." The answer is kept under Privacy & Security > Local Network in System Settings and covers every game and Wine version of that source. Rebuilding the bundle keeps the identifier, and with it the answer. Game Mode depends only on the category, so the identifier has no effect on it.

Until the request is answered, the game's local network operations wait. These are `.local` name lookups, Bonjour browsing, broadcast and multicast, and connections to addresses on the local network; Internet names and loopback connections do not count as local network access. Starting a game never waits on the request, however. Wine's session for the prefix (its boot program, which looks up the Mac's `.local` name, and its service processes) and the registry tool used before Play start from the engine's own loader outside the bundle, and the game then joins the running session from the bundle.

The game's **Network access** setting applies in addition to the macOS answer. While it is off, [network isolation](NETWORK_ISOLATION.md) blocks the game's local-network connections whatever the answer was.

### Steam

[Windows Steam games](WINDOWS_STEAM.md) describes the optional bridge to the Steam client for Mac. It runs the game in the game's own Windows environment and writes only Steam registry keys there.

## Sources declared by their data file

Each Wine source is a data file in `src/runtime-sources/wine`, and every such file is a runtime of the Windows module. A source with no adapter of its own, such as MetalSharp Wine and Highball Wine, is served entirely from its file:

- Its releases are the GitHub releases of `upstream.github` with an asset matching one of the `upstream.assets` patterns. The pattern's key names the CPU of that download, and the release version starts at the first dotted number of the tag.
- A download is verified against the publisher's SHA-256: the checksum file published beside the archive (`<archive>.sha256` or `SHA256SUMS`), otherwise the digest GitHub lists for the asset.
- The Wine tree is found by its files: the folder holding `lib/wine` with a `wine` executable in `bin`, or in `MacOS` inside an application. Nothing in the download is moved or rewritten, so a signed application keeps its signature.
- `upstream.app` names, per CPU, an application executable that builds for that CPU run through, relative to the Applications folder. Such a build is offered and usable only while that application is installed; its Wine tree's Unix loader (`lib/wine/aarch64-unix/wine` for arm64) is a link to that executable, which is where Wine looks for it.
- Included components (`included`) are paths in the Wine tree. An included CPU translator, such as FEX, is loaded by that Wine itself.
- A loader that its publisher signed inside an application bundle holding a provisioning profile (`Contents/embedded.provisionprofile`), as MetalSharp Wine's loaders are, runs from that bundle: the game's Wine view links it instead of copying it, because macOS ends a copy of a loader whose restricted entitlements need that profile. Such a loader runs with the hardened runtime, and dyld ignores `DYLD_INSERT_LIBRARIES` for it unless its entitlements include `com.apple.security.cs.allow-dyld-environment-variables`. MacLauncher reads that from the loader's code signature once per installed loader file. When the loader refuses the variable but loads libraries without library validation (`com.apple.security.cs.disable-library-validation`), and its ntdll reads `DXMT_RUNTIME_DIR`, as MetalSharp Wine's does, the graphics layer loads inside the game's process through the runtime's Metal library. The Wine view holds a `graphics-runtime` folder with links to every file in the Windows folders of the runtime's `lib/mullion`, the runtime's own `aarch64-unix/winemetal.so` as `winemetal-runtime.so`, and a copy of the graphics component's `maclauncher-winemetal.so` as `winemetal.so`. That library re-exports the runtime's own and opens the graphics layer named in `MACLAUNCHER_GRAPHICS_LIBRARIES`. dyld applies a library's `__interpose` pairs only to libraries inserted at launch, so the library applies the graphics layer's pairs itself: in every image loaded before or after it outside the dyld shared cache, apart from the graphics layer, the symbol pointers to each original function are rewritten to its replacement. The Wine Mac driver's `CGWarpMouseCursorPosition` calls, for example, reach the pointer mapping of a [virtual window](../graphics/FRAME_API.md#virtual-windows) as they do through `DYLD_INSERT_LIBRARIES`. Play sets `DXMT_RUNTIME_DIR` to the folder and starts the game without a private copy of the Wine launcher. When the loader refuses both, or the graphics component has no `maclauncher-winemetal.so`, MacLauncher's graphics layer (effects, live controls and screenshots) does not run in its games: the game's settings leave out the Graphics section, and Play starts the game with its original rendering, without a private copy of the Wine launcher, and records that graphics processing is unavailable.

Removing a source's file removes its runtime.

## What each source supplies

Which features a source can offer depends on its installed Wine tree. When a version is installed, MacLauncher reads these capabilities from the tree's binaries and plists, so the source's name and version number do not decide them:

| Capability | Read from | Effect |
| --- | --- | --- |
| Wine version | The version string in `ntdll.so` | Version labels and the Wine version recorded for each prefix |
| Minimum macOS | The deployment target of every native image | Installation stops on an older macOS, and an installed version that needs a newer one is listed as unavailable |
| MSync, ESync | The variables that `wineserver` reads | The **Synchronization** values that are offered |
| CrossOver graphics selector | `CX_GRAPHICS_BACKEND` in `ntdll.so` | When present, the source chooses among its own Direct3D engines; without it, MacLauncher places the selected libraries |
| Vulkan library selector | `CX_LIBVULKAN` in `winevulkan.so` or `win32u.so` | The selected Vulkan driver is also named through this variable, which these Wine builds read only while the WineD3D backend is active. The library link under the name that Wine opens applies with every backend. |
| D3DMetal bridge | `CX_APPLEGPTK_LIBD3DSHARED_PATH` in `ntdll.so` | A D3DMetal version from Runtimes can load in a source that does not include one |
| Reported graphics adapter | `D3DM_VENDOR_ID` in `win32u.so` | While D3DMetal performs a game's DLSS through [game temporal integration](SIKARUGIR.md#game-temporal-integration), the game sees an NVIDIA GeForce RTX 4090 adapter and therefore offers DLSS. `D3DM_VENDOR_ID`, `D3DM_DEVICE_ID` and `D3DM_DEVICE_DESCRIPTION` set in the [environment variables](TRANSLATOR_ENVIRONMENT.md) replace these values. |

The Wine trees of Sikarugir and WineCX run as Intel (x86-64) processes, which need Rosetta on Apple Silicon. For CrossOver, the loader's architecture is read from the registered application.

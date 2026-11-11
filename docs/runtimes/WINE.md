# Wine runtimes

MacLauncher runs [Windows games](../game-types/WINDOWS.md) and the compatible Windows executables of other game types through Wine. Three Wine sources are offered, and each one is a separate choice in the game's runtime selector and its own tab in **Runtimes**:

| Source | Runtime selector | Origin | Delivery |
| --- | --- | --- | --- |
| [Sikarugir](SIKARUGIR.md) | **Sikarugir (Wine)** | Sikarugir Wine engines with their Templates | Downloaded after consent; the default for Windows games |
| [CrossOver](CROSSOVER.md) | **CrossOver** | CodeWeavers' CrossOver application | Registered from an installed, licensed application; never downloaded |
| [WineCX](WINECX.md) | **WineCX (Wine)** | dappermint's winecx-gptk runtime: CodeWeavers' CrossOver Wine changes on a current Wine release | Downloaded after consent |

All three use one Wine layer. Its settings, translator choices, graphics effects, DLSS routing, Steam client bridge and private Windows environments work the same way for each source. The source pages describe only what differs: where the Wine tree comes from, how its versions are listed and installed, and the source's own environment kind.

## Shared behavior

- **Settings.** **Settings** holds one set of Wine defaults for each source, and each game's Runtime Settings can override them. The controls are the same for every source: Direct3D engine and per-API translators, Vulkan driver, video codecs, game temporal integration, synchronization, language locale, Windows version, executable, DLL overrides, arguments, debug channels, the BepInEx `winhttp` override, and the Display, Input, Compatibility and Diagnostics groups. [Sikarugir runtime settings](SIKARUGIR.md#runtime-settings) lists each control and its values. CrossOver adds its bottle type, which also selects the bottle that holds the game's saves, and Sikarugir adds DirectDraw compatibility through its Template's CNC-DDraw wrapper.
- **Translators.** The translator versions installed in **Runtimes → Graphics** serve every source, and each source's own translators are listed as Included rows labeled with that source. [Graphics translators](TRANSLATORS.md) describes their selection, loading and fallback.
- **Private environments.** Play prepares a private Windows environment for each game from its original files, keyed to the source and the Windows version. Environments do not depend on the source's version, installation path or package checksum, so updates and reinstalls keep them and their saves. Removing a game from the library removes the environments that MacLauncher created for it and leaves the game files alone.
- **Existing environments.** A CrossOver bottle or a Sikarugir wrapper that already exists can be used instead of a private environment. MacLauncher never deletes, recreates, moves or replaces it.
- **Graphics.** MacLauncher's [graphics effects](../graphics/SHARED_PROCESSING.md), MetalFX through a game's DLSS integration, and DLSS forwarding with DXVK and vkd3d-proton apply with every source. The installed Wine tree stays unchanged; private graphics views select the libraries for each game.
- **Steam.** [Windows Steam games](WINDOWS_STEAM.md) describes the optional bridge to the Steam client for Mac. It runs the game in its own Windows environment and writes only Steam registry keys there.

## What each source supplies

The installed Wine tree determines which features a source can offer. Installation reads these capabilities from its binaries and plists rather than from its name or version:

| Capability | Read from | Effect |
| --- | --- | --- |
| Wine version | The version string in `ntdll.so` | Version labels and the prefix's Wine identity |
| Minimum macOS | The deployment target of every native image | Installation stops on an older macOS, and an installed version that needs a newer one is listed as unavailable |
| MSync, ESync | The variables that `wineserver` reads | The **Synchronization** values that are offered |
| CrossOver graphics selector | `CX_GRAPHICS_BACKEND` in `ntdll.so` | The source chooses among its own Direct3D engines; otherwise MacLauncher places the selected libraries |
| Vulkan library selector | `CX_LIBVULKAN` in `winevulkan.so` or `win32u.so` | The selected Vulkan driver is named through the variable instead of a library link |
| D3DMetal bridge | `CX_APPLEGPTK_LIBD3DSHARED_PATH` in `ntdll.so` | A D3DMetal version from Runtimes can load in a source that does not include one |
| Adapter identity | `D3DM_VENDOR_ID` in `win32u.so` | While D3DMetal performs a game's DLSS through [game temporal integration](SIKARUGIR.md#game-temporal-integration), the game sees an NVIDIA GeForce RTX 4090 adapter and therefore offers DLSS. `D3DM_VENDOR_ID`, `D3DM_DEVICE_ID` and `D3DM_DEVICE_DESCRIPTION` set in the [environment variables](TRANSLATOR_ENVIRONMENT.md) replace these values. |

The Wine trees of Sikarugir and WineCX run as Intel (x86-64) processes, which need Rosetta on Apple Silicon. CrossOver's loader architecture is read from the registered application.

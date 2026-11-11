# WineCX (Wine)

[winecx-gptk](https://github.com/dappermint/winecx-gptk) is dappermint's Wine runtime built from CodeWeavers' CrossOver Wine changes rebased onto a current Wine release. Its Wine follows the CrossOver internals that Apple's D3DMetal component loads into. MacLauncher downloads its published releases and runs compatible Windows games with them. Game runtime selectors list it as **WineCX (Wine)**. It uses the shared [Wine layer](WINE.md): settings, translators, private environments, graphics effects and the Steam bridge behave as they do for [Sikarugir](SIKARUGIR.md).

## Requirements

Each release states its supported macOS versions; installation reads the minimum from the deployment target of every native image in the archive, and current releases require macOS 26 or later. On an older macOS, installation stops before anything is installed, and an installed version that needs a newer macOS is listed as unavailable with **Requires macOS 26 or later**. The Wine tree is Intel (x86-64) code, which needs Rosetta on Apple Silicon. Play checks for Rosetta and offers to install it, as [Rosetta](ROSETTA.md) describes.

## Versions

**Runtimes → WineCX** lists the downloadable and installed versions and selects the global preferred version, and the inspector's **Version** selector can override it for one game. Refresh reads every release that the publisher lists, newest first, and automatic selection uses the newest listed version. Installed versions stay selectable after a refresh, and an explicit per-game version remains exact.

A release is a runtime when it offers exactly one archive together with a checksum file named after it, such as `Libraries.tar.gz` and `Libraries.tar.gz.sha256`. The version number comes from the release tag, such as `runtime-v4.8.1`. Asset names, versions and checksums are read from each release, so new releases need no MacLauncher update. The download is checked against the SHA-256 that GitHub lists and against the publisher's checksum file. [Release catalogs](RUNTIME_CATALOGS.md#winecx) describes the catalog.

Version labels name the release and the Wine version read from the installed `ntdll.so`, in the form **WineCX 4.8.1 · Wine 11.19**. An installed version's row also names the DXVK and DXMT versions that its version plist states.

**Install** can replace an incomplete installation of the same version, and Play offers the same repair through its download prompt. Installation records every installed file in a sealed inventory, and a changed or missing Wine file makes the version unavailable until it is installed again.

## Contents

| Component | Location in the release | Role |
| --- | --- | --- |
| Wine | `Libraries/Wine` | The Wine tree, with its own FreeType, GnuTLS, GStreamer, wine-mono and wine-gecko |
| DXVK | `Libraries/DXVK` | Direct3D 10 and 11 to Vulkan, for 32-bit games when the 64-bit folder has no `dxgi.dll` |
| DXMT | `Libraries/DXMT` | Direct3D 10 and 11 to Metal |
| MoltenVK | `Libraries/Wine/lib/libMoltenVK.dylib` | Vulkan-to-Metal driver |

These appear as Included rows labeled **WineCX** in **Runtimes → Graphics** and in each game's translator choices. The release includes no D3DMetal. Its Wine reads `CX_APPLEGPTK_LIBD3DSHARED_PATH`, so a D3DMetal version installed in **Runtimes → Graphics → DirectX → Metal** can be selected for Direct3D 11 and 12. KosmicKrisp, vkd3d-proton and the other translator versions from Runtimes are selected the same way as for Sikarugir.

The automatic choice uses the release's DXMT for Direct3D 10 and 11, WineD3D for Direct3D 8 and 9, Wine vkd3d for Direct3D 12 and its MoltenVK for Vulkan. A DXVK or vkd3d-proton version from Runtimes pairs with MacLauncher KosmicKrisp, as [Selection and loading](KOSMICKRISP.md#selection-and-loading) describes. Its Wine names the selected Vulkan driver through `CX_LIBVULKAN`.

## Private environments

Each game has private prefixes for WineCX, separate from its Sikarugir and CrossOver environments. The Windows 10, 11, 7 and XP selections each keep their own prefix, and the other Windows versions are set per program in the Windows 10 prefix. WineCX has no external environment kind, so the **Environment** choice is not listed.

## Licenses

Wine and CodeWeavers' CrossOver Wine changes are licensed under LGPL-2.1-or-later. The release bundles FreeType, GnuTLS, GStreamer, MoltenVK, DXVK, DXMT, wine-mono and wine-gecko, which retain their own licenses. [Attributions](../ATTRIBUTIONS.md) lists the sources. D3DMetal is not part of the release; a version installed in Runtimes keeps Apple's Game Porting Toolkit license, as [Sikarugir licenses](SIKARUGIR.md#licenses) describes.

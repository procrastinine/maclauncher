# WineCX

[winecx-gptk](https://github.com/dappermint/winecx-gptk) is dappermint's Wine runtime, built from CodeWeavers' CrossOver Wine changes rebased onto a current Wine release. Its Wine keeps the CrossOver internals that Apple's D3DMetal component loads into. MacLauncher downloads the published releases and runs compatible Windows games with them, and game runtime selectors list the runtime as **WineCX**. It uses the shared [Wine layer](WINE.md), so settings, translators, private environments, graphics effects and the Steam bridge behave as they do for [Sikarugir](SIKARUGIR.md).

## Requirements

Current releases require macOS 26 or later. Each release states its supported macOS versions, and installation reads the minimum from the deployment target of every native image in the archive. Before a download, MacLauncher takes the requirement from the archive's first Wine executable: **Refresh** reads the start of the newest release's archive, about 4 MB, and Install reads the same part of any other version before downloading it. A version that needs a newer macOS is listed with **Requires macOS 26 or later** and is neither downloaded nor installed. An installed version that needs a newer macOS is listed as unavailable with the same text.

The Wine tree is Intel (x86-64) code and needs Rosetta on Apple Silicon. Play therefore checks for Rosetta and offers to install it, as [Rosetta](ROSETTA.md) describes.

## Versions

**Runtimes → WineCX** lists the downloadable and installed versions and sets the global preferred version, which the inspector's **Version** selector can override for one game. Refresh reads every release that the publisher lists, newest first, and automatic selection uses the newest listed version. Installed versions remain selectable after a refresh, and a version chosen for a single game is used exactly as chosen.

A release counts as a runtime when it offers exactly one archive together with a checksum file named after it, such as `Libraries.tar.gz` and `Libraries.tar.gz.sha256`. The version number comes from the release tag, such as `runtime-v4.8.1`. Because asset names, versions and checksums are read from each release, new releases need no MacLauncher update. Each download is checked against the SHA-256 that GitHub lists and against the publisher's checksum file. [Release catalogs](RUNTIME_CATALOGS.md#winecx) describes the catalog.

Version labels name the release and the Wine version read from the installed `ntdll.so`, in the form **WineCX 4.8.1 · Wine 11.19**. An installed version's row also names the translators it includes, as in **Includes DXMT 0.80 · DXVK 1.10.3 for 32-bit games · MoltenVK 1.4.2 · GStreamer 1.26.3**. DXVK and DXMT are shown with the versions that the release's version plist states, MoltenVK with the version that its library states, and GStreamer with the version of its core library ([Graphics translators](TRANSLATORS.md#versions-and-sources)).

**Install** can replace an incomplete installation of the same version, and Play offers the same repair through its download prompt. Installation records every installed file in an inventory, which each launch checks; a changed or missing Wine file makes the version unavailable until it is installed again.

**Register custom…** adds a WineCX folder that is already on the Mac, such as an extracted release: its `Libraries` folder, the folder that contains it, or a file inside it. Registration checks the folder in place with the same closure check as a download. `Libraries/Wine` must hold the Wine loader, `wineserver` and the native Wine components that a download needs, the CPU and the macOS requirement are read from its native images, and the release's version plist names its translator versions. A folder that needs a newer macOS than the running one is refused with the same **Requires macOS … or later** text as a download. Nothing in the folder is written or moved, and the folder has no inventory. A full check reads the folder's file listing and reads its native images again only when the listing has changed; the status shown in Runtimes reuses the last check while the folder's `wineserver` and Wine loader are unchanged. A registered folder is listed beside the installed versions and can be set as the default or chosen for one game.

## Contents

| Component | Location in the release | Role |
| --- | --- | --- |
| Wine | `Libraries/Wine` | The Wine tree, with its own FreeType, GnuTLS, GStreamer, wine-mono and wine-gecko |
| DXVK | `Libraries/DXVK` | Direct3D 10 and 11 to Vulkan, for 32-bit games when the 64-bit folder has no `dxgi.dll` |
| DXMT | `Libraries/DXMT` | Direct3D 10 and 11 to Metal, with the Wine tree's `winemetal.so` as its Unix module |
| MoltenVK | `Libraries/Wine/lib/libMoltenVK.dylib` | Vulkan-to-Metal driver |

These components appear as Included rows labeled **WineCX** in **Runtimes → Graphics** and in each game's translator choices. The release includes no D3DMetal. Its Wine reads `CX_APPLEGPTK_LIBD3DSHARED_PATH`, however, so a D3DMetal version installed in **Runtimes → Graphics → DirectX → Metal** can be selected for Direct3D 11 and 12. Its `win32u.so` also reads D3DMetal's adapter variables. While D3DMetal performs a game's DLSS through [game temporal integration](SIKARUGIR.md#game-temporal-integration), the game therefore sees an NVIDIA GeForce RTX 4090 and offers DLSS. KosmicKrisp, vkd3d-proton and the other translator versions from Runtimes are selected the same way as for Sikarugir.

The automatic choice uses the release's DXMT for Direct3D 10 and 11, WineD3D for Direct3D 8 and 9, Wine vkd3d for Direct3D 12 and the release's MoltenVK for Vulkan. A DXVK or vkd3d-proton version from Runtimes is paired with MacLauncher KosmicKrisp, as [Selection and loading](KOSMICKRISP.md#selection-and-loading) describes. Because this Wine opens `libMoltenVK.dylib` by name and reads `CX_LIBVULKAN` only while the WineD3D backend is active, a selected Vulkan driver is placed under that name, as [Loading](TRANSLATORS.md#loading) describes.

## Private environments

Each game has private WineCX prefixes, separate from its Sikarugir and CrossOver environments. The Windows 10, 11, 7 and XP selections each keep their own prefix, and the other Windows versions are set per program in the Windows 10 prefix. WineCX cannot use an existing environment from outside MacLauncher, so its settings do not list the **Environment** choice.

## Licenses

Wine and CodeWeavers' CrossOver Wine changes are licensed under LGPL-2.1-or-later. The release bundles FreeType, GnuTLS, GStreamer, MoltenVK, DXVK, DXMT, wine-mono and wine-gecko, which retain their own licenses. [Attributions](../ATTRIBUTIONS.md) lists the sources. D3DMetal is not part of the release, and a version installed in Runtimes keeps Apple's Game Porting Toolkit license, as [Sikarugir licenses](SIKARUGIR.md#licenses) describes.

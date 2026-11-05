# Graphics translators

**Runtimes → Graphics** organizes translators by their output: **DirectX → Vulkan** contains DXVK and vkd3d-proton, **DirectX → Metal** contains DXMT and D3DMetal, **Vulkan drivers** contains MoltenVK and KosmicKrisp, and **Video codecs** contains GStreamer. These groups manage the components used by [CrossOver](CROSSOVER.md) and [Sikarugir](SIKARUGIR.md). Each installed version is stored once. Games, private graphics views and Windows prefix DLLs refer to that installation through links. A loader that needs its own signature, or a library that locates its framework beside itself, uses a shared prepared copy rather than a copy per game.

Stale disposable graphics views are rebuilt in another shared generation. Previous generations remain in place until ordinary storage upkeep can retire them. Equivalent library links resolve to the same installed source.

## Versions and sources

Translator versions use the shared runtime catalogs and local registration. Refresh reads one source's published releases. Status and registered-file inspection remain offline. CrossOver and Sikarugir use the same installed versions; selecting another game adds no translator payload copy.

| Manager | Download sources | Local sources |
| --- | --- | --- |
| MoltenVK | KhronosGroup/MoltenVK | Library, folder, archive or installed runtime |
| KosmicKrisp | Mesa distributions | Driver and loader folder, archive or installed runtime |
| DXMT | 3Shain/dxmt builtin releases; Sikarugir Template | Folder, archive or installed runtime |
| DXVK | doitsujin/dxvk; Gcenx/DXVK-macOS, with a separate async catalog; Template dxvk, dxvk3 and d9vk | Folder, archive or installed runtime |
| vkd3d-proton | HansKristian-Work/vkd3d-proton | Folder or archive |
| D3DMetal | Sikarugir Template | Apple Game Porting Toolkit disk image or folder; installed runtime |
| GStreamer codecs | Local registration | Prepared plugin folder with its matching dependency closure |

DXVK-macOS is shown as an optional macOS alternative to the runtime's own included or automatic choice. Upstream, async and Template sources remain under Additional sources; D9VK is the older Direct3D 8/9 variant. Template package versions are distinct from installed component versions. The GStreamer panel registers prepared local codec folders, and D3DMetal links to Apple's official Game Porting Toolkit download page.

Each catalog has its own Refresh control and publisher link. Release labels identify the source. Installed files supply PE machine and builtin/native form, Mach-O CPU slices, deployment targets and Unix imports. Release numbers and vendor labels do not determine compatibility.

Directory and installed-application registrations reference the selected files. Archive registrations extract once into shared storage. Publisher archives are cached by asset identity across managers; installing another component from the same Template reuses that download. Template component installations retain their complete component tree, including notices, without installing another Wine engine. Removing a local registration preserves the original files.

Installed lists also show matching components included with registered CrossOver applications and Sikarugir Templates. These rows name the source, component version and binary CPU architectures, carry an Included label and reference the original files. Source-owned rows have no install, repair, default or removal actions.

An installed application selection resolves its component folder, framework or driver library. An application whose component cannot be identified requires selection of the component folder or library. Selecting a component inside CrossOver retains the CrossOver-only source restriction.

D3DMetal is downloaded from Sikarugir Template or supplied locally. MacLauncher does not host or build it. Apple's Game Porting Toolkit licence applies, including Apple hardware and distribution restrictions; the supplied notice remains with the component. Components registered from CrossOver are restricted to CrossOver launches.

GStreamer plugin registration is intended for a prepared codec directory. An unmodified GStreamer SDK can load a second GStreamer core alongside Wine's core. Its plugin dependencies must resolve to the intended libraries before the directory is selected through `GST_PLUGIN_PATH`. Registration does not replace `winegstreamer` or another Wine module, relocate library imports, or supply a codec SDK download catalog.

## Selection

Runtime Settings selects each component independently.

| Component | Choices |
| --- | --- |
| Direct3D engine | The runtime's automatic choice, its named engines, and managed DXMT, DXVK or D3DMetal versions. DXVK packages can provide different Direct3D API sets. |
| Vulkan driver | The runtime's automatic driver, its named drivers, and managed MoltenVK or KosmicKrisp versions. |
| Direct3D 12 | Wine vkd3d, D3DMetal or a managed Direct3D 12 translator. KosmicKrisp is recommended for vkd3d-proton. |
| Video codecs | The runtime defaults or a registered GStreamer plugin folder. Wine's own video modules remain with Wine. |

An existing bottle or wrapper first offers its current setting, read from its configuration without starting Wine. Automatic follows that runtime's existing behavior. Named choices show their version and source from release labels, component version files, framework metadata or the runtime's changelog; a component without readable version metadata still names its engine and source. Replacement DLL version resources report Windows component versions and do not supply translator release versions. Installed CrossOver components are used for CrossOver launches only.

Unreadable optional labels and inaccessible unrelated package entries produce diagnostics. Basic PE machine and builtin/native facts remain available when optional export inspection is incomplete. Invalid required binaries and component path escapes remain errors.

The Direct3D engine choice is also the DXMT version setting for camera support. The camera adapter keeps its own matching-library requirement. A mismatch leaves the selected renderer active and reports that camera support is unavailable.

## Loading

CrossOver's own engines use its graphics backend selector. Replacement Wine builtin DLLs use private Windows DLL directories, with their Unix modules beside the private Wine loader. D3DMetal selects its matching bridge and framework together. Upstream native Windows DLLs use links in the bottle's `system32` or `syswow64` directory and native DLL overrides. An existing DLL is preserved before replacement and restored when that selection is removed.

CrossOver Vulkan overrides place the selected Vulkan entry library at the private `libMoltenVK.dylib` location. KosmicKrisp uses the Khronos loader there and an explicit driver description naming the selected driver. This route applies across CrossOver backends; the additional `CX_LIBVULKAN` value is used only with WineD3D.

Sikarugir uses the same selected components through its private graphics view and Vulkan driver description. Its Wine engine, Template and registered wrapper engine remain in place.

## Compatibility and inspector

Play checks the files that the selected Wine process and Windows executable will load. An unused CPU variant in a multi-architecture installation does not affect the selection. A missing required file, absent PE machine or native CPU slice, a binary's declared macOS minimum above the running system, or a required Unix import absent from its actual Wine dependency can prevent loading. Weak imports, system-library imports and incomplete inspection do not establish a failure.

When loading is impossible, Play uses the same engine supplied by the selected CrossOver or Template. If that engine is unavailable, it uses the runtime's automatic choice. The saved choice remains selected. The warning and inspector show the selected engine, the engine used and the reason. Software version numbers, vendor strings and tested-version lists do not decide translator compatibility.

The inspector shows the effective Direct3D engine, Vulkan driver and Direct3D 12 choice. CrossOver's automatic engine remains labeled automatic when its own final choice is unresolved. WineVulkan scene capture uses its matching scene closure; a separate Vulkan driver override, including KosmicKrisp, leaves that scene closure unavailable.

## Sources and notices

[DXMT](https://github.com/3Shain/dxmt/releases) carries its release licence; v0.80 uses MIT and later source uses LGPL-2.1-or-later. [DXVK](https://github.com/doitsujin/dxvk) and [Gcenx's macOS and async builds](https://github.com/Gcenx/DXVK-macOS) use the zlib licence. [vkd3d-proton](https://github.com/HansKristian-Work/vkd3d-proton) uses LGPL-2.1. [Sikarugir Template](https://github.com/Sikarugir-App/Template/releases) supplies its component notices. [GStreamer](https://gstreamer.freedesktop.org/) and codec dependencies retain their own licences.

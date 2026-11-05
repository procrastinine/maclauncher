# Graphics translators

**Runtimes → Graphics** organizes translators by their output: **DirectX → Vulkan** contains DXVK, Wine vkd3d and vkd3d-proton, **DirectX → Metal** contains DXMT and D3DMetal, **Vulkan drivers** contains MoltenVK and KosmicKrisp, and **Video codecs** contains GStreamer. These groups manage the components used by [CrossOver](CROSSOVER.md) and [Sikarugir](SIKARUGIR.md). Each installed version is stored once. Games, private graphics views and Windows prefix DLLs refer to that installation through links. A loader that needs its own signature, or a library that locates its framework beside itself, uses a shared prepared copy rather than a copy per game.

Stale disposable graphics views are rebuilt in another shared generation. Previous generations remain in place until ordinary storage upkeep can retire them. Equivalent library links resolve to the same installed source.

## Versions and sources

Translator versions use the shared runtime catalogs and local registration. Refresh reads one source's published releases. Status and registered-file inspection remain offline. CrossOver and Sikarugir use the same installed versions; selecting another game adds no translator payload copy.

| Manager | Download sources | Local sources |
| --- | --- | --- |
| MoltenVK | KhronosGroup/MoltenVK | Library, folder, archive or installed runtime |
| KosmicKrisp | LWJGL packages | Driver and loader folder, archive or installed runtime |
| DXMT | 3Shain/dxmt builtin releases; Sikarugir Template | Folder, archive or installed runtime |
| DXVK | doitsujin/dxvk; Gcenx/DXVK-macOS, with a separate async catalog; historical AlpyneDreams/d8vk and misyltoad/d9vk releases; Template dxvk, dxvk3 and d9vk | Folder, archive or installed runtime |
| Wine vkd3d | Wine upstream source link | Read-only copies included with registered runtimes |
| vkd3d-proton | HansKristian-Work/vkd3d-proton | Folder or archive |
| D3DMetal | Sikarugir Template | Apple Game Porting Toolkit disk image or folder; installed runtime |
| GStreamer codecs | Local registration | Prepared plugin folder with its matching dependency closure |

DXVK-macOS is shown as an optional macOS alternative to the runtime's own included or automatic choice. Upstream, async, historical D8VK/D9VK and Template sources remain under Additional sources. D8VK and D9VK retain their historical releases; their Direct3D 8 and 9 work is part of modern DXVK. Installed rows show API coverage read from the actual libraries, so each version can expose a different API set. Template package versions are distinct from installed component versions. The GStreamer panel registers prepared local codec folders, and D3DMetal links to Apple's official Game Porting Toolkit download page.

Each catalog has its own Refresh control and publisher link. Release labels identify the source. Installed files supply PE machine and builtin/native form, Mach-O CPU slices, deployment targets and Unix imports. Release numbers and vendor labels do not determine compatibility.

LWJGL's package version is shown as package provenance for its KosmicKrisp driver. A KosmicKrisp component version is shown only when component metadata supplies it. Releases and builds that share a short label retain their publisher revision or exact build identity rather than a numbered position in a list.

Directory and installed-application registrations reference the selected files. Archive registrations extract once into shared storage. Publisher archives are cached by asset identity across managers; installing another component from the same Template reuses that download. Template component installations retain their complete component tree, including notices, without installing another Wine engine. Removing a local registration preserves the original files.

Installed lists also show matching components included with registered CrossOver applications and Sikarugir Templates. These rows name the component variant and source once, with the component version in the row details and CPU architectures alongside it. Template and Wine engine versions are separate fields, such as Template 1.0.24 (Wine 10.0_8). Template download and Included lists use newest-first numeric release order. Multiple copies of the same source retain their application or registration names. Included rows reference the original files and have no install, repair, default or removal actions. Wine vkd3d has its own Included copies panel; these copies remain with Wine and are separate from vkd3d-proton. Its upstream source archives are not presented as Windows runtime downloads.

An installed application selection resolves its component folder, framework or driver library. An application whose component cannot be identified requires selection of the component folder or library. Selecting a component inside CrossOver retains the CrossOver-only source restriction.

D3DMetal is downloaded from Sikarugir Template or supplied locally. MacLauncher does not host or build it. Apple's Game Porting Toolkit licence applies, including Apple hardware and distribution restrictions; the supplied notice remains with the component. Components registered from CrossOver are restricted to CrossOver launches.

GStreamer shows the plugin folders included with registered CrossOver applications and Sikarugir Templates as read-only sources. A folder without component release metadata names its source runtime; library ABI filenames do not supply a codec version. Official project and download links accompany local registration.

GStreamer plugin registration is intended for a prepared codec directory. An unmodified GStreamer SDK can load a second GStreamer core alongside Wine's core. Its plugin dependencies must resolve to the intended libraries before the directory is selected through `GST_PLUGIN_PATH`. Registration does not replace `winegstreamer` or another Wine module, relocate library imports, or supply a codec SDK download catalog.

## Selection

Runtime Settings selects installed components by API and shows shared library scopes.

| Component | Choices |
| --- | --- |
| Default Direct3D engine | The existing shared renderer policy, including runtime automatic and named installed versions. |
| Direct3D 8, 9, 10 / 10.1 and 11 | Installed implementations with the corresponding DLLs. Modern DXVK can serve several APIs; historical D8VK and D9VK remain specific source/version choices. |
| Direct3D 12 | Wine vkd3d, D3DMetal or a managed Direct3D 12 translator. KosmicKrisp is recommended for vkd3d-proton. |
| Vulkan driver | The runtime's automatic driver, its named drivers, and managed MoltenVK or KosmicKrisp versions. |
| Video codecs | The runtime defaults or a registered GStreamer plugin folder. Wine's own video modules remain with Wine. |

An existing bottle or wrapper first offers its current setting, read from its configuration without starting Wine. Automatic follows that runtime's existing behavior. Named choices show their version and source from release labels, component version files, framework metadata or the runtime's changelog; a component without readable version metadata still names its engine and source. Replacement DLL version resources report Windows component versions and do not supply translator release versions. Installed CrossOver components are used for CrossOver launches only.

Unreadable optional labels and inaccessible unrelated package entries produce diagnostics. Basic PE machine and builtin/native facts remain available when optional export inspection is incomplete. Invalid required binaries and component path escapes remain errors.

Unset API choices retain the existing shared renderer policy. No saved choices or runtime defaults are migrated when the settings are displayed. A linked choice changes its advertised API scope together. Automatic and existing Bottle setting or Wrapper setting remain available.

Direct3D APIs can share DXGI, native Unix modules and Windows thunks. A physical DLL/module binding has one source; conflicting providers use the existing coherent composition with the selected intent and reason retained in the inspector. Direct PE imports and matching Unix module facts identify companions. Incomplete companion information retains the package as an atomic group instead of predicting an ABI from engine names or versions.

CrossOver selects its included renderer through one global backend. Its unresolved automatic choice stays global. A concrete shared default or a complete explicit API composition uses the private loader. A partial override that still depends on unresolved global Automatic keeps the existing composition active and reports the coupling. Selecting each API individually is not required when a concrete shared default supplies the remaining APIs. CrossOver's application files remain unchanged.

The used Direct3D 11 DXMT version also supplies the camera adapter. The adapter keeps its own matching-library requirement. A mismatch leaves the selected renderer active and reports that camera support is unavailable. Engine settings apply to every engine actually used by the final API bindings.

## Loading

CrossOver's own engines use its graphics backend selector. Replacement Wine builtin DLLs use private Windows DLL directories, with their Unix modules beside the private Wine loader. D3DMetal selects its matching bridge and framework together. Upstream native Windows DLLs use links in the bottle's `system32` or `syswow64` directory and native DLL overrides. An existing DLL is preserved before replacement and restored when that selection is removed.

CrossOver Vulkan overrides place the selected Vulkan entry library at the private `libMoltenVK.dylib` location. KosmicKrisp uses the Khronos loader there and an explicit driver description naming the selected driver. This route applies across CrossOver backends; the additional `CX_LIBVULKAN` value is used only with WineD3D.

Sikarugir uses the same selected components through its private graphics view and Vulkan driver description. Its Wine engine, Template and registered wrapper engine remain in place.

## Compatibility and inspector

Play checks the files that the selected Wine process and Windows executable will load. An unused CPU variant in a multi-architecture installation does not affect the selection. A missing required file, absent PE machine or native CPU slice, a binary's declared macOS minimum above the running system, or a required Unix import absent from its actual Wine dependency can prevent loading. Weak imports, system-library imports and incomplete inspection do not establish a failure.

When loading is impossible, Play uses the same engine supplied by the selected CrossOver or Template. If that engine is unavailable, it uses the runtime's automatic choice. The saved choice remains selected. The warning and inspector show the selected engine, the engine used and the reason. Software version numbers, vendor strings and tested-version lists do not decide translator compatibility.

The inspector shows selected and used components for Direct3D 8 through 12, the Vulkan driver and video codecs. CrossOver's automatic engine remains labeled automatic when its own final choice is unresolved. Camera, DLSS and graphics consumers use the final API bindings. WineVulkan scene capture uses its matching scene closure; a separate Vulkan driver override, including KosmicKrisp, leaves that scene closure unavailable. API selection alone does not provide NGX interception through Vulkan/KosmicKrisp.

## Sources and notices

[DXMT](https://github.com/3Shain/dxmt/releases) carries its release licence; v0.80 uses MIT and later source uses LGPL-2.1-or-later. [DXVK](https://github.com/doitsujin/dxvk), [D8VK](https://github.com/AlpyneDreams/d8vk), [D9VK](https://github.com/misyltoad/d9vk) and [Gcenx's macOS and async builds](https://github.com/Gcenx/DXVK-macOS) use the zlib licence. [vkd3d-proton](https://github.com/HansKristian-Work/vkd3d-proton) uses LGPL-2.1. [Sikarugir Template](https://github.com/Sikarugir-App/Template/releases) supplies its component notices. [GStreamer](https://gstreamer.freedesktop.org/) and codec dependencies retain their own licences.

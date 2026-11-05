# Graphics translators

Windows games draw with Microsoft's Direct3D, and some draw with Vulkan, while macOS provides Metal. [CrossOver](CROSSOVER.md) and [Sikarugir](SIKARUGIR.md) therefore rely on graphics translators: libraries that carry a game's Direct3D or Vulkan calls to Metal, either directly or through a Vulkan driver that runs on Metal. Each Wine distribution brings its own set. CrossOver includes engines such as D3DMetal, DXMT and DXVK and chooses among them with its own graphics selector, and Sikarugir supplies its engines in the Template that accompanies each Wine version.

The choice of translators is a major part of MacLauncher's support for Windows games. Each game can choose a default Direct3D engine, a translator for each Direct3D version from 8 to 12, a Vulkan driver and video codecs, and Settings holds the default choices for all games. The choices include the copies that come with the selected Wine, upstream releases, files registered locally and the user's own copy of Apple's Game Porting Toolkit. MacLauncher keeps these versions outside the Wine distributions, whereas community tools such as [CXPatcher](https://github.com/italomandara/CXPatcher) update translators by patching a copy of the CrossOver application. Compared with running the same game in CrossOver or Sikarugir alone, this changes several things:

- A game can use a newer or older translator than the one its Wine distribution includes, and other games keep their own choices. The CrossOver application, Sikarugir engines and Templates are never modified for this.
- Versions installed in Runtimes are stored apart from CrossOver and the Templates, so updating or replacing those leaves the installed versions and the games' choices of them in place.
- Each translator version is installed once, and every game and Windows environment that uses it links to that single installation.
- Compatibility is decided from the translator's actual files when Play starts. A choice that cannot load falls back to the same engine from the selected Wine, and the inspector names both.
- [Graphics effects](../graphics/SHARED_PROCESSING.md) and temporal upscaling are prepared for the translator that the game actually uses after any fallback.

## Translators and drivers

| Translator | Graphics API | Role |
| --- | --- | --- |
| DXMT | Direct3D 10 and 11 | Translates to Metal. |
| D3DMetal | Direct3D 11 and 12 | Apple's translator to Metal, from the Game Porting Toolkit. |
| DXVK | Direct3D 8, 9, 10 and 11 | Translates to Vulkan. Its packages differ in the Direct3D versions they include: Sikarugir Templates have `dxvk`, `dxvk3` and `d9vk` variants, and Gcenx's macOS builds have async variants. The historical D8VK and D9VK releases cover Direct3D 8 and 9, work that modern DXVK includes. |
| vkd3d-proton | Direct3D 12 | Translates to Vulkan. |
| Wine vkd3d | Direct3D 12 | Wine's own Direct3D 12 libraries. |
| WineD3D | Direct3D | Wine's built-in Direct3D translation. |
| MoltenVK | Vulkan | Vulkan driver that runs on Metal. |
| KosmicKrisp | Vulkan | Vulkan driver from Mesa that runs on Metal on Apple Silicon. |
| GStreamer codecs | Video | Plugins for Wine's video playback. |

## Versions and sources

**Runtimes → Graphics** groups the translators by what they produce. **DirectX → Vulkan** holds DXVK, Wine vkd3d and vkd3d-proton, **DirectX → Metal** holds DXMT and D3DMetal, **Vulkan drivers** holds MoltenVK and KosmicKrisp, and **Video codecs** holds GStreamer. Each translator has its own section there, and its versions come from the shared runtime catalogs or from local registration. CrossOver and Sikarugir use the same installed versions, so selecting a translator for another game adds no copy of its files. Refresh reads the published releases of one source, while status and the inspection of registered files work offline.

| Manager | Download sources | Local sources |
| --- | --- | --- |
| MoltenVK | KhronosGroup/MoltenVK | Library, folder, archive or installed runtime |
| KosmicKrisp | LWJGL's KosmicKrisp builds of Mesa; MacLauncher KosmicKrisp from MacLauncher Builds | Driver and loader folder, archive or installed runtime |
| DXMT | 3Shain/dxmt builtin releases; Sikarugir Template | Folder, archive or installed runtime |
| DXVK | DXVK upstream, including historical D8VK/D9VK variants; DXVK-macOS with an async variant; Sikarugir Template components | Folder, archive or installed runtime |
| Wine vkd3d | Link to the Wine upstream source | Read-only copies included with registered runtimes |
| vkd3d-proton | HansKristian-Work/vkd3d-proton | Folder or archive |
| D3DMetal | Sikarugir Template | Apple Game Porting Toolkit disk image or folder; installed runtime |
| GStreamer codecs | Official GStreamer macOS runtime packages | Prepared plugin folder together with the libraries its plugins depend on |

Wine runs as an x86-64 process, also on Apple Silicon through Rosetta. Every macOS library that it loads must therefore contain x86-64 code, and only installations with Intel code are listed for Wine games. KosmicKrisp itself requires Apple Silicon, so a Wine game uses an x86-64 build of it: a Sikarugir Template's driver, an installed MacLauncher KosmicKrisp package that includes an Intel (x86-64) build, or a locally registered build with Intel code. LWJGL's KosmicKrisp builds are ARM64-only, so they never reach Wine.

MacLauncher KosmicKrisp is an adapted build of KosmicKrisp. In addition to upstream's features, it implements transform feedback and primitives-generated queries for DXVK's Direct3D stream output and ANGLE's OpenGL ES 3.2, non-solid polygon fill for DXVK, single-texel alignment of texel buffer views for vkd3d-proton, and variable multisample rate for Direct3D 11.1 and 12; [Native Vulkan libraries](../../src/modules/shared/vulkan/README.md) describes it.

Each source card has its own Refresh control and publisher link. A grouped source exposes its existing catalogs through a Variant control; Refresh updates those catalogs together. The **Vulkan drivers** entry also holds **MoltenVK scene support**, a MacLauncher Builds package that CrossOver's [Vulkan scene support](CROSSOVER.md#vulkan-scene-support) uses.

Translator versions are selected per game, with **Automatic** using the Wine runtime's own copy. Translator managers have no global version default. DXVK upstream is the primary download card; **Additional sources** holds DXVK-macOS, with its async variant, and Sikarugir Template components. Historical D8VK and D9VK releases are variants of DXVK upstream, and empty historical catalogs add no variant. Template component names identify folders; the installed files supply their Direct3D API coverage and component versions. A Template's package version remains distinct from its components' versions. D3DMetal has an Apple Game Porting Toolkit card for registering an Apple download, alongside the secondary Template source. The GStreamer panel offers official runtime packages and prepared local codec folders.

For LWJGL's KosmicKrisp driver, the LWJGL package version is shown as the package it came from, and a KosmicKrisp component version appears only when the component's metadata supplies one. Releases and builds that share a short label keep their publisher revision or exact build identity rather than a numbered position in a list.

A registered folder or installed application is used by reference to the selected files, which stay where they are. A registered archive or disk image, by contrast, is extracted once into shared storage. Publisher archives are cached by their asset identity across managers, so installing another component from the same Template reuses the earlier download. A Template component installation keeps its complete component tree, including notices, and installs no other Wine engine. Removing a local registration leaves the original files in place.

The installed lists also show matching components that come with registered CrossOver applications and Sikarugir Templates. Each of these Included rows names the component variant and its source once, and its details give the component version alongside its CPU architectures. Template and Wine engine versions are separate fields, as in Template 1.0.24 (Wine 10.0_8). Template downloads and Included rows are listed newest first in numeric release order, and several copies from the same source keep their application or registration names. Included rows refer to the original files and, because they belong to their source, have no install, repair, default or removal actions. Wine vkd3d has its own panel of included copies; these copies stay with Wine and are separate from vkd3d-proton, and Wine's upstream source archives are not offered as Windows runtime downloads.

When an installed application is selected, MacLauncher finds the component folder, framework or driver library inside it. If the component cannot be identified, the component folder or library has to be selected directly. Components registered from CrossOver, including one selected inside a CrossOver application, are used for CrossOver launches only.

D3DMetal is Apple's proprietary component. It is downloaded from the Sikarugir Template or supplied locally, for example from the user's own Game Porting Toolkit download; MacLauncher neither hosts nor builds it. Apple's Game Porting Toolkit license applies to it, including its Apple hardware and distribution restrictions, and the supplied notice stays with the component.

GStreamer lists the plugin folders that come with registered CrossOver applications and Sikarugir Templates as read-only sources. A folder without component release metadata is named after its source runtime, since the ABI numbers in library file names do not give a codec version. Links to the official project and its downloads accompany local registration.

Refresh reads the official macOS package index and its release directories. Runtime packages are separate from development and debug packages. Stable releases are preselected when available; development-series runtime packages stay listed as pre-releases and remain selectable. Install verifies the publisher's checksum when available and extracts the framework into managed runtime storage. Package scripts and the system installer are not run, and files are not installed into `/Library/Frameworks`. The retained framework includes plugin and dependency libraries; plugin directories are recorded separately from those dependencies.

Local GStreamer registration accepts a prepared codec directory. Plugin dependencies must resolve to the intended GStreamer and GObject libraries before selection through `GST_PLUGIN_PATH`. Acquiring a runtime package does not replace `winegstreamer` or another Wine module.

GStreamer components retain their complete library and resource closure. Plugin search directories are separate from dependency directories. Preparation follows the selected Wine's actual native dependencies and shares established host libraries, including its GStreamer and GObject core. Loader-relative images use one shared prepared neighborhood; unchanged files and resources remain links. The component's dependency and framework directories are not added to global dynamic-library search paths. Wine's scanner and system-plugin paths remain in use, and no Wine module is replaced.

An optional plugin with a missing required CPU slice, a higher binary macOS minimum or a strong import absent from its established host dependency is omitted with a warning. Usable siblings and runtime defaults remain available. Weak imports and incomplete dependency/export information remain unknown and produce diagnostics. Absolute or dynamic dependency paths whose target is not established remain identified as unresolved. An established package-core path that bypasses the prepared host-library view leaves that optional plugin unavailable with its path reason reported. A prepared plugin-folder registration without directory metadata retains its existing search directories.

## Installed versions and links

A translator version is stored once, in its manager's installation, and games refer to it through links. These links sit in two places. Shared graphics views are keyed by the Wine CPU and the checksums of the selected files, so every game with the same selection reuses one view. Native DLLs, in addition, are linked into the Windows environment that uses them. Equivalent library links resolve to the same installed source.

Real copies are made only where a link cannot work. A Wine loader that must carry its own code signature is copied, and so is D3DMetal's `libd3dshared.dylib`, which looks for its framework beside itself. These copies, too, are prepared once for each set of inputs and shared between games.

A shared graphics view that has gone stale is rebuilt as a new shared generation. Earlier generations stay in place until ordinary storage upkeep can remove them.

## Selection

Runtime Settings selects installed components for each graphics API and shows which choices share libraries. Settings holds the default of each control for all games, and a game's Runtime Settings can override it. Versions and sources are read from installed files, and a change applies on the next launch. A saved choice names one installed version, so installing a newer version adds a choice without changing the games that use an older one.

| Control | Choices |
| --- | --- |
| Default Direct3D engine | The shared renderer choice for every Direct3D API without a choice of its own: the runtime's automatic choice, the engines that come with the selected runtime, and named versions installed in Runtimes. |
| Direct3D 8, 9, 10 / 10.1 and 11 | Installed implementations that contain the corresponding DLLs. Modern DXVK can serve several of these APIs, while the historical D8VK and D9VK releases remain choices with their own source and version. |
| Direct3D 12 | Wine vkd3d, D3DMetal, or a vkd3d-proton or D3DMetal version installed in Runtimes. KosmicKrisp is recommended for vkd3d-proton. |
| Vulkan driver | The runtime's automatic driver, the drivers that come with the selected runtime, and MoltenVK or KosmicKrisp versions installed in Runtimes. |
| Video codecs | The runtime defaults or a registered GStreamer plugin folder. Wine's own video modules stay with Wine. |

Each list follows the same order. When a game runs in an existing CrossOver bottle or Sikarugir wrapper, the list opens with **Bottle setting** or **Wrapper setting** and its current value, which is read from the environment's configuration without starting Wine. Next comes the runtime's automatic choice, labeled **CrossOver's automatic choice** or **Template's automatic choice**, which keeps that runtime's usual behavior. The named choices follow, each with its engine, version and source, such as the DXMT version that a CrossOver release includes. Versions are read from release labels, component version files, framework metadata or the runtime's changelog. The version resources of replacement DLLs report Windows component versions, so they do not supply translator release versions. A component without readable version metadata still shows its engine and source. Components that come from CrossOver are listed only for CrossOver launches.

An optional label that cannot be read, or an unrelated package entry that cannot be accessed, produces a diagnostic. The basic PE machine type and builtin or native form stay available when the optional inspection of exports is incomplete. Invalid required binaries and component paths that escape their folder remain errors.

A Direct3D API without a choice of its own keeps the default Direct3D engine. Each list has one automatic entry, and copies with the same consumed libraries and scope share one option. Matching component labels with different API coverage include that coverage in their names. Opening the settings changes no saved choices or runtime defaults. When one installed version serves several APIs through shared libraries, their choices are linked and change together. **Automatic** and an existing environment's **Bottle setting** or **Wrapper setting** remain available. A choice that cannot be applied shows a short explanation; its detailed reason remains in the inspector.

Installed managed choices remain available before Wine is installed; the included choices appear after its installation. Optional malformed choice metadata does not suppress other choices. Inspection reuses unchanged file facts and refreshes them when the component files change. Source-declared package forms can limit which new choices appear for a runtime; saved selections retain their identities and use the same file-based loading checks.

Direct3D APIs can share DXGI, native Unix modules and Windows thunks, and each DLL or module location holds a file from only one source. When the selected choices would place different files at the same location, the affected APIs keep the components that the default Direct3D engine would use, and the inspector shows the selected choice with the conflict as the reason. Companion files are identified from direct PE imports and matching Unix modules. When that information is incomplete, the whole package is treated as one group, and no ABI is guessed from engine names or versions.

CrossOver selects its included renderer through one global backend, so while its automatic choice is unresolved, that choice applies to every API. A specific default Direct3D engine, or an explicit choice for every API, goes through the private loader instead. When only some APIs have their own choice and the others still depend on CrossOver's unresolved automatic choice, the game keeps CrossOver's automatic combination, and the inspector explains that the choices are linked. With a specific default Direct3D engine, the remaining APIs need no choices of their own. CrossOver's application files remain unchanged.

A game saved by an earlier MacLauncher version keeps its earlier **Graphics** and **DXMT support** selections, and on Sikarugir its earlier Vulkan driver, until a Direct3D engine or Vulkan driver is chosen in the new controls. The new choice then takes their place; the earlier controls are no longer shown.

The DXMT version actually used for Direct3D 11 also supplies camera support. Because the camera adapter still requires its own matching libraries, a DXMT version that does not match it stays active as the renderer, and the inspector reports that camera support is unavailable. Engine settings apply to every engine that the game actually uses for its Direct3D APIs.

## Loading

How a selected component is loaded depends on its source and form. CrossOver's own engines are chosen through CrossOver's graphics backend selector. A Direct3D engine from any other source is loaded in one of two ways:

- Replacement Wine builtin DLLs are placed in private Windows DLL directories, with their Unix modules beside the private Wine loader. D3DMetal's matching bridge and framework are selected together.
- Upstream native Windows DLLs, on the other hand, are linked into the environment's `system32` or `syswow64` directory and enabled with native DLL overrides. An existing DLL is set aside before it is replaced and restored when that selection is removed. Native DLLs are not placed for a **Bottle setting** or **Wrapper setting**, so the environment keeps its own files.

For a Vulkan driver override in CrossOver, the selected Vulkan library is placed at the private `libMoltenVK.dylib` location. With KosmicKrisp, the library at that location is the Khronos loader, together with an explicit driver description that names the selected driver. This route works with every CrossOver backend, while the additional `CX_LIBVULKAN` value is set only with WineD3D.

Sikarugir loads the same selected components through its private graphics view and Vulkan driver description. Its Wine engine, its Template and the engine of a registered wrapper stay in place. Selected video codecs reach both runtimes through `GST_PLUGIN_PATH`.

## Compatibility and fallback

Before a launch, Play checks the files that the selected Wine process and Windows executable will load. Only the CPU variant that will actually run is checked, so an unused variant in a multi-architecture installation does not affect the result. Loading counts as impossible when one of these facts holds:

- a required file is missing;
- the files have no PE machine type or native CPU slice for the game and the Wine process;
- a binary declares a macOS minimum above the running system;
- a Unix module needs a symbol that its actual Wine dependency does not export.

Weak imports, imports from system libraries and inspection that cannot be completed do not count as failures. Release numbers, vendor strings and lists of tested versions play no part in the decision.

When a translator cannot load, Play uses the same engine from the selected CrossOver or Template instead. If that runtime has no such engine, Play uses the runtime's automatic choice, as it also does when a saved choice is no longer installed. The saved choice stays selected for later launches, and a warning and the inspector show the selected engine, the engine actually used and the reason.

## Inspector

For each launch, the inspector shows the selected and the actually used components for Direct3D 8 through 12, the Vulkan driver and video codecs. When CrossOver makes its own automatic choice and has not resolved which engine that is, the row stays labeled as CrossOver's automatic choice. Camera support, DLSS and graphics effects use the components that each API actually uses after any fallback. CrossOver's [Vulkan scene support](CROSSOVER.md#vulkan-scene-support) works only while the Vulkan driver stays at CrossOver's automatic choice or a bottle's own setting, so selecting a specific Vulkan driver, including KosmicKrisp, makes it unavailable. Selecting an API does not by itself provide NGX interception through Vulkan or KosmicKrisp.

## Sources and notices

[DXMT](https://github.com/3Shain/dxmt/releases) carries the license of each release: v0.80 uses MIT, and later source uses LGPL-2.1-or-later. [DXVK](https://github.com/doitsujin/dxvk), [D8VK](https://github.com/AlpyneDreams/d8vk), [D9VK](https://github.com/misyltoad/d9vk) and [Gcenx's macOS and async builds](https://github.com/Gcenx/DXVK-macOS) use the zlib license, and [vkd3d-proton](https://github.com/HansKristian-Work/vkd3d-proton) uses LGPL-2.1. The [Sikarugir Template](https://github.com/Sikarugir-App/Template/releases) supplies the notices of its components. [GStreamer](https://gstreamer.freedesktop.org/) and codec dependencies keep their own licenses.

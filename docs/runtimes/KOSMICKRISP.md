# KosmicKrisp

macOS has no Vulkan driver of its own. Vulkan games, the Vulkan-based Direct3D translators in Wine and ANGLE's Vulkan renderer for Android therefore depend on a driver that implements Vulkan on Metal, and MacLauncher offers two: MoltenVK and KosmicKrisp. KosmicKrisp is also available as **MacLauncher KosmicKrisp**, an adapted build that adds the Vulkan features which DXVK, vkd3d-proton and ANGLE use.

## What KosmicKrisp is

[KosmicKrisp](https://docs.mesa3d.org/drivers/kosmickrisp.html) is a Vulkan driver in the [Mesa](https://mesa3d.org/) project, developed by LunarG for Apple Silicon Macs. Khronos has [announced](https://www.khronos.org/news/permalink/kosmickrisp-achieves-vulkan-1.4-conformance-on-apple-silicon) that it passed the Vulkan 1.4 conformance tests and is a conformant Vulkan 1.4 implementation on Apple Silicon; an earlier version was conformant to Vulkan 1.3. Because the driver is built on Metal 4, it requires macOS 26 or later.

Metal 4 shapes how the driver works. Vulkan command buffers are recorded into Metal 4 command buffers and submitted through Metal 4 command queues. A single Metal 4 compute encoder carries compute dispatches together with buffer and texture copies, render passes use Metal 4 render encoders, and resources are bound through argument tables and residency sets. Shaders pass through Mesa's NIR into the Metal Shading Language, version 4.0 on macOS 26 and 4.1 on macOS 27 and later, and Metal 4's compiler interface compiles them.

KosmicKrisp does not expose `VK_KHR_portability_subset`, the extension through which a Vulkan implementation lists the parts of Vulkan that it leaves out. Applications and the Vulkan loader therefore treat it as an ordinary Vulkan driver.

## KosmicKrisp and MoltenVK

[MoltenVK](https://github.com/KhronosGroup/MoltenVK) is the older Vulkan driver for macOS. Its README describes it as a layered implementation of Vulkan 1.4 on Metal that is not fully compliant with the Vulkan specification, and it reports what it omits through `VK_KHR_portability_subset`. MoltenVK runs on Intel and Apple Silicon Macs from macOS 12. The MoltenVK README also states that Khronos has deprecated MoltenVK and that the repository is maintained by the community on a best-effort basis. According to the same notice, Khronos recommends KosmicKrisp for Vulkan on Apple Silicon Macs, while MoltenVK remains the recommended option for Intel-based Macs and iOS.

MacLauncher uses both drivers. MoltenVK serves Intel Macs, macOS versions before 26 and virtual machines, since KosmicKrisp needs Metal 4 on physical Apple Silicon hardware. It is also the driver that CrossOver includes, and native ART execution on Android requires its Metal texture attachment interface. On an Apple Silicon Mac with macOS 26 or later, KosmicKrisp is available as well.

## Builds and sources

MacLauncher can install two KosmicKrisp builds, and a third comes with Sikarugir:

| Build | Source | CPU builds |
| --- | --- | --- |
| KosmicKrisp | [LWJGL's native builds](https://www.lwjgl.org/browse/release) of Mesa, identified by LWJGL release tag and Mesa source commit | arm64 |
| MacLauncher KosmicKrisp | The `maclauncher-kosmickrisp` package from [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds) | arm64 and x64 packages |
| Sikarugir Template KosmicKrisp | The Vulkan libraries of a [Sikarugir Template](SIKARUGIR.md) | x64 |

Each build needs a Khronos Vulkan loader beside the driver. LWJGL's builds use Homebrew's published Vulkan-Loader bottle, while each MacLauncher KosmicKrisp package contains a loader built from source together with the driver.

MacLauncher KosmicKrisp is built from a pinned Mesa commit, to which MacLauncher Builds applies its KosmicKrisp patch set. The package described on this page has these identities:

| Item | Identity |
| --- | --- |
| Package version | `27.0.0-devel-MCLv12` |
| Mesa source | Commit `4f071f891d63396c799b267172c19ba6b0301682` (Mesa 27.0.0-devel) |
| Vulkan loader | Khronos Vulkan-Loader commit `f2389e27734347c1d9f40e03be53f69f969976b1` |
| Minimum macOS | 26.0 |
| Earlier package ID | `vulkan-kosmickrisp-gles32` |

Installations, default versions and saved choices recorded under the earlier package ID are read as MacLauncher KosmicKrisp, so they keep working under the current name.

## CPU builds and consumers

A Vulkan driver and its loader are native macOS libraries, and each must contain code for the CPU architecture of the process that loads it. For a Windows game, that process is Wine's native side, so the CPU of the Wine build decides, not the game's own executable. Each consumer loads these builds:

| Consumer | Loading process | KosmicKrisp build | MoltenVK build |
| --- | --- | --- | --- |
| CrossOver with Intel Wine | x64 Wine; Rosetta on Apple Silicon | x64 | x64 slice of an x64 or universal library |
| CrossOver with ARM64 Wine | arm64 Wine; FEX runs the Windows x86-64 code | arm64 | arm64 slice of an arm64 or universal library |
| Sikarugir | x64 Wine; Rosetta on Apple Silicon | x64 | x64 slice of an x64 or universal library |
| Sikarugir GPU compute helper, used by XeSS | x64 Wine helper | x64, from the Sikarugir Template | Not used |
| CrossOver Wine Vulkan scene adapter | x64 Wine | Not used | x64 build of MoltenVK scene support |
| AnyPS5 | x64 host; Rosetta on Apple Silicon | x64 | x64 slice of an x64 or universal library |
| Prosper | x64 host; Rosetta on Apple Silicon | x64 | x64 slice of an x64 or universal library |
| Android, with JVM or ART execution, ANGLE's Vulkan renderer and native Vulkan apps | arm64 host | arm64 | arm64 slice of an arm64 or universal library |
| Shared libplacebo effects | The graphics host, arm64 or x64 | Not used | Universal library packaged with the effects |

For CrossOver, the architecture is read from the native Wine loader of the selected installation, never from version numbers or folder names. Translator lists for a Wine game then contain only builds with code for that architecture. Android always selects and installs arm64 builds, whatever the launcher's own CPU or a saved default. A universal MoltenVK library contains both slices, and the loading process uses its own.

Because LWJGL's KosmicKrisp builds contain only arm64 code, they can serve Android and ARM64 Wine but never an x64 process. KosmicKrisp needs Metal 4 on Apple Silicon in every case, so an x64 build runs only under Rosetta on an Apple Silicon Mac, and its requirement is judged by the Mac's hardware rather than by the CPU of the process. [Downloads and offline use](README.md#downloads-and-offline-use) describes how an Intel program such as AnyPS5 or Prosper is offered the x64 MacLauncher KosmicKrisp package.

## Selection and loading

**Runtimes → Graphics → Vulkan drivers** holds MoltenVK, KosmicKrisp and MacLauncher KosmicKrisp. Each consumer then chooses a driver in its own settings:

| Consumer | Setting | Automatic choice |
| --- | --- | --- |
| CrossOver and Sikarugir | **Vulkan driver** in Runtime Settings, with its default in Settings ([Selection](TRANSLATORS.md#selection)) | The Wine runtime's own driver. Sikarugir's Template prefers its KosmicKrisp on a physical Apple Silicon Mac with macOS 26 or later. |
| Android | **Vulkan implementation** in **Settings → Android** and in each game's settings ([Android](../game-types/ANDROID.md)) | An installed MoltenVK, then an installed KosmicKrisp, then a compatible MacLauncher KosmicKrisp |
| AnyPS5 and Prosper | **Vulkan** in the game's settings ([PlayStation 5](../game-types/PS5.md)) | Prefers KosmicKrisp |

MoltenVK's library is loaded directly. KosmicKrisp, by contrast, is reached through the Khronos Vulkan loader, which finds drivers through ICD manifests: small JSON files that name a driver library and its Vulkan version. Before a launch, MacLauncher writes such a manifest as `vulkan-icd.json` and points the loader to it with `VK_DRIVER_FILES` and `VK_ICD_FILENAMES`. A manifest supplied with the driver keeps its fields, while `library_path` becomes the absolute path of the selected driver and `is_portability_driver` is set to false. A driver without a manifest of its own, such as a MacLauncher KosmicKrisp package, receives one that declares Vulkan 1.4.0, because the loader withholds Vulkan 1.1 and later features from a driver declared as Vulkan 1.0. An unchanged manifest is not rewritten. [Loading](TRANSLATORS.md#loading) describes where Wine finds the loader.

A MacLauncher KosmicKrisp package is installed only after its archive matches the SHA-256 recorded in the MacLauncher Builds catalog and the code signatures of its native files are verified. Besides the driver, `libvulkan_kosmickrisp.dylib`, and the loader, `libvulkan.1.dylib`, the package contains the compiler and compression libraries that the driver loads through relative paths, its license notices and records of its dependencies. Each version is installed once and shared by every game that selects it, and an installed version works offline.

Neither KosmicKrisp build writes a Mesa disk shader cache. Compiled pipelines are kept across launches through the `VkPipelineCache` data that an application or translator stores itself. KosmicKrisp derives the pipeline cache UUID from its driver build, so cache data from a different build is not reused. In MacLauncher KosmicKrisp, shader cache keys also record the enabled device features that change shader compilation.

## Features of MacLauncher KosmicKrisp

MacLauncher KosmicKrisp adds Vulkan features that upstream KosmicKrisp does not expose at the same Mesa commit. Each one is implemented on Metal. Some exist because a particular consumer requires them, as [Where the differences matter](#where-the-differences-matter) explains; the others widen what Vulkan applications in general can use.

### Rasterization, geometry and queries

- Transform feedback (`VK_EXT_transform_feedback`) with geometry streams, and primitives-generated queries (`VK_EXT_primitives_generated_query`). Transform feedback uses Mesa Poly together with KosmicKrisp's own shader compiler and GPU command encoders.
- Non-solid polygon fill (`fillModeNonSolid`), which provides wireframe and point fill modes.
- Wide, rectangular, smooth and stippled Bresenham lines.
- Pipeline statistics queries.
- Variable multisample rate, which allows rendering without attachments at differing sample counts, as Direct3D 11.1 and 12 need.
- Depth bias control (`VK_EXT_depth_bias_control`), including exact and forced UNORM representations.
- Conservative rasterization (`VK_EXT_conservative_rasterization`), with an overestimation of 1/256 pixel, rasterized degenerate triangles and a fully covered fragment input. Underestimation and post-depth coverage are not supported.
- Fragment shader interlock (`VK_EXT_fragment_shader_interlock`) with sample interlock on Apple GPU family 7 and later. Pixel interlock is not exposed, because Metal's raster order groups keep different samples of one pixel apart under per-sample shading and therefore do not give the per-pixel guarantee that pixel interlock defines.
- Rasterization-order access (`VK_EXT_rasterization_order_attachment_access`) for color attachments on Apple GPU family 7 and later. Depth and stencil attachments have no such access.
- Mesh and task shaders (`VK_EXT_mesh_shader`) with mesh shader queries, and multiview together with geometry and tessellation shaders.

### Resources and memory

- Sparse binding and sparse residency for buffers, 2D and 3D images and aliased memory, together with shader resource residency. These are built on Metal placement sparse resources and are exposed when the Metal device supports them.
- Single-texel alignment for uniform and storage texel buffer views.
- Multisampled storage images with one, two or four samples.
- Descriptor heaps (`VK_EXT_descriptor_heap`), device-generated commands (`VK_EXT_device_generated_commands`) and device address commands (`VK_KHR_device_address_commands`).
- Vertex input dynamic state, and extended dynamic state for polygon mode, rasterization samples, sample mask, alpha to coverage, line stipple and conservative rasterization mode.
- Dynamic rendering with unused attachments, multisampled rendering to single-sampled images, sliced views of 3D images, non-seamless cube maps, image compression control, image alignment control (`VK_MESA_image_alignment_control`) and zero-initialized device memory.
- External memory through file descriptors, memory priority and pageable device-local memory.
- `VK_KHR_maintenance11` and `VK_KHR_extended_flags`.
- Minimum and maximum sampler filtering on every Apple GPU; upstream offers it from Apple GPU family 10.
- Custom border colors with border color swizzling, and minimum LOD for image views, enabled by default. Upstream KosmicKrisp treats them as experimental features and enables them only when `MESA_KK_EXPERIMENTAL` names them. In both builds, a value of `MESA_KK_EXPERIMENTAL` replaces the default selection.

### Shaders

- 64-bit floating point, computed in software as binary64 arithmetic, with fused multiply-add, round-to-nearest-even and preserved signed zero, infinity and NaN.
- 64-bit integer atomics on buffers and shared memory, and on images on Apple GPU family 8 and later.
- Independent float controls for each width. A shader can request preserved or flushed 32-bit denormals, and 16-bit and 64-bit denormals are preserved.
- 8-bit floating point (`VK_EXT_shader_float8`), cooperative matrices in compute shaders (`VK_KHR_cooperative_matrix`) and long vectors (`VK_EXT_shader_long_vector`).
- Compute shader derivatives in linear groups, fragment shader barycentrics where Metal reports barycentric coordinate support, and quad control (`VK_KHR_shader_quad_control`).
- Subgroup operations in vertex, tessellation and geometry shaders as well as compute and fragment shaders, and required subgroup sizes for compute shaders.

### Presentation

- `VK_GOOGLE_display_timing` for requested presentation times and presentation history.
- `VK_KHR_incremental_present`, which accepts damage regions and presents the complete image.
- `VK_EXT_headless_surface` for offscreen swapchains on macOS, where upstream builds leave it out.

### Limits

| Limit | Upstream KosmicKrisp | MacLauncher KosmicKrisp |
| --- | --- | --- |
| Push constants | 256 bytes | 4,096 bytes |
| Simultaneous memory allocations | 4,096 | 8,192 |
| Indirect draw count | 65,535 | 2<sup>30</sup> |

Neither build exposes ray tracing (acceleration structures, ray queries or ray tracing pipelines), fragment shading rate, pixel interlock or shading-rate interlock.

## Compatibility with MoltenVK

The table compares upstream KosmicKrisp at Mesa commit `4f071f89`, MacLauncher KosmicKrisp `27.0.0-devel-MCLv12` and MoltenVK 1.4.2.

| Capability | KosmicKrisp | MacLauncher KosmicKrisp | MoltenVK 1.4.2 |
| --- | --- | --- | --- |
| Vulkan version | 1.4, Khronos conformant | 1.4 | 1.4, with `VK_KHR_portability_subset` |
| Metal | Metal 4 | Metal 4 | Metal, without Metal 4 interfaces |
| macOS | 26 or later | 26.0 or later | 12.0 or later |
| Macs | Apple Silicon | Apple Silicon, with the x64 build under Rosetta | Intel and Apple Silicon |
| Geometry shaders | Yes | Yes | No |
| Tessellation shaders | Yes | Yes | Yes |
| Non-solid polygon fill | No | Yes | Yes |
| Wide lines | No | Yes | Only with MoltenVK's Metal private API option |
| Transform feedback and primitives-generated queries | No | Yes | No |
| Pipeline statistics queries | No | Yes | No |
| Robust buffer access 2 and null descriptors | Yes | Yes | No; the robustness2 extension is present without these features |
| Single-texel alignment of texel buffer views | No | Yes | Computed per format from the Metal device |
| Variable multisample rate | No | Yes | No |
| Multisampled storage images | No | Yes | No |
| 64-bit floating point in shaders | No | Yes, in software | No |
| 64-bit integer atomics on buffers and shared memory | No | Yes | No |
| Sparse binding and residency | No | Where Metal supports placement sparse resources | No |
| Conservative rasterization | No | Overestimation | No |
| Fragment shader interlock | No | Sample interlock | Pixel and sample interlock where Metal supports raster order groups |
| Mesh and task shaders | No | Yes | No |
| Cooperative matrices | No | Yes | No |
| Custom border colors | Through `MESA_KK_EXPERIMENTAL` | Yes | No |
| Vertex input dynamic state | No | Yes | No |
| Push constants | 256 bytes | 4,096 bytes | 4,096 bytes |
| Fragment shading rate | No | No | No |
| Ray tracing | No | No | No |

The Khronos conformance shown for KosmicKrisp belongs to upstream KosmicKrisp. MacLauncher KosmicKrisp is a modified build and has no conformance submission of its own.

## Where the differences matter

### Direct3D 8 to 11 through DXVK

DXVK 2.x and 3.x require Vulkan 1.3 and a fixed set of device features, among them geometry shaders, non-solid polygon fill, and the robust buffer access and null descriptors of robustness2. Upstream KosmicKrisp lacks non-solid fill, and MoltenVK lacks geometry shaders and those robustness2 features, so these DXVK versions cannot create a device on either. MacLauncher KosmicKrisp provides all of them. With MoltenVK, Direct3D 8 to 11 instead use DXVK builds made for it: the DXVK-macOS packages and the Sikarugir Template's `dxvk` folder. DXVK also uses transform feedback for Direct3D stream output when the driver supports it.

### Direct3D 12 through vkd3d-proton

vkd3d-proton refuses to create a device unless the driver provides transform feedback queries, single-texel alignment of texel buffer views, vertex attribute divisors including a zero divisor, the robust buffer and image access and null descriptors of robustness2, push descriptors, shader draw parameters and mirror-clamp-to-edge sampling. Upstream KosmicKrisp lacks transform feedback and single-texel alignment, while MoltenVK lacks transform feedback and the robustness2 features. MacLauncher KosmicKrisp provides each requirement, and the **Direct3D 12** control recommends KosmicKrisp for vkd3d-proton.

### Direct3D feature levels

DXVK and vkd3d-proton each derive a game's highest Direct3D feature level from the driver's features. Their conditions are:

| Feature level | DXVK, for Direct3D 11 | vkd3d-proton, for Direct3D 12 |
| --- | --- | --- |
| 11_1 | Logic operations, and stores and atomics in vertex pipeline stages | The same, plus 64 storage buffer and 64 storage image descriptors per stage |
| 12_0 | Tiled resources tier 2 and typed UAV loads of additional formats | Tiled resources tier 2, resource binding tier 2 and typed UAV loads of additional formats |
| 12_1 | Rasterizer-ordered views and conservative rasterization tier 1 | Rasterizer-ordered views and conservative rasterization tier 1 |
| 12_2 | Not offered | Shader model 6.5, ray tracing tier 1.1, variable shading rate tier 2, mesh shader tier 1, sampler feedback, tiled resources tier 3, conservative rasterization tier 3, resource binding tier 3 and further options |

Tiled resources tier 2 rests on Vulkan sparse residency, so feature level 12_0 needs the sparse features that MacLauncher KosmicKrisp exposes where Metal supports placement sparse resources. Both translators report rasterizer-ordered views only when the driver offers pixel interlock. MacLauncher KosmicKrisp offers sample interlock alone, so neither translator reports feature level 12_1 or higher on it. Feature level 12_2 would also require ray tracing and variable rate shading, which no KosmicKrisp build provides.

### OpenGL ES on Android through ANGLE

[ANGLE](https://chromium.googlesource.com/angle/angle) provides OpenGL ES to Android games. Its Metal renderer, which is the default, offers OpenGL ES 3.0 in the ANGLE version that MacLauncher includes. When an APK requires a newer OpenGL ES version and no backend has been chosen explicitly, launch switches to ANGLE's Vulkan renderer with the selected Vulkan implementation, and installs MoltenVK after consent when none is installed. Native ART execution uses MoltenVK for its shared buffers.

ANGLE's Vulkan renderer enables geometry and tessellation shaders, which OpenGL ES 3.2 requires, only when the driver supports transform feedback together with primitives-generated or pipeline statistics queries. Upstream KosmicKrisp and MoltenVK lack transform feedback, so ANGLE's conformant feature set stops at OpenGL ES 3.1 on them. MacLauncher KosmicKrisp supplies transform feedback and both kinds of query. The OpenGL ES version that an app sees comes from context creation on the selected backend.

### Vulkan games, AnyPS5 and Prosper

Games and runtimes that use Vulkan directly receive the selected driver's features without a translator in between. AnyPS5 and Prosper run as x64 programs, so they load an x64 driver build, and their automatic choice prefers KosmicKrisp.

### D3DMetal and DXMT

D3DMetal and DXMT translate Direct3D to Metal without Vulkan, so the Vulkan driver has no effect on them. D3DMetal, Apple's translator from the Game Porting Toolkit, covers Direct3D 11 and 12 for 64-bit games on Apple Silicon. DXMT covers Direct3D 10 and 11 from macOS 14. [Graphics translators](TRANSLATORS.md) describes both, together with their selection.

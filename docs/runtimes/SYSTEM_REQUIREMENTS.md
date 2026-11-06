# System requirements

MacLauncher requires macOS 13 or later. It comes as two separate apps, one for Apple Silicon and one for Intel, which share the same library, settings and installed runtimes. By default, each app selects the processor build that matches its own, even when the Intel app runs through Rosetta on Apple Silicon. Other published processor builds can be chosen in **Runtimes**, as described in [Processor builds](README.md#processor-builds).

Apple Silicon Macs execute ARM64 code directly and Intel code through [Rosetta](ROSETTA.md), while Intel Macs execute Intel code. A Universal binary contains both processor builds as separate slices. Native libraries that are loaded inside a game must match the game's process, but independent helpers can use a different processor build.

## Runtimes and downloaded tools

Each selected runtime determines its own requirements. MacLauncher reads the processor slices and minimum macOS versions of the downloaded executables and native libraries, and it keeps these requirements with the installation. A newer dependency can therefore raise the requirement of a single version or graphics backend. A runtime minimum below macOS 13, on the other hand, does not lower the launcher's own minimum.

MacLauncher Builds is a companion repository that publishes compiled packages for MacLauncher to download. Its [package verification](https://procrastinine.github.io/maclauncher-builds/verification.html) page lists each exact package with its source and verification records, and the [package index](https://procrastinine.github.io/maclauncher-builds/) lists the available versions and processor builds. Downloads from the original publishers follow those publishers' releases and dependency requirements. Compatible installed versions remain available offline.

The game itself adds requirements through its format and its binary interface (ABI). NW.js and GameMaker runners must match the game's bytecode, Unity Mono players need compatible assemblies and shaders, and Java native libraries must match the selected Java process. When a newer native runtime cannot replace an older compatible Intel runtime line, that line remains available through Rosetta.

A few runtimes are tied to one kind of processor. [Android](../game-types/ANDROID.md), [iOS](../game-types/IOS.md) and [Switch](../game-types/SWITCH.md) games execute ARM game code and require Apple Silicon. HashLink's just-in-time compiler (JIT), by contrast, produces Intel code. The mac32 runtime executes 32-bit Intel applications, and AnyPS5 executes converted Intel game code through Rosetta on Apple Silicon. These requirements apply only to those runtimes, not to the rest of the library.

## Graphics

The [graphics layer](../graphics/README.md) runs on Intel and Apple Silicon. Whether one of its features is available depends on the selected package's requirements, the operating-system APIs, the actual Metal device and the renderer's [scene inputs](../graphics/INPUTS_AND_ADAPTERS.md). When a provider is unavailable, only the operations that use it are affected.

Each feature has a platform minimum. The package selected for a feature can still require a newer macOS version, and the graphics build must also include the requested operation.

<!-- platform-requirements:start -->
| Feature | Minimum macOS | Processor and device |
| --- | --- | --- |
| MetalFX spatial scaling | 13 | Support queried per Metal device |
| MetalFX temporal scaling | 13 | Support queried per Metal device |
| MetalFX denoised scaling | 26 | Support queried per Metal device |
| MetalFX frame interpolation | 26 | Support queried per Metal device |
| MetalFX image interpolation | 26 | Support queried per Metal device |
| VideoToolbox low-latency interpolation | 26 | Support reported by VideoToolbox |
| MetalFX distortion and previous-color inputs | 27 | Support queried per Metal device |
| Metal 4 | 26 | Apple Silicon |
| MLX neural restoration and interpolation | 14 | Apple Silicon |
| FSR 4.1 | 15 | Apple Silicon |
| Window graphics | 15.2 | Support queried per Metal device |
| DXMT | 14 | Support queried per Metal device |
| D3DMetal | 14 | Apple Silicon |
| Sikarugir DXMT | 14 | Support queried per Metal device |
| Sikarugir D3DMetal | 26.4 | Apple Silicon |
| KosmicKrisp | 26 | Apple Silicon |
| Temporal upscaling in Windows games | 14 | Apple Silicon |
| Vulkan renderers for Windows games | 26 | Apple Silicon |
<!-- platform-requirements:end -->

MetalFX support is queried separately for each Metal device, Intel and AMD GPUs included. FSR 4.1 has two paths with different requirements: its SIMD path requires macOS 15 and Apple GPU family 7, and its Metal Performance Primitives path requires macOS 26 and Apple GPU family 10. Temporal algorithms and scene frame generation also need the matching inputs from the renderer.

The graphics package included with MacLauncher, together with its native dependencies, has these requirements:

<!-- selected-graphics-requirements:start -->
| Included component | Package version | Processor | Effective minimum macOS |
| --- | --- | --- | --- |
| Shared graphics effects | 0.3.7 | Apple Silicon and Intel | 13 |
| libplacebo filters and shader compilation | 0.3.7 | Apple Silicon and Intel | 13 |
| ISF shaders | 0.3.7 | Apple Silicon and Intel | 13 |
| Video export | 0.3.7 | Apple Silicon and Intel | 14 |
| Window graphics | 0.3.7 | Apple Silicon and Intel | 15.2 |
| MLX neural processing | 0.3.7 | Apple Silicon | 14 |
| Neural video decoding and encoding | 0.3.7 | Apple Silicon | 26 |
| Shared graphics effects | 0.3.7 | Intel | 13 |
| libplacebo filters and shader compilation | 0.3.7 | Intel | 13 |
| ISF shaders | 0.3.7 | Intel | 13 |
| Video export | 0.3.7 | Intel | 14 |
| Window graphics | 0.3.7 | Intel | 15.2 |
<!-- selected-graphics-requirements:end -->

Shaders are prepared with the selected compiler, so preparation follows the requirements of that compiler's dependencies, including the compiler's minimum for each processor. Once prepared, MagpieFX effects execute on Metal from macOS 13. Shader collections and model weights contain data, and the provider that executes them determines their processor, macOS and GPU requirements. For Intel game processes on Apple Silicon, MLX uses an ARM64 service.

Of the two Vulkan drivers, KosmicKrisp requires Apple Silicon and Metal 4, while MoltenVK follows the requirements of its selected native libraries and the operations that the Metal device supports. XeSS follows the requirements of its selected compute host. When Lossless Scaling models are acquired through SteamCMD, the acquisition uses Rosetta on Apple Silicon. [Graphics providers](../graphics/PROVIDERS.md) describes the algorithms and their inputs.

## Windows compatibility runtimes

CrossOver and Sikarugir run Windows programs in Intel Wine processes, which use Rosetta on Apple Silicon. The Wine engine and each renderer keep separate requirements. In Sikarugir, each Wine engine is paired with a Template, a package of the support libraries that the engine needs. Because MacLauncher reads the requirements of the installed renderer's libraries, a newer Template or graphics dependency can raise that renderer's minimum without disabling a compatible Wine engine or another renderer.

DXMT starts at macOS 14 with a compatible Metal GPU. D3DMetal requires Apple Silicon, and its effective macOS minimum is read from the installed D3DMetal libraries and everything they depend on. KosmicKrisp requires Apple Silicon and macOS 26. Renderer selection and bottle settings are described in [Sikarugir](SIKARUGIR.md) and [CrossOver](CROSSOVER.md).

## Helpers and tool hosts

The launcher's tools run in several kinds of host. Tools written as scripts or WebAssembly run in the included Python and Electron, Java tools use the shared Java host, and .NET tools use a runtime compatible with their target framework. A host's requirements are read from the native files of its selected build. Windows-only tools use the selected Sikarugir or CrossOver engine. Valve's macOS SteamCMD, however, is an Intel program.

Native helpers that run on their own use the selected processor build, whereas libraries injected into a game process contain the processor slices that match it. [Runtime distribution](RUNTIME_DISTRIBUTION.md) describes how the included components are delivered and which notices they require.

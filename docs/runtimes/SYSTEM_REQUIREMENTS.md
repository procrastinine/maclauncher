# System requirements

MacLauncher requires macOS 13 or later. It comes as two separate apps, one for Apple Silicon and one for Intel, which share the same library, settings and installed runtimes. Each app picks the runtime builds for its own processor by default, even when the Intel app runs through Rosetta on Apple Silicon. Other published processor builds can be chosen in **Runtimes**, as described in [Processor builds](README.md#processor-builds).

On Apple Silicon, ARM64 code runs directly and Intel code runs through [Rosetta](ROSETTA.md); Intel Macs run Intel code only. A Universal binary holds both processor builds as separate slices. Native libraries loaded inside a game must match the game's process, whereas independent helpers can use a different processor build.

## Runtimes and downloaded tools

Every runtime brings its own requirements. MacLauncher reads the processor slices and minimum macOS versions of the downloaded executables and native libraries and stores them with the installation, so a newer dependency can raise the requirement of a single version or graphics backend. A runtime whose minimum is below macOS 13 does not lower the launcher's own minimum, however.

Some of these downloads come from MacLauncher Builds, a companion repository that publishes compiled packages for MacLauncher to download. Its [package verification](https://procrastinine.github.io/maclauncher-builds/verification.html) page lists each exact package with the source it was built from and how it was verified. The [package index](https://procrastinine.github.io/maclauncher-builds/) lists every package with its latest version and that version's downloads, and each package's own page lists its published versions and what changed in each. Downloads from the original publishers follow those publishers' releases and dependency requirements. Compatible installed versions of either kind remain available offline.

The game itself adds requirements through its format and its binary interface (ABI). For example, NW.js and GameMaker runners must match the game's bytecode, Unity Mono players need compatible assemblies and shaders, and Java native libraries must match the selected Java process. When a newer native runtime cannot replace an older Intel runtime line that a game needs, that line stays available through Rosetta.

A few runtimes are tied to one kind of processor. [Android](../game-types/ANDROID.md), [iOS](../game-types/IOS.md) and [Switch](../game-types/SWITCH.md) games run ARM game code and so require Apple Silicon. HashLink's just-in-time compiler (JIT), by contrast, produces Intel code. The mac32 runtime runs 32-bit Intel applications, and AnyPS5's converter versions run converted Intel game code through Rosetta on Apple Silicon, while its FEX version, which requires Apple Silicon, runs the game's Intel code with FEX inside an Apple Silicon host. These requirements apply to those runtimes alone and leave the rest of the library unaffected. [Processor compatibility](PROCESSOR_COMPATIBILITY.md) lists the processor code of every component.

## Graphics

The [graphics layer](../graphics/README.md) runs on Intel and Apple Silicon. Whether a given feature is available depends on the selected package's requirements, the operating-system APIs, the Metal device in the Mac and the renderer's [scene inputs](../graphics/INPUTS_AND_ADAPTERS.md). Features rely on providers such as MetalFX or MLX, and when a provider is unavailable, only the operations that use it are affected.

The table below gives each feature's platform minimum. The package selected for a feature can still require a newer macOS version, and the graphics build must also include the requested operation.

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
| KosmicKrisp | 26 | Apple Silicon |
| Temporal upscaling in Windows games | 14 | Apple Silicon |
| Vulkan renderers for Windows games | 26 | Apple Silicon |
<!-- platform-requirements:end -->

MetalFX support is queried separately for each Metal device, Intel and AMD GPUs included. FSR 4.1 has two implementations with different requirements: its SIMD version requires macOS 15 and Apple GPU family 7, and its Metal Performance Primitives version requires macOS 26 and Apple GPU family 10. Temporal algorithms and scene frame generation also need the matching inputs from the renderer.

MacLauncher includes a graphics package of its own. Together with its native dependencies, it has these requirements:

<!-- selected-graphics-requirements:start -->
| Included component | Package version | Processor | Effective minimum macOS |
| --- | --- | --- | --- |
| Shared graphics effects | 0.3.14 | Apple Silicon and Intel | 13 |
| libplacebo filters and shader compilation | 0.3.14 | Apple Silicon and Intel | 13 |
| ISF shaders | 0.3.14 | Apple Silicon and Intel | 13 |
| Video export | 0.3.14 | Apple Silicon and Intel | 14 |
| Window graphics | 0.3.14 | Apple Silicon and Intel | 15.2 |
| MLX neural processing | 0.3.14 | Apple Silicon | 14 |
| Neural video decoding and encoding | 0.3.14 | Apple Silicon | 26 |
<!-- selected-graphics-requirements:end -->

Shaders are prepared with the selected compiler, so preparing them is subject to the requirements of that compiler's dependencies, including the compiler's minimum for each processor. Once prepared, MagpieFX effects run on Metal from macOS 13. Shader collections and model weights are data, so their processor, macOS and GPU requirements are those of the provider that runs them. For Intel game processes on Apple Silicon, MLX runs in a separate ARM64 service.

Of the two Vulkan drivers, KosmicKrisp requires Apple Silicon and Metal 4, while MoltenVK depends on its selected native libraries and on the operations that the Metal device supports. XeSS has the requirements of its selected compute host. Downloading Lossless Scaling models through SteamCMD uses Rosetta on Apple Silicon. [Graphics providers](../graphics/PROVIDERS.md) describes the algorithms and their inputs.

## Windows compatibility runtimes

The [Wine runtimes](WINE.md), CrossOver, Sikarugir and WineCX, run Windows programs in Wine processes. Sikarugir, WineCX and CrossOver's Intel Wine are x86-64 processes and use Rosetta on Apple Silicon, whereas a CrossOver installation with an ARM64 Wine loader runs as an arm64 process. [KosmicKrisp](KOSMICKRISP.md#cpu-builds-and-consumers) lists the graphics libraries that each of them loads.

The Wine engine and each renderer have separate requirements. In Sikarugir, each Wine engine is paired with a Template, a package of the support libraries that the engine needs. MacLauncher reads the requirements from the libraries of the installed renderer, so a newer Template or graphics dependency can raise that renderer's minimum without disabling a compatible Wine engine or another renderer. A downloaded Wine's own minimum comes from the deployment targets of every native image it installs; current WineCX releases require macOS 26. On an older macOS, installation stops before anything is written, and an installed version that needs a newer macOS is listed as unavailable.

DXMT needs macOS 14 and a compatible Metal GPU. D3DMetal requires Apple Silicon, and its effective macOS minimum is read from the installed D3DMetal libraries and everything they depend on. KosmicKrisp requires Apple Silicon and macOS 26. Renderer selection and bottle settings are described in [Sikarugir](SIKARUGIR.md), [CrossOver](CROSSOVER.md) and [WineCX](WINECX.md).

## Helpers and tool hosts

The launcher's tools need a host program to run in, and the host depends on the tool. Scripts and WebAssembly tools run in the included Python and Electron, Java tools use the shared Java host, and .NET tools use a runtime compatible with their target framework. Each host's requirements are read from the native files of its selected build. Windows-only tools use the selected Sikarugir or CrossOver engine, and Valve's macOS SteamCMD is an Intel program.

Native helpers that run on their own use the selected processor build. Libraries injected into a game process, on the other hand, contain the processor slices that match that process. [Runtime distribution](RUNTIME_DISTRIBUTION.md) describes how the included components are delivered and which notices they require.

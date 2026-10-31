# System requirements

MacLauncher requires macOS 13 or later. Separate Apple Silicon and Intel apps share the same library, settings and installed runtimes. Each app selects its own processor build by default, including when the Intel app runs through Rosetta on Apple Silicon. **Runtimes** also offers other published processor builds, as described in [Processor builds](README.md#processor-builds).

Apple Silicon Macs execute ARM64 code directly and Intel code through [Rosetta](ROSETTA.md). Intel Macs execute Intel code. A Universal binary contains both processor builds. Native libraries loaded inside a game must match that game's process; independent helpers can use a different processor build.

## Runtimes and downloaded tools

The selected runtime determines its requirements. MacLauncher reads processor slices and minimum macOS versions from downloaded executables and native libraries, and retains the requirements with the installation. A newer dependency can raise the requirement of one version or graphics backend. A runtime's minimum below macOS 13 does not lower the launcher's own minimum.

[MacLauncher Builds package verification](https://procrastinine.github.io/maclauncher-builds/verification.html) lists the exact managed packages and their source and verification records. The [package index](https://procrastinine.github.io/maclauncher-builds/) provides the available versions and processor builds. Original-publisher downloads follow their own releases and dependency requirements. Compatible installed versions remain available offline.

Game format and ABI requirements also apply: NW.js and GameMaker runners must match game bytecode; Unity Mono players require compatible assemblies and shaders; Java native libraries must match the selected Java process. Older compatible Intel runtime lines remain available through Rosetta when a newer native runtime cannot replace them.

[Android](../game-types/ANDROID.md), [iOS](../game-types/IOS.md) and [Switch](../game-types/SWITCH.md) execution uses ARM game code and requires Apple Silicon. HashLink's JIT produces Intel code. mac32 executes 32-bit Intel applications, and AnyPS5 executes converted Intel game code through Rosetta on Apple Silicon. These requirements apply to those runtimes rather than the rest of the library.

## Graphics

The [graphics layer](../graphics/README.md) runs on Intel and Apple Silicon. Availability combines the selected package's requirements, operating-system APIs, the actual Metal device and the renderer's [scene inputs](../graphics/INPUTS_AND_ADAPTERS.md). An unavailable provider affects only the operations that use it.

Each feature has a platform minimum, while its selected payload can require a newer macOS version. The graphics build must include the requested operation.

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

MetalFX support is queried separately for each Metal device, including Intel and AMD GPUs. FSR 4.1's SIMD path requires macOS 15 and Apple GPU family 7; its Metal Performance Primitives path requires macOS 26 and Apple GPU family 10. Temporal algorithms and scene frame generation require their matching renderer inputs.

The included graphics package and its native dependencies have these requirements:

<!-- selected-graphics-requirements:start -->
| Included component | Package version | Processor | Effective minimum macOS |
| --- | --- | --- | --- |
| Shared graphics effects | 0.3.1 | Apple Silicon and Intel | 13 |
| libplacebo filters and shader compilation | 0.3.1 | Apple Silicon and Intel | 13 |
| ISF shaders | 0.3.1 | Apple Silicon and Intel | 13 |
| Video export | 0.3.1 | Apple Silicon and Intel | 13 |
| MLX neural processing | 0.3.1 | Apple Silicon | 14 |
| Neural video decoding and encoding | 0.3.1 | Apple Silicon | 26 |
| Shared graphics effects | 0.3.1 | Intel | 13 |
| libplacebo filters and shader compilation | 0.3.1 | Intel | 13 |
| ISF shaders | 0.3.1 | Intel | 13 |
| Video export | 0.3.1 | Intel | 13 |
<!-- selected-graphics-requirements:end -->

Shader preparation uses the selected compiler's dependency requirements, including per-processor compiler minima. Prepared MagpieFX effects execute on Metal from macOS 13. Shader collections and model weights contain data; their execution provider determines the processor, macOS and GPU requirements. MLX uses an ARM64 service for Intel game processes on Apple Silicon.

KosmicKrisp requires Apple Silicon and Metal 4. MoltenVK follows the requirements of its selected native libraries and the operations supported by the Metal device. XeSS follows the selected compute host's requirements. Lossless Scaling model acquisition through SteamCMD uses Rosetta on Apple Silicon. [Graphics providers](../graphics/PROVIDERS.md) describes the algorithms and their inputs.

## Windows compatibility runtimes

CrossOver and Sikarugir run Intel Wine processes, which use Rosetta on Apple Silicon. The Wine engine and each renderer retain separate requirements. MacLauncher reads the installed renderer's library requirements, so a newer Template or graphics dependency can raise that renderer's minimum without disabling a compatible Wine engine or another renderer.

DXMT starts at macOS 14 with a compatible Metal GPU. D3DMetal requires Apple Silicon; its installed dependency closure supplies the effective macOS minimum. KosmicKrisp requires Apple Silicon and macOS 26. [Sikarugir](SIKARUGIR.md) and [CrossOver](CROSSOVER.md) describe renderer selection and bottle settings.

## Helpers and tool hosts

Included Python and Electron supply script and WebAssembly hosts for the launcher's tools. Java tools use the shared Java host, and .NET tools use a runtime compatible with their target framework. Host requirements are read from the selected native payload. Windows-only tools use the selected Sikarugir or CrossOver engine; Valve supplies SteamCMD as an Intel program.

Independent native helpers use the selected processor build. Libraries injected into game processes contain the corresponding processor slices. Included-component delivery and required notices are described in [Runtime distribution](RUNTIME_DISTRIBUTION.md).

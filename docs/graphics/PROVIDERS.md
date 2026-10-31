# Graphics providers

[Pipeline overview](PIPELINE.md) · [Graphics guide](README.md)

A provider implements one operation of the graphics pipeline inside MacLauncher's graphics processor, the native component that runs a game's effect chain. The editor's five row types describe what an operation does to the data: **Image filter**, **Downsample**, **Upscale**, **Temporal upscaling** and **Frame generation**. A shader format, model family or compute backend selects an implementation within those types, and a shader's declared output geometry selects its type.

Installing a provider and running it on a frame are separate conditions. An installed temporal provider still needs matching scene inputs, while an image filter needs only its declared image and assets. A missing optional input affects only the row that depends on it, and independent operations elsewhere in the chain keep running.

[Inputs and execution](#inputs-and-execution) · [Spatial resizing](#spatial-resizing) · [Scene-temporal upscaling](#scene-temporal-upscaling) · [Neural rendering, restoration and image upscaling](#neural-rendering-restoration-and-image-upscaling) · [Frame generation](#frame-generation) · [Shader formats and image effects](#shader-formats-and-image-effects) · [Source and feature declarations](#source-and-feature-declarations)

## Inputs and execution

| Input | Meaning |
| --- | --- |
| Color image | The current image with its actual size, orientation, color encoding and alpha convention. It can come from a renderer, decoded video or an earlier operation. |
| Image pair or sequence | Chronological color images with content IDs and timestamps. Motion estimated from images never counts as renderer motion. |
| Renderer guides | Depth, motion, jitter, exposure and camera data that the renderer supplies for the same scene frame, also called scene guides. Their units, sample regions and frame identifiers must match the color image. |
| Camera parameters | The actual near and far planes and vertical field of view, for algorithms that require them. These are separate from full view and projection matrices. |
| View and projection matrices | Explicit, valid matrices associated with the scene frame. Missing matrices are never replaced by identity matrices. |
| Video planes | Luma and chroma from the decoder or native player, or planes derived explicitly from RGB. Derived planes keep a record of that origin. |

Frame textures and inference stay on the GPU. Providers encode into the renderer's command buffer, which they only borrow: encoding neither submits it nor waits for it, and resource preparation compiles pipelines and allocates images outside that callback. Providers that run in another process use size-limited jobs, GPU-backed shared storage and completion metadata; the launcher never carries frame pixels through Electron.

The process's instruction set and the GPU are separate capabilities. Native Metal providers can run in an ARM64 process or a translated x86_64 process when the loaded binary, the OS and the GPU support them. MLX runs in ARM64 code on Apple Silicon, and an ARM64 GPU helper supplies MLX processing to an x86_64 graphics process. The helper does not make an ARM64 library loadable in an x86_64 process.

## Spatial resizing

Spatial operations use one image and its real source and target sizes. They need no depth, scene motion or renderer camera data. Downsampling is a separate row type with its own target sizing, rather than an upscale with a scale below one.

| Provider | Operation and output | Additional input | Platform or contract |
| --- | --- | --- | --- |
| Area | Footprint-weighted reduction to the requested size | None | Native Metal; suited to reduction, not enlargement. |
| Nearest | Source-texel selection at the requested size | None | Native Metal; useful for pixel art and explicit pixel grids. |
| Bilinear | Linear interpolation at the requested size | None | Native Metal. |
| Bicubic | Cubic interpolation at the requested size | None | Native Metal. |
| MetalFX Spatial | Apple's spatial reconstruction to the requested size | None | macOS 13 or later, on a device and format combination that MetalFX supports. |
| FSR 1 | FidelityFX EASU with its RCAS sharpening stage | None | Native Metal adaptation of the original spatial algorithm. |
| MAKO spatial | MAKO's spatial reconstruction and sharpening | None | Native Metal adaptation; separate from MAKO/Lossless frame generation. |
| LS1 | Lossless Scaling's LS1 spatial network | Compatible models imported from a local Lossless Scaling copy | The imported files stay separate from the graphics runtime. |
| libplacebo filters | Named reconstruction and reduction filters from the selected provider | Filter selection | The selected provider's [processor and macOS requirements](../runtimes/SYSTEM_REQUIREMENTS.md#graphics) apply; the available names come from its actual filter list. |
| Scaling shaders | The geometry the shader declares, including fixed scales, conditional scales and requested-size rules | The shader and its declared assets | Run by the shader's original provider. The original hook stages and saved reference images decide when a refinement runs. |

FSR 1 runs AMD's EASU reconstruction followed by RCAS sharpening, with **Sharpness** from 0 to 1. Each pass performs perceptual SDR scaling of up to twice the source size on each axis and preserves alpha. Larger ratios run as successive passes of the same method, each at most 2× per axis. Neither FSR 1 nor MAKO needs model files.

An intrinsic model or shader scale describes that row's own result, and a later explicit resize can fit the result to a different size. Input size and final display size are separate controls. Intermediate work and memory follow the actual sizes of the rows in order.

## Scene-temporal upscaling

These operations consume real renderer guides. A captured final image does not supply them, even when the same runtime can run image effects or color-pair frame generation. Whether a method can run depends on the scene data the runtime actually supplies; there is no list of eligible games or engines.

| Method | Algorithm | Required scene inputs | Output and platform |
| --- | --- | --- | --- |
| MetalFX Temporal | Native MetalFX temporal reconstruction | Color, matching depth and motion, and jitter and exposure conventions | Requested output size; a supported MetalFX device on macOS 13 or later. |
| MetalFX Temporal Denoised | Native denoising and temporal reconstruction | Noisy scene color, depth and motion, view and projection matrices, surface normal and roughness, and diffuse and specular material reflectance | Requested output size; macOS 26 or later and device support for the denoised scaler. |
| FSR 2 | The original FSR 2.2.1 scheduler and shaders, adapted to Metal | Color, depth and motion, jitter, exposure conventions and actual camera parameters; a scene region of at least 32 × 32 for its luminance pyramid | Requested output size; optional universal provider, macOS 13 or later. |
| FSR 3 | The original FSR 3.1.4 temporal upscaler, adapted to Metal | The scene data its scheduler requires | Requested output size; optional universal provider, macOS 13 or later. This row does not select FSR frame generation. |
| FSR 4 | The FSR 4.1.1 shader and model implementation, through the native Mac provider | Matching scene color, depth and motion, and jitter and exposure conventions | Requested output size; the provider requires macOS 15 or later and an Apple Silicon GPU, with its bundled model and shader resources. |
| Arm ASR | The original ASR scheduler with mixed fragment/MRT and compute passes, adapted to Metal | Matching scene color, depth and motion, jitter and exposure, and camera data | Requested output size; optional universal provider, macOS 13 or later. |
| Snapdragon GSR 2 | The original two-pass temporal algorithm, adapted to Metal | Matching color, depth and motion, and jitter, exposure and camera conventions | Requested output size; optional universal provider, macOS 13 or later. |
| XeSS | The original Intel XeSS runtime, through a shared GPU compute host | Matching color, depth and motion, and jitter and exposure conventions | Requested output size; support depends on the actual backend and installed host. |
| DLSS SR scene | MLX-DLSS's scene-input graph | Real color, depth and motion, jitter and exposure conventions, and a compatible local model | The intrinsic 2× model output is fitted on the GPU to the temporal output region. Apple Silicon, macOS 14 or later. |

Reactive masks and transparency or composition masks are optional inputs for algorithms that accept them. They stay distinct from masks estimated from the image. Reversed or infinite depth, output-resolution motion, jittered motion, and source and output regions are explicit conventions. Supported affine transforms update the guides together with the image; after an unknown image warp, the guides are no longer treated as aligned with the scene.

FSR 2 and FSR 3 prepare their pipelines, images and SDK context for the renderer that supplies the scene before encoding. Preparing resources does not encode into the caller's command buffer or advance frame history. A temporal row whose input falls outside its supported domain uses the common fallback, while independent compatible image rows continue.

MetalFX operations use the system framework. The inspector and the Runtimes window share one offline query of the default and available Metal devices, the operations each supports and their temporal scale ranges. Device support does not depend on the game's CPU instruction set. The optional reactive, hit-distance, denoise-strength and transparency inputs follow what the game's renderer actually declares.

### Arm ASR

ASR's Quality, Balanced, Performance and Ultra Performance choices select shader profiles; they do not prescribe a fixed ratio between input and output size. MacLauncher's Metal adaptation keeps the logical render-region boundary for integer RGB loads and gathers, and keeps the SDR history of the Performance profile in the same color domain as its prepared input. The [ASR recipe](../../src/modules/shared/reshade/temporal/asr/source.json) records the exact upstream commit and MacLauncher's changes to it.

### FSR 4

FSR 4's profile control selects Exact Fast, Lite or Lite 2 within the same Temporal upscaling row:

- Exact Fast keeps AMD's original coefficients and runs inference every frame. It is the default.
- Lite uses the upstream folded coefficients, rounding and guarded reuse of inference results.
- Lite 2 supplies six trained layers for the normal model family; its Ultra Performance model remains Lite.

Each profile has its own model and license, and an older installed provider offers only the profiles it contains. Background resource preparation keeps shader and model creation out of encoding. The network output and source alpha are composed on the GPU into the requested output region. FSR 4 uses no camera field of view or matrices.

### XeSS

A shared XeSS provider runs Intel's original Windows library. Super resolution has D3D12 and Vulkan host routes, and **Auto** picks an available compatible route. Compute hosts provided by modules supply the Windows ABI and graphics translation. The game that supplies the frames can be a native application or another scene-capable runtime; it does not need to run under Wine.

The transport uses GPU copies between shared Metal-backed storage and the host's D3D12 or Vulkan resources. CPU messages coordinate ownership and completion; they never read, encode or serialize frame pixels. The backend's capability, the original library and the helper resources are each validated separately. D3D12 and Vulkan rows keep independent prepared configurations when both appear in one chain.

The D3D11/DXMT game API replacement is a separate integration. It forwards the game's XeSS API resources and frame metadata to a configured shared temporal provider. This mapping does not mean that Intel's neural runtime ran, and it does not imply interception support for every D3D12 or Vulkan game API entry point. Unsupported flags or graphics profiles receive the corresponding API error.

Original XeSS components are imported from local files, and each is recorded exactly, together with its license terms. The super-resolution, frame-generation and latency components have separate requirements. Installing the provider code does not by itself install or enable every component.

For frame generation, the adapter supplies unjittered row-major view and projection matrices to the original SDK. It removes declared projection jitter and converts explicit clip-range and Y-orientation representations for its texture rows. Authored view, off-center projection and reverse-depth geometry are preserved. Missing renderer matrices are never inferred from camera parameters.

## Neural rendering, restoration and image upscaling

All the methods below use the shared GPU neural provider. [Neural models and packages](NEURAL_RESTORATION.md) describes the model architectures, how each model is validated against its declared architecture, and the import formats. The selected provider advertises the operations it supports, and older provider builds that support only neural rendering (NR) remain usable for that operation.

| Method | Implemented graph and inputs | Intrinsic output | Model requirement |
| --- | --- | --- | --- |
| DLSS neural rendering (`mlx-dlss`) | MLX-DLSS neural rendering on the current RGB image, with optional temporal estimation from the images | Same size | A compatible neural-rendering package. Temporal estimation uses image history, not engine depth or motion. |
| RTX VSR (`mlx-vsr`) | The RTX Video Super Resolution graph, on independent images | 2× each dimension | A VSR package for that operation. |
| DLSS SR image (`mlx-sr-image`) | MLX-DLSS image-sequence SR, with guides derived from the images | 2× each dimension | An image-SR package; separate from the scene variant, which uses renderer guides. |
| DLSS SR scene (`mlx-sr-scene`) | The scene-input SR graph, with normalized renderer guides | 2×, then fitted to the scene output region | A compatible scene-SR package. |
| Real-ESRGAN (`realesrgan`) | SRVGG-16 anime/video or SRVGG-32 general | 4× each dimension | A supported SRVGG safetensors file or package. |
| Real-CUGAN (`realcugan`) | Standard UpCunet2x, 3x or 4x | The selected model's 2×, 3× or 4× each dimension | The exact typed model and provider architecture. |
| NAFNet (`nafnet`) | SIDD width64 denoising or GoPro width64 deblurring | Same size | A matching float32 graph and tensors. |

These models take display-referred sRGB RGB in their declared range. For HDR or P3 input, the common color boundary can create an explicit local SDR conversion and restore the surrounding image's encoding afterward. That conversion cannot recover highlights the SDR model discards. Alpha is carried separately from RGB inference and restored with its actual convention.

The live neural implementation requires Apple Silicon and macOS 14 or later. ARM64 game processes can use the provider directly, and x86_64 processes translated by Rosetta use the ARM64 helper. In both cases, Metal and IOSurface input, the model operations and the output stay on the GPU. Preparation, live changes, and the loading and release of models use the same provider and model lifecycle.

### Warm-up and time limits

Before a neural row joins the running chain, its provider runs one inference at the row's size, with no frame command buffer waiting on it. That inference reads an opaque black image, so it loads and runs the model. Checks that depend on image content, such as the opaque SDR requirement, apply to the frames the row later consumes.

During warm-up, the graph reports Preparing with the reason "Neural provider is warming up", and the accepted chain keeps rendering. Retries keep the same warming node. After the ordinary two-second preparation grace period, the graph starts running without that row, whose stage keeps reporting Preparing with the same reason. The warmed node joins the graph once its inference completes.

A frame waits at most two seconds for its provider. When an inference takes longer, that frame keeps the row's input image, and later frames bypass the row, with a reason, until the late inference completes. A failed inference makes the row unavailable for a retry interval that starts at one second and doubles up to thirty seconds, with the reason "Neural provider failed; retrying". A successfully rendered inference resets the interval. XeSS host results use the same two-second limit.

## Frame generation

Frame generation produces timestamped images between two chronological endpoints. The common presenter delivers them and schedules their display. Providers never present extra frames on their own or change the application's simulation rate.

| Method | Inputs and algorithm | Generated images | Requirements |
| --- | --- | --- | --- |
| Lossless Scaling (`lsfg`) | A color pair; the original Lossless Scaling model and shaders through MAKO | The configured phases between the pair, up to four intermediate images | Compatible models imported from a local Lossless Scaling copy. Needs no renderer guides. |
| MLX interpolation | A color pair and an explicit phase; the MLX-DLSS interpolation graph | The configured phases, up to four intermediate images | A compatible interpolation model; the Apple Silicon and macOS 14 provider or the ARM64 helper. |
| RIFE | A color pair and an explicit phase; v4.6 four-stage flow refinement and GPU warping | The configured phases, up to four intermediate images | An exactly supported RIFE model; the same provider and helper requirements. |
| MetalFX interpolation | A real scene pair, depth and motion, jitter and exposure, and finite perspective camera data | One midpoint for an eligible real interval | macOS 26 or later and device support for the MetalFX interpolator. |
| FSR 3 interpolation | The original optical-flow and frame-interpolation effects, with real scene data and camera conventions | One midpoint for an eligible real interval | The optional universal Metal provider with its complete shader resources, macOS 13 or later. |
| XeSS interpolation | The original XeSS-FG and XeLL components; real scene color, depth and motion, and view and projection matrices | One midpoint for an eligible real interval | The D3D12 compute-host route and separately imported compatible FG and latency components. |

### LSFG color handling

LSFG keeps its original SDR kernels for ordinary 8-bit sRGB input. HDR and color-converted float input use the original HDR generation kernel, with float graph resources and FP16 source, history and generated images. The shared color adapter converts to linear BT.709/scRGB with an 80-nit reference white, then returns the generated images to the source encoding without an SDR tone-mapping step. Wide-gamut SDR input converted to this linear form also uses the HDR kernel. The real endpoints remain the original images. Initializing the graph's images is a batched GPU preparation step, and the graph becomes usable only after that work completes.

### Combining generation stages

Color-pair providers can consume suitable generated color images from an earlier stage. Scene providers work only between eligible real frames and keep track of which real frame their guides and matrices came from; they never invent renderer guides for an image generated by an earlier stage. Other generated images can stay in the same timeline. Combined stages therefore follow the actual timestamps and origin of each image, and the result is not necessarily the product of their multiplier labels.

### Repeated frames and scene cuts

For Lossless Scaling, MLX interpolation and RIFE, the shared timeline analyzes the input pair. A GPU comparison detects exact repeats of decoded texels, and color differences in the encoded domain, compared against fixed thresholds, give a conservative estimate of scene cuts. These signals come from the images and are separate from renderer reset markers. Each decision belongs to the exact pair, source epoch and upstream image revision it was made for. After the source GPU fence, a repeat, an estimated cut or unmatched history suppresses that pair's synthetic events and their descendants, and the real endpoint is kept. Each selected row budgets one GPU history image in the source format, two compute passes and one GPU image copy per pair. FSR 3 and the scene providers make their own reset and no-interpolation decisions.

### Transparency and history

Lossless Scaling, MetalFX, FSR 3 and XeSS generation declare that they need opaque images. The MLX interpolation and RIFE adapters carry alpha separately from their RGB model inputs. Transparency eligibility belongs to the selected generation provider and does not disable other image operations in the graph.

Reset, discontinuity, source epoch, scene and color geometry, and completion each belong to the relevant history. Paused redraws reprocess the accepted image without advancing generation history. A provider's no-interpolation or failed result is never counted as a generated event, and its real endpoint stays available. XeLL integration in a helper does not establish engine simulation markers or measure input latency end to end.

## Shader formats and image effects

| Format or provider | Supported work | Inputs, assets and platform |
| --- | --- | --- |
| ReShadeFX | Original FX techniques, parameters, textures and multipass effects | Referenced includes and assets must be available. Depth techniques require matching depth from the renderer. |
| RetroArch Slang | Slang shaders and presets, pass geometry, parameters and their declared history and assets | The original preset structure and assets remain part of the prepared input. |
| MPV/libplacebo hooks | Multipass image hooks, parameters, static textures, RGB, luma and chroma operations, and LUT processing | The selected provider's [processor and macOS requirements](../runtimes/SYSTEM_REQUIREMENTS.md#graphics) apply. Native video planes and planes derived from RGB keep their separate origins. |
| libplacebo image filters | The original renderer's debanding, selected by a data-only `.plfilter` descriptor | Iterations, threshold, radius and grain use the original deband parameters. The selected provider advertises its image-filter API, and the filter preserves the input size and alpha. |
| ISF | `inputImage` filters, typed controls, multiple passes and persistent targets, and imported images | The ISFMSLKit provider follows its selected package's [processor and macOS requirements](../runtimes/SYSTEM_REQUIREMENTS.md#graphics). Additional image, audio, FFT and cube inputs need actual bindings; they are not aliases for `inputImage`. |
| MagpieFX | Declared multipass HLSL pixel and compute effects, parameters, intermediate textures and source assets | MacLauncher's parser and translation keep the declared pass resources and output sizes. The graphics processor supplies the compiler and runtime resources. |
| Native image descriptors | Compiled image algorithms selected by typed `.mclfilter` data | A known algorithm ID and parameters within fixed ranges, with no source code or executable paths. The graphics processor advertises the compiled methods it contains. |

Image effects are searchable in the same category whatever their source format. Included collections cover ordinary finishing and appearance effects, and downloadable collections and imported files add further algorithms. Required textures, kernel tables and licenses come with their collection; they never depend on a working directory or an unrelated application installation.

Shader declarations determine geometry and input domain. An RGB effect does not become a native chroma operation because its filename contains "chroma", and a tensor or feature-texture pass does not resize the frame by itself. The original provider receives the exact source and destination sizes.

The native image effects are described below.

### FidelityFX Lens and Blur

FidelityFX Lens and Blur are ordinary Image filters that use the original SDK kernels. Lens has grain, chromatic aberration and vignette controls. Blur selects an odd Gaussian kernel size from 3 to 21 pixels and one of three sigma profiles. Both keep the source dimensions, signed HDR values and source alpha. Lens moves pixel coordinates, so renderer guides cannot pass through it unchanged; Blur keeps coordinates aligned. Their resources are prepared before live encoding.

### Screen-space reflections

Screen-space reflections follow the original Godot schedule: scale, ray march, roughness, horizontal and vertical filtering, and specular merge. The Image filter reads actual depth, projection, normals, roughness, metallic and resolved lighting from their declared renderer pass. If a later composition does not match, the full image is kept unchanged, so an earlier scene result is never applied to unrelated pixels.

### Anisotropic Kuwahara

Anisotropic Kuwahara uses the author's structure tensor, Gaussian smoothing, eigenframe and eight-sector filter. Its five-pass hook uses an equivalent separable Gaussian smoothing and a generated copy of the original sector table, and keeps source alpha. Radius, sharpness, anisotropy and orientation smoothing are ordinary live parameters. It is a different algorithm from the four-quadrant Kuwahara approximation.

### Local Laplacian

Local Laplacian uses Halide's fast local Laplacian formulation: eight Gaussian and Laplacian levels, intensity remapping and interpolation, then color reconstruction. Its float32 pyramids keep the halo regions needed for the original repeated-edge input boundary. Detail and contrast control the remapping, and intensity samples set the resolution of its approximation. The effect works in a bounded sRGB domain, keeps image dimensions, orientation and alpha, and uses the common local SDR conversion when necessary.

### CMAA2

CMAA2 processes resolved single-sample color with the original edge-detection, shape-candidate and deferred-application kernels. GPU counters generate the indirect dispatch arguments, and scratch lists and atomic heads stay GPU resources. Quality selects the edge threshold, and Preserve detail selects the sharpness variant. The adapter converts the image's encoding to linear RGB and back and keeps source alpha. It uses float32 deferred colors and a sign-symmetric edge metric for signed wide-gamut and HDR components, and needs no local SDR conversion. Multisample reconstruction is a separate input contract.

### XeGTAO

XeGTAO is a depth-aware Image filter that computes ambient visibility (ambient occlusion). It requires resolved renderer depth aligned to the current image and the actual unjittered projection matrix, with an explicit clip range of either zero to one or minus one to one. Projection inversion handles handedness, reverse Z, and perspective and orthographic views, while the current sample jitter and depth region stay explicit. Normals are reconstructed from depth on the GPU, so motion, view matrices and guessed camera field-of-view values are unnecessary.

The original depth prefilter, horizon search and edge-aware denoiser produce the ambient visibility. It multiplies linear RGB in the source primaries before the image returns to the source encoding and alpha convention. Radius uses scene view-space units, and Strength blends the visibility with 1. Quality selects the original sample counts, and Denoising selects the spatial passes. The effect keeps dimensions and alpha, uses stationary spatial noise and needs no temporal history. Missing scene inputs leave the row pending while independent image filters remain available.

### CACAO

CACAO is a second, independent depth-aware Image filter that uses the same scene inputs. Its original deinterleaved depth and normal preparation, quality-dependent SSAO generation, adaptive importance map and load counter, smart edge blur and application passes run on the GPU. Half resolution selects CACAO's original downsampled ambient-occlusion path and bilateral upscaler, and the row still returns the original dimensions. Normals are derived from depth, so no renderer normal buffer is needed. The projection, clip range, jitter and Y orientation keep their explicit scene meaning, including orthographic views and reverse Z. Signed tile halos and bounded scalar loads keep bilateral reconstruction inside the declared image region.

Radius and Fade distance use scene view-space units. Fading starts at one sixth of the selected distance and reaches neutral visibility at that distance, keeping the original default interval of 50–300. Strength controls the original shadow multiplier, Quality selects the original fixed or adaptive sample schedules, Blur selects zero to eight edge-sensitive passes, and Sharpness controls edge bleed. Ambient visibility multiplies linear RGB in the source primaries, and the original encoding and alpha are restored at output. Missing depth or projection leaves the row pending, independently of other image filters.

### FidelityFX DoF

FidelityFX DoF is an Image filter that uses the same renderer depth and projection. Its original five-pass schedule reduces depth and color, dilates the depth tiles, samples near and far blur, then composites at the current image size. Focus distance uses scene view-space units. Blur radius sets the maximum circle-of-confusion radius in the row's full-resolution output pixels, independently of any earlier resize. Quality selects one to eight sample rings, and Merge sample rings selects the original merged-ring variant. Motion and renderer lens metadata are unnecessary, because the focus distance and maximum radius define the chosen artistic camera response explicitly.

The adapter reconstructs view depth from the declared clip range, projection, origin, jitter and depth region before the original kernels run. It processes linear RGB in the source primaries and restores the original encoding and alpha. Known image resizes use the shared guide normalization. An unsupported guide transform or missing depth leaves only this row pending. Relative depth estimated from the image does not satisfy its requirement for renderer depth.

### Depth fog and Depth outlines

Depth fog and Depth outlines use the same resolved depth and projection. Both are Image filters in the common searchable selector. They keep the current size, encoding and alpha, and need no motion vectors, view matrix or temporal history. Known resize stages normalize their guides through the shared scene adapter. Missing depth, projection or clip conventions leave only the dependent row pending.

Depth fog uses the original FXShaders RetroFog curve, quantization, Bayer dither and optional sampled image color. Distance is measured in scene view-space units, reconstructed from the game's projection. Opacity, the curve endpoints and the center control the blend, and the fog color is applied in linear source primaries.

Depth outlines uses FXShaders' depth-gradient facing threshold with an adjustable blend strength. It reconstructs view distance before evaluating neighboring samples, preserving the declared depth region, origin and sample jitter.

### Estimated depth fog

Estimated depth fog is an Image filter with a **Model** selection. Its Depth Anything V2 Small graph uses the original ViT-S/14 backbone and DPT64 head to produce a raw R32Float relative inverse-depth attachment. The model receives a display-referred sRGB proxy of the image, with ImageNet normalization and an aspect-preserving bicubic resize. Input size selects the inference grid in multiples of fourteen, and the attachment still covers the complete source image. Model loading and shape preparation run asynchronously, and redraws of an unchanged image reuse the completed GPU attachment.

The fog computes percentile bounds on the GPU and stabilizes their range across real images before applying the shared RetroFog curve, dither and color functions to relative far depth. It smooths the normalization bounds without blending old depth pixels into moving objects. A cut estimated from the image resets the range when the image changes sharply; this is separate from a renderer's cut signal. Redraws and generated images do not advance real-image history. Constant predictions leave the source unchanged. Opacity and the curve controls are artistic image controls, and this filter has no physical Distance parameter. It keeps the source size, HDR encoding and alpha.

The estimated attachment records which image and model produced it and whether it is complete. It stays separate from renderer depth and does not supply scene inputs to temporal upscalers or ambient occlusion. Inference requires the Apple Silicon neural provider on macOS 14 or later, and the ARM64 helper also serves a translated x86_64 graphics process. The declared [Small graph and checkpoint](../../src/modules/shared/reshade/neural/native/depth-anything-source.json) use Apache-2.0 terms; other Depth Anything variants have separate contracts.

### Histogram exposure

Histogram exposure is a shared Image filter. A GPU log-luminance histogram uses 256 bins from −16 to +16 EV in linear source primaries. Low and High percentile trim the metering interval, and Target gray and Compensation determine the requested gain within the selected EV limits. Adaptation speed controls real-image history. Cut threshold enables a reset, derived explicitly from the image, when both the distribution and the exposure change substantially.

Exact redraws reuse the completed exposure without advancing its clock, and synthetic frames use the accepted exposure of the real image. Source epochs, seeks, changed upstream images and discarded GPU work have their own history and completion rules. The filter keeps dimensions, signed HDR color and alpha, and at zero EV the original encoded pixels are unchanged. It needs no renderer guides and is separate from CShade's average and spot log-luminance metering.

## Source and feature declarations

The graphics processor's feature manifest, provider descriptors and model declarations determine which implementations can be called. A running game keeps the verified processor files it loaded at launch, including its helper and shader resources; selecting a newer processor version does not change them for that session.

The main implementation declarations are:

- the [operation contracts](../../src/modules/shared/effects/operation-contracts.mjs);
- the [temporal provider registry](../../src/modules/shared/reshade/temporal/providers.js);
- the [neural graph sources](../../src/modules/shared/reshade/neural/native/restoration-sources.json);
- the [shader collections](../../src/modules/shared/reshade/shader-packs.json);
- the [native image methods](../../src/modules/shared/reshade/native-filter/index.js);
- the [downloadable shader collections](../../src/modules/shared/reshade/managed-shader-packs.json).

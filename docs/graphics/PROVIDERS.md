# Graphics providers

[Pipeline overview](PIPELINE.md) · [Graphics guide](README.md)

MacLauncher's graphics processor is the native component that runs a game's effect chain, and each operation in that chain is implemented by a provider. The editor groups operations into five row types, which describe what an operation does to the data: **Image filter**, **Downsample**, **Upscale**, **Temporal upscaling** and **Frame generation**. Within those types, a shader format, model family or compute backend selects the implementation, while a shader's declared output geometry decides which type it belongs to.

Having a provider installed does not mean that it can run on a given frame. A temporal provider, for example, still needs matching scene inputs, whereas an image filter needs only its declared image and assets. When an optional input is missing, only the row that depends on it is affected, and independent operations elsewhere in the chain keep running.

[Inputs and execution](#inputs-and-execution) · [Spatial resizing](#spatial-resizing) · [Scene-temporal upscaling](#scene-temporal-upscaling) · [Neural rendering, restoration and image upscaling](#neural-rendering-restoration-and-image-upscaling) · [Frame generation](#frame-generation) · [Shader formats and image effects](#shader-formats-and-image-effects) · [Source and feature declarations](#source-and-feature-declarations)

## Inputs and execution

Providers work with the following inputs:

| Input | Meaning |
| --- | --- |
| Color image | The current image with its actual size, orientation, color encoding and alpha convention. It can come from a renderer, decoded video or an earlier operation. |
| Image pair or sequence | Chronological color images with content IDs and timestamps. Motion estimated from images never counts as renderer motion. |
| Renderer guides | Depth, motion, jitter, exposure and camera data that the renderer supplies for the same scene frame, also called scene guides. Their units, sample regions and frame identifiers must match the color image. |
| Camera parameters | The actual near and far planes and vertical field of view, for algorithms that require them. These are separate from full view and projection matrices. |
| View and projection matrices | Explicit, valid matrices associated with the scene frame. Missing matrices are never replaced by identity matrices. |
| Video planes | Luma and chroma from the decoder or native player, or planes derived explicitly from RGB. Derived planes keep a record of that origin. |

Frame textures and inference stay on the GPU. A provider encodes its work into a command buffer that it only borrows, the renderer's or, for [image-pair presentation](#image-pair-methods-from-macos-frameworks), the presenter's, so encoding neither submits that buffer nor waits for it. Compiling pipelines and allocating images belong to resource preparation, which happens outside that callback. Providers that run in another process work through size-limited jobs, GPU-backed shared storage and completion metadata, and the launcher never carries frame pixels through Electron.

Whether a provider can run depends separately on the process's instruction set and on the GPU. Native Metal providers can run in an ARM64 process or a translated x86_64 process, as long as the loaded binary, the OS and the GPU support them. MLX, however, runs in ARM64 code on Apple Silicon, so an x86_64 graphics process receives MLX processing from an ARM64 GPU helper. This helper does not make an ARM64 library loadable in an x86_64 process.

## Spatial resizing

Spatial operations resize an image using only that image and its real source and target sizes, so they need no depth, scene motion or renderer camera data. Downsampling has its own row type and target sizing; it is not an upscale with a scale below one.

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

FSR 1 runs AMD's EASU reconstruction followed by RCAS sharpening, and its **Sharpness** ranges from 0 to 1. Each pass performs perceptual SDR scaling of up to twice the source size on each axis and preserves alpha. Larger ratios therefore run as successive passes of the same method, each at most 2× per axis. Neither FSR 1 nor MAKO needs model files.

Some models and shaders have an intrinsic scale. That scale describes only the row's own result, and a later explicit resize can still fit the result to a different size. Input size and final display size are likewise separate controls, and intermediate work and memory follow the actual sizes of the rows in order.

## Scene-temporal upscaling

Scene-temporal upscaling is temporal upscaling guided by the renderer, so these operations consume real renderer guides. A captured final image does not supply those guides, even when the same runtime can run image effects or color-pair frame generation. Whether a method can run therefore depends on the scene data the runtime actually supplies, and there is no list of eligible games or engines.

A game's upscaling API and the selected provider are separate choices. DLSS Super Resolution evaluations can reach the shared processor through vkd3d-proton or DXVK with a compatible Vulkan driver, while compatible DXMT and D3DMetal integrations forward the scene inputs from their native MetalFX calls. The selected provider runs only when the forwarded resources and inputs meet its requirements. On these DLSS routes, camera-dependent providers, including FSR 2 and FSR 3, require actual camera parameters from the game's Streamline constants through a matching adapter; DLSS alone supplies none. A provider with missing required inputs uses the common fallback, and DXMT or D3DMetal keeps its original scaler when shared processing cannot replace it. Separate HUD-less/UI attachments and full scene matrices remain absent unless the producer explicitly forwards them. [Scene producers](INPUTS_AND_ADAPTERS.md#scene-producers) lists what each route carries.

| Method | Algorithm | Required scene inputs | Output and platform |
| --- | --- | --- | --- |
| MetalFX Temporal | Native MetalFX temporal reconstruction | Color, matching depth and motion, and jitter and exposure conventions | Requested output size; a supported MetalFX device on macOS 13 or later. |
| MetalFX Temporal Denoised | Native denoising and temporal reconstruction | Noisy scene color, depth and motion, view and projection matrices, surface normal and roughness, and diffuse and specular material reflectance | Requested output size; macOS 26 or later and device support for the denoised scaler. |
| FSR 2 | The original FSR 2.2.1 scheduler and shaders, adapted to Metal | Color, depth and motion, jitter, exposure conventions and actual camera parameters; a scene region of at least 32 × 32 for its luminance pyramid | Requested output size; optional universal provider, macOS 13 or later. |
| FSR 3 | The original FSR 3.1.4 temporal upscaler, adapted to Metal | The scene data its scheduler requires | Requested output size; optional universal provider, macOS 13 or later. This row does not select FSR frame generation. |
| FSR 4 | The FSR 4.1.1 shader and model implementation, through the native Mac provider | Matching scene color, depth and motion, and jitter and exposure conventions | Requested output size; the provider requires macOS 15 or later and an Apple Silicon GPU, with the model and shader resources it includes. |
| Arm ASR | The original ASR scheduler with mixed fragment/MRT and compute passes, adapted to Metal | Matching scene color, depth and motion, jitter and exposure, and camera data | Requested output size; optional universal provider, macOS 13 or later. |
| Snapdragon GSR 2 | The original two-pass temporal algorithm, adapted to Metal | Matching color, depth and motion, and jitter, exposure and camera conventions | Requested output size; optional universal provider, macOS 13 or later. |
| XeSS | The original Intel XeSS runtime, through a shared GPU compute host | Matching color, depth and motion, and jitter and exposure conventions | Requested output size; support depends on the actual backend and installed host. |
| DLSS SR scene | MLX-DLSS's scene-input graph | Real color, depth and motion, jitter and exposure conventions, and a compatible local model | The intrinsic 2× model output is fitted on the GPU to the temporal output region. Apple Silicon, macOS 14 or later. |

Algorithms that accept them can also take reactive masks and transparency or composition masks as optional inputs, which stay distinct from masks estimated from the image. Reversed or infinite depth, output-resolution motion, jittered motion, and source and output regions are declared as explicit conventions. When the image goes through a supported affine transform, the guides are updated with it. After an unknown image warp, however, the guides are no longer treated as aligned with the scene.

Before encoding, FSR 2 and FSR 3 prepare their pipelines, images and SDK context for the renderer that supplies the scene. This preparation does not encode into the caller's command buffer or advance frame history. When a temporal row's input falls outside its supported domain, the row uses the common fallback, while independent compatible image rows continue.

MetalFX operations use the system framework, and their support is a property of the Metal device: it does not depend on the game's CPU instruction set. The inspector and the Runtimes window share one offline query of the default and available Metal devices, the operations each supports and their temporal scale ranges. MetalFX's optional reactive, hit-distance, denoise-strength and transparency inputs follow what the game's renderer actually declares.

### Arm ASR

In Arm ASR, the Quality, Balanced, Performance and Ultra Performance choices select shader profiles and do not prescribe a fixed ratio between input and output size. MacLauncher runs ASR through its own Metal adaptation. This adaptation keeps the logical render-region boundary for integer RGB loads and gathers, and it keeps the SDR history of the Performance profile in the same color domain as its prepared input. The exact upstream commit and MacLauncher's changes to it are recorded in the [ASR recipe](../../src/modules/shared/reshade/temporal/asr/source.json).

### FSR 4

Within one Temporal upscaling row, FSR 4's profile control selects one of three profiles, Exact Fast, Lite or Lite 2:

- Exact Fast keeps AMD's original coefficients and runs inference every frame. It is the default.
- Lite uses the upstream folded coefficients, rounding and guarded reuse of inference results.
- Lite 2 supplies six trained layers for the normal model family; its Ultra Performance model remains Lite.

Each profile has its own model and license, and an older installed provider offers only the profiles it contains. Shaders and models are created during background resource preparation, which keeps that work out of encoding. On the GPU, the network output and source alpha are then composed into the requested output region. FSR 4 uses no camera field of view or matrices.

### XeSS

A shared XeSS provider runs Intel's original Windows library on a compute host. Such compute hosts are provided by modules, and they supply the Windows ABI and graphics translation that the library needs. Super resolution can use a D3D12 or a Vulkan host route, and **Auto** picks an available compatible route. The game that supplies the frames, on the other hand, does not need to run under Wine: it can be a native application or another scene-capable runtime.

Frames reach the host through GPU copies between shared Metal-backed storage and the host's D3D12 or Vulkan resources. CPU messages coordinate ownership and completion, but they never read, encode or serialize frame pixels. The backend's capability, the original library and the helper resources are each validated separately. When D3D12 and Vulkan rows both appear in one chain, each keeps its own prepared configuration.

Games that call the XeSS API themselves are covered by a separate integration, a replacement for the game's XeSS API under D3D11 and DXMT. It forwards the game's XeSS API resources and frame metadata to a configured shared temporal provider. This mapping does not mean that Intel's neural runtime ran, nor does it imply interception support for every D3D12 or Vulkan game API entry point. Flags or graphics profiles that it does not support receive the corresponding API error.

The original XeSS components are imported from local files, and each is recorded exactly, together with its license terms. Because the super-resolution, frame-generation and latency components have separate requirements, installing the provider code does not by itself install or enable every component.

XeSS frame generation also needs view and projection matrices. The XeSS adapter gives the original SDK unjittered row-major matrices: it removes declared projection jitter and converts explicit clip-range and Y-orientation representations for its texture rows. Authored view, off-center projection and reverse-depth geometry are preserved, and missing renderer matrices are never inferred from camera parameters.

## Neural rendering, restoration and image upscaling

The neural methods below run trained models on the GPU, and all of them use the shared GPU neural provider. The selected provider advertises the operations it supports, so older provider builds that support only neural rendering (NR) remain usable for that operation. [Neural models and packages](NEURAL_RESTORATION.md) describes the model architectures, how each model is validated against its declared architecture, and the import formats.

| Method | Implemented graph and inputs | Intrinsic output | Model requirement |
| --- | --- | --- | --- |
| DLSS neural rendering (`mlx-dlss`) | MLX-DLSS neural rendering on the current RGB image, with optional temporal estimation from the images | Same size | A compatible neural-rendering package. Temporal estimation uses image history, not engine depth or motion. |
| RTX VSR (`mlx-vsr`) | The RTX Video Super Resolution graph, on independent images | 2× each dimension | A VSR package for that operation. |
| DLSS SR image (`mlx-sr-image`) | MLX-DLSS image-sequence SR, with guides derived from the images | 2× each dimension | An image-SR package; separate from the scene variant, which uses renderer guides. |
| DLSS SR scene (`mlx-sr-scene`) | The scene-input SR graph, with normalized renderer guides | 2×, then fitted to the scene output region | A compatible scene-SR package. |
| Real-ESRGAN (`realesrgan`) | SRVGG-16 anime/video or SRVGG-32 general | 4× each dimension | A supported SRVGG safetensors file or package. |
| Real-CUGAN (`realcugan`) | Standard UpCunet2x, 3x or 4x | The selected model's 2×, 3× or 4× each dimension | The exact typed model and provider architecture. |
| NAFNet (`nafnet`) | SIDD width64 denoising or GoPro width64 deblurring | Same size | A matching float32 graph and tensors. |

These models take display-referred sRGB RGB in their declared range. For HDR or P3 input, the shared color conversion at the model's boundary can therefore create an explicit local SDR conversion and restore the surrounding image's encoding afterward. However, that conversion cannot recover highlights that the SDR model discards. Alpha is carried separately from RGB inference and restored with its actual convention.

The live neural implementation requires Apple Silicon and macOS 14 or later. ARM64 game processes can use the provider directly, while x86_64 processes translated by Rosetta use the ARM64 helper. In both cases, Metal and IOSurface input, the model operations and the output stay on the GPU. Preparation, live changes, and the loading and release of models all use the same provider and model lifecycle.

### Warm-up and time limits

A neural row is warmed up before it joins the running chain. Its provider runs one inference at the row's size, with no frame command buffer waiting on it, and that inference reads an opaque black image, so it loads and runs the model. Checks that depend on image content, such as the opaque SDR requirement, apply to the frames the row later consumes.

During warm-up, the graph reports Preparing with the reason "Neural provider is warming up", and the accepted chain keeps rendering. Retries keep the same warming node. If warm-up outlasts the ordinary two-second preparation grace period, the graph starts running without that row, whose stage keeps reporting Preparing with the same reason. The warmed node then joins the graph once its inference completes.

Once the row runs, a frame waits at most two seconds for its provider. When an inference takes longer, that frame keeps the row's input image, and later frames bypass the row, with a reason, until the late inference completes. A failed inference makes the row unavailable for a retry interval that starts at one second and doubles up to thirty seconds, with the reason "Neural provider failed; retrying". A successfully rendered inference resets the interval. XeSS host results use the same two-second limit.

## Frame generation

Frame generation produces timestamped images between two chronological endpoints. These images are delivered by the common presenter, which also schedules their display, so providers never present extra frames on their own or change the application's simulation rate. Window graphics add one limit: the shared timeline requests only the images that the display can show. When the display refresh rate leaves no refresh for a generated image at the current source frame rate, no image is generated for that interval, as [Timing](FRAME_API.md#timing) describes.

| Method | Inputs and algorithm | Generated images | Requirements |
| --- | --- | --- | --- |
| Lossless Scaling (`lsfg`) | A color pair; the original Lossless Scaling model and shaders through MAKO | The configured phases between the pair, up to four intermediate images | Compatible models imported from a local Lossless Scaling copy. Needs no renderer guides. |
| MLX interpolation | A color pair and an explicit phase; the MLX-DLSS interpolation graph | The configured phases, up to four intermediate images | A compatible interpolation model; the Apple Silicon and macOS 14 provider or the ARM64 helper. |
| RIFE | A color pair and an explicit phase; v4.6 four-stage flow refinement and GPU warping | The configured phases, up to four intermediate images | An exactly supported RIFE model; the same provider and helper requirements. |
| MetalFX interpolation | A real scene pair, depth and motion, jitter and exposure, and finite perspective camera data | One midpoint for an eligible real interval | macOS 26 or later and device support for the MetalFX interpolator. |
| FSR 3 interpolation | The original optical-flow and frame-interpolation effects, with real scene data and camera conventions | One midpoint for an eligible real interval | The optional universal Metal provider with its complete shader resources, macOS 13 or later. |
| XeSS interpolation | The original XeSS-FG and XeLL components; real scene color, depth and motion, and view and projection matrices | One midpoint for an eligible real interval | The D3D12 compute-host route and separately imported compatible FG and latency components. |
| VideoToolbox interpolation (`vt-interpolation`) | A color pair; VideoToolbox low-latency frame interpolation (`VTFrameProcessor` with `VTLowLatencyFrameInterpolationConfiguration`) on the Neural Engine | One midpoint at 2×, or up to three images at quarter phases at 4× | macOS 26 or later and a Mac that the processor reports as supported. Needs no model files or renderer guides. |
| MetalFX image interpolation (`metalfx-image`) | A color pair; the MetalFX frame interpolator with motion estimated from the pair by `VTMotionEstimationSession` and a constant depth | One midpoint for each pair | macOS 26 or later and device support for the MetalFX interpolator. Needs no renderer guides. |
| Vision optical flow (`vision-flow`) | A color pair; forward and backward flow from `VNGenerateOpticalFlowRequest`, a consistency-checked warp and a blend fallback | The configured phases, up to four intermediate images | macOS 11 or later. Needs no model files or renderer guides. |
| Automatic (`auto`) | One of the three methods above for each pair, chosen by measured cost | As the method that runs the pair | At least one of its methods available for the row's multiplier. |

### Image-pair methods from macOS frameworks

VideoToolbox interpolation, MetalFX image interpolation and Vision optical flow are frame-generation methods that run on frameworks included in macOS, so they need no model files. Each is an image-pair provider, a method that generates from two color images and declares no scene input. The shared timeline, its repeat and scene-cut analysis, the static-content step and the presenter therefore apply to them as to other image-pair methods. Each provider also keeps its own previous image. A discontinuity in the pair sequence restarts the provider, and the first image after a restart passes through with no generated images.

Graphics packages that include these methods list `vt-interpolation`, `metalfx-image`, `vision-flow` and `auto` in `features.graphics.frameGenerationMethods`. In addition, each method needs the macOS version that its contract declares, and MetalFX image interpolation also needs device support for the MetalFX interpolator.

VideoToolbox interpolation uses the low-latency frame interpolation processor of VideoToolbox and works on 8-bit SDR images. Its input and output pass through the shared SDR color adapter, and a GPU pass converts each image to the processor's pixel format, which is BGRA when the processor offers it and otherwise BT.709 4:2:0 in full or video range; the outputs receive the inverse conversion.

The processor also has a maximum frame size. When the graphics build includes the macOS 27 size-query API and runs on macOS 27 or later, the processor reports that size itself. Otherwise, the limit is 1920 pixels in either dimension and 1920×1080 pixels in total. Larger images are resampled to fit, keeping their aspect ratio, and the outputs are resampled back to the source size. If a session cannot start at the reported size, the provider tries 1280×720 and then 960×540.

Starting a session loads the processor's model. This work runs on the background preparation queue, and the row reports that it is preparing until the session is ready. For image-pair presentation, the producer buffer copies the real color image and matched depth, then hands the completed snapshot to the presenter. Image-pair processing and presentation run on a presenter-owned queue; the producer buffer does not wait for CPU or Neural Engine generation work. Once ready, the processor runs inside the presenter's command buffer. Its multiplier is 2× or 4×: at 2× the processor is configured for one interpolated image at the midpoint, and at 4× for points at 0.25, 0.5 and 0.75. When the output interval allows fewer images than the multiplier, a requested phase between two of these points uses the nearest point.

MetalFX image interpolation is an image-pair variant of MetalFX interpolation, and MetalFX interpolation with renderer scene inputs remains a separate method. In place of renderer motion, the provider estimates motion between the two images with `VTMotionEstimationSession`, using multi-pass search on 16×16 blocks of a luma image that fits within 1920×1080 pixels, and expands the block vectors to a per-pixel motion image. Before the expansion, two tests replace outlying block vectors. A vector farther from the median of its 3×3 block neighborhood than 32 pixels or twice the length of that median, whichever is larger, takes the neighborhood median. A vector farther from the frame-wide median than the largest of 32 pixels, four times the length of that median and eight times the median distance from it takes the frame-wide median. These distances are in pixels of the luma image. The other scene inputs are fixed: depth is a constant far plane, and the camera is a nominal perspective camera. The estimated motion stays inside the provider and never counts as renderer motion, as described in [Depth](INPUTS_AND_ADAPTERS.md#depth). The presenter's command buffer waits for the motion field. When the field is not ready within 100 ms, that pair's generated image is omitted and its real endpoint stays. Because the provider produces only the midpoint, its multiplier is 2×.

Vision optical flow is ported from [MetalDuck](https://github.com/Nycolazs/MetalDuck). Each image is first downscaled to at most 800 pixels in its larger dimension. Vision then computes forward and backward flow between the pair in parallel, using request revision 1, whose vectors are in pixels, when the system offers it. From this flow, a GPU pass builds each requested phase by warping both endpoints. A vector counts only where it survives a round trip through the opposite field, so at the edge of a moving object, the side that can still see the pixel is used. Where neither side is reliable, the pass blends the two endpoints instead. The presenter's command buffer waits for the flow. When the flow is not ready within 100 ms, the pass borrows the most recent completed flow from a pair at most two captures older. With borrowed flow, the pass also compares the colors that the two warped endpoints contribute around each pixel: above an average difference of 0.08 the result moves toward the blend of the two endpoints, which it reaches at three times that difference. When no flow can be borrowed, the pair's images are blends of the two endpoints. The late flow is still completed and can be borrowed by a later pair.

VideoToolbox interpolation and MetalFX image interpolation also size their work by its measured cost. VideoToolbox interpolation measures the GPU time of the command buffer that processes each pair, and MetalFX image interpolation measures each motion search; both compare that time with the interval between source images. When the smoothed ratio stays above 80 percent for three consecutive measurements, the provider prepares a session one size smaller, and after 120 consecutive measurements below 40 percent, it prepares a session one size larger. VideoToolbox interpolation steps between its maximum frame size, 1280×720 and 960×540, and MetalFX image interpolation between motion searches that fit 1920×1080, 1280×720, 960×540 and 640×360; both keep the source's aspect ratio. A replacement session, for a new processing size or a new source size, is prepared in the background while the current session keeps serving pairs. During that time, VideoToolbox interpolation resamples through the current session's buffers, and MetalFX image interpolation resizes its input and output to the current session's size. Status and the performance overlay name the active processing size and show when a replacement is being prepared.

### Automatic

A frame-generation row can also select **Automatic**, which chooses among the three framework methods for each pair by their measured cost. VideoToolbox interpolation is preferred, then MetalFX image interpolation, then Vision optical flow. Only the methods that produce the row's multiplier take part: 2× uses all three, 4× uses VideoToolbox interpolation and Vision optical flow, and 3× and 5× use Vision optical flow. Every participating method is prepared in the background, so it is ready when Automatic changes to it, and a method that cannot be created or prepared is skipped.

The cost is measured after each pair: Automatic compares the time from encoding to GPU completion with the interval since the previous pair. If a pair took longer than the interval, or the method refused it as busy, the row moves to the next prepared method at once. A method that refuses a pair only because it is still preparing a session does not count as falling behind, and the active method stays selected while it prepares a replacement session. A change of source size restarts these measurements. A pair that took at most three quarters of the interval counts as headroom, and after ten seconds of continuous headroom, the row returns to a more preferred method. However, it never returns sooner than thirty seconds after it left that method, and a pair between these limits restarts the headroom period. Because a change of method restarts generation history, the first image after a change has no generated images.

Status, Details and the performance overlay list `auto` as the requested method and the method that runs now as the active one, with the reason for the latest change. When the active method is VideoToolbox interpolation or MetalFX image interpolation, its processing size follows the reason. A row that names a specific method, by contrast, always runs that method.

### LSFG color handling

Lossless Scaling Frame Generation (LSFG) has separate kernels for SDR and HDR input. Ordinary 8-bit sRGB input keeps the original SDR kernels, while HDR and color-converted float input use the original HDR generation kernel, with float graph resources and FP16 source, history and generated images. For the HDR kernel, the shared color adapter converts the input to linear BT.709/scRGB with an 80-nit reference white, then returns the generated images to the source encoding without an SDR tone-mapping step. Wide-gamut SDR input converted to this linear form also uses the HDR kernel. In every case, the real endpoints remain the original images. The graph's images are initialized in a batched GPU preparation step, and the graph becomes usable only after that work completes.

### Combining generation stages

A chain can hold more than one frame-generation stage, and the stages differ in what they accept from one another. Color-pair providers can consume suitable generated color images from an earlier stage. Scene providers, by contrast, work only between eligible real frames and keep track of which real frame their guides and matrices came from, so they never invent renderer guides for an image generated by an earlier stage. Other generated images can stay in the same timeline. Combined stages therefore follow the actual timestamps and origin of each image, and the result is not necessarily the product of their multiplier labels.

### Repeated frames and scene cuts

Image-pair providers are the generation methods that declare no scene input, such as Lossless Scaling, MLX interpolation and RIFE. Because these providers see only images, the shared timeline analyzes their input pairs for repeated frames and scene cuts in window sessions, in multi-stage generation and when Keep static content is enabled. A GPU comparison detects exact repeats of decoded texels, while color differences in the encoded domain, compared against fixed thresholds, give a conservative estimate of scene cuts. These signals come from the images and are separate from renderer reset markers.

Each decision belongs to the exact pair, source epoch and upstream image revision it was made for. After the source GPU fence, a repeat, an estimated cut or unmatched history suppresses that pair's synthetic events and their descendants, and the real endpoint is kept. For this analysis, each selected row budgets one GPU history image in the source format, two compute passes and one GPU image copy per pair. FSR 3 and the scene providers, on the other hand, make their own reset and no-interpolation decisions.

### Static content

Image-pair providers can warp interface elements and text that did not move between the two real frames. To keep them sharp, a frame-generation row's **Keep static content** option adds one shared step after every image-pair provider; the option is off by default for games and on by default for window graphics. The step reuses the pair analysis's history image and identity check, and it adds one render pass per generated image in the same command buffer, before the history advances. It needs no additional image memory.

For each pixel, the step measures the largest change between the two real endpoints within a 3×3 neighborhood and compares that change with the neighborhood's own contrast. Where every texel of the neighborhood is identical in the two endpoints, the generated pixel is replaced by the exact real pixel, in flat areas as well. Elsewhere, where the endpoints match relative to that contrast, the generated pixel blends toward the real image at the generated phase. Changed areas keep the generated pixel, and so do changed flat areas, which have too little contrast to show a warp. Because the comparison sees only the endpoints, a small object that moves farther than the neighborhood between two real frames, across a detailed unchanged area, can be missing from the generated images. Unmatched history, nonfinite input and an image whose format or usage does not allow blending leave the generated image unchanged.

Graphics packages that include the step declare `features.graphics.generationStaticContentAPI: 1`, which the app's graphics capabilities report as `staticContent`. The option appears only for image-pair rows of such packages, and a package without the flag ignores the saved option and leaves generated images unchanged.

### Transparency and history

Most generation methods need opaque images: Lossless Scaling, MetalFX, FSR 3, XeSS, VideoToolbox interpolation, MetalFX image interpolation, Vision optical flow and Automatic generation declare this requirement. The MLX interpolation and RIFE adapters, however, carry alpha separately from their RGB model inputs. This transparency requirement belongs to the selected generation provider and does not disable other image operations in the graph.

Reset, discontinuity, source epoch, scene and color geometry, and completion each belong to the relevant history. Paused redraws reprocess the accepted image without advancing generation history. When a provider returns a no-interpolation or failed result, that result is never counted as a generated event, and its real endpoint stays available. XeLL, the latency component used with XeSS frame generation, is integrated in a helper; this integration does not establish engine simulation markers or measure input latency end to end.

## Shader formats and image effects

Image effects can come from several shader formats and native providers:

| Format or provider | Supported work | Inputs, assets and platform |
| --- | --- | --- |
| ReShadeFX | Original FX techniques, parameters, textures and multipass effects | Referenced includes and assets must be available. Depth techniques require matching depth from the renderer. |
| RetroArch Slang | Slang shaders and presets, pass geometry, parameters and their declared history and assets | The original preset structure and assets remain part of the prepared input. |
| MPV/libplacebo hooks | Multipass image hooks, parameters, static textures, RGB, luma and chroma operations, and LUT processing | The selected provider's [processor and macOS requirements](../runtimes/SYSTEM_REQUIREMENTS.md#graphics) apply. Native video planes and planes derived from RGB keep their separate origins. |
| libplacebo image filters | The original renderer's debanding, selected by a data-only `.plfilter` descriptor | Iterations, threshold, radius and grain use the original deband parameters. The selected provider advertises its image-filter API, and the filter preserves the input size and alpha. |
| ISF | `inputImage` filters, typed controls, multiple passes and persistent targets, and imported images | The ISFMSLKit provider follows its selected package's [processor and macOS requirements](../runtimes/SYSTEM_REQUIREMENTS.md#graphics). Additional image, audio, FFT and cube inputs need actual bindings; they are not aliases for `inputImage`. |
| MagpieFX | Declared multipass HLSL pixel and compute effects, parameters, intermediate textures and source assets | MacLauncher's parser and translation keep the declared pass resources and output sizes. The graphics processor supplies the compiler and runtime resources. |
| Native image descriptors | Compiled image algorithms selected by typed `.mclfilter` data | A known algorithm ID and parameters within fixed ranges, with no source code or executable paths. The graphics processor advertises the compiled methods it contains. |

Whatever their source format, image effects are searchable in the same category. The included collections cover ordinary finishing and appearance effects, while downloadable collections and imported files add further algorithms. Required textures, kernel tables and licenses come with their collection, so they never depend on a working directory or an unrelated application installation.

A shader's geometry and input domain are determined by its declarations. For example, an RGB effect does not become a native chroma operation because its filename contains "chroma", and a tensor or feature-texture pass does not resize the frame by itself. The original provider receives the exact source and destination sizes.

The native image effects are described below.

### FidelityFX Lens and Blur

FidelityFX Lens and Blur are ordinary Image filters that use the original SDK kernels. Lens has grain, chromatic aberration and vignette controls, and Blur selects an odd Gaussian kernel size from 3 to 21 pixels and one of three sigma profiles. Both keep the source dimensions, signed HDR values and source alpha. They differ in how they treat coordinates: Lens moves pixel coordinates, so renderer guides cannot pass through it unchanged, whereas Blur keeps coordinates aligned. The resources of both are prepared before live encoding.

### Screen-space reflections

The Screen-space reflections Image filter computes reflections from the renderer's own scene data. It follows the original Godot schedule: scale, ray march, roughness, horizontal and vertical filtering, and specular merge. For this, the filter reads actual depth, projection, normals, roughness, metallic and resolved lighting from their declared renderer pass. If a later composition does not match, the full image is kept unchanged, so an earlier scene result is never applied to unrelated pixels.

### Anisotropic Kuwahara

Anisotropic Kuwahara is a different algorithm from the four-quadrant Kuwahara approximation. It uses the original author's structure tensor, Gaussian smoothing, eigenframe and eight-sector filter. In MacLauncher, it runs as a five-pass hook, which uses an equivalent separable Gaussian smoothing and a generated copy of the original sector table and keeps source alpha. Radius, sharpness, anisotropy and orientation smoothing are ordinary live parameters.

### Local Laplacian

Local Laplacian uses Halide's fast local Laplacian formulation: eight Gaussian and Laplacian levels, intensity remapping and interpolation, then color reconstruction. Its float32 pyramids keep the halo regions needed for the original repeated-edge input boundary. Detail and contrast control the remapping, while intensity samples set the resolution of its approximation. Because the effect works in a bounded sRGB domain, it uses the common local SDR conversion when necessary; it keeps image dimensions, orientation and alpha.

### CMAA2

CMAA2 is an anti-aliasing filter. It processes resolved single-sample color with the original edge-detection, shape-candidate and deferred-application kernels, and its work stays on the GPU: GPU counters generate the indirect dispatch arguments, and scratch lists and atomic heads remain GPU resources. Quality selects the edge threshold, and Preserve detail selects the sharpness variant. MacLauncher's adapter converts the image's encoding to linear RGB and back and keeps source alpha. It also uses float32 deferred colors and a sign-symmetric edge metric for signed wide-gamut and HDR components, and it needs no local SDR conversion. Multisample reconstruction is a separate input contract.

### XeGTAO

XeGTAO is a depth-aware Image filter that computes ambient visibility (ambient occlusion). It requires resolved renderer depth aligned to the current image and the actual unjittered projection matrix, with an explicit clip range of either zero to one or minus one to one. Projection inversion handles handedness, reverse Z, and perspective and orthographic views, while the current sample jitter and depth region stay explicit. Normals are reconstructed from depth on the GPU, so motion, view matrices and guessed camera field-of-view values are unnecessary.

The ambient visibility comes from the original depth prefilter, horizon search and edge-aware denoiser, and it multiplies linear RGB in the source primaries before the image returns to the source encoding and alpha convention. Radius uses scene view-space units, and Strength blends the visibility with 1. Quality selects the original sample counts, and Denoising selects the spatial passes. The effect keeps dimensions and alpha, uses stationary spatial noise and needs no temporal history. Missing scene inputs leave the row pending while independent image filters remain available.

### CACAO

CACAO is a second, independent depth-aware Image filter that uses the same scene inputs. Its original deinterleaved depth and normal preparation, quality-dependent SSAO generation, adaptive importance map and load counter, smart edge blur and application passes run on the GPU. Half resolution selects CACAO's original downsampled ambient-occlusion path and bilateral upscaler, and the row still returns the original dimensions. Normals are derived from depth, so no renderer normal buffer is needed. The projection, clip range, jitter and Y orientation keep their explicit scene meaning, including orthographic views and reverse Z. Signed tile halos and bounded scalar loads keep bilateral reconstruction inside the declared image region.

Radius and Fade distance use scene view-space units. Fading starts at one sixth of the selected distance and reaches neutral visibility at that distance, which keeps the original default interval of 50 to 300. Strength controls the original shadow multiplier, Quality selects the original fixed or adaptive sample schedules, Blur selects zero to eight edge-sensitive passes, and Sharpness controls edge bleed. Ambient visibility multiplies linear RGB in the source primaries, and the original encoding and alpha are restored at output. Missing depth or projection leaves the row pending, independently of other image filters.

### FidelityFX DoF

FidelityFX DoF (depth of field) is an Image filter that uses the same renderer depth and projection. Its original five-pass schedule reduces depth and color, dilates the depth tiles, samples near and far blur, then composites at the current image size. Focus distance uses scene view-space units. Blur radius sets the maximum circle-of-confusion radius in the row's full-resolution output pixels, independently of any earlier resize. Quality selects one to eight sample rings, and Merge sample rings selects the original merged-ring variant. Motion and renderer lens metadata are unnecessary, because the focus distance and maximum radius define the chosen artistic camera response explicitly.

Its adapter reconstructs view depth from the declared clip range, projection, origin, jitter and depth region before the original kernels run. It processes linear RGB in the source primaries and restores the original encoding and alpha. Known image resizes use the shared guide normalization. An unsupported guide transform or missing depth leaves only this row pending. Relative depth estimated from the image does not satisfy its requirement for renderer depth.

### Depth fog and Depth outlines

Depth fog and Depth outlines are two more Image filters in the common searchable selector, and they use the same resolved depth and projection. Both keep the current size, encoding and alpha, and they need no motion vectors, view matrix or temporal history. Known resize stages normalize their guides through the shared scene adapter, and missing depth, projection or clip conventions leave only the dependent row pending.

Depth fog uses the original FXShaders RetroFog curve, quantization, Bayer dither and optional sampled image color. Distance is measured in scene view-space units, reconstructed from the game's projection. Opacity, the curve endpoints and the center control the blend, and the fog color is applied in linear source primaries.

Depth outlines uses FXShaders' depth-gradient facing threshold with an adjustable blend strength. It reconstructs view distance before evaluating neighboring samples, preserving the declared depth region, origin and sample jitter.

### Estimated depth fog

Estimated depth fog applies fog from a relative depth that a model estimates from the image, so it does not need renderer depth. For this, the Image filter has a **Model** selection. Its Depth Anything V2 Small graph uses the original ViT-S/14 backbone and DPT64 head to produce a raw R32Float relative inverse-depth attachment. The model receives a display-referred sRGB proxy of the image, with ImageNet normalization and an aspect-preserving bicubic resize. Input size selects the inference grid in multiples of fourteen, and the attachment still covers the complete source image. Model loading and shape preparation run asynchronously, and redraws of an unchanged image reuse the completed GPU attachment.

The fog computes percentile bounds on the GPU and stabilizes their range across real images before applying the shared RetroFog curve, dither and color functions to relative far depth. It smooths the normalization bounds without blending old depth pixels into moving objects. A cut estimated from the image resets the range when the image changes sharply; this is separate from a renderer's cut signal. Redraws and generated images do not advance real-image history. Constant predictions leave the source unchanged. Opacity and the curve controls are artistic image controls, and this filter has no physical Distance parameter. It keeps the source size, HDR encoding and alpha.

The estimated attachment records which image and model produced it and whether it is complete. It stays separate from renderer depth and does not supply scene inputs to temporal upscalers or ambient occlusion. Inference requires the Apple Silicon neural provider on macOS 14 or later, and the ARM64 helper also serves a translated x86_64 graphics process. The declared [Small graph and checkpoint](https://github.com/procrastinine/maclauncher-builds/tree/main/producers/maclauncher/src/modules/shared/reshade/neural/native) use Apache-2.0 terms; other Depth Anything variants have separate contracts.

### Histogram exposure

Histogram exposure is a shared Image filter that adjusts exposure from the image's own luminance. Its GPU log-luminance histogram uses 256 bins from −16 to +16 EV in linear source primaries. Low and High percentile trim the metering interval, and Target gray and Compensation determine the requested gain within the selected EV limits. Adaptation speed controls real-image history. Cut threshold enables a reset, derived explicitly from the image, when both the distribution and the exposure change substantially.

Exact redraws reuse the completed exposure without advancing its clock, and synthetic frames use the accepted exposure of the real image. Source epochs, seeks, changed upstream images and discarded GPU work have their own history and completion rules. The filter keeps dimensions, signed HDR color and alpha, and at zero EV the original encoded pixels are unchanged. It needs no renderer guides and is separate from CShade's average and spot log-luminance metering.

## Source and feature declarations

Which implementations can be called is determined by the graphics processor's feature manifest, provider descriptors and model declarations. A running game keeps the verified processor files that it loaded at launch, including its helper and shader resources, so selecting a newer processor version does not change them for that session.

The main implementation declarations are:

- the [operation contracts](../../src/modules/shared/effects/operation-contracts.mjs);
- the [temporal provider registry](../../src/modules/shared/reshade/temporal/providers.js);
- the [neural graph sources](../../src/modules/shared/reshade/neural/model-source.json);
- the [shader collections](../../src/modules/shared/reshade/shader-packs.json);
- the [native image methods](../../src/modules/shared/reshade/native-filter/index.js);
- the [downloadable shader collections](../../src/modules/shared/reshade/managed-shader-packs.json).

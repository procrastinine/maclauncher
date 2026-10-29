# Graphics providers

Providers implement operations inside the ordered graphics pipeline. The editor's
five node types describe the data transformation: **Image filter**, **Downsample**,
**Upscale**, **Temporal upscaling** and **Frame generation**. A shader format,
model family or compute backend selects an implementation within those types;
a shader's declared output geometry selects its type.

Installation and frame eligibility are separate. An installed temporal provider
still needs matching scene inputs; an image filter needs only its declared image
and assets. A missing optional input affects its dependent node. It does not
disable independent operations elsewhere in the sequence. Detection and selection
read local metadata; acquisition belongs to an explicit installation or consented
preparation action.

## Inputs and execution

| Input | Meaning |
| --- | --- |
| Color image | The current image, its actual extent, orientation, color encoding and alpha convention. It may come from a renderer, decoded video or an earlier operation. |
| Image pair or sequence | Chronological color images with content identities and timestamps. Image-based motion estimation does not become renderer motion. |
| Renderer guides | Depth, motion, jitter, exposure and camera data published for the same scene frame. Units, sample regions and temporal identity must match the color image. |
| Camera parameters | Actual near/far planes and vertical field of view where the algorithm requires them. These are separate from full view/projection matrices. |
| View/projection matrices | Explicit valid matrices associated with the scene frame. Missing matrices are not replaced by identity matrices. |
| Video planes | Decoder/native-player luma and chroma, or explicitly RGB-derived planes. Derived planes retain that provenance. |

Frame textures and inference stay on the GPU. Command encoding does not submit or
wait for the borrowed renderer command buffer. Resource preparation compiles
pipelines and allocates images outside that callback. Cross-process providers use
bounded jobs, GPU-backed shared storage and completion metadata; the launcher does
not carry frame pixels through Electron.

The process instruction set and GPU are different capabilities. Native Metal
providers can execute in an ARM64 or translated x86_64 process when the loaded
binary, OS and actual GPU support them. MLX executes in ARM64 code on Apple
Silicon; an ARM64 GPU helper supplies that implementation to an x86_64 graphics
process. This does not make an ARM64 library loadable in an x86_64 process.

## Spatial resizing

Spatial operations use one image and its real source/target extents. They do not
require depth, scene motion or renderer camera data. Downsampling has its own node
type and target sizing; it is not an upscale option with a scale below one.

| Provider | Operation and output | Additional input | Platform or contract |
| --- | --- | --- | --- |
| Area | Footprint-weighted reduction to the requested extent | None | Native Metal; appropriate for reduction rather than enlargement. |
| Nearest | Source-texel selection at the requested extent | None | Native Metal; useful for pixel art and explicit pixel grids. |
| Bilinear | Linear interpolation at the requested extent | None | Native Metal. |
| Bicubic | Cubic interpolation at the requested extent | None | Native Metal. |
| MetalFX Spatial | Apple's spatial reconstruction to the requested extent | None | macOS 13 or later and an actual supported MetalFX device/format combination. |
| FSR 1 | FidelityFX EASU with its RCAS sharpening stage | None | Native Metal adaptation of the original spatial algorithm. |
| MAKO spatial | MAKO's spatial reconstruction and sharpening | None | Native Metal adaptation; distinct from MAKO/Lossless frame generation. |
| LS1 | Lossless Scaling's LS1 spatial network | Compatible local Lossless Scaling input | Imported source remains separate from the graphics runtime. |
| libplacebo filters | Named reconstruction/reduction filters from the selected provider | Filter selection | Optional universal provider, macOS 15 or later; available names come from its actual filter inventory. |
| Scaling shaders | Geometry declared by the selected shader, including fixed scales, conditional scales and requested-size rules | Shader and its declared assets | Executed by the shader's original provider. Original hook stages and saved reference images determine when a refinement runs. |

An intrinsic model or shader scale describes its own result. A later explicit
resize can fit that result to a different extent. Input size and final display
size remain separate controls; intermediate work and memory follow the actual
ordered sizes.

## Scene-temporal upscaling

These operations consume real renderer guides. A captured final image alone does
not supply those guides, even when the same runtime can run image effects or
color-pair frame generation. Eligibility follows the published frame contract,
rather than a list of game or engine names.

| Method | Algorithm | Required scene inputs | Output and platform |
| --- | --- | --- | --- |
| MetalFX Temporal | Native MetalFX temporal reconstruction | Color, matching depth/motion, jitter and exposure conventions | Requested output extent; supported MetalFX device on macOS 13 or later. |
| MetalFX Temporal Denoised | Native denoising and temporal reconstruction | Noisy scene color, depth/motion, view/projection matrices, surface normal/roughness and diffuse/specular material reflectance | Requested output extent; macOS 26 or later and actual device support for the denoised scaler. |
| FSR 2 | Original FSR 2.2.1 scheduler and shaders adapted to Metal | Color, depth/motion, jitter, exposure conventions and actual camera parameters; scene region at least 32 by 32 for its luminance pyramid | Requested output extent; optional universal provider, macOS 13 or later. |
| FSR 3 | Original FSR 3.1.4 temporal upscaler adapted to Metal | The same scene data required by its scheduler | Requested output extent; optional universal provider, macOS 13 or later. This row does not select FSR frame generation. |
| FSR 4 | FSR 4.1.1 shader/model implementation through the native Mac provider | Matching scene color, depth/motion and jitter/exposure conventions | Requested output extent; provider requires macOS 15 or later and an Apple Silicon GPU with its bundled model/shader resources. |
| Arm ASR | Original ASR mixed fragment/MRT and compute scheduler adapted to Metal | Matching scene color, depth/motion, jitter/exposure and camera data | Requested output extent; optional universal provider, macOS 13 or later. |
| Snapdragon GSR 2 | Original two-pass temporal algorithm adapted to Metal | Matching color, depth/motion, jitter/exposure and camera conventions | Requested output extent; optional universal provider, macOS 13 or later. |
| XeSS | Original Intel XeSS runtime through a shared GPU compute host | Matching color, depth/motion, jitter and exposure conventions | Requested output extent; actual backend and installed host determine support. |
| DLSS SR scene | MLX-DLSS's scene-input graph | Real color, depth/motion, jitter and exposure conventions; compatible local model | Intrinsic 2× model output is fitted on the GPU to the actual temporal output region. Apple Silicon, macOS 14 or later. |

Reactive and transparency/composition masks are optional inputs where the selected
algorithm accepts them. They remain distinct from estimated image masks. Reversed
or infinite depth, output-resolution motion, jittered motion and source/output
regions are explicit conventions. Supported affine transforms update guides with
the image; unknown image warps cannot silently claim valid scene alignment.

FSR 2 and FSR 3 prepare pipelines, images and SDK context for the actual scene
owner before encoding. Resource-only preparation does not encode into the
caller's command buffer or advance frame history. A temporal row outside its
supported input domain uses the common fallback while independent compatible
image rows continue.

MetalFX operations use the system framework. Inspector and Runtimes share an
offline query of the default and available Metal devices, operation support and
temporal scale intervals. Device support is independent of the game's CPU
instruction set. Optional reactive, hit-distance, denoise-strength and
transparency inputs retain their actual producer declarations.

ASR's Quality, Balanced, Performance and Ultra Performance choices select actual
shader profiles. They do not prescribe a fixed input/output ratio. Its owned Metal
adaptation preserves the logical render-region boundary for integer RGB loads and
gathers, and keeps Performance's SDR history in the same color domain as its
prepared input. The source pin and exact adaptations are declared in the
[ASR recipe](../../src/modules/shared/reshade/temporal/asr/source.json).


FSR4's profile control selects Exact Fast, Lite or Lite2 within the same Temporal
upscaling row. Exact Fast keeps the original AMD coefficients and runs inference
every frame. Lite uses the upstream folded coefficients, rounding and guarded
inference reuse. Lite2 supplies six trained layers for the normal model family;
its Ultra Performance model remains Lite. These profiles have distinct model and
license identities. The default remains Exact Fast, and an older installed
provider exposes only the profiles it contains. Background resource preparation
keeps shader/model creation out of encoding; the actual network output and source
alpha are composed on the GPU into the requested output region. FSR4 consumes no
camera FOV or matrices.

### Original XeSS and game API mapping

The shared XeSS provider runs Intel's original Windows library. Super resolution
has D3D12 and Vulkan host routes; **Auto** chooses an available compatible route.
Module-owned compute hosts provide the Windows ABI and graphics translation.
The frame producer can be a native application or another scene-capable runtime;
the game itself does not need to be a Wine application.

The transport uses GPU copies between shared Metal-backed storage and the host's
D3D12/Vulkan resources. CPU messages coordinate ownership and completion. They do
not read, encode or serialize frame pixels. Backend capability, original library
identity and helper resources are validated separately. D3D12 and Vulkan nodes
retain independent prepared configurations when both appear in one sequence.

The D3D11/DXMT game API replacement is a separate integration. It forwards actual
XeSS API resources and frame metadata to a configured shared temporal provider.
That mapping does not establish that Intel's neural runtime executed, and does
not imply interception support for every D3D12/Vulkan game API entry point.
Unsupported flags or graphics profiles receive the corresponding API error.

Original XeSS components are imported as local runtime inputs with their exact
component identities and license terms. Super-resolution, frame-generation and
latency components have separate requirements. Provider code installation does
not itself install or authorize every component.

Frame generation supplies unjittered row-major view/projection matrices to the
original SDK. The adapter removes declared projection jitter and converts
explicit clip-range and Y-orientation representations for its actual texture
rows. Authored view, off-center projection and reverse-depth geometry are
preserved; missing renderer matrices are not inferred from camera parameters.

## Neural rendering, restoration and image upscaling

All methods below use the shared GPU neural provider. A model's manifest and actual
tensor names, dimensions, data types and operation are validated together. A
display name or renamed weights file cannot turn one architecture into another.
The selected provider advertises its actual operations; older NR-only payloads
remain usable for their supported operation.

| Method | Implemented graph and inputs | Intrinsic output | Model requirement |
| --- | --- | --- | --- |
| DLSS neural rendering (`mlx-dlss`) | MLX-DLSS neural rendering; current RGB, with optional image-based temporal estimation | Same extent | Compatible neural-rendering package. Temporal estimation uses image history, not engine depth/motion. |
| RTX VSR (`mlx-vsr`) | Independent-image RTX Video Super Resolution graph | 2× each dimension | VSR package matching that operation. |
| DLSS SR image (`mlx-sr-image`) | MLX-DLSS image-sequence SR with its image-derived guide path | 2× each dimension | Image-SR package; distinct from a real renderer-guide scene contract. |
| DLSS SR scene (`mlx-sr-scene`) | Scene-input SR graph with actual normalized renderer guides | 2× before fitting to the scene output region | Compatible scene-SR contract. |
| Real-ESRGAN (`realesrgan`) | SRVGG-16 anime/video or SRVGG-32 general; PReLU, pixel shuffle and nearest residual | 4× each dimension | Supported SRVGG safetensors/package; RRDB is a different architecture. |
| Real-CUGAN (`realcugan`) | Standard UpCunet2x/3x/4x cascaded U-Nets, transpose convolutions and global squeeze-excitation statistics; 4× includes the original residual/pixel-shuffle tail | Model-selected 2×, 3× or 4× each dimension | Exact typed model and provider architecture; Pro has a separate graph contract. |
| NAFNet (`nafnet`) | SIDD width64 denoising or GoPro width64 deblurring with its TLC pooling behavior | Same extent | Matching float32 graph/tensors. GoPro and SIDD are separate contracts. |

These models consume display-referred sRGB RGB in their declared range. The common
color boundary can create an explicit local SDR conversion for HDR/P3 input and
restore the surrounding image's encoding afterward. That conversion does not
recover highlights discarded by the SDR model. Alpha is transported separately
from RGB inference and restored with its actual convention.

General SRVGG-32 can use its matching WDN checkpoint. `denoiseStrength` blends the
paired model parameters during model loading: zero selects weak denoising and one
the strong general model. It is exposed only for a compatible paired package,
and is separate from neural-rendering intensity or output opacity.

Real-CUGAN's attention statistics cover complete feature images. NAFNet retains
its trained block counts, channel normalization, residual scales and padding;
GoPro uses its training-derived local pooling kernels and float32 reductions.
Independent image tiles cannot replace those attention or pooling domains.

Local `.dlssmodel` and `.restorationmodel` packages retain their manifest, weights,
checksums and notices. Compatible raw restoration safetensors are recognized by
their actual tensor contract. RIFE's original supported ncnn model folder can be
converted during import; this conversion processes model weights, not frames.
Model weights and their terms remain separate from provider source licenses.
See [neural restoration models](../NEURAL_RESTORATION.md) for import details.

Original NR libraries containing `WEIGHTS_HT` or `WEIGHTS_CC_SMALL_FP8` can be
imported directly. Import decodes their PE resource data into complete logical
NR tensors without loading or executing the DLL. A library containing both
networks supplies separate HT71 and Small31 models. Logical NR safetensors can
also be imported; complete tensor topology, precision and the 16-feature to
four-channel model contract determine admission.

The supported original NVIDIA 310.9.16 frame-generation DLL and Linux RTX VSR
1.8.2 library can be converted during import without executing vendor code or
requiring Python. Their packed FP16 parameters become the matching interpolation
or VSR package. DLSS SR uses a prepared preset-K LDR 2× package containing its
reconstruction filter and exact postprocessing shader. Import also accepts a
local capture folder containing `libnvidia-ngx-dlss.so.310.7.0`,
`L0001_params.bin`, `L0012_params.bin` and their corresponding
`L0001_buf<address>.bin` and `L0012_buf<address>.bin` files. The converter verifies
the exact original library, trained weight and reconstruction-filter digests,
then produces the SR package. An NR package cannot supply these resources.

The live neural implementation requires Apple Silicon and macOS 14 or later.
ARM64 frame producers may use the in-process provider; translated x86_64 producers
use the ARM64 helper. Metal/IOSurface ingestion, model operations and egress remain
on the GPU in both cases. Preparation, live changes and model lifetime use the
same managed provider/model lifecycle.

Before a neural row is adopted, its provider runs one inference at the row's
extent with no frame command buffer waiting on it. That inference reads an
opaque black image, so it loads and runs the model; admission checks that depend
on image content, such as the opaque SDR requirement, follow the frames the row
consumes. The graph reports Preparing
with the reason "Neural provider is warming up" while the accepted chain keeps
rendering. Retries keep the same warming node. After the ordinary two-second
preparation grace, the graph is adopted without that row, whose stage reports
Preparing with the same reason, and the warmed node joins the graph once its
inference completes. A frame waits at most
two seconds for its provider. When an inference exceeds that bound, the frame
keeps the row's input image and later frames bypass the row with a reason until
the late inference completes. A failed inference makes the row unavailable for
a retry interval that starts at one second and doubles to at most thirty
seconds, with the reason "Neural provider failed; retrying". A rendered
inference resets the interval. XeSS host results use the same two-second bound.

## Frame generation

Frame generation produces timestamped images between chronological endpoints.
The common presenter owns delivery and display scheduling. Providers do not
independently present extra frames or alter the application's simulation rate.

| Method | Inputs and algorithm | Generated images | Requirements |
| --- | --- | --- | --- |
| Lossless Scaling (`lsfg`) | Color pair; original Lossless Scaling model/shaders through MAKO | Configured phases between the pair, up to four intermediate images | Compatible imported local Lossless Scaling input. No renderer guides required. |
| MLX interpolation | Color pair and explicit phase; MLX-DLSS interpolation graph | Configured phases, up to four intermediate images | Compatible interpolation model; Apple Silicon/macOS 14 provider or ARM64 helper. |
| RIFE | Color pair and explicit phase; v4.6 four-stage flow refinement and GPU warping | Configured phases, up to four intermediate images | Exact supported RIFE model; same neural provider/helper requirements. |
| MetalFX interpolation | Real scene pair, depth/motion, jitter/exposure and finite perspective camera data | One midpoint for an eligible real interval | macOS 26 or later and actual device support for the MetalFX interpolator. |
| FSR 3 interpolation | Original optical-flow and frame-interpolation effects with actual scene data/camera conventions | One midpoint for an eligible real interval | Optional universal Metal provider and its complete shader resources, macOS 13 or later. |
| XeSS interpolation | Original XeSS-FG and XeLL components; real scene color, depth/motion, view/projection matrices | One midpoint for an eligible real interval | D3D12 compute-host route and separately imported compatible FG/latency components. |

LSFG retains its original SDR kernels for ordinary 8-bit sRGB input. HDR and
color-converted float inputs use the original HDR generation kernel with float
graph resources and FP16 source, history and generated images. The shared color
adapter converts to linear BT.709/scRGB with an 80-nit reference white, then
returns generated images to the source encoding without an SDR tone-map step.
Wide-gamut SDR converted to this linear contract also uses the HDR kernel.
Real endpoints remain the original images. Graph image initialization is a
batched GPU preparation; the graph becomes usable only after that work completes.

Color-pair providers can consume suitable generated color images from an earlier
stage. Scene providers operate on eligible real intervals and retain the actual
guide/matrix lineage; they do not fabricate renderer guides for an upstream
synthetic image. Other synthetic events can remain in the same timeline.
Consequently, combining stages composes actual timestamps and provenance rather
than promising the product of their multiplier labels.

The shared timeline analyzes the actual input pair for Lossless Scaling, MLX
interpolation and RIFE. GPU comparison detects exact decoded-texel repeats;
bounded encoding-domain color differences provide a conservative cut estimate.
These are image-derived signals, separate from renderer reset markers. After
the source GPU fence, a repeat, estimated cut or unmatched history suppresses
that pair's synthetic events and their descendants while retaining its real
endpoint. Each selected row budgets one source-format GPU history image, two
compute passes and one GPU image copy per pair. FSR 3 and scene providers retain
their own reset and no-interpolation decisions.

Lossless Scaling, MetalFX, FSR 3 and XeSS generation declare an opaque-image
requirement. The MLX interpolation and RIFE adapters carry alpha separately from
their RGB model inputs. Transparency eligibility belongs to the selected
generation provider, rather than disabling every image operation in the graph.

Reset, discontinuity, source epoch, scene/color geometry and completion belong to
the relevant histories. Paused redraws reprocess the accepted image without
advancing generation history. A provider's no-interpolation or failed result
cannot be counted as a generated event; its real endpoint remains available.
XeLL integration in a helper does not establish engine simulation markers or an
end-to-end input-latency measurement.

## Shader formats and image effects

| Format/provider | Supported work | Inputs, assets and platform |
| --- | --- | --- |
| ReShadeFX | Original FX techniques, parameters, textures and multipass effects | Referenced includes/assets must be available. Depth techniques require a matching real depth publication. |
| RetroArch Slang | Slang shaders/presets, pass geometry, parameters and their declared history/assets | Original preset structure and assets remain part of the prepared input. |
| MPV/libplacebo hooks | Multipass image hooks, parameters, static textures, RGB/luma/chroma operations and LUT processing | Optional universal provider on macOS 15 or later. Native video planes and RGB-derived planes retain separate provenance. |
| libplacebo image filters | Original renderer debanding selected by a data-only `.plfilter` descriptor | Iterations, threshold, radius and grain use the original deband parameters. The selected provider advertises its image-filter API; the filter preserves the input extent and alpha. |
| ISF | `inputImage` filters, typed controls, multipass and persistent targets, imported images | Optional universal ISFMSLKit provider on macOS 15 or later. Additional image/audio/FFT/cube inputs need actual bindings; they are not aliases for `inputImage`. |
| MagpieFX | Declared multipass HLSL pixel/compute effects, parameters, intermediate textures and source assets | Owned parser/translation preserves pass resource and output-size declarations. The selected graphics payload supplies its compiler/runtime resources. |
| Native image descriptors | Compiled image algorithms selected by typed `.mclfilter` data | Known algorithm ID and bounded parameters; no source code or executable paths. The payload advertises the compiled methods it contains. |

Image effects remain searchable in the same category regardless of source format.
Included collections cover ordinary finishing and appearance effects; managed
collections and imported files supply additional algorithms. Required textures,
kernel tables and licenses accompany their collection rather than depending on a
working directory or an unrelated application installation.

FidelityFX Lens and Blur are ordinary Image filters using the original SDK
kernels. Lens exposes grain, chromatic aberration and vignette controls; Blur
selects odd Gaussian kernel sizes from 3 to 21 pixels and three sigma profiles.
Both preserve source dimensions, signed HDR values and source alpha. Lens changes
pixel coordinates, so renderer guides cannot pass through it unchanged. Blur
retains coordinate alignment. Their resources are prepared before live encoding.

Screen-space reflections use the original Godot scale, ray-march, roughness,
horizontal/vertical filter and specular-merge schedule. The Image filter consumes
actual depth, projection, normals, roughness, metallic and resolved lighting at
their declared renderer pass. A mismatched later composition preserves the full
image instead of applying an earlier scene result to unrelated pixels.

Anisotropic Kuwahara uses the author's structure tensor, Gaussian smoothing,
eigenframe and eight-sector filter. Its five-pass hook uses separable equivalent
Gaussian smoothing, the generated original sector table and retained source
alpha. Radius, sharpness, anisotropy and orientation smoothing are ordinary live
parameters. The algorithm is distinct from a four-quadrant Kuwahara approximation.

Shader declarations determine geometry and input domain. An RGB effect does not
become a native chroma operation because its filename contains “chroma”; a tensor
or feature-texture pass does not resize the frame by itself. Exact source and
destination sizes remain available to the original provider.

Local Laplacian uses Halide's fast local Laplacian formulation: eight Gaussian and
Laplacian levels, intensity remapping and interpolation, followed by color
reconstruction. Its float32 pyramids retain the halo domains needed for the
original repeated-edge input boundary. Detail and contrast control the remapping;
intensity samples control its approximation resolution. The native effect has a
bounded sRGB working domain, retains image dimensions/orientation and alpha, and
uses the common local SDR conversion boundary when necessary.

CMAA2 processes resolved single-sample color with the original edge detection,
shape-candidate and deferred-application kernels. GPU counters generate the
indirect dispatch arguments; scratch lists and atomic heads remain GPU resources.
Quality selects its edge threshold and Preserve detail selects its sharpness
variant. The adapter converts the actual image encoding to linear RGB and back,
retains source alpha, and uses float32 deferred colors plus a sign-symmetric edge
metric for signed wide-gamut/HDR components. It does not require an SDR conversion
island. Multisample reconstruction is a separate input contract.


XeGTAO is a depth-aware Image filter. It requires resolved renderer depth aligned
to the current image and the actual unjittered projection matrix with an explicit
zero-to-one or minus-one-to-one clip range. Projection inversion handles handedness,
reverse Z, perspective and orthographic views; current sample jitter and depth ROI
remain explicit. Normals are reconstructed from depth on the GPU, so motion,
view matrices and guessed camera FOV values are unnecessary. The original depth
prefilter, horizon search and edge-aware denoiser produce ambient visibility,
which multiplies linear RGB in the source primaries before returning to the source
encoding and alpha convention. Radius uses scene view-space units; Strength blends
visibility with one. Quality chooses the original sample counts and Denoising
chooses the spatial passes. The effect retains dimensions and alpha, uses stationary
spatial noise, and requires no temporal history. Missing scene inputs leave the row
pending while independent image filters remain available.


CACAO supplies an independent depth-aware Image filter through the same actual
scene-input boundary. Its original deinterleaved depth and normal preparation,
quality-dependent SSAO generation, adaptive importance map and load counter, smart
edge blur and application passes run on the GPU. Half resolution selects CACAO's
original downsampled AO path and bilateral upscaler; the image row still returns
the original dimensions. Depth-derived normals need no renderer normal buffer.
The projection, clip range, jitter and Y orientation retain their explicit scene
meaning, including orthographic views and reverse Z. Signed tile halos and bounded
scalar loads keep bilateral reconstruction inside the declared image region.

Radius and Fade distance use scene view-space units. Fading starts at one sixth
of the selected distance and reaches neutral visibility at that distance, retaining
the original default interval of 50–300. Strength controls the original shadow
multiplier, Quality selects the original fixed/adaptive sample schedules, Blur
selects zero through eight edge-sensitive passes, and Sharpness controls edge
bleed. Ambient visibility multiplies linear RGB in the source primaries; the
original encoding and alpha are restored at output. Missing actual depth or
projection leaves the row pending, independently of other image filters.

FidelityFX DoF is an Image filter using the same actual renderer depth and
projection contract. Its original five-pass schedule reduces depth and color,
dilates the depth tiles, samples near and far blur, then composites at the current
image extent. Focus distance uses scene view-space units. Blur radius specifies
the maximum circle-of-confusion radius in that row's full-resolution output
pixels, independently of an earlier resize. Quality selects one through eight
sample rings; Merge sample rings selects the original merged-ring variant.
Motion and renderer lens metadata are unnecessary: the focus and maximum radius
define the selected artistic camera response explicitly.

The adapter reconstructs view depth from the declared clip range, projection,
origin, jitter and depth region before the original kernels run. It processes
linear RGB in the source primaries and restores the original encoding and alpha.
Known image resizes use the shared guide normalization; unsupported guide
transforms or missing actual depth leave only this row pending. Image-estimated
relative depth does not satisfy its renderer-depth contract.

Depth fog and Depth outlines use the same resolved-depth and actual-projection
boundary. Both are Image filters in the common searchable selector. They retain
the current extent, encoding and alpha and need no motion vectors, view matrix
or temporal history. Known resize stages normalize their guides through the
shared scene adapter. Missing depth, projection or explicit clip conventions
leave only the dependent row pending.

Depth fog uses the original FXShaders RetroFog curve, quantization, Bayer dither
and optional sampled image color. Distance is measured in scene view-space
units reconstructed from the actual projection. Opacity, curve endpoints and
center control the blend; fog color is applied in linear source primaries.
Depth outlines uses FXShaders' depth-gradient facing threshold with an adjustable
blend strength. It reconstructs view distance before evaluating neighboring
samples, preserving the declared depth region, origin and sample jitter.

Estimated depth fog is an Image filter with a compatible Model selection. Its
Depth Anything V2 Small graph uses the original ViT-S/14 backbone and DPT64 head
to produce a raw R32Float relative inverse-depth attachment. A display-referred
sRGB proxy, ImageNet normalization and aspect-preserving bicubic resize supply
the model. Input size selects the inference grid in multiples of fourteen; the
attachment still covers the complete source image. Model loading and shape
preparation run asynchronously, and exact unchanged-image redraws reuse the
completed GPU attachment.

The fog consumer uses GPU percentile bounds and stabilizes their range across
real images before applying the shared RetroFog curve, dither and color
functions to relative far depth. It smooths the normalization bounds without
blending old depth pixels into moving objects. An image-derived cut estimate
resets the range when the image changes sharply; it is distinct from a renderer
cut signal. Redraws and generated images do not advance real-image history.
Constant predictions preserve the source. Opacity and the curve controls are
artistic image controls; this filter has no physical Distance parameter. It
preserves the source extent, HDR encoding and alpha. The estimated attachment
retains its image/model identity and completion validity, stays separate from
renderer depth and does not supply scene inputs to temporal upscalers or AO.
Inference requires the Apple Silicon neural provider on macOS 14 or later; its
ARM64 helper also serves a translated x86_64 graphics process. The declared
[Small graph and checkpoint](../../src/modules/shared/reshade/neural/native/depth-anything-source.json)
use Apache-2.0 terms; other Depth Anything variants have separate contracts.

Histogram exposure is a shared Image filter. A GPU log-luminance histogram uses
256 bins from −16 to +16 EV in linear source primaries. Low and High percentile
trim the metering interval; Target gray and Compensation determine the requested
gain within the selected EV limits. Adaptation speed controls real-image
history. Cut threshold enables an explicitly image-derived reset when both the
distribution and exposure change substantially.

Exact redraws reuse the completed exposure without advancing its clock.
Synthetic frames use the accepted real-image exposure. Source epochs, seeks,
changed upstream images and discarded GPU work retain separate history and
completion rules. The filter preserves dimensions, signed/HDR color and alpha;
zero EV preserves the original encoded pixels. It needs no renderer guides and
is distinct from CShade's average/spot log-luminance metering.

## Source and feature declarations

The selected graphics payload's feature manifest, provider descriptors and model
contracts determine the callable implementations. A running session retains the
trusted payload it actually mapped, including its helper and shader resources;
selecting a newer payload does not change those bytes inside that session.

The primary implementation declarations are the
[operation contracts](../../src/modules/shared/effects/operation-contracts.mjs),
[temporal provider registry](../../src/modules/shared/reshade/temporal/providers.js),
[neural graph sources](../../src/modules/shared/reshade/neural/native/restoration-sources.json),
[shader collections](../../src/modules/shared/reshade/shader-packs.json),
[native image methods](../../src/modules/shared/reshade/native-filter/index.js), and
[managed shader sources](../../src/modules/shared/reshade/managed-shader-packs.json).

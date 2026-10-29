# Graphics and effects

MacLauncher uses one ordered graphics chain across native apps, browser games,
Android and iOS apps, Wine and engine runtimes. Effects process GPU images without
changing game files. Shaders, processing sizes, models and output settings share
the same editor. Available scene integrations follow the running process.

Color filters, resizing and image reconstruction use completed images. Scene
effects additionally require matching depth, motion or camera data. The shared
libplacebo provider can derive luma and chroma from RGB; hooks requiring original
decoder planes or metadata retain those distinct input requirements.

The [settings reference](runtimes/GRAPHICS.md) describes renderer integrations,
CRT tuning and model acquisition. The [pipeline reference](GRAPHICS_PIPELINE.md)
documents adapters and frame APIs. Graphics processing applies to images; runtime
volume and mute controls manage audio separately.

The [frame-source and scene-input tables](graphics/INPUTS_AND_ADAPTERS.md#frame-sources-and-scene-inputs)
distinguish native GPU ingress, browser window streaming, bitmap upload and
decoder input from the separate depth, motion and camera requirements. The
[provider reference](graphics/PROVIDERS.md) maps each algorithm and shader format
to its image, history, guide, model and color contracts.

## The graphics chain

The inspector's **Graphics** switch bypasses the whole chain while preserving
its rows, sizes, parameters and model choices. The **Preset** menu sits above
the Simple/Advanced selector. **Simple** presents flat method
dropdowns with contextual options, grouped by input and output: **Image filters**,
**Resize** (Downsample and Upscale) and **Temporal**. Multiple image filters
compose in the same chain; temporal upscaling and frame generation share the
Temporal group. Model and shader labels show their declared scale. A shader
selected or dropped on a row appears in that row and uses its size controls:
**Output size** for a shader that renders at a requested size, or the declared
scale followed by the row's window fit for a fixed-scale shader.
**Motion clarity** remains a main feature control.
**Advanced** exposes the full ordered chain. Both views edit the same settings;
switching views preserves every effect. Custom orders remain intact, and
multiple active resizing or temporal effects show Custom with an edit action.
Large method selectors include search, arrow-key navigation and Enter selection;
Escape closes the picker and returns focus to the selected method.
**Manage filters…** opens the shared searchable shader library with the matching
type selected. Imported filters appear in compatible selectors immediately.

In Advanced, **Add effect…** first selects **Image filter**, **Downsample**,
**Upscale**, **Temporal upscaling** or **Frame generation**, then searches
compatible methods. Image filters preserve size, including DLSS neural
rendering. A shader's declared output geometry places it: a fixed 2× shader or
one that conditionally doubles toward the window is an Upscale, a fixed
reduction is a Downsample, and a shader that renders at a requested size is
listed under its declared resize directions. Shaders whose size cannot be
determined from their declarations remain Image filters marked **Unknown size**.
Every shader uses the same execution path. Imported shaders extend the same
library. Each expandable
row shares the method selector for its input and output type, with an enable switch,
parameters, reorder buttons and removal. Dragging or Alt-Up/Down also reorders
rows. Effects run from top to bottom, with up to 32 rows.

Options/Details includes the observed input and output pixel dimensions for every
step, including size-preserving filters. Match window, percentages of the image
or window, and pixel width/height remain distinct size choices. The final window
keeps its visible size while processing resolution changes.

A row retains its own parameters when another row changes. Existing compound
shader selections retain their passes; additional combinations use ordinary
rows. The actions menu contains **Clear effects**, followed by **Undo**. Opening
or expanding controls does not change the saved chain.

Edits save immediately while replacement resources prepare asynchronously.
Controls remain usable during shader compilation and model loading. Turning
Graphics off can interrupt preparation. Unsupported or missing optional inputs
leave independent stages and original rendering available. Saved requests remain
intact. Changes that require establishing a renderer integration at launch are
identified by their controls.

Compact badges distinguish saving, preparation, publication and observed GPU
execution. **Applying…** means a replacement has been published; **Active** on a
row requires matching runtime work. **Details** exposes dimensions, counters and
fallback reasons. Counters describe processing, separately from game FPS.

**Presets** saves the current chain, applies a copy or opens its editor under
Settings → Graphics → **Presets**. Later preset edits leave applied
games unchanged. Preset lists update across open launcher windows; unsaved
editor drafts remain intact. Presets contain references to shared shaders and models.

## Shader library

| Format | Provider | Resources |
| --- | --- | --- |
| `.fx` | ReShadeFX | Techniques, passes, uniforms, includes and lookup textures. |
| `.slangp`, `.slang` | librashader with Metal | Preset passes, scaling, textures and parameters. |
| `.glsl`, `.hook` | libplacebo or native mpv | Hook passes, embedded textures, declared scaling and parameters. |
| `.cube` | GPU libplacebo LUT hook | 1D tables, 3D tables and combined shaper/3D tables. |
| `.fs`, `.isf` | ISF on Metal | Declared parameters, image resources, multiple passes and persistent targets. |
| `.hlsl` | MagpieFX on Metal | Format 4 parameters, includes, image/DDS assets, authored geometry and compute passes. |

**Manage filters…** opens Runtimes → Graphics → **Shaders**. The **Library**
contains included, collection and imported shaders together. Names, input/output
types and availability match the inspector. Display names are editable without
changing shader identity; source details expose file paths. Imported registrations
also support replacing a path or removing the registration. Removing a
registration preserves original files and dependent resources.

**Import filter…** registers an original local file. Enter or leaving an edited
field saves, and Escape cancels. Dropping shader or LUT files into the launcher,
or opening them through Finder, uses the same library.

The **Collections** sub-tab contains project versions, installation and defaults.
Installed choices appear in the inspector's matching input/output category.
Anime4K, ArtCNN, Chroma from Luma, CuNNy, ACNet/ARNet, RAVU/NNEDI3, Vidvox ISF,
libretro Slang, MagpieFX, CShade, prod80, FXShaders, qUINT, NiceGuy shaders,
Visibility bitmask lighting and the mpv shader collection use explicit refresh
and installation. CShade includes image-derived optical-flow/motion
effects and average/spot exposure; prod80 includes grading and LUT resources;
FXShaders includes NeoBloom and ArcaneBloom. The libretro Slang selection covers
pixel-art reconstruction (xBRZ, SABR and pixel-art scalers), dedithering, median
and bilateral restoration, CRT halation and image-history shaders. NiceGuy
shaders provide screen-space lighting, reflections, depth fog and image effects
with their original textures. Visibility bitmask lighting (SSRT3) provides
indirect lighting in two entry points, lighting only and diffuse composition, and
reads actual depth, normals, radiance and camera matrices.
Selection and local status remain offline. Installed collections retain exact source revisions.
**Set default** records an explicit collection-version choice. Installing or removing
another version preserves that choice, including an unavailable saved version.
Collection versions have no package-wide recommendation; effect recommendations
and their menu order are independent of collection-version settings.

Shader names do not determine their processing category. Authored output sizes,
scale factors, stage dependencies and resize declarations determine placement.
Search results retain algorithm groups and compact output-size labels; contextual
help explains placement requirements.

Included effects work offline and follow app updates:
- the built-in **CRT**, **Grayscale**, **Colour** (vibrance), **Sharpen** and
  **CAS Sharpen** effects, and **Combine effects…**, which runs two to four of them
  as one row;
- SweetFX SMAA, Tonemap, Vibrance and Curves;
- CRT Easymode, Lottes, GTU, zfast and CRT Royale;
- Image color balance, threshold deband, pixel palette and soft bloom;
- **Daltonize**, LMS color-vision simulation and error redistribution with
  adjustable strength;
- SSimSuperRes, an mpv hook that refines an upscaled image against its
  lower-resolution source;
- anisotropic Kuwahara;
- the native image effects: Histogram exposure, Local Laplacian, CMAA2, XeGTAO,
  CACAO, Depth fog, Depth outlines, Estimated depth fog, Screen-space reflections,
  FidelityFX DoF, FidelityFX Lens and FidelityFX Blur.

The [collection notices](../src/modules/shared/reshade/shader-collection/NOTICE.md)
record their sources and licenses. **CAS Sharpen** preserves alpha and applies
AMD Contrast Adaptive Sharpening in linear light. The
[provider reference](graphics/PROVIDERS.md#shader-formats-and-image-effects)
describes each native image effect's algorithm and inputs.

**Custom shader…** and **Choose shader…** select local entry files up to 8 MiB.
Includes, preset passes and textures retain their original relative locations.
**Shader parameters…** exposes declared names, defaults, ranges, vectors,
booleans and choices. Uniform changes reuse resources; changing a compile-time
constant rebuilds them. Repeated uses of one shader retain separate parameters.
A shader whose compiled program reads depth also shows **Depth input**: the
game's reversed, logarithmic, far-plane and multiplier definitions, shared by
all of its depth shaders. Changing them recompiles those shaders.

MagpieFX preparation compiles original HLSL pass bodies outside the game process
and stores immutable Metal resources. Runtime passes use the caller's Metal command
buffer. Authored output dimensions retain their expressions and intrinsic scale;
effects with unspecified output dimensions accept the selected stage size.
Collection imports resolve parent-relative includes and assets within their
declared folders; standalone imports use the entry folder. Windows and Unix
path separators are supported. DDS lookup textures preserve their channels and
mipmaps. Optional FP16 declarations
can use the equivalent FP32 path. ISF and MagpieFX use a local sRGB SDR conversion
when the source requires it; other compatible rows retain their native range.

CUBE imports preserve domain and input ranges, red-fastest table order and
original files. LUT controls provide strength, trilinear or tetrahedral 3D
interpolation, and independent encoded/linear input and output transfer choices.
The GPU uses the full table, including 65³ LUTs. Static texture preparation has a
16 MiB generated-hook limit; per-frame pixels remain on the GPU. LUT packages
retain their own color-space assumptions and licensing terms.

## Rendering, processing and output size

**Game resolution** changes the game's render target through its runtime source
adapter. Available divisors and fixed heights follow that adapter. **Original**
retains the game's size. Simple **Upscale** defaults to half-size input for
general spatial filters, or reciprocal input for a uniform intrinsic scale:
a 4× model starts at 25% of presentation size. Its output fits the window when
no manual size is selected. Its owned input request is
removed when that feature is turned off; manual sizes remain intact. Simple
neural rendering chooses a compatible installed model and starts with a fixed
540-pixel input height, preserving aspect ratio and smaller inputs. Native decoded video retains
its decoded input size. Source filtering is separate; an adapter can declare
an exclusive scene-scaler requirement. Godot retains its 2D interface and physical window while changing
root 3D scale.

**Downsample** and **Upscale** share three size modes: scale of the previous
image, fraction of the window/fullscreen surface, and fixed resolution.
Downsample defaults to 0.5× input. Upscale defaults to 100% of the window/fullscreen
surface; this is window fitting, without a separate size mode. The 540p preset
means a height of 540 pixels, with aspect ratio preserved. It does not choose
another pixel height as the window changes.
MetalFX spatial uses the requested output dimensions; fixed-scale models retain
their intrinsic scale and can use a separate final fit. Custom width, height or
both accept 1–16384 pixels; a single dimension preserves aspect ratio.

The final presentation surface follows the native window's backing size or the
fullscreen surface, including Retina. Intermediate image sizes do not resize the
window. A common final fit normalizes the last processed image to that surface.
An explicit last resize row can choose the fitting algorithm; a matching result
needs no further resize. The **DLSS · 540p + LSFG 4×** preset uses bilinear
downsampling to 540p, same-size neural rendering, window fitting and 4× frame
generation.

A chain can Downsample → neural reconstruction → Upscale → CRT. Fixed-scale
neural models and shaders retain their intrinsic scale. A separate resize row
changes the resulting size. Processing reduction lowers downstream effect work;
game render cost changes only through the source adapter.

Downsample **Options → Adaptive quality** adjusts a working extent within the
selected scale bounds and GPU budget. The saved Output size remains its baseline;
turning the policy off restores it. Measurements identify the completed GPU
processing section they cover. Affected provider work on an unreported queue keeps
the policy pending with its reason in help. The same policy applies to file export,
with fixed output dimensions and media timestamps; export timing covers the owned
processing job, separately from decoding and video encoding.

MetalFX Spatial, FSR 1, MAKO, LS1 and standard filters operate on images.
MetalFX Temporal, FSR 2.2/3.1/4.1, Arm ASR and Snapdragon GSR 2 require matching
scene depth, motion and jitter. Providers that use camera projection require its
actual metadata. A processor with shared scene-guide normalization can carry
these inputs through known processing resizes, including cropped inputs and
output-resolution motion. Unknown coordinate changes cannot supply matching
guides. FSR3 upscaling and frame generation are separate operations.

FSR 4 **Profile** selects the installed Exact Fast, Lite or Lite 2 shaders.
ASR quality selects its Quality, Balanced, Performance or Ultra Performance
shader profile independently of the input/output resolution. SGSR2 uses the
original two-pass reconstruction shaders with native motion, camera and exposure
conversion. Provider availability follows the selected processor's compiled
support and installed resources.

## Neural models

Neural rows have one **Model** menu for compatible installed packages and model
management. New method choices require an installed compatible model. A saved
selection whose model becomes unavailable remains visible with **Model needed**
and a route to the model library. Missing models leave independent effects
running; only their automatic input helpers remain pending.

**Automatic** shares one selection policy in Simple and Advanced: a compatible
per-operation preference, a compatible existing default, then the curated source.
Choosing an interpolation default preserves the neural-rendering preference.
Real-ESRGAN's curated default is General with its paired WDN checkpoint. Explicit
per-game model paths remain separate from these defaults.
The Model menu checks an imported package's operation before assigning it to an
effect. Imported packages remain available in the shared library for their own
operations.

Model output size follows the selected package. Real-CUGAN keeps its 2×, 3×
and 4× variants in the same Model menu. Changing the model refits automatically
owned input sizing; explicit processing sizes remain intact. Directly selected
shader files expose their own geometry, inputs and model controls.

DLSS neural rendering blends its result with **Intensity** from 0 to 1.
**Temporal reconstruction** estimates image motion and retains history,
independently of renderer temporal upscaling. RTX VSR and DLSS SR image models
produce an intrinsic 2× image. Real-ESRGAN and Real-CUGAN retain their model's
intrinsic scale; NAFNet restores an image at its original size. Real-ESRGAN
denoising strength appears only for an installed paired denoising model. MLX
interpolation and RIFE use paired images for generation. History controls follow
the model operation; image-only restoration does not request scene guides.
Operations appear according to the selected provider's compiled support.

[Restoration models](NEURAL_RESTORATION.md) describe Real-ESRGAN, Real-CUGAN,
NAFNet and RIFE input/output contracts, supported architectures and imports.

Runtimes → Graphics → **Neural models** imports `.dlssmodel`, `.vsrmodel`,
`.srmodel`, `.fgmodel`, `.restorationmodel`, `.depthmodel`, compatible raw weights, apps containing model packages,
or ZIP packages. Manifests, declared weights and notices are copied without
executing the source. Original packages remain unchanged. **Download model…**
obtains its declared source after consent. Reimport repairs an incomplete managed
copy. Model terms remain separate from the provider's source license.

The model table lists supported sources and compatible imports, their actual
input/output category and scale, installed state and a per-row help button.
Installed models lead the table. While any model is installed, sources not yet
installed follow behind **More downloads**.
**Install** obtains the declared source after consent. **Default for** selects
the preferred installed model for one named operation; selecting an image-model
default preserves scene-reconstruction and frame-generation preferences.
**Use existing package…**
keeps a prepared package in its current location, while **Import model…** creates
a managed copy or converts compatible raw weights.

Download choices are:
- the DLSSMac 0.1.6 HT71 neural-rendering model;
- Real-ESRGAN Anime 4×, and Real-ESRGAN General 4× with its paired WDN denoising model;
- Real-CUGAN 2× in Conservative, No denoising and Denoise 1, 2 and 3 variants, and
  3× and 4× in Conservative, No denoising and Denoise 3 variants;
- NAFNet SIDD width64 (denoising) and NAFNet GoPro width64 (deblurring);
- RIFE 4.6 and MLX interpolation 310.9.16 for frame generation;
- RTX VSR 1.8.2 2×;
- Depth Anything V2 Small for estimated depth.
Each source retains pinned checksums and original license notices. Import adapts
supported Swift SRVGG tensor names, floating-point ncnn RIFE storage and the
declared packed weights in the supported NVIDIA `.dll` or `.so` library. The
NVIDIA library is treated as data and is never loaded or executed. VSR acquisition
retrieves only its declared model entry and notices from the source archive.
Conversion changes model metadata or tensor storage, separately from GPU image
processing. Installed sources are reused offline.

Compatible CUGAN and NAFNet `.pth` files import through a bounded tensor-storage
reader. Convolution layouts and tensor names are converted without executing
checkpoint code or requiring Python. Downloaded archives expose only their
declared checkpoint; complete source checksums are checked before import.

Image filters with a declared model dependency use the same **Model** menu.
Relative-depth packages produce a single inferred attachment for their consumer;
they do not provide renderer depth, motion or camera guides. Model defaults stay
separate for each operation.

Models are shared across games and selectable per row. Importing another model
during play makes it available immediately. Active copies remain reserved until
their game releases them. MetalFX, ordinary shaders and non-model filters operate
independently of model acquisition.

## Generation and output

Frame generation inserts images between real frames without changing simulation
rate. Row **Frame multiplier** controls the requested ratio. **Output** contains
shared pacing controls. The main **Motion clarity** row uses the same
presentation clock.
Adaptive pacing approaches its target within the selected multiplier and actual
display refresh. Smooth cadence favors evenly delivered images.

**Output → Tone mapping** selects Automatic, None, Reinhard or PBR Neutral.
Automatic follows the declared image and output range. None skips final
highlight compression while retaining required color and alpha conversion.
PBR Neutral uses scene-referred input; display-referred or already mapped input
falls back to Automatic with a reason in Details. Output conversion and dither
remain shared by presentation and video export.

**Output → Compare** selects the source image, a source/processed split or the
absolute RGB difference. Source is the real image handed to the presenter,
including any earlier scene reconstruction. Generated phases use their closing
real source as the reference. Both sides enter one linear display-color domain;
the final output conversion and dithering run afterward. The same saved policy
applies to file export. Divider and difference-gain controls follow the selected
mode.

LS1 and LSFG use models from a purchased
[Lossless Scaling](https://store.steampowered.com/app/993090/Lossless_Scaling/) copy.
Runtimes → Graphics → **Upscaling** supports local DLL import, offline discovery
and explicit Steam acquisition. The source DLL remains unchanged. LSFG controls
include Quality/Performance, precision and motion-estimation scale.

Motion clarity offers **Auto**, **Off**, black-frame insertion and CRT beam
scheduling when supported by the presenter. Auto follows an actual subframe
shader. Explicit Off overrides that request. Subframe count, duty and brightness
control scheduling and illumination; actual refresh and presentation determine
the available result.

## Runtime and resource ownership

The shared layer receives Metal, OpenGL, Core Animation, hosted browser and
explicit runtime textures. Metal images remain on the GPU. OpenGL uses shared
texture/surface interop; libplacebo uses MoltenVK on the same Metal device.
Completed Quartz bitmaps upload once. Intermediate textures and model resources
remain retained until GPU work completes. Unchanged settings reuse compiled
resources. Dormant activation allows later live edits without loading shaders or
model weights.

Component minimums remain independent of the launcher's macOS 13 minimum:
shared FX/Slang and MagpieFX Metal execution support ARM64 and x86_64 on
macOS 13. MagpieFX preparation uses the launcher's compiler architecture: macOS
15 on Apple Silicon or macOS 14 on Intel. ISF and shared libplacebo require
macOS 15; managed mpv CLI and live ARM64 MLX processing require macOS 14.
The decoded-frame mpv host requires Apple Silicon and macOS 27. FSR 4.1 SIMD
compute requires macOS 15 and an Apple GPU family 7 or newer device. Its Metal
Performance Primitives path requires macOS 26 and Apple GPU family 10 or newer.
Native mpv supplies its own video
shader phases. The [video guide](runtimes/VIDEO.md) describes playback and export.
